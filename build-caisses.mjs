// ════════════════════════════════════════════════════════════════════════
//  build-caisses.mjs — USINE À PAGES CAISSES retraitia
//  ÉTAPE 2 / 3 : génération réelle, pilotée à 100 % par les données.
//  Lit  : _template-caisse.html + caisses.json + professions.json (lecture
//         seule, pour reconstruire automatiquement les professions affiliées
//         — aucune donnée dupliquée entre les deux fichiers JSON).
//  Écrit: ./retraite-<slug-caisse>.html (à la racine, même convention que
//         les pages métier) + .manifest-caisses.json (slugs générés).
//  Lance: node build-caisses.mjs
//  Ce script boucle sur TOUTES les entrées de caisses.json, sans aucun code
//  spécifique à une caisse en particulier : avec une seule entrée dans le
//  fichier (CARPIMKO), une seule page est produite. Ajouter les 8 autres
//  caisses ne demandera aucune modification de ce fichier.
//  Aucune dépendance externe. Copie locale volontaire des petits helpers
//  (svg/fill/cap) : pas de lib/ partagée avec build-metiers.mjs, pour ne
//  prendre aucun risque sur le silo métier existant.
// ════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'node:fs';

// ── 1. Configuration ─────────────────────────────────────────────────────
const BASE_URL = 'https://retraitia.com';
const OUT_DIR  = '.'; // racine, même convention que les pages métier (retraite-<slug>.html)

// ── 2. Petite bibliothèque d'icônes — copie locale (cf. note en tête) ───
const ICONS = {
  shield:      '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  clock:       '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  euro:        '<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  building:    '<path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="M9 21v-6h6v6"/>',
  bars:        '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6" rx="1"/><rect x="12.5" y="7" width="3" height="10" rx="1"/><rect x="18" y="13" width="3" height="4" rx="1"/>',
  stethoscope: '<path d="M4.5 3v6a4.5 4.5 0 0 0 9 0V3"/><path d="M13.5 9v3a5.5 5.5 0 0 0 11 0"/><circle cx="19.5" cy="6" r="1.5"/>',
  arrowRight:  '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  clockAlert:  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chartdown:   '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
  trenddown:   '<path d="M22 17 13.5 8.5 8.5 13.5 2 7"/><path d="M16 17h6v-6"/>',
  alert:       '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};
const svg = (name, size = 22) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.shield}</svg>`;

const PROF_ICONS  = ['stethoscope', 'shield', 'building', 'bars', 'euro', 'clock'];
const ERROR_ICONS = ['alert', 'chartdown', 'trenddown', 'euro', 'clockAlert', 'bars'];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// ── 3. Générateurs de blocs HTML, tous pilotés par les données ──────────
function chiffresClesHtml(items) {
  return '\n' + items.map(c => `      <div class="fact-card">
        <div class="fact-ico">${svg('shield')}</div>
        <div class="fact-label">${c.label}</div>
        <div class="fact-value">${c.url ? `<a href="${c.url}" target="_blank" rel="noopener noreferrer nofollow">${c.value} ↗</a>` : c.value}</div>
        <div class="fact-note">${c.note}</div>
      </div>`).join('\n') + '\n    ';
}

function heroBulletsHtml(bullets) {
  return bullets.map(b => `<span>${b}</span>`).join('\n      ');
}

function fonctionnementCardsHtml(items) {
  return '\n' + items.map(f => `      <div class="fonct-card">
        <h3>${f.titre}</h3>
        <p>${f.texte}</p>
      </div>`).join('\n') + '\n    ';
}

function erreursCardsHtml(items) {
  return '\n' + items.map((e, i) => `      <div class="erreur-card">
        <div class="erreur-ico">${svg(ERROR_ICONS[i % ERROR_ICONS.length])}</div>
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

// SEULE section qui lit professions.json. Rien n'est stocké dans
// caisses.json : le lien caisse → métiers est reconstruit à chaque build.
// Cartes premium : nom du métier, courte description générique (composée à
// partir des champs déjà existants de professions.json, aucun champ ajouté),
// pension moyenne, et bouton dédié « Voir le guide ».
function professionsCardsHtml(affiliatedProfessions) {
  if (!affiliatedProfessions.length) {
    return '\n      <p style="text-align:center;color:var(--text-muted);">Aucune profession affiliée renseignée pour le moment.</p>\n    ';
  }
  return '\n' + affiliatedProfessions.map((p, i) => `      <div class="why-card profession-card">
        <div class="why-ico">${svg(PROF_ICONS[i % PROF_ICONS.length])}</div>
        <h3>${cap(p.professionLong)}</h3>
        <p>Âge légal, pension moyenne et leviers d'optimisation propres aux ${p.professionLong}.</p>
        <div class="profession-pension">Pension moyenne : ${p.pensionMoyenne}</div>
        <a class="profession-btn" href="/${p.slug}">Voir le guide ${svg('arrowRight', 15)}</a>
      </div>`).join('\n') + '\n    ';
}

// SEULE section qui lit caisses.json en dehors de l'entrée courante.
// Structure prête pour 9 caisses ; avec une seule entrée aujourd'hui,
// affiche un message d'attente neutre plutôt qu'un bloc vide.
function autresCaissesHtml(allCaisses, currentKey) {
  const autres = allCaisses.filter(c => c.key !== currentKey);
  if (!autres.length) {
    return '<p class="autres-caisses-empty">Les autres caisses de retraite seront bientôt disponibles.</p>';
  }
  return `<div class="autres-caisses-grid">\n` + autres.map(c => `      <a class="autre-caisse-card" href="/${c.slug}">
        <span>${c.nom}</span>
        ${svg('arrowRight', 18)}
      </a>`).join('\n') + '\n    </div>';
}

