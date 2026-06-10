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

  // Validation minimale de la structure renvoyée par le modèle
  const prospect = (model && model.prospect) || {};
  const conseiller = (model && model.conseiller) || {};
  if (!prospect.situation || !prospect.leviers) {
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

  // 7. Réponse au CLIENT — UNIQUEMENT le bilan prospect. Ni score, ni brief, ni angles.
  return json({
    ok: true,
    bilan: {
      situation: prospect.situation,
      contexteRegime: prospect.contexteRegime || '',
      revele: prospect.revele || '',
      leviers: prospect.leviers,
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
    salaireNetMensuel: num(s.monthlySalaryNet),
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
 *  SCORE DE LEAD — déterministe, calculé EN CODE (jamais par l'IA)
 *  Pondère : revenu × ampleur du déficit × statut × proximité retraite.
 *  Sortie : { total 0-100, temperature 'chaud'|'tiède'|'froid', detail }
 *  Les poids sont volontairement lisibles et ajustables.
 * ────────────────────────────────────────────────────────────────────────── */
function computeScore(f) {
  // a) Capacité financière (revenu) — plus le revenu est élevé, meilleure la capacité d'épargne.
  //    Échelle douce : 30 k€ → ~20, 60 k€ → ~55, 100 k€ → ~85, 150 k€+ → 100.
  const revenu = f.salaireBrutAnnuel || 0;
  const sRevenu = clamp(((revenu - 25000) / 125000) * 100, 0, 100);

  // b) Ampleur du déficit — plus le manque mensuel est élevé, plus le besoin est fort (lead « chaud »).
  //    300 €/mois → ~25, 800 € → ~55, 1500 € → ~85, 2500 €+ → 100.
  const manque = f.manqueMensuel || 0;
  const sManque = clamp((manque / 2500) * 100, 0, 100);

  // c) Statut — proxy de potentiel d'optimisation (TNS/libéral : marge de déduction supérieure).
  const STATUT_POIDS = {
    liberal: 90, tns: 85, 'self-employed': 80,
    cadre: 70, fonctionnaire: 55, 'non-cadre': 50,
  };
  const sStatut = STATUT_POIDS[f.statut] != null ? STATUT_POIDS[f.statut] : 60;

  // d) Proximité retraite — fenêtre idéale 5-15 ans (revenus établis + urgence ressentie).
  //    < 3 ans : peu de temps pour agir (mitigé) ; > 25 ans : urgence faible.
  const ans = f.anneesAvantRetraite != null ? f.anneesAvantRetraite : 20;
  let sProx;
  if (ans <= 0) sProx = 40;
  else if (ans < 5) sProx = 70;
  else if (ans <= 15) sProx = 100;
  else if (ans <= 25) sProx = 70;
  else sProx = 45;

  // Pondération globale
  const total = Math.round(
    sRevenu * 0.30 +
    sManque * 0.30 +
    sStatut * 0.20 +
    sProx   * 0.20
  );

  let temperature = 'froid';
  if (total >= 66) temperature = 'chaud';
  else if (total >= 40) temperature = 'tiède';

  return {
    total,
    temperature,
    detail: {
      revenu: Math.round(sRevenu),
      deficit: Math.round(sManque),
      statut: Math.round(sStatut),
      proximite: Math.round(sProx),
    },
  };
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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
    '',
    'STYLE : tutoiement chaleureux, phrases courtes, concret. Pas de jargon non expliqué. Pas de superlatifs commerciaux. Tu valorises la prise de conscience et l\'action mesurée, jamais l\'anxiété.',
    '',
    'SORTIE : réponds UNIQUEMENT par un objet JSON valide, sans texte autour, sans balises Markdown. Schéma exact :',
    '{',
    '  "prospect": {',
    '    "situation": "2-3 phrases résumant SA situation à partir des chiffres fournis (statut, âge, départ, pension estimée).",',
    '    "contexteRegime": "3-4 phrases FACTUELLES et MESURÉES sur les pressions structurelles propres au régime de retraite de SA catégorie professionnelle. Adapte selon le statut : salariés du privé (cadres/non-cadres) -> rôle de la complémentaire AGIRC-ARRCO et érosion tendancielle du taux de remplacement, plafonnement relatif au PASS pour les hauts revenus ; fonctionnaires -> pension calculée sur le traitement indiciaire des 6 derniers mois HORS primes, d\'où un écart pour ceux dont les primes pèsent lourd ; indépendants/TNS au régime général -> cotisations et pensions historiquement plus basses ; professions libérales -> caisses spécifiques (CNAVPL et apparentées) et taux de remplacement souvent faible au regard des revenus d\'activité. Ton informatif et posé, JAMAIS alarmiste ni anxiogène. AUCUNE statistique chiffrée précise inventée : reste qualitatif sur les tendances structurelles.",',
    '    "revele": "2-4 phrases expliquant ce que la simulation révèle : l\'écart entre revenus actuels et future pension, et ce que cela implique concrètement sur le niveau de vie.",',
    '    "leviers": "3-4 phrases présentant les leviers généraux pour réduire cet écart (effort d\'épargne régulier, horizon de temps, intérêts composés, et le PER comme catégorie générale avec son intérêt fiscal lié à la TMI si fournie). Aucune offre nommée.",',
    '    "prochaineEtape": "2 phrases invitant à échanger avec un conseiller pour une analyse adaptée. Encourageant, sans pression."',
    '  },',
    '  "conseiller": {',
    '    "syntheseProfil": "2-3 phrases de synthèse du profil, à usage interne du conseiller.",',
    '    "chiffresCles": "Phrase listant les chiffres clés utiles à l\'entretien (déficit, capacité d\'effort, plafond PER / déduction potentielle si fournis).",',
    '    "anglesAccroche": ["angle 1 pour le RDV", "angle 2", "angle 3"],',
    '    "pointsVigilance": "1-2 phrases : sensibilités à anticiper ou éléments à creuser."',
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
  if (f.salaireNetMensuel != null) lines.push('- Revenu net mensuel actuel : ' + eur(f.salaireNetMensuel));
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
  lines.push('CONTEXTE INTERNE (pour le brief conseiller uniquement) :');
  lines.push('- Température commerciale du lead (calculée séparément) : ' + temperature + '. Adapte le ton des angles d\'accroche en conséquence (plus direct si « chaud », plus pédagogique si « froid »). N\'inclus PAS ce mot ni de score dans la partie « prospect ».');
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
    <div style="padding:0 32px;font:400 15px/1.6 Arial,Helvetica,sans-serif;color:#3a4055;">Voici la synth&egrave;se de votre simulation retraite, pr&eacute;par&eacute;e &agrave; partir des &eacute;l&eacute;ments que vous avez renseign&eacute;s. Elle situe votre future pension et l'effort d'&eacute;pargne qui permettrait de pr&eacute;server votre niveau de vie.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:18px 27px 4px;"><tr>
      ${kpi(C.pensionNetteMensuelle != null ? eur(C.pensionNetteMensuelle) : '—', 'Pension nette / mois')}
      ${kpi(C.tauxRemplacement != null ? C.tauxRemplacement + ' %' : '—', 'Taux de remplacement')}
      ${kpi(C.manqueMensuel != null ? '&minus; ' + eur(Math.abs(C.manqueMensuel)) : '—', 'Manque / mois', '#C0392B')}
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${sec('Votre situation', p.situation)}
      ${sec('Votre régime de retraite', p.contexteRegime)}
      ${sec('Ce que ça révèle', p.revele)}
      ${sec('Vos leviers', p.leviers)}
      ${sec('Prochaine étape', p.prochaineEtape)}
    </table>
    ${C.ctaUrl ? `<div style="padding:24px 32px 8px;">
      <a href="${esc(C.ctaUrl)}" style="display:block;text-align:center;${grad};color:#ffffff;text-decoration:none;font:700 15px Arial,Helvetica,sans-serif;padding:15px;border-radius:10px;">R&eacute;server mon bilan gratuit</a>
    </div>` : ''}
    <div style="padding:8px 32px 18px;font:400 11px/1.6 Arial,Helvetica,sans-serif;color:#9099b5;">${esc(DISCLAIMER_BILAN)}</div>
    <div style="background:${C.bgDark};padding:18px 32px;font:400 11px/1.6 Arial,Helvetica,sans-serif;color:rgba(255,255,255,.6);">
      <strong style="color:#ffffff;">${esc(C.cabinet)}</strong>${C.cabinetPhone ? ' &middot; ' + esc(C.cabinetPhone) : ''}<br>Vous recevez cet e-mail suite &agrave; votre simulation sur notre simulateur retraite.
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
  const angles = Array.isArray(c.anglesAccroche) ? c.anglesAccroche : [];
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

      ${c.syntheseProfil ? h("Angle d'approche") + `<div style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#3a4055;">${esc(c.syntheseProfil)}</div>` : ''}
      ${c.chiffresCles ? `<div style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#3a4055;margin-top:8px;">${esc(c.chiffresCles)}</div>` : ''}
      ${angles.length ? h('Leviers à pousser') + `<ul style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#3a4055;margin:0;padding-left:20px;">${angles.map((a) => `<li style="margin-bottom:5px;">${esc(a)}</li>`).join('')}</ul>` : ''}
      ${c.pointsVigilance ? h('Points de vigilance') + `<div style="font:400 14px/1.6 Arial,Helvetica,sans-serif;color:#3a4055;">${esc(c.pointsVigilance)}</div>` : ''}

      <div style="margin-top:20px;background:#F3EEFE;border-left:3px solid ${C.secondary};border-radius:8px;padding:11px 14px;font:400 12px/1.55 Arial,Helvetica,sans-serif;color:#55608B;">
        <strong style="color:#1B2241;">Interne au cabinet</strong> &mdash; ce brief et le score ne sont pas transmis au prospect. Le prospect a re&ccedil;u, de son c&ocirc;t&eacute;, son bilan p&eacute;dagogique.
      </div>

      <details style="margin-top:16px;">
        <summary style="cursor:pointer;font:600 13px Arial,Helvetica,sans-serif;color:#666;">Copie du bilan re&ccedil;u par le prospect</summary>
        <div style="border-left:3px solid #E3E7F5;padding-left:14px;margin-top:10px;color:#444;font:400 13px/1.6 Arial,Helvetica,sans-serif;">
          <p><strong>Votre situation &mdash;</strong> ${esc(prospectCopy.situation)}</p>
          ${prospectCopy.revele ? `<p><strong>Ce que cela révèle &mdash;</strong> ${esc(prospectCopy.revele)}</p>` : ''}
          <p><strong>Les leviers &mdash;</strong> ${esc(prospectCopy.leviers)}</p>
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
