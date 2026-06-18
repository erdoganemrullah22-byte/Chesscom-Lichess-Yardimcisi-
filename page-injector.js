/*
 * Lichess Page Injector
 *
 * document_start'ta çalışır. Lichess'in main script'i sayfaya yüklenmeden
 * ÖNCE page-script.js'i sayfa bağlamına enjekte eder. Bu sayede page-script
 * window.WebSocket constructor'unu sarmalayıp Lichess socket bağlantısını
 * yakalayabilir.
 */
if (typeof browser === "undefined") { var browser = chrome; }

(function () {
  const script = document.createElement("script");
  script.src = browser.runtime.getURL("page-script.js");
  script.async = false;
  script.defer = false;
  (document.head || document.documentElement).appendChild(script);
})();