// ── 4. Générateurs de schémas JSON-LD ───────────────────────────────────
function faqSchema(items) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a }
    }))
  };
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n</script>`;
}

function breadcrumbSchema(c) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Accueil',       item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: 'Guides retraite', item: `${BASE_URL}/retraite` },
      { '@type': 'ListItem', position: 3, name: c.nomLong,        item: `${BASE_URL}/${c.slug}` }
    ]
  };
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n</script>`;
}

// ── 5. Remplacement sûr des tokens du template (fill()) ─────────────────
function fill(tpl, map) {
  let out = tpl;
  for (const [k, v] of Object.entries(map)) out = out.split(`{{${k}}}`).join(v);
  return out;
}

// ── 6. Build ─────────────────────────────────────────────────────────────
const template   = readFileSync('_template-caisse.html', 'utf-8');
const caisses     = JSON.parse(readFileSync('caisses.json', 'utf-8'));
const professions = JSON.parse(readFileSync('professions.json', 'utf-8')); // lecture seule — source unique de vérité

const generatedSlugs = [];

for (const c of caisses) {
  const affiliated = professions.filter(p => p.regime === c.key);

  const map = {
    // SEO / meta
    TITLE:        c.meta.title,
    META_DESC:    c.meta.description,
    OG_TITLE:     c.meta.ogTitle,
    OG_DESC:      c.meta.ogDesc,
    OG_IMAGE:     c.meta.ogImage || `${BASE_URL}/og/${c.slug}.jpg`,
    CANONICAL:    `${BASE_URL}/${c.slug}`,
    // schémas
    BREADCRUMB_SCHEMA: breadcrumbSchema(c),
    FAQ_SCHEMA:        faqSchema(c.faq),
    // identité
    NOM:      c.nom,
    NOM_LONG: c.nomLong,
    SLUG:     c.slug,
    KEY:      c.key,
    UPDATE_DATE: c.updateDate,
    // hero — orienté conversion
    HERO_BADGE:     c.hero.badge,
    HERO_TITRE:     c.hero.titre,
    HERO_SOUSTITRE: c.hero.sousTitre,
    HERO_CTA_LABEL: c.hero.ctaLabel,
    HERO_BULLETS:   heroBulletsHtml(c.hero.bullets),
    HERO_CARD_PROFESSIONS:          c.hero.carte.professionsLabel,
    HERO_CARD_FONCTIONNEMENT:       c.hero.carte.fonctionnementLabel,
    HERO_CARD_TYPE_REGIME:          c.hero.carte.typeRegimeLabel,
    HERO_CARD_LIEN_OFFICIEL_LABEL:  c.hero.carte.lienOfficielLabel,
    HERO_CARD_LIEN_OFFICIEL_URL:    c.hero.carte.lienOfficielUrl,
    // en un coup d'œil
    GLANCE_PUBLIC:              c.coupOeil.publicConcerne,
    GLANCE_FONCTIONNEMENT:      c.coupOeil.fonctionnement,
    GLANCE_TYPE:                c.coupOeil.typeRetraite,
    GLANCE_REVERSION:           c.coupOeil.reversion,
    GLANCE_CREATION:            c.coupOeil.creation,
    GLANCE_SITE_OFFICIEL_LABEL: c.coupOeil.siteOfficielLabel,
    GLANCE_SITE_OFFICIEL_URL:   c.coupOeil.siteOfficielUrl,
    // présentation
    PRESENTATION_HTML: c.presentationHtml,
    // fonctionnement + chiffres clés + erreurs fréquentes
    FONCTIONNEMENT_CARDS: fonctionnementCardsHtml(c.fonctionnementCartes),
    CHIFFRES_CLES:        chiffresClesHtml(c.chiffresCles),
    ERREURS_CARDS:        erreursCardsHtml(c.erreursFrequentes),
    // maillage — reconstruit depuis professions.json et caisses.json
    PROFESSIONS_CARDS: professionsCardsHtml(affiliated),
    AUTRES_CAISSES:    autresCaissesHtml(caisses, c.key),
    // faq + pourquoi préparer + cta
    FAQ_SUB:   c.faqSub,
    FAQ_HTML:  faqHtml(c.faq),
    POURQUOI_PREPARER_HTML: c.pourquoiPreparerHtml,
    CTA_TITLE: c.ctaTitle,
  };

  let html = fill(template, map);

  const left = [...new Set(html.match(/\{\{[A-Z0-9_]+\}\}/g) || [])];
  if (left.length) { console.error(`✗ ${c.slug} — tokens non remplis :`, left); process.exitCode = 1; continue; }

  if (!affiliated.length) {
    console.warn(`⚠ ${c.slug} — aucune profession affiliée trouvée pour la clé "${c.key}" (vérifier professions.json)`);
  }

  writeFileSync(`${OUT_DIR}/${c.slug}.html`, html);
  generatedSlugs.push(c.slug);
  console.log(`✓ ${OUT_DIR}/${c.slug}.html  (${(html.length / 1024).toFixed(0)} Ko, ${affiliated.length} métier(s) affilié(s))`);
}

// ── 7. Manifeste (slugs générés — le sitemap est fusionné ailleurs, par ─
//      build-sitemap.mjs, seul responsable de sitemap.xml) ───────────────
writeFileSync('.manifest-caisses.json', JSON.stringify({ slugs: generatedSlugs }, null, 2));
console.log('✓ .manifest-caisses.json écrit');

console.log(`\n${generatedSlugs.length} page(s) caisse générée(s) dans ${OUT_DIR}/`);
