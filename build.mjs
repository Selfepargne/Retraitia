// ════════════════════════════════════════════════════════════════════════
//  build.mjs — ORCHESTRATEUR retraitia
//  Ne contient AUCUNE logique métier. Séquence uniquement, dans l'ordre :
//    1. build-metiers.mjs   (pages métier — comportement inchangé)
//    2. build-caisses.mjs   (pages caisse — squelette pour l'instant)
//    3. build-sitemap.mjs   (sitemap.xml — seul écrivain, à partir des
//                             manifestes produits par les deux builders)
//  Lance: node build.mjs
//  Chaque builder reste exécutable seul (node build-metiers.mjs, etc.) —
//  build.mjs ne fait qu'automatiser l'enchaînement dans le bon ordre.
//  Aucune dépendance externe.
// ════════════════════════════════════════════════════════════════════════
import { execFileSync } from 'node:child_process';

const STEPS = ['build-metiers.mjs', 'build-caisses.mjs', 'build-sitemap.mjs'];

for (const step of STEPS) {
  console.log(`\n▶ ${step}`);
  try {
    execFileSync(process.execPath, [step], { stdio: 'inherit' });
  } catch (err) {
    console.error(`✗ Échec de ${step} — arrêt du build.`);
    process.exitCode = 1;
    break;
  }
}
