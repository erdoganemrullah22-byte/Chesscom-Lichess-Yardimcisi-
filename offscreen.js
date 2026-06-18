/*
 * Lichess + Chess.com Stockfish Yardımcısı - Offscreen Document (Chrome MV3)
 *
 * Bu betik bir offscreen document içinde çalışır (görünmez gizli sayfa).
 * Stockfish motorunu Web Worker olarak burada barındırırız.
 *
 * Offscreen document chrome.tabs API'sine erişemediğinden, sekmeye cevap
 * yollarken chrome.runtime.sendMessage ile __sfh_response flag'li mesaj
 * gönderir; service worker bunu yakalayıp chrome.tabs.sendMessage ile
 * ilgili content script'e iletir.
 */

const LOADER_FILE = "stockfish.js";

let engine = null;
let engineReady = false;
let engineError = null;
let pendingInit = null;

let isSearching = false;
let currentRequest = null;
let pendingRequest = null;
let restartCount = 0;
let currentMultiPv = 1;
let currentLimit = false;
let currentElo = 0;

function log(...args) { console.log("[SF-Yardimci/offscreen]", ...args); }
function warn(...args) { console.warn("[SF-Yardimci/offscreen]", ...args); }

// Sekmeye cevap: SW üzerinden relay
function sendToTab(tabId, payload) {
  if (tabId == null) return;
  chrome.runtime.sendMessage({
    __sfh_response: true,
    __sfh_tabId: tabId,
    payload
  }).catch(() => {});
}

// Tüm satranç sekmelerine yayın: SW'ye yayın talebi
function notifyAllTabs(payload) {
  chrome.runtime.sendMessage({
    __sfh_broadcast: true,
    payload
  }).catch(() => {});
}

function createEngine() {
  if (engine) {
    try { engine.terminate(); } catch (_) {}
    engine = null;
    engineReady = false;
  }
  engineError = null;
  isSearching = false;
  currentRequest = null;
  currentMultiPv = 1;
  currentLimit = false;
  currentElo = 0;

  const url = chrome.runtime.getURL(LOADER_FILE);
  log("Stockfish yükleniyor:", url);

  try {
    engine = new Worker(url);
  } catch (err) {
    engineError = "Worker oluşturulamadı: " + err.message;
    warn(engineError);
    return Promise.reject(err);
  }

  engine.onmessage = handleEngineMessage;
  engine.onerror = (err) => {
    const msg = (err && (err.message || err.filename)) || "bilinmeyen hata";
    warn("Motor onerror:", err);
    engineReady = false;
    isSearching = false;

    if (restartCount < 3) {
      restartCount++;
      engineError = "Motor çöktü (" + msg + "), yeniden başlatılıyor (" + restartCount + "/3)…";
      notifyAllTabs({ type: "engine-error", message: engineError });
      setTimeout(() => {
        createEngine().then(() => {
          engineError = null;
          if (pendingRequest) startNextSearch();
        }).catch((e) => warn("Restart başarısız:", e));
      }, 800);
    } else {
      engineError = "Motor 3 kez çöktü, yeniden başlatma durduruldu. Eklentiyi tekrar yükleyin.";
      notifyAllTabs({ type: "engine-error", message: engineError });
    }
  };

  pendingInit = new Promise((resolve, reject) => {
    let timeout = setTimeout(() => {
      if (!engineReady) {
        engineError = "Motor 20 saniye içinde hazır olmadı. stockfish.wasm dosyası eklenti klasöründe mi?";
        warn(engineError);
        reject(new Error(engineError));
      }
    }, 20000);

    const onReady = (e) => {
      const line = typeof e.data === "string" ? e.data : (e.data && e.data.data) || "";
      if (line === "readyok") {
        clearTimeout(timeout);
        engine.removeEventListener("message", onReady);
        engineReady = true;
        setTimeout(() => { if (engineReady) restartCount = 0; }, 5000);
        log("Motor hazır.");
        resolve();
      }
    };
    engine.addEventListener("message", onReady);
    engine.postMessage("uci");
    engine.postMessage("setoption name MultiPV value " + currentMultiPv);
    engine.postMessage("isready");
  });

  return pendingInit;
}

