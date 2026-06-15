// ════════════════════════════════════════════════════════════════════════
//  build.mjs — USINE À PAGES MÉTIER retraitia
//  Lit  : _template-metier.html  +  professions.json
//  Écrit: ./pages/retraite-<slug>.html  (statiques, prêtes à déployer)
//  Lance: node build.mjs
//  Aucune dépendance externe.
// ════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// ── 1. Configuration (le SEUL endroit pour le domaine) ──────────────────
const BASE_URL = 'https://retraitia.fr';   // ← mets ton domaine réel ici
const OUT_DIR = '.';

// ── 2. Petite bibliothèque d'icônes (inner SVG, trait = couleur courante) ─
const ICONS = {
  shield:    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  clock:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  euro:      '<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  alert:     '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  chartdown: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
  trenddown: '<path d="M22 17 13.5 8.5 8.5 13.5 2 7"/><path d="M16 17h6v-6"/>',
  bars:      '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6" rx="1"/><rect x="12.5" y="7" width="3" height="10" rx="1"/><rect x="18" y="13" width="3" height="4" rx="1"/>',
  building:  '<path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="M9 21v-6h6v6"/>',
};
const svg = (name, size = 22) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.shield}</svg>`;

// Icônes fixes par position pour les 4 chiffres clés ; cycle pour les erreurs.
const FACT_ICONS  = ['shield', 'clock', 'euro', 'alert'];
const ERROR_ICONS = ['clock', 'chartdown', 'trenddown', 'euro', 'bars', 'building'];

// ── 3. Générateurs de blocs HTML ────────────────────────────────────────
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function factCardsHtml(cards) {
  return '\n' + cards.map((c, i) => `      <div class="fact-card">
        <div class="fact-ico">${svg(FACT_ICONS[i] || 'shield')}</div>
        <div class="fact-label">${c.label}</div>
        <div class="fact-value">${c.value}</div>
        <div class="fact-note">${c.note}</div>
      </div>`).join('\n') + '\n    ';
}

function erreursCardsHtml(items) {
  return '\n' + items.map((e, i) => `      <div class="error-card">
        <div class="error-ico">${svg(ERROR_ICONS[i % ERROR_ICONS.length])}</div>
        <h3>${e.titre}</h3>
        <p>${e.texte}</p>
      </div>`).join('\n') + '\n    ';
}

function faqHtml(items) {
  return '\n' + items.map(f => `      <details>
        <summary>${f.q}</summary>
        <div class="faq-a">${f.aHtml || f.a}</div>
      </details>`).join('\n') + '\n    ';
}

// ── 4. Générateurs de schémas JSON-LD (toujours synchrones avec le contenu) ─
function faqSchema(items) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a }   // texte brut (pas de HTML)
    }))
  };
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n</script>`;
}

function breadcrumbSchema(p) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Accueil',            item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: 'Retraite par métier', item: `${BASE_URL}/retraite` },
      { '@type': 'ListItem', position: 3, name: cap(p.professionLong), item: `${BASE_URL}/${p.slug}` }
    ]
  };
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n</script>`;
}

// ── 5. Remplacement sûr des tokens ({{X}}) — pas d'interprétation de $ ───
function fill(tpl, map) {
  let out = tpl;
  for (const [k, v] of Object.entries(map)) out = out.split(`{{${k}}}`).join(v);
  return out;
}

// ── 6. Build ────────────────────────────────────────────────────────────
const template = readFileSync('_template-metier.html', 'utf-8');
const pages    = JSON.parse(readFileSync('professions.json', 'utf-8'));
mkdirSync(OUT_DIR, { recursive: true });

for (const p of pages) {
  const map = {
    // SEO / meta
    TITLE:        p.meta.title,
    META_DESC:    p.meta.description,
    OG_TITLE:     p.meta.ogTitle,
    OG_DESC:      p.meta.ogDesc,
    OG_IMAGE:     p.meta.ogImage || `${BASE_URL}/og/${p.slug}.jpg`,
    CANONICAL:    `${BASE_URL}/${p.slug}`,
    // schémas (générés)
    BREADCRUMB_SCHEMA: breadcrumbSchema(p),
    FAQ_SCHEMA:        faqSchema(p.faq),
    // bloc PAGE {} + champs cachés
    NOM:             p.nom,
    PROFESSION_LONG: p.professionLong,
    PROFESSION_LONG_CAP: cap(p.professionLong),
    PROFESSION_KEY:  p.key,
    SLUG:            p.slug,
    REGIME:          p.regime,
    AGE_LEGAL:       p.ageLegal,
    REVENU_MOYEN:    p.revenuMoyen,
    PENSION_MOYENNE: p.pensionMoyenne,
    STATUT:          p.statut,
    // hero
    HERO_EYEBROW: p.heroEyebrow,
    H1:           p.h1,
    HERO_SUB:     p.heroSubHtml,
    // simulateur + crédibilité
    CRED_BADGE_1: p.credBadge1,
    // chiffres clés
    FACTS_HEADING: p.factsHeading,
    FACT_CARDS:    factCardsHtml(p.factCards),
    // exemple
    EX_TITRE:     p.exemple.titre,
    EX_REVENU:    p.exemple.revenu,
    EX_PENSION:   p.exemple.pension,
    EX_ECART:     p.exemple.ecart,
    EX_ECART_PCT: p.exemple.ecartPct,
    EX_FOOT:      p.exemple.footHtml,
    // contenu SEO + erreurs + faq + cta
    SEO_BODY:      p.seoBodyHtml,
    FAQ_SUB:       p.faqSub,
    ERREURS_CARDS: erreursCardsHtml(p.erreurs),
    FAQ_HTML:      faqHtml(p.faq),
    CTA_TITLE:     p.ctaTitle,
  };

  let html = fill(template, map);

  // Filet de sécurité : aucun token non remplacé ne doit subsister
  const left = [...new Set(html.match(/\{\{[A-Z0-9_]+\}\}/g) || [])];
  if (left.length) { console.error(`✗ ${p.slug} — tokens non remplis :`, left); process.exitCode = 1; }

  writeFileSync(`${OUT_DIR}/${p.slug}.html`, html);
  console.log(`✓ ${OUT_DIR}/${p.slug}.html  (${(html.length / 1024).toFixed(0)} Ko)`);
}

console.log(`\n${pages.length} page(s) générée(s) dans ${OUT_DIR}/`);
