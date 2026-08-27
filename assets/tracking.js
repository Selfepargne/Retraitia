/* ════════════════════════════════════════════════════════════════════════
   tracking.js — CONTEXTE D'ACQUISITION retraitia
   ────────────────────────────────────────────────────────────────────────
   Un seul module, chargé sur toutes les pages. Il répond à une question
   que le site ne savait pas répondre : QUI est arrivé, D'OÙ, et SUR QUEL
   MÉTIER — et il fait suivre cette réponse jusqu'au bout du parcours.

   ── LE DÉFAUT QU'IL CORRIGE ───────────────────────────────────────────
   Les pages métier envoyaient vers /simulateur?src=metier-pharmacien.
   Le simulateur ne lisait jamais ce paramètre. Résultat : les trois
   événements qui comptent — simulation_complete, lead_submit, rdv_click —
   ne portaient ni profession, ni canal. On savait que 200 pharmaciens
   avaient lu la page. On ne savait pas si l'un d'eux avait simulé.

   ── CE QU'IL FAIT, DANS L'ORDRE ───────────────────────────────────────
   1. lit utm_*, gclid, ?src=, le référent et la page d'atterrissage ;
   2. en déduit canal, profession, caisse, statut, type et page d'entrée ;
   3. conserve TROIS contextes — le premier (90 j), le courant, et
      l'attribution publicitaire gelée à l'entrée dans la session ;
   4. enveloppe gtag pour que TOUS les événements portent les dimensions ;
   5. expose window.RetraitiaTracking pour le simulateur.

   ── POURQUOI UNE ENVELOPPE PLUTÔT QUE 13 APPELS MODIFIÉS ──────────────
   Ajouter les paramètres à la main dans chaque gtag('event', …) marche
   jusqu'au quatorzième, où quelqu'un oubliera. L'enveloppe rend
   l'exhaustivité structurelle : un événement écrit demain porte les
   dimensions sans que son auteur ait à y penser.

   ── AUCUNE DÉPENDANCE. AUCUNE DONNÉE PERSONNELLE. ─────────────────────
   Ni nom, ni e-mail, ni téléphone ne transitent par ici : les conditions
   d'utilisation de Google l'interdisent, et un compte peut être fermé
   pour ça. Ces données-là vont au CRM, par un autre chemin.
   ════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ══ 1. RÉFÉRENTIEL MÉTIER ═══════════════════════════════════════════
     Miroir de professions.json, réduit à ce dont la mesure a besoin.

     Dupliqué ici à dessein : le site est statique, il n'y a pas de
     mécanisme d'import, et charger 280 Ko de JSON pour lire deux champs
     serait absurde. La contrepartie est de tenir cette table à jour —
     d'où le contrôle de cohérence en fin de fichier, qui hurle dans la
     console si une clé du référentiel manque ici.                        */
  var PROFESSIONS = {
    'pharmacien':              ['CAVP',     'tns_cnavpl'],
    'medecin':                 ['CARMF',    'tns_cnavpl'],
    'kinesitherapeute':        ['CARPIMKO', 'tns_cnavpl'],
    'infirmier-liberal':       ['CARPIMKO', 'tns_cnavpl'],
    'orthophoniste':           ['CARPIMKO', 'tns_cnavpl'],
    'orthoptiste':             ['CARPIMKO', 'tns_cnavpl'],
    'podologue':               ['CARPIMKO', 'tns_cnavpl'],
    'chirurgien-dentiste':     ['CARCDSF',  'tns_cnavpl'],
    'sage-femme':              ['CARCDSF',  'tns_cnavpl'],
    'veterinaire':             ['CARPV',    'tns_cnavpl'],
    'avocat':                  ['CNBF',     'tns_cnavpl'],
    'expert-comptable':        ['CAVEC',    'tns_cnavpl'],
    'commissaire-aux-comptes': ['CAVEC',    'tns_cnavpl'],
    'architecte':              ['CIPAV',    'tns_cnavpl'],
    'consultant-liberal':      ['SSI',      'tns_ssi'],
    'artisan-batiment':        ['SSI',      'tns_ssi'],
    'electricien':             ['SSI',      'tns_ssi'],
    'plombier':                ['SSI',      'tns_ssi'],
    'restaurateur':            ['SSI',      'tns_ssi'],
    'commercant':              ['SSI',      'tns_ssi'],
    'developpeur-freelance':   ['SSI',      'tns_ssi'],
    'consultant-it':           ['SSI',      'tns_ssi'],
    'graphiste':               ['SSI',      'tns_ssi'],
    'coach-formateur':         ['SSI',      'tns_ssi'],
    'agent-immobilier':        ['SSI',      'tns_ssi']
  };

  var CAISSES = ['CARPIMKO','CARMF','CAVP','CARCDSF','CNBF','CAVEC','CIPAV','SSI','CARPV'];

  /* ══ 2. STOCKAGE ═════════════════════════════════════════════════════
     Deux contextes, deux durées de vie, deux usages :

     • PREMIER passage (localStorage, 90 jours) — c'est LUI qui décidera
       de la source du lead dans le CRM. Un prospect qui découvre en SEO,
       revient par une annonce et signe trois semaines plus tard doit
       rester attribué au SEO : c'est la règle du premier contact, et
       elle sera la même des deux côtés.

     • COURANT (sessionStorage) — le parcours d'aujourd'hui. C'est lui qui
       porte la profession de la page qu'on vient de lire, et qui la fait
       suivre jusqu'au simulateur.

     • ATTRIBUTION (sessionStorage, §7) — les paramètres publicitaires bruts,
       gelés à la première page de la session. C'est le seul des trois qui
       quitte le navigateur : il part avec le lead. Volontairement séparé
       des deux autres, parce qu'il n'a pas la même règle d'écriture — et
       parce que toucher à ctx_last casserait des dimensions GA4 en place. */
  var K_FIRST = 'retraitia_ctx_first';
  var K_LAST  = 'retraitia_ctx_last';
  var K_ATTR  = 'retraitia_attr';
  var FIRST_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  function read(store, key) {
    try {
      var raw = window[store].getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }   /* navigation privée, stockage bloqué */
  }

  function write(store, key, value) {
    try { window[store].setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  /* ══ 3. LECTURE DE L'URL ═════════════════════════════════════════════ */
  function params() {
    try { return new URLSearchParams(window.location.search); }
    catch (e) { return { get: function () { return null; } }; }
  }

  function clean(value) {
    if (!value) return '';
    /* 100 caractères : la limite d'une valeur de dimension GA4. Au-delà,
       Google tronque à la collecte — autant le faire nous-mêmes, et
       proprement. */
    return String(value).trim().toLowerCase().slice(0, 100);
  }

  /* ══ 4. DÉDUCTION DU CANAL ═══════════════════════════════════════════
     L'ordre des tests n'est pas indifférent : gclid en premier, parce
     qu'il est le seul signal que l'utilisateur ne peut pas fabriquer et
     que Google ajoute lui-même. Une annonce mal balisée en utm reste
     donc correctement attribuée.                                        */
  var SEARCH_ENGINES = /google\.|bing\.|yahoo\.|duckduckgo\.|ecosia\.|qwant\./i;

  function deriveCanal(p, referrer) {
    var source = clean(p.get('utm_source'));
    var medium = clean(p.get('utm_medium'));
    var paid   = /cpc|ppc|paid|ads/.test(medium);

    if (p.get('gclid')) return 'google_ads';
    if (source === 'google' && paid) return 'google_ads';
    if (medium === 'email' || source === 'email') return 'email';
    if (/facebook|instagram|meta/.test(source) && paid) return 'meta_ads';
    if (/linkedin/.test(source) && paid) return 'linkedin_ads';

    /* Un utm_source non publicitaire est une campagne référente : un
       partenaire, une newsletter externe, un lien sponsorisé éditorial. */
    if (source) return 'referral';

    if (!referrer) return 'direct';
    try {
      var host = new URL(referrer).hostname;
      if (host === window.location.hostname) return '';   /* navigation interne */
      if (SEARCH_ENGINES.test(host)) return 'seo';
      return 'referral';
    } catch (e) { return 'direct'; }
  }

  /* ══ 5. DÉDUCTION DU MÉTIER ══════════════════════════════════════════
     Trois sources, par ordre de fiabilité décroissante :
       a) l'objet PAGE, injecté par les builders — la page SAIT ce qu'elle est ;
       b) le paramètre ?src=metier-x / ?src=caisse-y, déjà émis par les CTA ;
       c) le chemin de l'URL, en dernier recours.

     Le slug est la clé : tous valent « retraite-<clé> », côté métier
     comme côté caisse. C'est ce qui permet de n'avoir qu'un vocabulaire,
     de la page au CRM.                                                   */
  function keyFromSlug(slug) {
    return clean(slug).replace(/^retraite-/, '');
  }

  function deriveSubject(p) {
    var out = { profession: '', caisse: '', statut_regime: '', entry_type: '', entry_slug: '' };

    /* (a) La page se déclare elle-même. */
    var PAGE = window.PAGE;
    if (PAGE && typeof PAGE === 'object') {
      if (PAGE.slug && PAGE.profession) {
        var pk = keyFromSlug(PAGE.slug);
        if (PROFESSIONS[pk]) {
          out.profession = pk;
          out.caisse = PROFESSIONS[pk][0];
          out.statut_regime = PROFESSIONS[pk][1];
          out.entry_type = 'metier';
          out.entry_slug = clean(PAGE.slug);
          return out;
        }
      }
      if (PAGE.slug && PAGE.caisse) {
        out.caisse = String(PAGE.caisse).toUpperCase().slice(0, 100);
        out.entry_type = 'caisse';
        out.entry_slug = clean(PAGE.slug);
        return out;
      }
    }

    /* (b) Le paramètre src, transmis par les CTA des landings. */
    var src = clean(p.get('src'));
    var m = /^metier-(.+)$/.exec(src);
    if (m && PROFESSIONS[m[1]]) {
      out.profession = m[1];
      out.caisse = PROFESSIONS[m[1]][0];
      out.statut_regime = PROFESSIONS[m[1]][1];
      out.entry_type = 'metier';
      out.entry_slug = 'retraite-' + m[1];
      return out;
    }
    var c = /^caisse-(.+)$/.exec(src);
    if (c && CAISSES.indexOf(c[1].toUpperCase()) !== -1) {
      out.caisse = c[1].toUpperCase();
      out.entry_type = 'caisse';
      out.entry_slug = 'retraite-' + c[1];
      return out;
    }

    /* (c) Le chemin, pour une arrivée directe sur une landing. */
    var path = clean(window.location.pathname).replace(/^\/+|\/+$/g, '');
    var pathKey = keyFromSlug(path);
    if (PROFESSIONS[pathKey]) {
      out.profession = pathKey;
      out.caisse = PROFESSIONS[pathKey][0];
      out.statut_regime = PROFESSIONS[pathKey][1];
      out.entry_type = 'metier';
      out.entry_slug = path;
      return out;
    }
    if (CAISSES.indexOf(pathKey.toUpperCase()) !== -1) {
      out.caisse = pathKey.toUpperCase();
      out.entry_type = 'caisse';
      out.entry_slug = path;
      return out;
    }

    /* Ni métier ni caisse : un hub (accueil, /retraite, /per) ou le
       simulateur atteint directement. */
    out.entry_type = path === '' || /^(retraite|per)$/.test(path) ? 'hub' : 'direct';
    out.entry_slug = path || 'accueil';
    return out;
  }

  /* ══ 6. CONSTRUCTION DU CONTEXTE ═════════════════════════════════════ */
  function build() {
    var p = params();
    var subject = deriveSubject(p);
    var canal = deriveCanal(p, document.referrer);

    return {
      ts: Date.now(),
      canal: canal,
      campagne: clean(p.get('utm_campaign')),
      /* gclid stocké mais JAMAIS envoyé à GA4 : Google le gère nativement.
         Il servira au CRM, pour remonter la valeur du contrat signé à Ads. */
      gclid: p.get('gclid') || '',
      profession: subject.profession,
      caisse: subject.caisse,
      statut_regime: subject.statut_regime,
      entry_type: subject.entry_type,
      entry_slug: subject.entry_slug
    };
  }

  var current = build();

  /* Premier passage : posé une fois, jamais réécrit tant qu'il est valide.
     C'est le socle de la règle du premier contact. */
  var first = read('localStorage', K_FIRST);
  if (!first || !first.ts || (Date.now() - first.ts) > FIRST_TTL_MS) {
    first = current;
    write('localStorage', K_FIRST, first);
  }

  /* Contexte courant : on ne l'écrase que s'il apporte quelque chose. Une
     navigation interne (canal vide, pas de métier) ne doit pas effacer la
     page métier d'où l'on vient — sinon le simulateur perdrait tout. */
  var last = read('sessionStorage', K_LAST);
  var meaningful = current.profession || current.caisse || current.canal ||
                   current.campagne || current.entry_type === 'metier';
  if (!last || meaningful) {
    last = last && !meaningful ? last : merge(last, current);
    write('sessionStorage', K_LAST, last);
  }

  function merge(previous, next) {
    if (!previous) return next;
    var out = {};
    for (var k in next) {
      /* Une valeur vide n'écrase jamais une valeur connue : c'est ce qui
         permet au simulateur d'hériter du métier de la page précédente. */
      out[k] = next[k] || previous[k] || '';
    }
    out.ts = next.ts;
    return out;
  }

  /* ══ 7. ATTRIBUTION PUBLICITAIRE — LE GEL ════════════════════════════
     Les cinq paramètres que l'annonceur a payés, plus la page où le
     visiteur a atterri. Ce bloc est destiné à sortir du navigateur : il
     accompagne le lead jusqu'au brief conseiller, qui est aujourd'hui le
     chemin par lequel l'attribution rejoint le CRM.

     ── GEL ATOMIQUE, PAS PREMIER-ARRIVÉ PAR CHAMP ────────────────────
     L'objet entier est écrit une fois, à la première page de la session,
     puis plus jamais. On ne complète pas un champ vide plus tard.

     La raison est une question de vérité, pas de simplicité : si un gclid
     arrivé au troisième clic venait remplir un champ laissé vide au
     premier, il se retrouverait associé à la landing d'une AUTRE visite.
     Le tuple raconterait une arrivée qui n'a jamais eu lieu. Un champ
     vide est une information ; un champ faux n'en est pas une.

     C'est aussi ce qui rend `landing_slug` fiable : figé avec le reste,
     il est la page d'ENTRÉE, jamais celle de conversion. Le simulateur
     n'écrase rien parce qu'il n'écrit rien.

     ── LA CASSE DU gclid ─────────────────────────────────────────────
     `clean()` passe en minuscules — correct pour un utm, destructeur pour
     un gclid, qui est sensible à la casse. Un gclid minusculé est rejeté
     à l'import des conversions hors ligne dans Google Ads : la valeur du
     contrat signé ne remonte jamais à la campagne qui l'a produit. D'où
     `rawParam()`, qui se contente de couper les espaces et de borner.    */

  /* 200 caractères : un gclid tourne autour de 90, mais Google en a
     allongé le format par le passé. Borner large plutôt que tronquer un
     identifiant, qui ne vaut rien s'il est incomplet. */
  function rawParam(p, name) {
    var v = p.get(name);
    return v ? String(v).trim().slice(0, 200) : '';
  }

  function buildAttribution(p) {
    var path = String(window.location.pathname || '')
                 .replace(/^\/+|\/+$/g, '')
                 .toLowerCase();
    return {
      ts:           Date.now(),
      gclid:        rawParam(p, 'gclid'),
      utm_source:   clean(p.get('utm_source')),
      utm_campaign: clean(p.get('utm_campaign')),
      utm_content:  clean(p.get('utm_content')),
      utm_term:     clean(p.get('utm_term')),
      landing_slug: path || 'accueil'
    };
  }

  /* Copie en mémoire : en navigation privée, `write` échoue en silence et
     `read` renverra null à la page suivante. Le gel est alors perdu d'une
     page à l'autre, mais le lead soumis DEPUIS cette page part quand même
     avec son attribution — c'est le cas qui compte. */
  var memAttr = read('sessionStorage', K_ATTR);
  if (!memAttr || !memAttr.ts) {
    memAttr = buildAttribution(params());
    write('sessionStorage', K_ATTR, memAttr);
  }

  /* ══ 8. LES DIMENSIONS ENVOYÉES ══════════════════════════════════════
     Le sujet vient du parcours courant : la profession de la page lue.
     Le canal vient du PREMIER passage : qui a payé pour cette personne.

     Mélanger les deux serait une erreur d'attribution. Quelqu'un arrivé
     par une annonce pharmacien puis passé sur la page médecin reste un
     visiteur acquis par la campagne pharmacien.                          */
  var enrichment = {};

  function refresh() {
    var ctx = read('sessionStorage', K_LAST) || current;
    enrichment = {
      profession:    ctx.profession    || '(none)',
      caisse:        ctx.caisse        || '(none)',
      statut_regime: ctx.statut_regime || '(none)',
      entry_type:    ctx.entry_type    || '(none)',
      entry_slug:    ctx.entry_slug    || '(none)',
      canal:         first.canal       || 'direct',
      campagne:      first.campagne    || '(none)'
    };
    for (var k in extra) if (extra[k]) enrichment[k] = extra[k];
  }

  /* Dimensions posées en cours de route par le simulateur (mode, tranches). */
  var extra = {};
  refresh();

  /* ══ 9. L'ENVELOPPE gtag ═════════════════════════════════════════════
     Le site déclare `function gtag(){ dataLayer.push(arguments) }` avant
     de charger ce fichier. On remplace la référence globale : les appels
     inline (onclick="gtag(…)") comme ceux des scripts de page passent
     désormais par ici.

     Les paramètres déjà présents dans l'appel GAGNENT sur les nôtres —
     un événement qui précise sa propre profession n'est pas écrasé.      */
  var native = window.gtag;
  if (typeof native === 'function') {
    window.gtag = function () {
      var args = Array.prototype.slice.call(arguments);
      if (args[0] === 'event') {
        var payload = {};
        for (var k in enrichment) payload[k] = enrichment[k];
        var given = args[2] || {};
        for (var g in given) payload[g] = given[g];
        args[2] = payload;
      }
      return native.apply(window, args);
    };
  }

  /* ══ 10. SURFACE PUBLIQUE ═════════════════════════════════════════════ */
  window.RetraitiaTracking = {
    /** Contexte du premier passage — celui que le CRM devra enregistrer. */
    first: function () { return read('localStorage', K_FIRST) || first; },
    /** Contexte du parcours courant. */
    current: function () { return read('sessionStorage', K_LAST) || current; },
    /** Dimensions telles qu'elles partent avec chaque événement. */
    dimensions: function () { var c = {}; for (var k in enrichment) c[k] = enrichment[k]; return c; },

    /**
     * Attribution publicitaire gelée à l'entrée dans la session (§7).
     * { ts, gclid, utm_source, utm_campaign, utm_content, utm_term, landing_slug }
     * Toujours un objet — jamais null : `landing_slug` vaut au minimum
     * « accueil », pour qu'un appelant n'ait pas à se protéger.
     */
    attribution: function () {
      var a = read('sessionStorage', K_ATTR) || memAttr;
      var c = {};
      for (var k in a) c[k] = a[k];
      return c;
    },

    /**
     * Enrichit le contexte depuis le simulateur.
     * Attendu : { mode, age, manque } — les tranches sont calculées ici,
     * pour que la règle de découpage vive à un seul endroit.
     */
    setSimulation: function (data) {
      data = data || {};
      if (data.mode)   extra.mode_simulation = clean(data.mode);
      if (data.age    != null) extra.tranche_age    = ageBand(data.age);
      if (data.manque != null) extra.tranche_manque = manqueBand(data.manque);
      refresh();
    }
  };

  /* Tranches plutôt que valeurs brutes : GA4 traite un nombre comme une
     métrique, pas comme un axe. On ne segmente pas sur « 52 ans », on
     segmente sur « 50-54 ». Les valeurs brutes continuent de partir par
     ailleurs, pour les moyennes. */
  function ageBand(age) {
    var a = Number(age);
    if (!isFinite(a) || a <= 0) return '(none)';
    if (a < 40) return '-40';
    if (a < 50) return '40-49';
    if (a < 55) return '50-54';
    if (a < 60) return '55-59';
    return '60+';
  }

  function manqueBand(manque) {
    var m = Math.abs(Number(manque));
    if (!isFinite(m)) return '(none)';
    if (m < 500)  return '-500';
    if (m < 1000) return '500-1000';
    if (m < 2000) return '1000-2000';
    return '2000+';
  }

  /* ══ 11. CONTRÔLE DE COHÉRENCE ═══════════════════════════════════════
     Le référentiel du §1 est une copie. Une copie diverge toujours.

     Si une page métier se charge et que sa clé est inconnue ici, la
     dimension partirait vide sans que rien ne le signale — le pire des
     défauts de mesure, celui qui ne se voit pas. On le dit dans la
     console, où le prochain développeur passera forcément.               */
  if (window.PAGE && window.PAGE.profession && window.PAGE.slug) {
    var check = keyFromSlug(window.PAGE.slug);
    if (!PROFESSIONS[check]) {
      console.warn(
        '[tracking] Métier « ' + check + ' » absent du référentiel de tracking.js. ' +
        'La profession ne sera pas mesurée. Ajoutez-le à la table PROFESSIONS.'
      );
    }
  }
})();
