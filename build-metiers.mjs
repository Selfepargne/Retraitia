// ════════════════════════════════════════════════════════════════════════
//  build-metiers.mjs — USINE À PAGES MÉTIER retraitia
//  Lit  : .template-metier.html  +  professions.json  (gabarit caché : non publié)
//  Écrit: ./pages/retraite-<slug>.html  (statiques, prêtes à déployer)
//         + .manifest-metiers.json (slugs générés — lu par build-sitemap.mjs)
//  Lance: node build-metiers.mjs
//  Comportement IDENTIQUE à l'ancien build.mjs — seule différence : le
//  sitemap.xml n'est plus écrit ici (responsabilité unique déplacée vers
//  build-sitemap.mjs). Aucune autre ligne de logique n'a changé.
//  Aucune dépendance externe.
// ════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// ── 1. Configuration (le SEUL endroit pour le domaine) ──────────────────
const BASE_URL = 'https://retraitia.com';   // ← mets ton domaine réel ici
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
/* Le point initial n'est pas cosmétique : Cloudflare Pages ne publie pas les
   fichiers cachés. Sous « _template-metier.html », le gabarit était servi à
   /_template-metier — 111 Ko de contenu quasi identique aux 25 pages qu'il
   produit, accessible et indexable. Le renommer suffit à le retirer du site
   sans le sortir du dépôt, là où les builders le cherchent. */
const template = readFileSync('.template-metier.html', 'utf-8');
const pages    = JSON.parse(readFileSync('professions.json', 'utf-8'));
// Lecture seule — pour le maillage profession → caisse (point 7). N'écrit jamais
// dans caisses.json, ne modifie jamais son contenu. Si le fichier n'existe pas
// encore (ordre de build inhabituel), on continue sans encart plutôt que de
// planter — le maillage est un enrichissement, pas une dépendance dure.
let caisses = [];
try {
  caisses = JSON.parse(readFileSync('caisses.json', 'utf-8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

// Encart de maillage vers la caisse correspondante (vide si aucune caisse
// ne couvre encore ce régime dans caisses.json — aucun lien codé en dur).
function caisseLinkBlockHtml(profession) {
  const caisse = caisses.find(c => c.key === profession.regime);
  if (!caisse) return '';
  return `<section class="block" style="padding-top:0;">
  <div class="wrap">
    <div class="caisse-link-box">
      <div class="caisse-link-ico"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="M9 21v-6h6v6"/></svg></div>
      <div class="caisse-link-txt">
        <b>Cette profession dépend de ${caisse.nomLong}.</b>
        <span>Comprendre le fonctionnement de cette caisse : cotisations, points, régimes.</span>
      </div>
      <a class="caisse-link-btn" href="/${caisse.slug}">Découvrir la ${caisse.nom} <span class="arrow">→</span></a>
    </div>
  </div>
</section>`;
}

// ── Maillage interne : « Professions similaires » ────────────────────────
// Sélection 100 % automatique, aucun métier codé en dur.
// Règle 1 : même caisse (regime) d'abord, dans l'ordre de professions.json.
// Règle 2 : si moins de 3 dans la même caisse, complète avec le même statut
//           (libéral CNAVPL, indépendant SSI, etc.), sans doublon ni le
//           métier courant. Toujours 3 résultats maximum (0 si le jeu de
//           données est trop restreint pour en trouver).
function selectSimilarProfessions(current, allProfessions) {
  const excluded = new Set([current.key]);
  const sameRegime = allProfessions.filter(p => p.regime === current.regime && !excluded.has(p.key));

  const selected = sameRegime.slice(0, 3);
  selected.forEach(p => excluded.add(p.key));

  if (selected.length < 3) {
    // Complément par statut : on privilégie une profession par caisse (regime)
    // différente à chaque tour, pour éviter de proposer 3 métiers de la même
    // caisse voisine — l'objectif est la diversité des pistes de lecture,
    // pas juste l'ordre brut du fichier.
    const candidates = allProfessions.filter(p => p.statut === current.statut && !excluded.has(p.key));
    const byRegime = new Map();
    for (const p of candidates) {
      if (!byRegime.has(p.regime)) byRegime.set(p.regime, []);
      byRegime.get(p.regime).push(p);
    }
    let added = true;
    while (selected.length < 3 && added) {
      added = false;
      for (const [, group] of byRegime) {
        if (selected.length >= 3) break;
        const next = group.shift();
        if (next) { selected.push(next); excluded.add(next.key); added = true; }
      }
    }
  }

  return selected.slice(0, 3);
}

function similarProfessionsHtml(current, allProfessions) {
  const similar = selectSimilarProfessions(current, allProfessions);
  if (!similar.length) return '';
  return `<section class="block" style="padding-top:0;">
  <div class="wrap">
    <div class="section-head">
      <h2>Professions <span class="grad-text">similaires</span></h2>
      <p class="section-sub">Découvrez également les guides retraite de professions proches de la vôtre.</p>
    </div>
    <div class="why-grid similar-grid">
${similar.map(p => `      <div class="why-card similar-card">
        <h3>${p.nom}</h3>
        <p>${p.regimeLong || p.regime}</p>
        <a class="similar-link" href="/${p.slug}">Voir le guide <span class="arrow">→</span></a>
      </div>`).join('\n')}
    </div>
  </div>
</section>`;
}
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
    CAISSE_LINK_BLOCK: caisseLinkBlockHtml(p),
    SIMILAR_PROFESSIONS_BLOCK: similarProfessionsHtml(p, pages),
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

// ── 7. Manifeste (liste des slugs générés — le sitemap est fusionné ────
//      ailleurs, par build-sitemap.mjs, seul responsable de sitemap.xml) ─
writeFileSync('.manifest-metiers.json', JSON.stringify({ slugs: pages.map(p => p.slug) }, null, 2));
console.log('✓ .manifest-metiers.json écrit');

console.log(`\n${pages.length} page(s) générée(s) dans ${OUT_DIR}/`);
