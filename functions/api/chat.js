/* ════════════════════════════════════════════════════════════════════════
 *  functions/api/chat.js  —  Cloudflare Pages Function  →  route  POST /api/chat
 * ────────────────────────────────────────────────────────────────────────
 *  Chat interactif BORNÉ, affiché sous le bilan IA. Le prospect peut poser
 *  quelques questions sur SA simulation de retraite.
 *
 *  Reçoit : { payload: <sortie de buildSimulationPayload()>, messages: [{role,content}, …] }
 *  Renvoie : { ok, reply, remaining }   (remaining = échanges restants)
 *
 *  Garde-fous (identiques au bilan + spécifiques chat) :
 *   - périmètre verrouillé : retraite / PER (catégorie générale) / cette simulation ;
 *   - hors-sujet refusé poliment ;
 *   - toute demande de conseil perso -> réponse générale + redirection conseiller ;
 *   - aucun chiffre inventé (seuls ceux du contexte) ; aucun rendement promis ;
 *   - aucune offre/établissement nommé ; disclaimer géré par l'interface ;
 *   - nombre d'échanges PLAFONNÉ côté serveur (anti-coût / anti-dérive).
 *
 *  Variables d'environnement : ANTHROPIC_API_KEY (requis), BILAN_MODEL (optionnel),
 *  ALLOWED_ORIGIN (optionnel). Pas d'e-mail ici.
 * ════════════════════════════════════════════════════════════════════════ */

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Plafonds (ajustables)
const MAX_TURNS = 4;          // nombre de questions autorisées par session
const MAX_TOKENS = 450;       // réponses courtes
const MAX_MSG_LEN = 1000;     // longueur max d'un message entrant (anti-abus)

const CAPPED_REPLY =
  "Pour aller plus loin et obtenir des réponses adaptées à votre situation précise, " +
  "le mieux est d'en discuter avec un conseiller : il pourra reprendre tous ces éléments avec vous en détail.";

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

export async function onRequestPost({ request, env }) {
  if (!env || !env.ANTHROPIC_API_KEY) {
    return json({ ok: false, error: 'Configuration serveur incomplète.' }, 500, env);
  }

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Requête invalide.' }, 400, env); }

  const payload = body && body.payload;
  const rawMessages = (body && body.messages) || [];
  if (!payload || !payload.state) return json({ ok: false, error: 'Contexte de simulation manquant.' }, 400, env);
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return json({ ok: false, error: 'Aucun message.' }, 400, env);
  }

  // Nettoyage + validation de l'historique
  const messages = [];
  for (const m of rawMessages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = String(m.content == null ? '' : m.content).slice(0, MAX_MSG_LEN).trim();
    if (!content) continue;
    messages.push({ role: m.role, content });
  }
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    return json({ ok: false, error: 'Le dernier message doit être une question.' }, 400, env);
  }

  // PLAFOND d'échanges — compté côté serveur
  const userTurns = messages.filter((m) => m.role === 'user').length;
  if (userTurns > MAX_TURNS) {
    return json({ ok: true, reply: CAPPED_REPLY, remaining: 0, capped: true }, 200, env);
  }

  // Appel modèle
  let reply;
  try {
    const system = buildChatSystemPrompt(factsSummary(payload));
    reply = await callClaude(env, system, messages.slice(-(2 * MAX_TURNS))); // borne la fenêtre
  } catch (err) {
    return json({ ok: false, error: 'Réponse indisponible.' }, 502, env);
  }

  return json({ ok: true, reply, remaining: Math.max(0, MAX_TURNS - userTurns) }, 200, env);
}

