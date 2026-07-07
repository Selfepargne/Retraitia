// ════════════════════════════════════════════════════════════════════════
//  build-sitemap.mjs — GÉNÉRATION UNIQUE DU SITEMAP retraitia
//  Lit  : .manifest-metiers.json + .manifest-caisses.json
//         (PAS professions.json, PAS caisses.json — responsabilité unique :
//         ce script ne connaît que des slugs déjà générés, pas leur contenu)
//  Écrit: sitemap.xml
//  Lance: node build-sitemap.mjs   (après build-metiers.mjs et build-caisses.mjs)
//  Aucune dépendance externe.
// ════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'node:fs';

// ── 1. Configuration (le SEUL endroit pour le domaine et les hubs fixes) ─
const BASE_URL = 'https://retraitia.com';
const HUB_URLS = [`${BASE_URL}/`, `${BASE_URL}/retraite`]; // un seul hub SEO : /retraite

// ── 2. Lecture des manifestes ────────────────────────────────────────────
function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`✗ Manifeste manquant : ${path}`);
      console.error('  → build-sitemap.mjs doit être exécuté après build-metiers.mjs ET build-caisses.mjs.');
      console.error('  → Lance "node build.mjs" (orchestrateur) plutôt que ce script isolément,');
      console.error('    ou exécute les builders manquants avant de relancer celui-ci.');
      process.exit(1);
    }
    throw err;
  }
}
const metiers = readManifest('.manifest-metiers.json');
const caisses = readManifest('.manifest-caisses.json');

// ── 3. Garde-fou : aucun slug ne doit exister dans les deux manifestes ──
//      (métiers et caisses partagent le même espace de noms de fichiers,
//      à la racine — cf. décision de renoncer à /caisses/ comme sous-dossier)
const doublons = metiers.slugs.filter(s => caisses.slugs.includes(s));
if (doublons.length) {
  console.error('✗ Collision de slugs entre métiers et caisses :', doublons);
  process.exitCode = 1;
}

// ── 4. Construction et écriture du sitemap ──────────────────────────────
const sitemapUrls = [
  ...HUB_URLS,
  ...metiers.slugs.map(s => `${BASE_URL}/${s}`),
  ...caisses.slugs.map(s => `${BASE_URL}/${s}`),
];
const sitemap =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  sitemapUrls.map(u => `  <url><loc>${u}</loc></url>`).join('\n') +
  '\n</urlset>\n';
writeFileSync('sitemap.xml', sitemap);

console.log(`✓ sitemap.xml généré (${metiers.slugs.length} métier(s) + ${caisses.slugs.length} caisse(s) + ${HUB_URLS.length} hub(s) = ${sitemapUrls.length} URL(s))`);
