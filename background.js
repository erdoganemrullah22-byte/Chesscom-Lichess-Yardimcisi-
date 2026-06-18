/*
 * Lichess + Chess.com Stockfish Yardımcısı - Service Worker (Chrome MV3)
 *
 * Mimari:
 *   content script ←→ SW ←→ offscreen document ←→ Stockfish Worker
 *
 * Offscreen document'lar chrome.tabs API'sine erişemez, dolayısıyla SW
 * bir relay olarak çalışır:
 *
 *   content → SW   : SW offscreen'in canlı olduğundan emin olur,
 *                     mesajı offscreen'e forward eder.
 *   offscreen → SW : SW cevap mesajını chrome.tabs.sendMessage ile
 *                     ilgili content script'e iletir.
 *
 * İletişim flag'leri:
 *   msg.__sfh_forward    → SW'den offscreen'e iletilen kullanıcı mesajı
 *   msg.__sfh_response   → offscreen'den SW'ye gelen, sekmeye iletilecek cevap
 *   msg.__sfh_broadcast  → offscreen'den SW'ye gelen, tüm satranç sekmelerine yayınlanacak
 */

const OFFSCREEN_HTML = "offscreen.html";
let creating = null;

async function isOffscreenAlive() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await isOffscreenAlive()) return;
  if (creating) { await creating; return; }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_HTML,
    reasons: ["WORKERS"],
    justification: "Stockfish chess engine runs in a Web Worker; MV3 service workers cannot spawn Workers themselves."
  });
  try { await creating; } finally { creating = null; }
}

chrome.runtime.onInstalled.addListener(() => ensureOffscreen().catch(() => {}));
chrome.runtime.onStartup.addListener(() => ensureOffscreen().catch(() => {}));

const CHESS_URLS = [
  "https://lichess.org/*",
  "https://www.chess.com/*",
  "https://chess.com/*"
];

function broadcast(payload) {
  chrome.tabs.query({ url: CHESS_URLS }, (tabs) => {
    if (chrome.runtime.lastError) return;
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, payload, () => void chrome.runtime.lastError);
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  // 1) Offscreen → sekmeye cevap
  if (msg.__sfh_response && msg.__sfh_tabId != null) {
    chrome.tabs.sendMessage(msg.__sfh_tabId, msg.payload, () => void chrome.runtime.lastError);
    return false;
  }

  // 2) Offscreen → tüm satranç sekmelerine yayın (motor hatası vb.)
  if (msg.__sfh_broadcast) {
    broadcast(msg.payload);
    return false;
  }

  // 3) Content script → offscreen'e forward
  if (sender && sender.tab) {
    const tabId = sender.tab.id;

    if (msg.type === "ping") {
      // Async: offscreen'den gerçek motor durumunu al
      (async () => {
        try {
          await ensureOffscreen();
          const res = await chrome.runtime.sendMessage({
            __sfh_forward: true,
            __sfh_tabId: tabId,
            payload: msg
          });
          sendResponse(res || { ok: true, ready: false });
        } catch (e) {
          sendResponse({ ok: false, ready: false, error: "Motor yanıt vermiyor" });
        }
      })();
      return true; // async response
    }

    // analyze / stop / vb. — fire-and-forget
    (async () => {
      try {
        await ensureOffscreen();
        await chrome.runtime.sendMessage({
          __sfh_forward: true,
          __sfh_tabId: tabId,
          payload: msg
        });
      } catch (_) {}
    })();
    return false;
  }

  return false;
});
