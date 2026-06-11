/* ════════════════════════════════════════════════════════════════════════
 *  functions/api/bilan.js  —  Cloudflare Pages Function  →  route  POST /api/bilan
 * ────────────────────────────────────────────────────────────────────────
 *  Copilote IA « deux faces » du simulateur Self Épargne.
 *
 *  Reçoit du client (index.html) :
 *    { payload: <sortie de buildSimulationPayload()>, lead: { firstName, lastName, email, phone } }
 *
 *  Produit, EN UN SEUL appel LLM :
 *    1.  BILAN PROSPECT   — pédagogique, encourageant. Renvoyé au client (affiché
 *                           à l'écran) + envoyé au prospect par e-mail, copie cabinet.
 *    2.  BRIEF CONSEILLER  — interne. Score + angles d'accroche + copie du bilan.
 *                           Envoyé AU CABINET UNIQUEMENT. Jamais renvoyé au client.
 *
 *  ⚠️ Le prospect ne voit JAMAIS le score ni le brief : ils ne quittent pas le serveur.
 *  ⚠️ Cette fonction NE TOUCHE PAS à FormSubmit : elle tourne en parallèle, en plus.
 *
 *  ── Variables d'environnement (Cloudflare Pages → Settings → Environment variables) ──
 *    ANTHROPIC_API_KEY   (requis)   clé API Anthropic — NE JAMAIS committer dans le code
 *    RESEND_API_KEY      (optionnel) clé Resend ; si absente → e-mails ignorés, bilan
 *                                   quand même affiché à l'écran (mode v1 « écran seul »)
 *    MAIL_FROM           (optionnel) expéditeur vérifié dans Resend (ex. bilan@retraitia.com)
 *    BILAN_MODEL         (optionnel) override du modèle Claude
 *    ALLOWED_ORIGIN      (optionnel) origine autorisée pour CORS (défaut « * »)
 * ════════════════════════════════════════════════════════════════════════ */

// ── Modèle Claude — configurable. Équilibre coût / qualité pour un outil à fort volume.
//    Réf. des chaînes de modèles : https://docs.claude.com/en/docs/about-claude/models
//    En cas d'erreur 404 « model not found », basculez sur la chaîne datée correspondante.
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 2000;

// ── GARDE-FOU #5 : disclaimer ajouté PAR TEMPLATE, jamais par l'IA ────────────
const DISCLAIMER_BILAN =
  "Ce bilan est une simulation pédagogique fondée sur les règles réglementaires 2026. " +
  "Il ne constitue pas un conseil en investissement personnalisé au sens de la directive MIF II, " +
  "ni une recommandation de produit. Les montants sont des estimations en euros courants (hors inflation future) " +
  "et ne sont ni exacts ni garantis. Seul un échange avec un conseiller habilité permet une analyse adaptée à votre situation.";

/* ──────────────────────────────────────────────────────────────────────────
 *  CORS
 * ────────────────────────────────────────────────────────────────────────── */
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': (env && env.ALLOWED_ORIGIN) || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Handler principal
 * ────────────────────────────────────────────────────────────────────────── */
export async function onRequestPost({ request, env }) {
  // 1. Clé API présente ?
  if (!env || !env.ANTHROPIC_API_KEY) {
    return json({ ok: false, error: 'Configuration serveur incomplète (ANTHROPIC_API_KEY manquante).' }, 500, env);
  }

  // 2. Corps de requête
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Requête invalide.' }, 400, env);
  }

  const payload = body && body.payload;
  const lead = (body && body.lead) || {};
  if (!payload || !payload.state || !payload.projectionData) {
    return json({ ok: false, error: 'Données de simulation manquantes.' }, 400, env);
  }

  // 3. Extraction sûre des chiffres déterministes (GARDE-FOU #2 : aucune invention)
  const facts = extractFacts(payload, lead);

  // 4. GARDE-FOU « le prospect ne voit jamais le score » : score calculé EN CODE, côté serveur
  const scoring = computeScore(facts);

  // 5. Appel LLM unique → bilan prospect + brief conseiller (sortie structurée, GARDE-FOU #3)
  let model;
  try {
    const system = buildSystemPrompt();
    const userMsg = buildUserMessage(facts, scoring.temperature);
    const raw = await callClaude(env, system, userMsg);
    model = parseModelJson(raw);
  } catch (err) {
    return json({ ok: false, error: 'Le bilan n\'a pas pu être généré. ' + (err.message || '') }, 502, env);
  }

  // Validation minimale de la structure renvoyée par le modèle (nouveau schéma MOD 2)
  const prospect = (model && model.prospect) || {};
  const conseiller = (model && model.conseiller) || {};
  if (!prospect.situation || !prospect.impactNiveauVie || !prospect.strategiePossible) {
    return json({ ok: false, error: 'Réponse du modèle incomplète.' }, 502, env);
  }

  // 6. E-mails (Resend) — best-effort, EN PARALLÈLE, sans bloquer la réponse au client.
  //    Si RESEND_API_KEY absente → ignorés silencieusement (bilan affiché quand même).
  const prospectHtml = renderProspectHtml(prospect, facts);
  const briefHtml = renderBriefHtml(conseiller, scoring, facts, prospect);
  const emailTask = dispatchEmails(env, facts, lead, prospectHtml, briefHtml, scoring);

  // En contexte Cloudflare, on attend les e-mails (rapide) — mais une erreur d'envoi
  // ne doit jamais empêcher l'affichage du bilan.
  try { await emailTask; } catch (e) { /* envoi best-effort */ }

  // 7. Réponse au CLIENT — UNIQUEMENT le bilan prospect. Ni score, ni brief, ni angles, ni priorité.
  //    Schéma EXACTEMENT aligné avec l'affichage écran (renderBilanIA) et l'e-mail prospect (OBJ 8) :
  //    situation / impactNiveauVie / strategiePossible / prochaineEtape.
  return json({
    ok: true,
    bilan: {
      situation: prospect.situation,
      impactNiveauVie: prospect.impactNiveauVie || '',
      strategiePossible: prospect.strategiePossible || '',
      prochaineEtape: prospect.prochaineEtape || '',
    },
    disclaimer: DISCLAIMER_BILAN,
    prenom: facts.prenom || '',
  }, 200, env);
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Extraction des faits (uniquement les valeurs affichées + state immuable)
 * ────────────────────────────────────────────────────────────────────────── */