/* ── Résumé chiffré injecté (les SEULS chiffres citables) ─────────────────── */
function factsSummary(payload) {
  const s = payload.state || {};
  const pd = payload.projectionData || {};
  const STATUT = {
    cadre: 'salarié cadre (privé)', 'non-cadre': 'salarié non-cadre (privé)',
    fonctionnaire: 'fonctionnaire', tns: 'travailleur non salarié (TNS)',
    liberal: 'profession libérale', 'self-employed': 'indépendant',
  };
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? Math.round(x) : null; };
  const eur = (v) => (v == null ? null : n(v).toLocaleString('fr-FR') + ' €');
  const L = [];
  L.push('- Statut : ' + (STATUT[s.statut] || s.statut || 'non précisé') + (s.tnsProfession ? ' (' + s.tnsProfession + ')' : ''));
  if (s.currentAge != null) L.push('- Âge : ' + n(s.currentAge) + ' ans');
  if (s.retireAge != null) L.push('- Départ visé : ' + n(s.retireAge) + ' ans');
  if (s.monthlySalaryNet != null) L.push('- Revenu net mensuel actuel : ' + eur(s.monthlySalaryNet));
  if (s.pensionNetteMensuelle != null) L.push('- Pension nette estimée : ' + eur(s.pensionNetteMensuelle) + ' / mois');
  if (s.tauxRemplacement != null) L.push('- Taux de remplacement : ' + Math.round(s.tauxRemplacement * 1000) / 10 + ' %');
  if (pd.manqueMensuel != null) L.push('- Manque mensuel estimé : ' + eur(pd.manqueMensuel) + ' / mois');
  if (pd.effortMensuel != null) L.push('- Effort d\'épargne suggéré : ' + eur(pd.effortMensuel) + ' / mois');
  if (pd.coutReelMensuel != null) L.push('- Coût réel après avantage fiscal : ' + eur(pd.coutReelMensuel) + ' / mois');
  if (s.plafondPER != null) L.push('- Plafond de déduction PER : ' + eur(s.plafondPER));
  if (s.tmi != null) L.push('- TMI : ' + Math.round(s.tmi * 100) + ' %');
  return L.join('\n');
}

/* ── Prompt système — périmètre verrouillé + 6 garde-fous ─────────────────── */
function buildChatSystemPrompt(facts) {
  return [
    "Tu es l'assistant pédagogique d'un simulateur de retraite français. Tu réponds aux questions d'un internaute À PROPOS de la simulation de retraite qu'il vient de recevoir. Tu n'es PAS conseiller financier.",
    '',
    'CONTEXTE CHIFFRÉ — ce sont les SEULS chiffres que tu peux citer ; n\'en invente, n\'en modifie et n\'en extrapole aucun autre :',
    facts,
    '',
    'PÉRIMÈTRE — tu ne réponds QUE sur : la retraite et le fonctionnement du système de retraite français ; le PER (Plan d\'Épargne Retraite) en tant que catégorie générale d\'enveloppe prévue par la loi ; les chiffres et le contenu de CETTE simulation.',
    '',
    'RÈGLES ABSOLUES :',
    '1. Jamais de recommandation d\'un produit, contrat ou établissement précis. Le PER uniquement comme catégorie générale, jamais une offre commerciale nommée.',
    '2. Jamais de conseil en investissement personnalisé. Si on te demande quoi faire, combien investir précisément, si tel placement est bon, comment répartir, etc. -> donne une explication générale puis renvoie explicitement vers le conseiller humain habilité.',
    '3. Ne promets jamais de rendement ; les taux sont des hypothèses, pas des engagements.',
    '4. N\'utilise que les chiffres du contexte ci-dessus. Si une information n\'y est pas, dis simplement que la simulation ne la couvre pas et oriente vers le conseiller.',
    '5. HORS-SUJET (tout ce qui ne relève pas de la retraite, du PER ou de cette simulation) : refuse poliment en une phrase et recentre. N\'aborde aucun autre domaine.',
    '6. N\'ajoute aucune mention légale ni disclaimer : ils sont gérés par l\'interface.',
    '',
    'STYLE : réponses COURTES (2 à 4 phrases maximum), tutoiement chaleureux, clair, sans jargon non expliqué, jamais anxiogène. Quand la question appelle une décision ou un choix concret, conclus en invitant à en parler avec un conseiller.',
  ].join('\n');
}

async function callClaude(env, system, messages) {
  const model = env.BILAN_MODEL || DEFAULT_MODEL;
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, messages }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error('API Anthropic ' + resp.status + (t ? ' : ' + t.slice(0, 200) : ''));
  }
  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error('Réponse vide.');
  return text;
}
