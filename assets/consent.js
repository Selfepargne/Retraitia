/* ════════════════════════════════════════════════════════════════════════
   consent.js — CONSENTEMENT & CHARGEMENT DE GA4
   ────────────────────────────────────────────────────────────────────────
   Un seul fichier, chargé sur TOUTES les pages, qui porte :
     • le mode Consentement v2 de Google (obligatoire dans l'EEE) ;
     • le bandeau, son style et son stockage ;
     • le chargement conditionnel de GA4.

   ── LE DÉFAUT QU'IL CORRIGE ───────────────────────────────────────────
   Le bandeau n'existait que sur 4 pages sur 39. Les 25 pages métier, les
   9 pages caisse et /retraite appelaient gtag('config') sans condition :
   un visiteur ayant cliqué « Refuser » sur l'accueil était quand même
   mesuré dès qu'il ouvrait une page métier.

   Ce sont précisément les pages où le trafic publicitaire va atterrir.

   ── POURQUOI LE MODE CONSENTEMENT v2, ET PAS UN SIMPLE if ────────────
   Bloquer le script suffit à être conforme, mais fait perdre toute
   information sur les visiteurs qui refusent. Le mode Consentement, lui,
   charge GA4 en état « refusé » : aucun cookie n'est déposé, et Google
   reçoit un signal anonyme qui lui permet de MODÉLISER les conversions
   manquantes.

   Sans lui, pour un annonceur européen : les listes de remarketing ne se
   remplissent plus, le Smart Bidding perd des signaux, et la modélisation
   des conversions cesse de fonctionner. Ce n'est pas qu'une question de
   droit, c'est une question de performance publicitaire.

   ── L'ORDRE DE CHARGEMENT EST CRITIQUE ────────────────────────────────
       1. consent.js   ← consent 'default' AVANT toute mesure
       2. tracking.js  ← enveloppe gtag, ajoute les dimensions
   Inverser les deux ferait partir des événements avant que l'état de
   consentement soit connu — donc avec les cookies déjà posés.
   ════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var GA_ID = 'G-X4RQ7ZNLB4';
  var CONSENT_KEY = 'retraitia_cookie_consent';
  var POLICY_URL = '/confidentialite#cookies';

  /* ══ 1. AMORÇAGE gtag ════════════════════════════════════════════════
     Repris tel quel des pages : dataLayer plus une fonction qui empile.
     Il doit exister AVANT l'appel de consentement ci-dessous.           */
  window.dataLayer = window.dataLayer || [];
  if (typeof window.gtag !== 'function') {
    window.gtag = function () { window.dataLayer.push(arguments); };
  }

  function stored() {
    try { return window.localStorage.getItem(CONSENT_KEY); } catch (e) { return null; }
  }

  /* ══ 2. ÉTAT PAR DÉFAUT — REFUSÉ ═════════════════════════════════════
     Posé immédiatement, avant tout `config`. Tant que le visiteur n'a pas
     tranché, Google ne dépose aucun cookie et ne conserve aucun
     identifiant publicitaire.

     `wait_for_update` laisse 500 ms au navigateur pour lire le choix déjà
     enregistré : sans ce délai, un visiteur qui a accepté hier verrait sa
     première page partir en « refusé », puis basculer — et le page_view
     serait perdu.                                                        */
  var known = stored();
  var granted = known === 'accepted';

  window.gtag('consent', 'default', {
    ad_storage:            'denied',
    ad_user_data:          'denied',
    ad_personalization:    'denied',
    analytics_storage:     'denied',
    functionality_storage: 'granted',   /* strictement nécessaire */
    security_storage:      'granted',   /* strictement nécessaire */
    wait_for_update: 500
  });

  /* ══ 3. CHARGEMENT DE GA4 ════════════════════════════════════════════
     Chargé dans TOUS les cas, y compris en refus.

     C'est le cœur du mode Consentement : la balise s'exécute mais, en
     état refusé, ne pose aucun cookie et n'envoie que des signaux sans
     identifiant. Ne pas la charger du tout reviendrait à se priver de la
     modélisation — pour un gain de conformité nul, puisque l'absence de
     cookie est déjà obtenue.                                             */
  var loaded = false;
  function loadGA4() {
    if (loaded) return;
    loaded = true;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    window.gtag('js', new Date());
    window.gtag('config', GA_ID);
  }

  function grant() {
    window.gtag('consent', 'update', {
      ad_storage:         'granted',
      ad_user_data:       'granted',
      ad_personalization: 'granted',
      analytics_storage:  'granted'
    });
  }

  if (granted) grant();
  loadGA4();

  /* ══ 4. LE BANDEAU ═══════════════════════════════════════════════════
     Style injecté par le script : aucune page n'a de CSS à recopier, et
     le bandeau ne peut pas diverger d'une page à l'autre.

     « Refuser » a le MÊME poids visuel que « Accepter ». La CNIL l'exige :
     un refus rendu plus difficile qu'une acceptation vicie le
     consentement, qui doit être libre.                                   */
  var CSS =
    '.rtc-banner{position:fixed;left:0;right:0;bottom:0;z-index:9999;' +
    'background:#fff;border-top:1px solid #e5e7f0;box-shadow:0 -4px 24px rgba(0,0,0,.08);' +
    'padding:16px 24px;display:none;align-items:center;justify-content:space-between;' +
    'gap:24px;flex-wrap:wrap;font:400 13px/1.6 "DM Sans",system-ui,sans-serif;color:#1e2440}' +
    '.rtc-banner.rtc-open{display:flex}' +
    '.rtc-text{flex:1 1 420px;max-width:760px}' +
    '.rtc-text a{color:#8931ed;text-decoration:underline}' +
    '.rtc-actions{display:flex;gap:10px;flex-shrink:0}' +
    '.rtc-btn{border:none;cursor:pointer;padding:10px 20px;border-radius:8px;' +
    'font:600 13px "DM Sans",system-ui,sans-serif;transition:opacity .15s}' +
    '.rtc-btn:hover{opacity:.85}' +
    '.rtc-accept{background:#8931ed;color:#fff}' +
    '.rtc-refuse{background:#fff;color:#1e2440;border:1px solid #ced5f3}' +
    '.rtc-link{position:fixed;left:12px;bottom:12px;z-index:9998;font:400 11px "DM Sans",sans-serif;' +
    'color:#55608b;background:#fff;border:1px solid #e5e7f0;border-radius:6px;padding:4px 9px;' +
    'cursor:pointer;opacity:.6}' +
    '.rtc-link:hover{opacity:1}' +
    '@media(max-width:640px){.rtc-banner{padding:14px 16px;gap:14px}' +
    '.rtc-actions{width:100%}.rtc-btn{flex:1}}';

  function injectStyle() {
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function buildBanner() {
    var el = document.createElement('div');
    el.className = 'rtc-banner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Consentement aux cookies');
    el.innerHTML =
      '<div class="rtc-text">Nous déposons des cookies de mesure d\'audience ' +
      '(Google Analytics) pour comprendre comment ce site est utilisé et améliorer nos ' +
      'contenus. Ils ne sont posés qu\'avec votre accord et vous pouvez le retirer à tout ' +
      'moment. <a href="' + POLICY_URL + '">En savoir plus</a>.</div>' +
      '<div class="rtc-actions">' +
      '<button type="button" class="rtc-btn rtc-refuse">Refuser</button>' +
      '<button type="button" class="rtc-btn rtc-accept">Accepter</button>' +
      '</div>';
    return el;
  }

  /* Retirer son consentement doit être aussi simple que le donner : une
     pastille discrète, présente une fois le choix fait. Sans elle, le
     visiteur qui a accepté n'a plus aucun moyen de revenir dessus. */
  function buildReopen() {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'rtc-link';
    el.textContent = 'Cookies';
    return el;
  }

  function decide(accepted) {
    try { window.localStorage.setItem(CONSENT_KEY, accepted ? 'accepted' : 'refused'); } catch (e) {}
    if (accepted) grant();
    else {
      window.gtag('consent', 'update', {
        ad_storage: 'denied', ad_user_data: 'denied',
        ad_personalization: 'denied', analytics_storage: 'denied'
      });
    }
  }

  function mount() {
    injectStyle();

    var banner = buildBanner();
    var reopen = buildReopen();
    document.body.appendChild(banner);
    document.body.appendChild(reopen);

    function open()  { banner.classList.add('rtc-open');    reopen.style.display = 'none'; }
    function close() { banner.classList.remove('rtc-open'); reopen.style.display = ''; }

    banner.querySelector('.rtc-accept').addEventListener('click', function () {
      decide(true); close();
    });
    banner.querySelector('.rtc-refuse').addEventListener('click', function () {
      decide(false); close();
    });
    reopen.addEventListener('click', open);

    if (known === 'accepted' || known === 'refused') close();
    else open();

    /* Ouvrir le bandeau depuis n'importe quel lien de la page — utile
       dans les mentions légales et le pied de page. */
    window.RetraitiaConsent = {
      open: open,
      status: function () { return stored() || 'unknown'; }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
