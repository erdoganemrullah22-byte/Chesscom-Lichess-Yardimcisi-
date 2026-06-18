/*
 * Lichess Page Script
 *
 * Lichess sayfasının asıl JavaScript bağlamında, document_start zamanında
 * çalışır (page-injector tarafından enjekte edilir).
 *
 * Birincil iş: Lichess'in sunucuyla konuştuğu WebSocket bağlantısını
 * yakalamak. Bu sayede otomatik hamle isteği gelince, Chessground'u
 * tamamen atlayıp protokol seviyesinde hareket mesajı gönderebiliriz.
 *
 * İkincil stratejiler (socket bulunamadığı durumlarda):
 *   - keyboard-move formu (kullanıcı bu özelliği açtıysa)
 *   - window.lichess.analyse.ctrl gibi eski globaller (sürüm bağımlı)
 *   - chessground.state.movable.events.after callback'i
 */
(function () {
  "use strict";

  function log(...args) { console.log("[sfh-page]", ...args); }
  function warn(...args) { console.warn("[sfh-page]", ...args); }

  // -------------------------------------------------------------------
  // 1) WebSocket constructor'unu sarmala (sayfanın ilk WS'inden önce)
  // -------------------------------------------------------------------
  const sockets = [];
  let lichessSocket = null;
  const OriginalWS = window.WebSocket;

  function Wrapped(url, protocols) {
    const ws = protocols !== undefined ? new OriginalWS(url, protocols)
                                       : new OriginalWS(url);
    try {
      const u = typeof url === "string" ? url : url.toString();
      if (/lichess|\/socket(\/|$|\?)|sri=/.test(u)) {
        sockets.push(ws);
        lichessSocket = ws;
        log("Lichess WebSocket yakalandı:", u);
        ws.addEventListener("close", () => {
          if (lichessSocket === ws) lichessSocket = null;
          log("WebSocket kapandı.");
        });
      }
    } catch (e) { warn("WS URL incelenirken hata:", e); }
    return ws;
  }
  Wrapped.prototype = OriginalWS.prototype;
  Wrapped.CONNECTING = OriginalWS.CONNECTING;
  Wrapped.OPEN = OriginalWS.OPEN;
  Wrapped.CLOSING = OriginalWS.CLOSING;
  Wrapped.CLOSED = OriginalWS.CLOSED;
  try { Object.setPrototypeOf(Wrapped, OriginalWS); } catch (_) {}
  window.WebSocket = Wrapped;

  log("WebSocket wrapper kuruldu (document.readyState=" + document.readyState + ")");

  // -------------------------------------------------------------------
  // 2) Hamle gönderme stratejileri
  // -------------------------------------------------------------------

  // Strateji: doğrudan socket üzerinden move mesajı
  function sendMoveViaSocket(uciMove) {
    // En son açık olan socket'i bul (kapalıysa düşür)
    let ws = lichessSocket;
    if (!ws || ws.readyState !== 1) {
      ws = sockets.filter(s => s.readyState === 1).pop() || null;
      lichessSocket = ws;
    }
    if (!ws) {
      warn("Aktif Lichess socket yok.");
      return false;
    }
    try {
      const payload = JSON.stringify({
        t: "move",
        d: { u: uciMove, b: 1, a: Date.now() & 0xffff }
      });
      ws.send(payload);
      log("Socket ile hamle gönderildi:", uciMove);
      return true;
    } catch (e) {
      warn("Socket send hatası:", e);
      return false;
    }
  }

  // Strateji: keyboard-move formu
  function tryKeyboardMove(uciMove) {
    const forms = document.querySelectorAll("form.keyboard-move, .keyboard-move form, .keyboardMove form");
    for (const form of forms) {
      const input = form.querySelector("input");
      if (!input) continue;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, uciMove);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      try {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        log("keyboard-move ile hamle gönderildi:", uciMove);
        return true;
      } catch (e) { warn("keyboard-move submit hatası:", e); }
    }
    return false;
  }

  // Strateji: eski global controller (sürüm bağımlı)
  function deepGet(obj, path) {
    try {
      for (const k of path.split(".")) {
        if (obj == null) return null;
        obj = obj[k];
      }
      return obj;
    } catch (_) { return null; }
  }

  function tryDirectCtrl(uciMove) {
    const paths = [
      "lichess.analyse.ctrl", "lichess.round.ctrl", "lichess.puzzle.ctrl",
      "LichessAnalyse.ctrl", "LichessRound.ctrl", "LichessPuzzle.ctrl"
    ];
    for (const p of paths) {
      const ctrl = deepGet(window, p);
      if (!ctrl) continue;
      const orig = uciMove.substring(0, 2);
      const dest = uciMove.substring(2, 4);
      const promoUci = uciMove[4] || null;
      const promoMap = { q: "queen", r: "rook", b: "bishop", n: "knight" };
      const promoLong = promoUci ? promoMap[promoUci] : undefined;
      try {
        if (typeof ctrl.userMove === "function") {
          ctrl.userMove(orig, dest, promoLong);
          log("ctrl.userMove (" + p + ") ile hamle yapıldı:", uciMove);
          return true;
        }
        if (typeof ctrl.sendMove === "function") {
          ctrl.sendMove(orig, dest, promoLong);
          log("ctrl.sendMove (" + p + ") ile hamle gönderildi:", uciMove);
          return true;
        }
        if (typeof ctrl.playUci === "function") {
          ctrl.playUci(uciMove);
          log("ctrl.playUci (" + p + ") ile hamle yapıldı:", uciMove);
          return true;
        }
      } catch (e) { warn("ctrl call hatası:", e); }
    }
    return false;
  }

  // -------------------------------------------------------------------
  // 3) Ana dispatcher
  // -------------------------------------------------------------------
  function performMove(uciMove) {
    if (!uciMove || uciMove.length < 4) return "invalid";

    // En güvenilir: socket
    if (sendMoveViaSocket(uciMove)) return "socket";

    // Sonra: keyboard-move (varsa)
    if (tryKeyboardMove(uciMove)) return "keyboard-move";

    // Son çare: eski globaller
    if (tryDirectCtrl(uciMove)) return "direct-ctrl";

    warn("Hiçbir strateji başarılı olmadı.");
    return "failed";
  }

  // -------------------------------------------------------------------
  // 4) Content script ile iletişim
  // -------------------------------------------------------------------
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;

    if (e.data.type === "sfh-ping") {
      // Content script ready mesajını kaçırmış olabilir; tekrar yayınla
      window.postMessage({ type: "sfh-page-ready" }, "*");
      return;
    }

    if (e.data.type === "sfh-move") {
      const result = performMove(e.data.move);
      window.postMessage({
        type: "sfh-move-result",
        id: e.data.id,
        result,
        move: e.data.move
      }, "*");
    }
  });

  window.postMessage({ type: "sfh-page-ready" }, "*");
  log("Page helper hazır.");
})();