function handleEngineMessage(e) {
  const line = typeof e.data === "string" ? e.data : (e.data && e.data.data) || "";
  if (!line) return;

  if (line.startsWith("info ") && currentRequest) {
    const mpvMatch = line.match(/\bmultipv (\d+)/);
    const depthMatch = line.match(/\bdepth (\d+)/);
    const cpMatch = line.match(/\bscore cp (-?\d+)/);
    const mateMatch = line.match(/\bscore mate (-?\d+)/);
    const pvMatch = line.match(/\bpv ([a-h1-8nbrqk ]+)/i);

    if (!pvMatch) return;
    const pvArr = pvMatch[1].trim().split(/\s+/);
    const mpvIdx = (mpvMatch ? parseInt(mpvMatch[1], 10) : 1) - 1;
    if (mpvIdx < 0 || mpvIdx > 9) return;

    const cp = cpMatch ? parseInt(cpMatch[1], 10) : null;
    const mate = mateMatch ? parseInt(mateMatch[1], 10) : null;
    const depth = depthMatch ? parseInt(depthMatch[1], 10) : null;

    currentRequest.lines[mpvIdx] = { move: pvArr[0], cp, mate, depth, pv: pvArr };

    if (mpvIdx === 0 && (depthMatch || cpMatch || mateMatch)) {
      sendToTab(currentRequest.tabId, {
        type: "evaluation",
        depth, cp, mate, pv: pvArr,
        turn: currentRequest.turn,
        requestId: currentRequest.id
      });
    }
    return;
  }

  if (line.startsWith("bestmove")) {
    const parts = line.split(/\s+/);
    const best = parts[1];

    if (currentRequest) {
      const lines = currentRequest.lines.filter((l) => l && l.move);
      sendToTab(currentRequest.tabId, {
        type: "bestmove",
        move: best,
        lines,
        turn: currentRequest.turn,
        requestId: currentRequest.id
      });
    }

    isSearching = false;
    currentRequest = null;
    if (pendingRequest) setTimeout(startNextSearch, 30);
    return;
  }
}

async function ensureEngine() {
  if (engine && engineReady) return;
  if (pendingInit) { await pendingInit; return; }
  await createEngine();
}

function startNextSearch() {
  if (!engineReady || !pendingRequest || isSearching) return;
  const req = pendingRequest;
  pendingRequest = null;
  currentRequest = req;
  currentRequest.lines = [];
  isSearching = true;

  const wantedMpv = Math.max(1, Math.min(5, req.multipv || 1));
  if (wantedMpv !== currentMultiPv) {
    engine.postMessage("setoption name MultiPV value " + wantedMpv);
    currentMultiPv = wantedMpv;
  }

  const wantedLimit = !!req.limitStrength;
  if (wantedLimit !== currentLimit) {
    engine.postMessage("setoption name UCI_LimitStrength value " + wantedLimit);
    currentLimit = wantedLimit;
  }
  if (wantedLimit) {
    const wantedElo = Math.max(1320, Math.min(3190, req.elo || 1500));
    if (wantedElo !== currentElo) {
      engine.postMessage("setoption name UCI_Elo value " + wantedElo);
      currentElo = wantedElo;
    }
  }

  engine.postMessage("position fen " + req.fen);
  if (req.movetime && req.movetime > 0) {
    engine.postMessage("go movetime " + req.movetime);
  } else {
    engine.postMessage("go depth " + (req.depth || 16));
  }
}

async function analyze(req) {
  try {
    await ensureEngine();
  } catch (err) {
    sendToTab(req.tabId, {
      type: "engine-error",
      message: engineError || ("Motor yüklenemedi: " + err.message),
      requestId: req.requestId
    });
    return;
  }

  pendingRequest = {
    tabId: req.tabId,
    id: req.requestId,
    turn: req.turn,
    fen: req.fen,
    depth: req.depth,
    movetime: req.movetime,
    multipv: req.multipv,
    limitStrength: req.limitStrength,
    elo: req.elo
  };

  if (isSearching) {
    engine.postMessage("stop");
  } else {
    startNextSearch();
  }
}

// ---- Mesaj dinleyici ----
// Sadece SW tarafından __sfh_forward flag'i ile gönderilen kullanıcı
// mesajlarını işle. Direkt content script'ten gelenler (sender.tab var,
// flag yok) yoksayılır — SW her zaman önce ona ulaşır ve forward eder.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.__sfh_forward) return false;

  const payload = msg.payload;
  const tabId = msg.__sfh_tabId;
  if (!payload || !payload.type) return false;

  if (payload.type === "analyze") {
    analyze({
      fen: payload.fen,
      depth: payload.depth,
      movetime: payload.movetime,
      multipv: payload.multipv,
      limitStrength: payload.limitStrength,
      elo: payload.elo,
      tabId,
      requestId: payload.requestId,
      turn: payload.turn
    });
    return false;
  }

  if (payload.type === "stop") {
    if (engine && engineReady && isSearching) engine.postMessage("stop");
    pendingRequest = null;
    return false;
  }

  if (payload.type === "ping") {
    sendResponse({ ok: true, ready: engineReady, error: engineError });
    return false;
  }

  return false;
});

// Sayfa yüklenir yüklenmez motoru başlat
createEngine().catch((e) => log("İlk motor başlatma başarısız:", e.message || e));
