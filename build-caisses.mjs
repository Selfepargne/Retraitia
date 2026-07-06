// ════════════════════════════════════════════════════════════════════════
//  build-caisses.mjs — USINE À PAGES CAISSES retraitia (silo caisses)
//  ÉTAPE 1 / 3 : squelette uniquement.
//  Ce script ne génère ENCORE AUCUNE page. Il se contente de :
//    1. vérifier qu'il peut s'exécuter sans erreur,
//    2. écrire un manifeste vide (.manifest-caisses.json), pour que
//       build-sitemap.mjs puisse déjà s'exécuter sans erreur lui aussi
//       en attendant l'étape 2 (génération réelle des pages caisse).
//  Rien ici ne lit ni ne modifie professions.json, caisses.json, ou un
//  quelconque template — cela viendra à l'étape suivante.
// ════════════════════════════════════════════════════════════════════════
import { writeFileSync } from 'node:fs';

// ── Manifeste (vide pour l'instant — aucune page caisse générée) ────────
const manifest = { slugs: [] };
writeFileSync('.manifest-caisses.json', JSON.stringify(manifest, null, 2));
console.log('✓ .manifest-caisses.json écrit (vide — aucune page caisse générée à ce stade)');
console.log('0 page(s) caisse générée(s) — squelette de builder uniquement (étape 1/3)');
