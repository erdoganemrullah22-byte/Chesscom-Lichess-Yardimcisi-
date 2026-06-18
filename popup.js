/*
 * Popup mantığı - ayarları storage'a yaz, motor durumunu göster.
 */
if (typeof browser === "undefined") { var browser = chrome; }

const STATE_KEY = "lichessSfHelperState";

const DEFAULTS = {
  enabled: true,
  depth: 16,
  movetime: 0,
  showArrow: true,
  showEval: true,
  multipv: 3,
  limitStrength: false,
  elo: 1500,
  autoPlay: false,
  autoPlayDelay: 800
};

const el = {
  enabled: document.getElementById("enabled"),
  showArrow: document.getElementById("showArrow"),
  showEval: document.getElementById("showEval"),
  depth: document.getElementById("depth"),
  movetime: document.getElementById("movetime"),
  multipv: document.getElementById("multipv"),
  limitStrength: document.getElementById("limitStrength"),
  elo: document.getElementById("elo"),
  autoPlay: document.getElementById("autoPlay"),
  autoPlayDelay: document.getElementById("autoPlayDelay"),
  status: document.getElementById("status")
};

function syncEloInput() {
  el.elo.disabled = !el.limitStrength.checked;
  el.elo.style.opacity = el.limitStrength.checked ? "1" : "0.4";
}

function load() {
  return browser.storage.local.get(STATE_KEY).then((res) => {
    const s = { ...DEFAULTS, ...(res[STATE_KEY] || {}) };
    el.enabled.checked = !!s.enabled;
    el.showArrow.checked = !!s.showArrow;
    el.showEval.checked = !!s.showEval;
    el.depth.value = s.depth;
    el.movetime.value = s.movetime;
    el.multipv.value = s.multipv;
    el.limitStrength.checked = !!s.limitStrength;
    el.elo.value = s.elo;
    el.autoPlay.checked = !!s.autoPlay;
    el.autoPlayDelay.value = s.autoPlayDelay;
    syncEloInput();
  });
}

function save() {
  const s = {
    enabled: el.enabled.checked,
    showArrow: el.showArrow.checked,
    showEval: el.showEval.checked,
    depth: clamp(parseInt(el.depth.value, 10) || 16, 1, 30),
    movetime: clamp(parseInt(el.movetime.value, 10) || 0, 0, 60000),
    multipv: clamp(parseInt(el.multipv.value, 10) || 3, 1, 5),
    limitStrength: el.limitStrength.checked,
    elo: clamp(parseInt(el.elo.value, 10) || 1500, 1320, 3190),
    autoPlay: el.autoPlay.checked,
    autoPlayDelay: clamp(parseInt(el.autoPlayDelay.value, 10) || 800, 0, 10000)
  };
  syncEloInput();
  return browser.storage.local.set({ [STATE_KEY]: s });
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function checkEngine() {
  browser.runtime.sendMessage({ type: "ping" })
    .then((res) => {
      if (res && res.ready) {
        el.status.textContent = "Motor hazır.";
        el.status.className = "status ok";
      } else if (res && res.error) {
        el.status.textContent = res.error;
        el.status.className = "status err";
      } else {
        el.status.textContent = "Motor yükleniyor… (birkaç saniye sonra tekrar dene)";
        el.status.className = "status";
      }
    })
    .catch(() => {
      el.status.textContent = "Background ile iletişim kurulamadı.";
      el.status.className = "status err";
    });
}

setInterval(checkEngine, 2000);

["enabled", "showArrow", "showEval", "depth", "movetime", "multipv",
 "limitStrength", "elo", "autoPlay", "autoPlayDelay"].forEach((k) => {
  el[k].addEventListener("change", save);
  el[k].addEventListener("input", save);
});

load().then(checkEngine);
