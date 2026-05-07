/* dashboard-geral-trafego — landing-snippet.js
 *
 * Snippet auto-contido pra landing externa colar antes do redirect pro
 * gateway (Kirvano, Hotmart, Eduzz, Kiwify). Captura dados do browser do
 * user (cookies _fbc/_fbp + IP/UA implicitos no request) e manda pra
 * /api/checkout-prep do back, pra que o webhook posterior faca match e
 * dispare CAPI com match quality alto.
 *
 * INSTALACAO (1 tag):
 *   <script
 *     src="https://SEU-BACKEND/public/landing-snippet.js"
 *     data-product-slug="ebook-foo"
 *     data-api-base="https://SEU-BACKEND/api"
 *     defer></script>
 *
 * USO (qualquer um dos 3 modos):
 *
 * 1. Auto-intercept dos botoes/links de checkout (default):
 *    Marque o botao com data-checkout-link:
 *      <a data-checkout-link href="https://pay.kirvano.com/...">Comprar</a>
 *    O snippet intercepta o click, dispara prep + redireciona em ate 500ms.
 *
 * 2. Capturar email/phone de um form (opcional):
 *    Marque inputs:
 *      <input type="email" data-checkout-email>
 *      <input type="tel"   data-checkout-phone>
 *    Os valores sao enviados no prep se preenchidos no momento do click.
 *
 * 3. Modo programatico (SPA/React):
 *    window.LandingPrep.send({email, phone}).then(() => location.href = url);
 *
 * O snippet e idempotente: rechamar nao duplica registro porque cada call
 * cria CheckoutPrep novo com TTL 1h, e o webhook usa o mais recente por
 * (productId, email).
 *
 * MIT-style — copia, modifica, distribui sem creditos.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  if (!script) {
    console.warn("[landing-snippet] document.currentScript indisponivel — usar atributo manual");
    return;
  }

  var PRODUCT_SLUG = script.getAttribute("data-product-slug") || "";
  var API_BASE = (script.getAttribute("data-api-base") || "").replace(/\/$/, "");
  var REDIRECT_TIMEOUT_MS = parseInt(
    script.getAttribute("data-redirect-timeout") || "500",
    10
  );
  var DEBUG = script.getAttribute("data-debug") === "true";

  if (!PRODUCT_SLUG || !API_BASE) {
    console.warn("[landing-snippet] data-product-slug e data-api-base obrigatorios");
    return;
  }

  function log() {
    if (DEBUG) console.log.apply(console, ["[landing-prep]"].concat([].slice.call(arguments)));
  }

  // ─────────────────────────────────────────────────────────────────
  // sessionId persistente (sessionStorage) — sobrevive a navegacao
  // entre paginas da landing mas zera ao fechar a aba.
  // ─────────────────────────────────────────────────────────────────
  function uuid4() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // fallback: pseudo-random RFC4122 v4
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getSessionId() {
    try {
      var key = "_lp_session";
      var existing = sessionStorage.getItem(key);
      if (existing && existing.length >= 8) return existing;
      var fresh = uuid4();
      sessionStorage.setItem(key, fresh);
      return fresh;
    } catch (e) {
      // Safari ITP / private mode: sessionStorage pode bloquear. Gera
      // um uuid efemero — pior caso, prep nao sera reusado, mas captura.
      return uuid4();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Captura cookies _fbc e _fbp setados pelo Pixel.
  // Se _fbc nao existir mas houver fbclid na query, monta no formato
  // exigido: "fb.1.<unix_ms>.<fbclid>".
  // ─────────────────────────────────────────────────────────────────
  function getCookie(name) {
    var match = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&") + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function getFbc() {
    var fbc = getCookie("_fbc");
    if (fbc) return fbc;
    try {
      var params = new URLSearchParams(location.search);
      var fbclid = params.get("fbclid");
      if (fbclid) return "fb.1." + Date.now() + "." + fbclid;
    } catch (e) {}
    return null;
  }

  function getFbp() {
    return getCookie("_fbp");
  }

  // ─────────────────────────────────────────────────────────────────
  // Captura email/phone de inputs marcados.
  // ─────────────────────────────────────────────────────────────────
  function readMarkedInput(selector) {
    var el = document.querySelector(selector);
    return el && typeof el.value === "string" ? el.value.trim() : "";
  }

  // ─────────────────────────────────────────────────────────────────
  // Envia o prep. Usa fetch com keepalive=true pra que sobreviva ao
  // redirect mesmo se a pagina trocar antes da resposta chegar.
  // ─────────────────────────────────────────────────────────────────
  function send(extraData) {
    extraData = extraData || {};
    var body = {
      sessionId: getSessionId(),
      productSlug: PRODUCT_SLUG,
      email: extraData.email || readMarkedInput("[data-checkout-email]") || null,
      phone: extraData.phone || readMarkedInput("[data-checkout-phone]") || null,
      fbc: getFbc(),
      fbp: getFbp(),
      landingUrl: location.href,
    };
    log("send", body);

    var url = API_BASE + "/checkout-prep";
    try {
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true,
        credentials: "omit",
        mode: "cors",
      }).catch(function (err) {
        log("fetch error", err);
      });
    } catch (e) {
      log("send threw", e);
      return Promise.resolve();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Auto-intercept de cliques em <a data-checkout-link> ou
  // <button data-checkout-link>. Dispara prep e redireciona em ate
  // REDIRECT_TIMEOUT_MS, pra nao bloquear o user.
  // ─────────────────────────────────────────────────────────────────
  function interceptClicks() {
    document.addEventListener("click", function (ev) {
      var target = ev.target;
      if (!target) return;
      var link = target.closest && target.closest("[data-checkout-link]");
      if (!link) return;
      var href = link.getAttribute("href") || link.dataset.href;
      if (!href) return;

      ev.preventDefault();
      log("intercept click", href);

      var done = false;
      function go() {
        if (done) return;
        done = true;
        window.location.href = href;
      }

      send().then(go);
      setTimeout(go, REDIRECT_TIMEOUT_MS);
    }, true);
  }

  // ─────────────────────────────────────────────────────────────────
  // Expose programatico
  // ─────────────────────────────────────────────────────────────────
  window.LandingPrep = {
    send: send,
    sessionId: getSessionId,
    fbc: getFbc,
    fbp: getFbp,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", interceptClicks);
  } else {
    interceptClicks();
  }

  log("ready", { product: PRODUCT_SLUG, api: API_BASE });
})();