function extractFacts(payload, lead) {
  const s = payload.state || {};
  const pd = payload.projectionData || {};
  const b = payload.BRAND || {};

  const STATUT_LABELS = {
    cadre: 'Salarié cadre (secteur privé)',
    'non-cadre': 'Salarié non-cadre (secteur privé)',
    fonctionnaire: 'Fonctionnaire',
    tns: 'Travailleur non salarié (TNS)',
    liberal: 'Profession libérale',
    'self-employed': 'Indépendant',
  };

  return {
    // Lead
    prenom: (lead.firstName || '').trim(),
    nom: (lead.lastName || '').trim(),
    emailProspect: (lead.email || '').trim(),
    telephone: (lead.phone || '').trim(),

    // Profil
    statut: s.statut || '',
    statutLabel: STATUT_LABELS[s.statut] || s.statut || 'Non précisé',
    profession: s.tnsProfession || '',
    ageActuel: num(s.currentAge),
    ageDepart: num(s.retireAge),
    anneesAvantRetraite: num(s.yearsToRetire),
    enfants: num(s.children),
    salaireBrutAnnuel: num(s.brutSalary),
    salaireNetMensuel: num(s.monthlySalaryNet),   // ⚠ net de FIN DE CARRIÈRE avant impôt — USAGE INTERNE (ratio d'effort du score), jamais présenté comme « revenu actuel »
    tmi: s.tmi != null ? Math.round(s.tmi * 100) : null,
    plafondPER: num(s.plafondPER),

    // Résultats affichés
    pensionNetteMensuelle: num(s.pensionNetteMensuelle),
    tauxRemplacement: s.tauxRemplacement != null ? Math.round(s.tauxRemplacement * 1000) / 10 : null,
    manqueMensuel: num(pd.manqueMensuel),
    effortMensuel: num(pd.effortMensuel),
    coutReelMensuel: num(pd.coutReelMensuel),
    capitalCible: num(pd.capitalCible),
    rendement: payload.selectedRendement != null ? payload.selectedRendement : null,
    mode: payload.currentMode === 'interests' ? 'Vivre de ses intérêts' : 'Vivre de son capital',

    // ── Niveau de vie — variables MÉTIER EXACTES transmises par le payload (aucun nouveau calcul).
    //    Chaîne logique : revenu disponible ACTUEL → niveau de vie PROJETÉ fin de carrière →
    //    OBJECTIF retraite → PENSION → MANQUE.
    //      • niveauVieActuel   = niveauVieActuelMensuel  : revenu net APRÈS impôt d'AUJOURD'HUI (disponible réel)
    //      • revenuNetProjete  = revenuNetProjeteMensuel : niveau de vie projeté en FIN DE CARRIÈRE (réf. retraite)
    //      • objectifMensuel   = objectifMensuel         : objectif retraite (= revenuNetProjeté × lifestyle)
    //      • niveauVieSouhaite = objectifMensuel (alias)   [repli : pension + manque si la valeur exacte manque]
    //    NB : monthlySalaryNet (salaire de fin de carrière avant impôt) n'est PLUS utilisé comme « actuel ».
    niveauVieActuel: num(s.niveauVieActuelMensuel),
    revenuNetProjete: num(s.revenuNetProjeteMensuel),
    objectifMensuel: num(s.objectifMensuel),
    niveauVieSouhaite: num(s.objectifMensuel) != null
      ? num(s.objectifMensuel)
      : ((num(s.pensionNetteMensuelle) != null && num(pd.manqueMensuel) != null)
          ? num(s.pensionNetteMensuelle) + num(pd.manqueMensuel)
          : null),
    lifestylePct: s.lifestyle != null ? Math.round(s.lifestyle * 100) : null,

    // Cabinet
    cabinet: b.name || 'votre conseiller',
    cabinetEmail: b.email || '',
    cabinetEmailLeads: b.emailLeads || '',
    cabinetPhone: b.phone || '',
    ctaUrl: b.ctaUrl || '',

    // Palette (pour les e-mails on-brand — retraitia)
    gold: b.primary || '#2A52F4',
    secondary: b.secondary || '#8931ED',
    bgCard: b.bgCard || '#FFFFFF',
    bgDark: b.bgDark || '#0C163B',
    text: b.text || '#1B2241',
    textMuted: b.textMuted || '#55608B',
    border: b.border || '#E3E7F5',
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function eur(v) {
  if (v == null) return '—';
  return v.toLocaleString('fr-FR') + ' €';
}

/* ──────────────────────────────────────────────────────────────────────────
 *  SCORE DE LEAD — déterministe, calculé EN CODE (jamais par l'IA). RESTE INTERNE.
 *  MOD 5 : ce score représente la PROBABILITÉ DE CONVERSION PER (et non le besoin retraite).
 *  Pondère, par ordre d'importance pour la vente d'un PER :
 *    TMI (levier fiscal, cœur du PER) > plafond PER disponible ≈ manque mensuel ≈ revenu brut
 *    > effort réel après fiscalité (absorbabilité) > horizon retraite > statut.
 *  Sortie : { total 0-100, temperature 'chaud'|'tiède'|'froid', detail }  (poids lisibles/ajustables)
 * ────────────────────────────────────────────────────────────────────────── */
function computeScore(f) {
  // a) TMI — levier fiscal central du PER : la déduction ne vaut vraiment qu'à TMI élevée.
  const tmi = f.tmi != null ? f.tmi : 0;
  let sTmi;
  if (tmi >= 41) sTmi = 100;        // 41 % / 45 % → avantage fiscal maximal
  else if (tmi >= 30) sTmi = 80;    // 30 % → fort
  else if (tmi >= 11) sTmi = 35;    // 11 % → faible
  else sTmi = 8;                    // 0 %  → quasi nul (PER peu pertinent)

  // b) Plafond PER disponible — capacité de déduction réelle ; plus il est élevé, mieux c'est.
  const plafond = f.plafondPER || 0;
  const sPlafond = clamp((plafond / 30000) * 100, 0, 100);

  // c) Manque mensuel — besoin réel = motivation à agir.
  const manque = f.manqueMensuel || 0;
  const sManque = clamp((manque / 2500) * 100, 0, 100);

  // d) Revenu brut — capacité d'épargne.
  const revenu = f.salaireBrutAnnuel || 0;
  const sRevenu = clamp(((revenu - 25000) / 125000) * 100, 0, 100);

  // e) Effort réel APRÈS fiscalité — absorbabilité : un coût réel mesuré au regard du revenu net
  //    rend l'engagement crédible (donc convertible). Le coût réel intègre déjà l'avantage fiscal.
  const net = f.salaireNetMensuel || f.niveauVieActuel || 0;
  const cout = f.coutReelMensuel != null ? f.coutReelMensuel : f.effortMensuel;
  let sEffort = 60; // neutre si donnée absente
  if (net > 0 && cout != null) {
    const r = cout / net;
    if (r <= 0.15) sEffort = 100;
    else if (r <= 0.25) sEffort = 75;
    else if (r <= 0.40) sEffort = 45;
    else sEffort = 25;
  }

  // f) Horizon retraite — COURBE EN CLOCHE (probabilité de conversion PER).
  //    Logique commerciale : trop proche → peu de temps pour agir ; horizon intermédiaire
  //    (pic ~10 ans) → idéal ; très lointain → urgence faible. Interpolation LINÉAIRE
  //    continue entre points d'ancrage [années, score] → aucune rupture brutale
  //    (ex. 9 ans → 98, 10 → 100, 11 → 99 ; et non 9 → 100, 10 → 90).
  const ans = f.anneesAvantRetraite != null ? f.anneesAvantRetraite : 20;
  const HORIZON_ANCHORS = [[0, 30], [3, 50], [5, 90], [10, 100], [20, 90], [25, 70], [35, 40]];
  let sHorizon;
  const firstA = HORIZON_ANCHORS[0];
  const lastA = HORIZON_ANCHORS[HORIZON_ANCHORS.length - 1];
  if (ans <= firstA[0]) {
    sHorizon = firstA[1];                 // avant le 1er point d'ancrage (0 an) → 30
  } else if (ans >= lastA[0]) {
    sHorizon = lastA[1];                  // plancher : 30 ans et + → 40
  } else {
    for (let i = 0; i < HORIZON_ANCHORS.length - 1; i++) {
      const x0 = HORIZON_ANCHORS[i][0], y0 = HORIZON_ANCHORS[i][1];
      const x1 = HORIZON_ANCHORS[i + 1][0], y1 = HORIZON_ANCHORS[i + 1][1];
      if (ans >= x0 && ans <= x1) {
        sHorizon = y0 + (y1 - y0) * (ans - x0) / (x1 - x0);  // interpolation linéaire continue
        break;
      }
    }
  }
  sHorizon = clamp(sHorizon, 0, 100);

  // g) Statut — BONUS faible (pas un facteur principal) : petit ajout selon le potentiel
  //    d'optimisation / niveau de plafond (TNS & libéraux devant), ajouté au score sur 100.
  const STATUT_BONUS = {
    liberal: 6, tns: 5, 'self-employed': 4,
    cadre: 3, 'non-cadre': 1, fonctionnaire: 0,
  };
  const bonusStatut = STATUT_BONUS[f.statut] != null ? STATUT_BONUS[f.statut] : 2;

  // Pondération « probabilité de conversion PER » (OBJ 5) — 6 facteurs = 100, statut en bonus.
  const base =
    sTmi     * 0.35 +
    sManque  * 0.20 +
    sEffort  * 0.15 +
    sRevenu  * 0.15 +
    sHorizon * 0.10 +
    sPlafond * 0.05;
  const total = clamp(Math.round(base + bonusStatut), 0, 100);

  let temperature = 'froid';
  if (total >= 66) temperature = 'chaud';
  else if (total >= 40) temperature = 'tiède';

  return {
    total,
    temperature,
    detail: {
      tmi:     Math.round(sTmi),
      plafond: Math.round(sPlafond),
      deficit: Math.round(sManque),
      revenu:  Math.round(sRevenu),
      effort:  Math.round(sEffort),
      horizon: Math.round(sHorizon),
      statut:  bonusStatut,
    },
  };
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* ──────────────────────────────────────────────────────────────────────────
 *  SIGNAUX D'ACHAT (OBJ 6) — déterministes, calculés EN CODE (jamais par l'IA),
 *  pour que le conseiller voie en un coup d'œil POURQUOI ce lead mérite un appel.
 *  Renvoie une liste de 0 à 6 signaux (les plus forts d'abord). RESTE INTERNE.
 * ────────────────────────────────────────────────────────────────────────── */
function buildBuySignals(f) {
  const sig = [];
  if (f.tmi != null && f.tmi >= 30) sig.push('TMI élevée (' + f.tmi + ' %) — fort levier de déduction PER');
  if (f.manqueMensuel != null && f.manqueMensuel >= 800) sig.push('Déficit retraite important (' + eur(f.manqueMensuel) + ' / mois) — besoin tangible');
  if (f.plafondPER != null && f.plafondPER >= 8000) sig.push('Plafond PER disponible (' + eur(f.plafondPER) + ') — marge de déduction réelle');
  if (f.salaireBrutAnnuel != null && f.salaireBrutAnnuel >= 70000) sig.push('Revenu confortable (' + eur(f.salaireBrutAnnuel) + '/an) — capacité d\'épargne identifiée');
  const net = f.salaireNetMensuel || f.niveauVieActuel || 0;
  const cout = f.coutReelMensuel != null ? f.coutReelMensuel : f.effortMensuel;
  if (net > 0 && cout != null && cout / net <= 0.15) sig.push('Effort réel modéré après fiscalité — engagement crédible');
  if (f.anneesAvantRetraite != null && f.anneesAvantRetraite >= 15) sig.push('Horizon long (' + f.anneesAvantRetraite + ' ans) — intérêts composés favorables');
  return sig.slice(0, 6);
}

/* ──────────────────────────────────────────────────────────────────────────
 *  GARDE-FOU #1 : prompt système — rôle verrouillé + interdits explicites
 * ────────────────────────────────────────────────────────────────────────── */
function buildSystemPrompt() {
  return [
    "Tu es l'assistant pédagogique d'un simulateur de retraite français. Ton rôle est strictement d'EXPLIQUER une simulation déjà calculée, en français clair et bienveillant. Tu n'es PAS conseiller financier.",
    '',
    'RÈGLES ABSOLUES — ne jamais enfreindre :',
    "1. Tu ne recommandes JAMAIS un produit précis, un contrat précis, ni un établissement précis. Tu peux mentionner le PER (Plan d'Épargne Retraite) uniquement comme catégorie générale d'enveloppe d'épargne retraite prévue par la loi — jamais une offre commerciale nommée.",
    '2. Tu ne donnes JAMAIS de conseil en investissement personnalisé. Toute recommandation relève du conseiller humain habilité.',
    '3. Tu ne promets JAMAIS de rendement. Les taux affichés sont des hypothèses de simulation, pas des engagements.',
    "4. Tu n'INVENTES, ne modifies ni n'extrapoles AUCUN chiffre. Tu n'utilises QUE les montants fournis dans les données. Si un chiffre n'est pas fourni, tu ne le mentionnes pas.",
    '5. Tu renvoies toujours vers le conseiller humain pour toute décision ou recommandation.',
    "6. Tu n'ajoutes aucune mention légale ni disclaimer : ils sont gérés ailleurs par le système.",
    "7. Tu n'expliques JAMAIS le fonctionnement général des régimes (AGIRC-ARRCO, retraite par répartition, régime général, complémentaires, etc.) et tu ne produis AUCUN contenu encyclopédique : le prospect veut comprendre SA situation, pas recevoir un cours sur les retraites. Reste centré sur son niveau de vie, son écart et sa stratégie.",
    "8. RÉFÉRENTIEL DES CHIFFRES — distingue RIGOUREUSEMENT ces 5 montants (fournis dans les données) et respecte leur enchaînement logique :",
    "   (1) Revenu DISPONIBLE AUJOURD'HUI = revenu net APRÈS impôt actuel → c'est la SEULE valeur pour « tu vis aujourd'hui avec X ». N'utilise JAMAIS un salaire de fin de carrière comme revenu actuel.",
    "   (2) Niveau de vie PROJETÉ en FIN DE CARRIÈRE = revenu net attendu juste avant la retraite ; sert de référence à l'objectif.",
    "   (3) OBJECTIF retraite = niveau de vie à maintenir à la retraite (un % de (2)).",
    "   (4) PENSION nette projetée = ce que la retraite versera réellement.",
    "   (5) MANQUE mensuel = (3) − (4) = l'écart à financer.",
    "   Enchaînement : (1) aujourd'hui → (2) fin de carrière → (3) objectif → (4) pension → (5) manque. Ne CONFONDS JAMAIS (2) et (4) : « niveau de vie projeté » désigne TOUJOURS (2), JAMAIS la pension.",
    "9. BRIEF CONSEILLER — le brief n'est PAS un résumé du bilan prospect : le conseiller a DÉJÀ accès à tous les chiffres. Il doit apporter des MUNITIONS COMMERCIALES exploitables au téléphone, que le prospect n'a pas reçues. N'y reprends AUCUNE phrase ni argument du bloc prospect.",
    '',
    'STYLE : 100 % TUTOIEMENT pour TOUT le contenu prospect — JAMAIS de vouvoiement, même partiel (« tu », « ton », « tes » ; jamais « vous » ni « votre »). Phrases courtes, concret. Pas de jargon non expliqué, pas de superlatifs commerciaux. Tu valorises la prise de conscience et l\'action mesurée, jamais l\'anxiété.',
    '',
    'SORTIE : réponds UNIQUEMENT par un objet JSON valide, sans texte autour, sans balises Markdown. Schéma EXACT (n\'ajoute, ne retire et ne renomme aucune clé) :',
    '{',
    '  "prospect": {',
    '    "situation": "MAXIMUM 3 phrases. Rappelle UNIQUEMENT : son âge, son horizon avant la retraite et sa pension nette estimée. Aucun blabla, aucune généralité, AUCUN cours sur le fonctionnement des retraites.",',
    '    "impactNiveauVie": "BLOC PRINCIPAL — le plus important. Appuie-toi sur la CHAÎNE (1)→(5) du référentiel : ancre d\'abord « aujourd\'hui tu disposes d\'environ X € nets APRÈS impôt par mois » avec (1) UNIQUEMENT, puis montre l\'OBJECTIF (3) que la PENSION (4) ne couvre pas, d\'où le MANQUE (5). Ne te contente JAMAIS de citer un chiffre brut : traduis-le TOUJOURS en CONSÉQUENCE concrète. Convertis le MANQUE mensuel en impact ANNUEL (× 12 = pouvoir d\'achat annuel en moins) et en réalité quotidienne : voyages, résidence secondaire, aide aux enfants, loisirs, train de vie, confort. Ton attendu — au lieu de « ta pension est de 3 420 € », écris « avec une pension estimée à 3 420 €, ton niveau de vie resterait sensiblement en dessous de celui que tu veux conserver » ; au lieu de « le manque est de 1 088 € », écris « sans préparation, c\'est plus de 13 000 € de pouvoir d\'achat en moins chaque année ». Lucide et bienveillant, JAMAIS anxiogène.",',
    '    "strategiePossible": "Déroule UNE progression claire : PROBLÈME (l\'écart) -> SOLUTION générale (se constituer un complément ; le PER peut être cité comme catégorie générale d\'enveloppe prévue par la loi, AUCUNE marque ni produit nommé) -> EFFORT RÉEL (ce que ça demande chaque mois) -> IMPACT FISCAL (l\'avantage lié à la TMI si fournie, qui réduit le coût réel). PUIS, comme élément CENTRAL, le « pourquoi agir maintenant » fondé sur l\'HORIZON : plus l\'horizon est long, plus l\'effort peut rester progressif et plus les intérêts composés travaillent ; chaque année de report réduit ce temps disponible et la puissance de la capitalisation. Tu PEUX, de façon SECONDAIRE et mesurée, rappeler qu\'à plusieurs décennies de la retraite les règles des régimes évoluent au fil des réformes, ce qui rend une épargne complémentaire utile pour moins dépendre des évolutions futures — mais SANS JAMAIS prédire une réforme, annoncer une baisse des pensions, affirmer qu\'une réforme est certaine, ni tenir un discours alarmiste. L\'effet du temps et des intérêts composés RESTE le message principal. Concret, mesuré, sans promesse de rendement.",',
    '    "prochaineEtape": "MAXIMUM 2 phrases. Invite à en parler avec un conseiller pour une analyse adaptée. Encourageant, sans pression."',
    '  },',
    '  "conseiller": {',
    '    "opportuniteCommerciale": "2-3 phrases ORIENTÉES CONVERSION (jamais descriptives) : pourquoi appeler MAINTENANT + le levier CHIFFRÉ à actionner (déduction PER annuelle récupérable, gain d\'impôt estimé selon la TMI, montant de versement « cible » à proposer). Ce n\'est PAS un résumé de l\'écart.",',
    '    "anglePrincipal": "1-2 phrases : une ACCROCHE TÉLÉPHONIQUE prête à dire, percutante et chiffrée (ex. « à votre TMI, chaque 1 000 € versés ne vous coûtent réellement que X € »). INTERDIT de reformuler le bilan prospect.",',
    '    "anglesSecondaires": ["2 à 3 leviers DISTINCTS du prospect, centrés sur : fiscalité / effort réel après impôt / horizon de capitalisation restant / plafond PER disponible / urgence d\'action"],',
    '    "objectionProbable": "1 phrase : l\'objection CONDITIONNÉE AU PROFIL (TMI faible → intérêt fiscal limité ; horizon court → liquidité / peu de temps ; effort élevé → budget ; TNS → trésorerie ; fonctionnaire → habitudes ; proche de la retraite → blocage de l\'épargne). Choisis celle qui colle à CE profil précis.",',
    '    "reponseObjection": "1-2 phrases PRÊTES À DIRE au téléphone, appuyées sur un CHIFFRE du dossier (TMI, plafond PER, coût réel, horizon) — pas de pédagogie produit générique.",',
    '    "priorite": "UN seul mot parmi : haute, moyenne, basse. Cohérent avec la température commerciale fournie dans le message.",',
    '    "justificationPriorite": "1 phrase justifiant la priorité, SANS citer de score chiffré."',
    '  }',
    '}',
  ].join('\n');
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Message utilisateur — TOUS les chiffres injectés depuis le code
 * ────────────────────────────────────────────────────────────────────────── */
function buildUserMessage(f, temperature) {
  const lines = [];
  lines.push('Voici les données de la simulation (chiffres déjà calculés — à utiliser tels quels, sans en inventer d\'autres) :');
  lines.push('');
  lines.push('PROFIL');
  lines.push('- Prénom : ' + (f.prenom || 'non communiqué'));
  lines.push('- Statut : ' + f.statutLabel + (f.profession ? ' (' + f.profession + ')' : ''));
  if (f.ageActuel != null) lines.push('- Âge actuel : ' + f.ageActuel + ' ans');
  if (f.ageDepart != null) lines.push('- Âge de départ visé : ' + f.ageDepart + ' ans');
  if (f.anneesAvantRetraite != null) lines.push('- Années avant la retraite : ' + f.anneesAvantRetraite);
  if (f.enfants != null) lines.push('- Enfants : ' + f.enfants);
  if (f.salaireBrutAnnuel != null) lines.push('- Revenu brut annuel : ' + eur(f.salaireBrutAnnuel));
  if (f.tmi != null) lines.push('- Tranche marginale d\'imposition (TMI) : ' + f.tmi + ' %');
  lines.push('');
  lines.push('RÉSULTATS DE LA SIMULATION');
  if (f.pensionNetteMensuelle != null) lines.push('- Pension nette mensuelle estimée : ' + eur(f.pensionNetteMensuelle));
  if (f.tauxRemplacement != null) lines.push('- Taux de remplacement estimé : ' + f.tauxRemplacement + ' %');
  if (f.manqueMensuel != null) lines.push('- Manque mensuel estimé (écart de niveau de vie) : ' + eur(f.manqueMensuel) + ' / mois');
  if (f.effortMensuel != null) lines.push('- Effort d\'épargne mensuel suggéré par la simulation : ' + eur(f.effortMensuel) + ' / mois');
  if (f.coutReelMensuel != null) lines.push('- Coût réel mensuel après avantage fiscal : ' + eur(f.coutReelMensuel) + ' / mois');
  if (f.capitalCible != null) lines.push('- Capital cible : ' + eur(f.capitalCible));
  if (f.plafondPER != null) lines.push('- Plafond de déduction PER disponible : ' + eur(f.plafondPER));
  if (f.rendement != null) lines.push('- Hypothèse de rendement annuel retenue : ' + f.rendement + ' % (hypothèse, non garantie)');
  lines.push('- Scénario : ' + f.mode);
  lines.push('');
  lines.push('NIVEAU DE VIE — CHAÎNE LOGIQUE À RESPECTER (cœur de l\'analyse, à exploiter EN PRIORITÉ pour "impactNiveauVie") :');
  if (f.niveauVieActuel != null) lines.push('- (1) Revenu DISPONIBLE AUJOURD\'HUI (net APRÈS impôt) : ' + eur(f.niveauVieActuel) + ' / mois  ← c\'est la SEULE valeur pour « tu vis aujourd\'hui avec X »');
  if (f.revenuNetProjete != null) lines.push('- (2) Niveau de vie PROJETÉ en FIN DE CARRIÈRE (net après impôt, référence retraite) : ' + eur(f.revenuNetProjete) + ' / mois');
  if (f.objectifMensuel != null) lines.push('- (3) OBJECTIF retraite (niveau de vie à maintenir' + (f.lifestylePct != null ? ', soit ' + f.lifestylePct + ' % du revenu de fin de carrière' : '') + ') : ' + eur(f.objectifMensuel) + ' / mois');
  if (f.pensionNetteMensuelle != null) lines.push('- (4) PENSION nette projetée (ce que la retraite versera réellement) : ' + eur(f.pensionNetteMensuelle) + ' / mois');
  if (f.manqueMensuel != null) lines.push('- (5) MANQUE mensuel = objectif (3) − pension (4) = l\'écart à financer : ' + eur(f.manqueMensuel) + ' / mois');
  lines.push('  → Ne CONFONDS JAMAIS (2) « niveau de vie projeté fin de carrière » et (4) « pension ». Pour « aujourd\'hui », utilise UNIQUEMENT (1) ; n\'utilise jamais un salaire de fin de carrière comme revenu actuel.');
  lines.push('');
  lines.push('CONTEXTE INTERNE (pour la partie « conseiller » UNIQUEMENT — jamais visible du prospect) :');
  lines.push('- Température commerciale du lead (probabilité de conversion PER, calculée séparément) : ' + temperature + '. Utilise-la pour fixer "priorite" (chaud -> haute, tiède -> moyenne, froid -> basse) et pour calibrer le ton des angles (plus direct si « chaud », plus pédagogique si « froid »). N\'inclus NI ce mot, NI aucun score, NI aucun élément de la partie conseiller dans la partie « prospect ».');
  lines.push('');
  lines.push('Génère le JSON demandé.');
  return lines.join('\n');
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Appel Anthropic
 * ────────────────────────────────────────────────────────────────────────── */
async function callClaude(env, system, userMsg) {
  const model = env.BILAN_MODEL || DEFAULT_MODEL;
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error('API Anthropic ' + resp.status + (t ? ' : ' + t.slice(0, 200) : ''));
  }
  const data = await resp.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('Réponse vide.');
  return text;
}

function parseModelJson(text) {
  let t = text.trim();
  // Retire d'éventuelles clôtures Markdown
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // Isole le premier objet { ... } si du texte parasite subsiste
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last !== -1) t = t.slice(first, last + 1);
  return JSON.parse(t);
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Rendus HTML des e-mails (on-brand, sobres, compatibles clients mail)
 * ────────────────────────────────────────────────────────────────────────── */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderProspectHtml(p, f) {
  const C = f;
  const grad = 'background:#4A3AD0;background-image:linear-gradient(125deg,' + C.secondary + ' 0%,' + C.gold + ' 70%)';
  const kpi = (val, lab, color) => `<td width="33%" valign="top" style="padding:0 5px;">
        <div style="background:#F4F6FD;border:1px solid #E6EAF8;border-radius:10px;padding:14px 6px;text-align:center;">
          <div style="font:700 18px Arial,Helvetica,sans-serif;color:${color || C.text};">${val}</div>
          <div style="font:700 8px Arial,Helvetica,sans-serif;letter-spacing:.05em;text-transform:uppercase;color:#8892B9;margin-top:5px;">${lab}</div>
        </div></td>`;
  const sec = (titre, corps) => corps
    ? `<tr><td style="padding:18px 32px 0;">
         <div style="font-size:0;line-height:0;"><span style="display:inline-block;width:34px;height:3px;background:${C.gold};border-radius:3px;">&nbsp;</span></div>
         <div style="font:700 11px Arial,Helvetica,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:${C.gold};margin:8px 0 6px;">${esc(titre)}</div>
         <div style="font:400 15px/1.6 Arial,Helvetica,sans-serif;color:#3a4055;">${esc(corps)}</div>
       </td></tr>` : '';
  return `
  <div style="max-width:600px;margin:0 auto;background:${C.bgCard};border:1px solid ${C.border};border-radius:10px;overflow:hidden;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${grad};">
      <tr><td style="padding:22px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font:800 24px Arial,Helvetica,sans-serif;color:#ffffff;letter-spacing:-.5px;">retraitia</td>
        <td align="right" style="font:700 11px Arial,Helvetica,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.92);">&#10022; Bilan g&eacute;n&eacute;r&eacute; par l'IA</td>
      </tr></table></td></tr>
    </table>
    <div style="padding:26px 32px 4px;font:700 18px Arial,Helvetica,sans-serif;color:${C.text};">Bonjour${C.prenom ? ' ' + esc(C.prenom) : ''},</div>
    <div style="padding:0 32px;font:400 15px/1.6 Arial,Helvetica,sans-serif;color:#3a4055;">Voici la synth&egrave;se de ta simulation retraite, pr&eacute;par&eacute;e &agrave; partir des &eacute;l&eacute;ments que tu as renseign&eacute;s. Elle situe ta future pension et l'effort d'&eacute;pargne qui te permettrait de pr&eacute;server ton niveau de vie.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:18px 27px 4px;"><tr>
      ${kpi(C.pensionNetteMensuelle != null ? eur(C.pensionNetteMensuelle) : '—', 'Pension nette / mois')}
      ${kpi(C.tauxRemplacement != null ? C.tauxRemplacement + ' %' : '—', 'Taux de remplacement')}
      ${kpi(C.manqueMensuel != null ? '&minus; ' + eur(Math.abs(C.manqueMensuel)) : '—', 'Manque / mois', '#C0392B')}
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${sec('Ta situation', p.situation)}
      ${sec('Ce que ça change pour ton niveau de vie', p.impactNiveauVie)}
      ${sec('Une stratégie possible', p.strategiePossible)}
      ${sec('Prochaine étape', p.prochaineEtape)}
    </table>
    ${C.ctaUrl ? `<div style="padding:24px 32px 8px;">
      <a href="${esc(C.ctaUrl)}" style="display:block;text-align:center;${grad};color:#ffffff;text-decoration:none;font:700 15px Arial,Helvetica,sans-serif;padding:15px;border-radius:10px;">R&eacute;server mon bilan gratuit</a>
    </div>` : ''}
    <div style="padding:8px 32px 18px;font:400 11px/1.6 Arial,Helvetica,sans-serif;color:#9099b5;">${esc(DISCLAIMER_BILAN)}</div>
    <div style="background:${C.bgDark};padding:18px 32px;font:400 11px/1.6 Arial,Helvetica,sans-serif;color:rgba(255,255,255,.6);">
      <strong style="color:#ffffff;">${esc(C.cabinet)}</strong>${C.cabinetPhone ? ' &middot; ' + esc(C.cabinetPhone) : ''}<br>Tu re&ccedil;ois cet e-mail suite &agrave; ta simulation sur notre simulateur retraite.
    </div>
  </div>`;
}

function renderBriefHtml(c, scoring, f, prospectCopy) {
  const C = f;
  const grad = 'background:#4A3AD0;background-image:linear-gradient(125deg,' + C.secondary + ' 0%,' + C.gold + ' 70%)';
  const temp = scoring.temperature || '';
  const chip = temp === 'chaud' ? { bg: '#13935A', txt: 'Lead prioritaire' }
             : temp === 'tiède' ? { bg: '#B8860B', txt: 'Lead à qualifier' }
             : { bg: '#6B7390', txt: 'Lead à nurturer' };
  const anglesSecondaires = Array.isArray(c.anglesSecondaires) ? c.anglesSecondaires : [];
  const signaux = buildBuySignals(C);   // signaux d'achat déterministes (OBJ 6) — internes, 0 à 6
  const h = (t) => `<div style="font-size:0;line-height:0;margin-top:22px;"><span style="display:inline-block;width:30px;height:3px;background:${C.gold};border-radius:3px;">&nbsp;</span></div><div style="font:700 11px Arial,Helvetica,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:${C.gold};margin:8px 0 6px;">${esc(t)}</div>`;
  const row = (k, v) => v ? `<tr><td style="padding:7px 0;border-bottom:1px solid #EEF0F8;font:400 13px Arial,Helvetica,sans-serif;color:#55608B;">${esc(k)}</td><td align="right" style="padding:7px 0;border-bottom:1px solid #EEF0F8;font:700 13px Arial,Helvetica,sans-serif;color:#1B2241;">${v}</td></tr>` : '';
  return `
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #E3E7F5;border-radius:10px;overflow:hidden;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${grad};">
      <tr><td style="padding:22px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font:800 24px Arial,Helvetica,sans-serif;color:#ffffff;letter-spacing:-.5px;">retraitia</td>
        <td align="right" style="font:700 11px Arial,Helvetica,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.92);">Brief conseiller &mdash; nouveau lead</td>
      </tr></table></td></tr>
    </table>
    <div style="padding:22px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FD;border:1px solid #E6EAF8;border-radius:12px;"><tr>
        <td width="96" valign="middle" style="padding:14px 0 14px 20px;font:800 38px Arial,Helvetica,sans-serif;color:${C.gold};white-space:nowrap;">${scoring.total}<span style="font-size:16px;color:#8892B9;font-weight:700;">/100</span></td>
        <td valign="middle" style="padding:14px 20px;">
          <span style="display:inline-block;background:${chip.bg};color:#ffffff;font:700 10px Arial,Helvetica,sans-serif;letter-spacing:.06em;text-transform:uppercase;padding:4px 11px;border-radius:20px;">${chip.txt}</span>
          <div style="height:7px;border-radius:20px;background:#E0E5F6;margin-top:9px;font-size:0;line-height:0;"><div style="height:7px;border-radius:20px;width:${clamp(scoring.total,3,100)}%;${grad};">&nbsp;</div></div>
          <div style="font:400 11px Arial,Helvetica,sans-serif;color:#55608B;margin-top:8px;">Lead ${esc(temp)} &middot; score ${scoring.total}/100</div>
        </td>
      </tr></table>

      ${h('Prospect')}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${row('Nom', esc(C.prenom) + ' ' + esc(C.nom))}
        ${row('E-mail', `<a href="mailto:${esc(C.emailProspect)}" style="color:${C.gold};text-decoration:none;">${esc(C.emailProspect)}</a>`)}
        ${row('Téléphone', C.telephone ? `<a href="tel:${esc(C.telephone)}" style="color:${C.gold};text-decoration:none;">${esc(C.telephone)}</a>` : '')}
      </table>

      ${h('Profil & chiffres clés')}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${row('Statut · naissance', esc(C.statutLabel) + (C.profession ? ' (' + esc(C.profession) + ')' : '') + (C.ageDepart ? ' · départ ' + C.ageDepart + ' ans' : ''))}
        ${row('Revenu brut annuel', C.salaireBrutAnnuel != null ? eur(C.salaireBrutAnnuel) : '')}
        ${row('Pension nette estimée', C.pensionNetteMensuelle != null ? eur(C.pensionNetteMensuelle) + ' / mois' : '')}
        ${row('Taux de remplacement', C.tauxRemplacement != null ? C.tauxRemplacement + ' %' : '')}
        ${row('Manque mensuel', C.manqueMensuel != null ? `<span style="color:#C0392B;">&minus; ${eur(Math.abs(C.manqueMensuel))} / mois</span>` : '')}
        ${row('Capital cible (PER)', C.capitalCible != null ? eur(C.capitalCible) : '')}
        ${row('Effort / coût réel', C.effortMensuel != null ? eur(C.effortMensuel) + (C.coutReelMensuel != null ? ' &rarr; ' + eur(C.coutReelMensuel) : '') + ' / mois' : '')}
        ${row('TMI', C.tmi != null ? C.tmi + ' %' : '')}
      </table>

      ${signaux.length ? h("Signaux d'achat") + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0FAF4;border:1px solid #CDEBDA;border-radius:10px;"><tr><td style="padding:11px 15px;"><ul style="font:600 13px/1.6 Arial,Helvetica,sans-serif;color:#1B5E3F;margin:0;padding-left:18px;">${signaux.map((s) => `<li style="margin-bottom:4px;">${esc(s)}</li>`).join('')}</ul></td></tr></table>` : ''}

      ${c.opportuniteCommerciale ? h('Opportunité commerciale') + `<div style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#3a4055;">${esc(c.opportuniteCommerciale)}</div>` : ''}
      ${c.anglePrincipal ? h('Angle principal') + `<div style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#3a4055;">${esc(c.anglePrincipal)}</div>` : ''}
      ${anglesSecondaires.length ? h('Angles secondaires') + `<ul style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#3a4055;margin:0;padding-left:20px;">${anglesSecondaires.map((a) => `<li style="margin-bottom:5px;">${esc(a)}</li>`).join('')}</ul>` : ''}
      ${c.objectionProbable ? h('Objection probable') + `<div style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#3a4055;">${esc(c.objectionProbable)}</div>` : ''}
      ${c.reponseObjection ? h('Réponse recommandée') + `<div style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#3a4055;">${esc(c.reponseObjection)}</div>` : ''}
      ${c.priorite ? h('Priorité du lead') + `<div style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#3a4055;"><strong style="text-transform:capitalize;">${esc(c.priorite)}</strong>${c.justificationPriorite ? ' &mdash; ' + esc(c.justificationPriorite) : ''}</div>` : ''}

      <div style="margin-top:20px;background:#F3EEFE;border-left:3px solid ${C.secondary};border-radius:8px;padding:11px 14px;font:400 12px/1.55 Arial,Helvetica,sans-serif;color:#55608B;">
        <strong style="color:#1B2241;">Interne au cabinet</strong> &mdash; ce brief et le score ne sont pas transmis au prospect. Le prospect a re&ccedil;u, de son c&ocirc;t&eacute;, son bilan p&eacute;dagogique.
      </div>

      <details style="margin-top:16px;">
        <summary style="cursor:pointer;font:600 13px Arial,Helvetica,sans-serif;color:#666;">Copie du bilan re&ccedil;u par le prospect</summary>
        <div style="border-left:3px solid #E3E7F5;padding-left:14px;margin-top:10px;color:#444;font:400 13px/1.6 Arial,Helvetica,sans-serif;">
          <p><strong>Situation &mdash;</strong> ${esc(prospectCopy.situation)}</p>
          ${prospectCopy.impactNiveauVie ? `<p><strong>Impact niveau de vie &mdash;</strong> ${esc(prospectCopy.impactNiveauVie)}</p>` : ''}
          ${prospectCopy.strategiePossible ? `<p><strong>Stratégie possible &mdash;</strong> ${esc(prospectCopy.strategiePossible)}</p>` : ''}
          ${prospectCopy.prochaineEtape ? `<p><strong>Prochaine étape &mdash;</strong> ${esc(prospectCopy.prochaineEtape)}</p>` : ''}
        </div>
      </details>
    </div>
    <div style="background:${C.bgDark};padding:14px 28px;font:400 11px Arial,Helvetica,sans-serif;color:rgba(255,255,255,.6);"><strong style="color:#ffffff;">retraitia</strong> &middot; brief g&eacute;n&eacute;r&eacute; automatiquement &agrave; la soumission du simulateur &middot; ne constitue pas un conseil en investissement.</div>
  </div>`;
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Envoi des e-mails via Resend — best-effort, optionnel
 * ────────────────────────────────────────────────────────────────────────── */
async function dispatchEmails(env, f, lead, prospectHtml, briefHtml, scoring) {
  if (!env.RESEND_API_KEY) return; // mode v1 « écran seul » : pas d'envoi

  const from = env.MAIL_FROM || ('bilan@' + (deriveDomain(f) || 'exemple.fr'));
  const cabinetTo = [f.cabinetEmail, f.cabinetEmailLeads].filter(Boolean);
  const tasks = [];

  // 1. Bilan prospect → prospect UNIQUEMENT (aucune copie cabinet)
  if (f.emailProspect) {
    tasks.push(sendEmail(env, {
      from,
      to: [f.emailProspect],
      subject: `Votre bilan retraite${f.prenom ? ' — ' + f.prenom : ''}`,
      html: prospectHtml,
    }));
  }

  // 2. Brief conseiller → CABINET UNIQUEMENT
  if (cabinetTo.length) {
    tasks.push(sendEmail(env, {
      from,
      to: cabinetTo,
      subject: `Lead ${scoring.temperature.toUpperCase()} (${scoring.total}/100) — ${f.prenom} ${f.nom}`.trim(),
      html: briefHtml,
    }));
  }

  await Promise.allSettled(tasks);
}

function deriveDomain(f) {
  const e = f.cabinetEmail || '';
  const at = e.indexOf('@');
  return at !== -1 ? e.slice(at + 1) : '';
}

async function sendEmail(env, { from, to, cc, subject, html }) {
  const body = { from, to, subject, html };
  if (cc && cc.length) body.cc = cc;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    console.error('Resend ' + resp.status + ' : ' + t.slice(0, 200));
  }
}
