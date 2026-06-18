/*
 * Lichess + Chess.com Stockfish Yardımcısı - Content Script
 *
 * Bu dosya site adapter mimarisi kullanır. Her site için (Lichess,
 * Chess.com) ayrı bir adapter tanımlanır — findBoard, readGrid,
 * detectTurn, isFlipped, vb. site-spesifik fonksiyonları sağlar.
 * Geri kalan her şey (FEN üretimi, eval kutusu, ok çizimi, scan
 * döngüsü, background iletişimi) site-bağımsız ortak koddur.
 */

// Cross-browser polyfill: Chrome'da `browser` yok, sadece `chrome` var
if (typeof browser === "undefined") { var browser = chrome; }

(function () {
  "use strict";

  // ===================================================================
  // Ayarlar & durum
  // ===================================================================
  const STATE_KEY = "lichessSfHelperState";

  const DEFAULT_SETTINGS = {
    enabled: true,
    depth: 16,
    movetime: 0,
    showArrow: true,
    showEval: true,
    multipv: 3,
    limitStrength: false,
    elo: 1500,
    autoPlay: false,       // en iyi hamleyi otomatik oyna
    autoPlayDelay: 800     // hamleden önce bekleme süresi (ms)
  };

  let settings = { ...DEFAULT_SETTINGS };
  let lastFen = null;
  let lastRequestId = 0;
  let evalBox = null;
  let observer = null;
  let observedBoard = null;
  let pollTimer = null;
  let lastUrl = location.href;

  // Lichess page-script enjeksiyon durumu
  let pageHelperInjected = false;
  let pageHelperReady = false;

  // Sürüklenebilir kutu için konum bellekte tutulur
  const POS_KEY = "lichessSfHelperPos";
  let boxPos = null;

  const PIECE_CHAR = {
    pawn: "p", knight: "n", bishop: "b",
    rook: "r", queen: "q", king: "k",
    p: "p", n: "n", b: "b", r: "r", q: "q", k: "k"
  };

  function loadSettings() {
    return browser.storage.local.get([STATE_KEY, POS_KEY]).then((res) => {
      const stored = res[STATE_KEY] || {};
      settings = { ...DEFAULT_SETTINGS, ...stored };
      if (res[POS_KEY] && typeof res[POS_KEY].left === "number") {
        boxPos = res[POS_KEY];
      }
    });
  }

  function saveBoxPos() {
    if (!boxPos) return;
    browser.storage.local.set({ [POS_KEY]: boxPos });
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STATE_KEY]) return;
    settings = { ...DEFAULT_SETTINGS, ...(changes[STATE_KEY].newValue || {}) };
    if (!settings.enabled) {
      clearArrow();
      hideEvalBox();
    } else {
      lastFen = null;
      scheduleScan();
    }
  });

  // ===================================================================
  // Site adapter seçimi
  // ===================================================================
  let A = null;

  function selectAdapter() {
    const host = location.host;
    if (host === "lichess.org" || host.endsWith(".lichess.org")) {
      A = LichessAdapter;
      // Lichess'te otomatik hamle için page-script gerekiyor
      injectLichessPageHelper();
    } else if (host === "chess.com" || host.endsWith(".chess.com")) {
      A = ChessComAdapter;
    } else {
      A = null;
    }
    if (A) console.log("[SF-Yardimci] Site adapter:", A.name);
  }

  // ===================================================================
  // ADAPTER: Lichess
  // ===================================================================
  const LichessAdapter = {
    name: "lichess",

    findBoard() {
      let boards = document.querySelectorAll("cg-board");
      if (boards.length === 0) boards = document.querySelectorAll(".cg-board");

      let best = null, bestArea = 0;
      for (const b of boards) {
        const rect = b.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea && rect.width > 40 && rect.height > 40) {
          best = b; bestArea = area;
        }
      }
      return best;
    },

    isFlipped(board) {
      const wrap = board.closest(".cg-wrap") || board.parentElement;
      return wrap ? wrap.classList.contains("orientation-black") : false;
    },

    readGrid(board) {
      const flipped = this.isFlipped(board);
      const grid = Array.from({ length: 8 }, () => Array(8).fill(""));
      const boardRect = board.getBoundingClientRect();
      const sq = boardRect.width / 8;

      const pieces = board.querySelectorAll("piece, .piece");
      pieces.forEach((p) => {
        if (p.classList.contains("ghost") || p.classList.contains("fading") ||
            p.classList.contains("anim")) return;

        const cls = p.className.split(/\s+/);
        let color = null, type = null;
        for (const c of cls) {
          if (c === "white" || c === "black") color = c;
          else if (PIECE_CHAR[c] && c.length > 1) type = c;
        }
        if (!color || !type) return;

        let fx = null, fy = null;
        const transform = p.style.transform || "";

        let m = transform.match(/translate3?d?\(\s*(-?[\d.]+)(px|%)?\s*,\s*(-?[\d.]+)(px|%)?/);
        if (m) {
          const xv = parseFloat(m[1]);
          const yv = parseFloat(m[3]);
          if (m[2] === "%") { fx = Math.round(xv / 12.5); fy = Math.round(yv / 12.5); }
          else { fx = Math.round(xv / sq); fy = Math.round(yv / sq); }
        }

        if (fx === null || fy === null) {
          const mx = transform.match(/translateX\(\s*(-?[\d.]+)(px|%)?/);
          const my = transform.match(/translateY\(\s*(-?[\d.]+)(px|%)?/);
          if (mx && my) {
            const xv = parseFloat(mx[1]);
            const yv = parseFloat(my[1]);
            fx = Math.round(mx[2] === "%" ? xv / 12.5 : xv / sq);
            fy = Math.round(my[2] === "%" ? yv / 12.5 : yv / sq);
          }
        }

        if (fx === null || fy === null || isNaN(fx) || isNaN(fy)) {
          const pr = p.getBoundingClientRect();
          if (pr.width > 0 && pr.height > 0) {
            fx = Math.round((pr.left - boardRect.left) / sq);
            fy = Math.round((pr.top - boardRect.top) / sq);
          } else return;
        }

        if (fx < 0 || fx > 7 || fy < 0 || fy > 7) return;

        let rank, file;
        if (flipped) { file = 7 - fx; rank = fy; }
        else { file = fx; rank = 7 - fy; }

        const row = 7 - rank;
        const col = file;
        grid[row][col] = color === "white"
          ? PIECE_CHAR[type].toUpperCase()
          : PIECE_CHAR[type];
      });

      return grid;
    },

    detectTurn(board) {
      const wrap = document.querySelector(".cg-wrap");
      if (wrap) {
        if (wrap.classList.contains("turn-white")) return "w";
        if (wrap.classList.contains("turn-black")) return "b";
      }

      const moveSelectors = [
        "l4x kwdb", "l4x move", ".tview2 move",
        ".moves move", "rm6 move", ".replay move"
      ];
      let moves = [];
      for (const sel of moveSelectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) { moves = found; break; }
      }
      if (moves.length > 0) return moves.length % 2 === 0 ? "w" : "b";
      return "w";
    },

    getArrowContainer(board) {
      return board.closest("cg-container") || board.parentElement;
    },

    uciToBoardXY(uciMove, board) {
      const flipped = this.isFlipped(board);
      const fromFile = uciMove.charCodeAt(0) - 97;
      const fromRank = parseInt(uciMove[1], 10) - 1;
      const toFile = uciMove.charCodeAt(2) - 97;
      const toRank = parseInt(uciMove[3], 10) - 1;
      if (isNaN(fromRank) || isNaN(toRank)) return null;

      const toXY = (file, rank) => {
        let x = file, y = 7 - rank;
        if (flipped) { x = 7 - x; y = 7 - y; }
        return { x: x * 12.5 + 6.25, y: y * 12.5 + 6.25 };
      };
      return { from: toXY(fromFile, fromRank), to: toXY(toFile, toRank) };
    }
  };

  // ===================================================================
  // ADAPTER: Chess.com
  // ===================================================================
  const ChessComAdapter = {
    name: "chesscom",

    findBoard() {
      let boards = document.querySelectorAll("wc-chess-board, chess-board");
      if (boards.length === 0) {
        boards = document.querySelectorAll(".board, #board-board");
      }

      let best = null, bestArea = 0;
      for (const b of boards) {
        const rect = b.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea && rect.width > 40 && rect.height > 40) {
          best = b; bestArea = area;
        }
      }
      return best;
    },

    isFlipped(board) {
      if (board.classList.contains("flipped")) return true;
      const orient = board.getAttribute("orientation");
      if (orient === "black") return true;

      const bottomPlayer = document.querySelector(".player-bottom, .board-layout-bottom .player");
      if (bottomPlayer && /\bblack\b/i.test(bottomPlayer.className)) return true;

      return false;
    },

    readGrid(board) {
      const flipped = this.isFlipped(board);
      const grid = Array.from({ length: 8 }, () => Array(8).fill(""));
      const boardRect = board.getBoundingClientRect();
      const sq = boardRect.width / 8;

      const pieces = board.querySelectorAll(".piece, piece");
      pieces.forEach((p) => {
        if (p.classList.contains("dragging") || p.classList.contains("ghost") ||
            p.classList.contains("anim") || p.classList.contains("fading")) return;

        let color = null, type = null;
        let file = null, rank = null;

        for (const c of p.classList) {
          if (/^[wb][pnbrqk]$/.test(c)) {
            color = c[0] === "w" ? "white" : "black";
            type = c[1];
            continue;
          }
          const sqMatch = c.match(/^square-(\d)(\d)$/);
          if (sqMatch) {
            file = parseInt(sqMatch[1], 10) - 1;
            rank = parseInt(sqMatch[2], 10) - 1;
            continue;
          }
        }

        if (file === null || rank === null) {
          const transform = p.style.transform || "";
          const m = transform.match(/translate3?d?\(\s*(-?[\d.]+)(px|%)?\s*,\s*(-?[\d.]+)(px|%)?/);
          let fx, fy;
          if (m) {
            const xv = parseFloat(m[1]);
            const yv = parseFloat(m[3]);
            if (m[2] === "%") { fx = Math.round(xv / 12.5); fy = Math.round(yv / 12.5); }
            else { fx = Math.round(xv / sq); fy = Math.round(yv / sq); }
          } else {
            const pr = p.getBoundingClientRect();
            if (pr.width <= 0) return;
            fx = Math.round((pr.left - boardRect.left) / sq);
            fy = Math.round((pr.top - boardRect.top) / sq);
          }
          if (flipped) { file = 7 - fx; rank = fy; }
          else         { file = fx;     rank = 7 - fy; }
        }

        if (!type) {
          const dp = p.getAttribute("data-piece") || "";
          const m = dp.match(/^([wb])([pnbrqk])$/);
          if (m) { color = m[1] === "w" ? "white" : "black"; type = m[2]; }
        }

        if (!color || !type) return;
        if (file == null || rank == null) return;
        if (file < 0 || file > 7 || rank < 0 || rank > 7) return;

        const row = 7 - rank;
        const col = file;
        grid[row][col] = color === "white"
          ? PIECE_CHAR[type].toUpperCase()
          : PIECE_CHAR[type];
      });

      return grid;
    },

    detectTurn(board) {
      const activeClock = document.querySelector(".clock-component.clock-player-turn, " +
                                                  ".clock-player-turn, .clock-bottom.clock-player-turn, " +
                                                  ".clock-top.clock-player-turn");
      if (activeClock) {
        const isBottom = activeClock.classList.contains("clock-bottom") ||
                         activeClock.closest(".clock-bottom, .board-layout-bottom");
        const flipped = this.isFlipped(board);
        if (isBottom) return flipped ? "b" : "w";
        return flipped ? "w" : "b";
      }

      const moveSelectors = [
        ".move-list-component .move .move-text-component",
        ".vertical-move-list .move-text-component",
        ".move-list-wrapper .move",
        ".move-list .move",
        "vertical-move-list .move",
        "wc-vertical-move-list .move"
      ];
      for (const sel of moveSelectors) {
        const moves = document.querySelectorAll(sel);
        if (moves.length > 0) return moves.length % 2 === 0 ? "w" : "b";
      }

      const movesGen = document.querySelectorAll('[class*="move-text"]');
      if (movesGen.length > 0) return movesGen.length % 2 === 0 ? "w" : "b";

      return "w";
    },

    getArrowContainer(board) {
      return board;
    },

    uciToBoardXY(uciMove, board) {
      const flipped = this.isFlipped(board);
      const fromFile = uciMove.charCodeAt(0) - 97;
      const fromRank = parseInt(uciMove[1], 10) - 1;
      const toFile = uciMove.charCodeAt(2) - 97;
      const toRank = parseInt(uciMove[3], 10) - 1;
      if (isNaN(fromRank) || isNaN(toRank)) return null;

      const toXY = (file, rank) => {
        let x, y;
        if (flipped) { x = 7 - file; y = rank; }
        else         { x = file;     y = 7 - rank; }
        return { x: x * 12.5 + 6.25, y: y * 12.5 + 6.25 };
      };
      return { from: toXY(fromFile, fromRank), to: toXY(toFile, toRank) };
    }
  };

  // ===================================================================
  // Ortak: FEN üretimi
  // ===================================================================
  function guessCastling(grid) {
    let rights = "";
    if (grid[7][4] === "K") {
      if (grid[7][7] === "R") rights += "K";
      if (grid[7][0] === "R") rights += "Q";
    }
    if (grid[0][4] === "k") {
      if (grid[0][7] === "r") rights += "k";
      if (grid[0][0] === "r") rights += "q";
    }
    return rights || "-";
  }

  function buildFen(grid, turn) {
    const rows = grid.map((row) => {
      let str = "";
      let empty = 0;
      for (const cell of row) {
        if (cell === "") empty++;
        else {
          if (empty > 0) { str += empty; empty = 0; }
          str += cell;
        }
      }
      if (empty > 0) str += empty;
      return str;
    });
    return `${rows.join("/")} ${turn} ${guessCastling(grid)} - 0 1`;
  }

  // ===================================================================
  // Ortak: Ok çizimi
  // ===================================================================
  const ARROW_ID = "lichess-sf-helper-arrow";

  function clearArrow() {
    const old = document.getElementById(ARROW_ID);
    if (old) old.remove();
  }

  // En iyi + alternatif hamleleri okla gösterir.
  // 1. en iyi → YEŞİL ok
  // 2-5. alternatif → MAVİ ok, azalan opaklık
  function drawArrows(lines, board) {
    clearArrow();
    if (!A || !settings.showArrow) return;
    if (!lines || lines.length === 0) return;

    const maxArrows = Math.max(1, Math.min(5, settings.multipv || 1));
    const container = A.getArrowContainer(board);
    if (!container) return;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = ARROW_ID;
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.position = "absolute";
    svg.style.top = "0";
    svg.style.left = "0";
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.pointerEvents = "none";
    svg.style.zIndex = "5";

    const COLOR_BEST = "#43a047";
    const COLOR_ALT  = "#1e88e5";

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const mkMarker = (id, color) => {
      const m = document.createElementNS("http://www.w3.org/2000/svg", "marker");
      m.setAttribute("id", id);
      m.setAttribute("markerWidth", "4");
      m.setAttribute("markerHeight", "4");
      m.setAttribute("refX", "2.2");
      m.setAttribute("refY", "2");
      m.setAttribute("orient", "auto");
      m.setAttribute("markerUnits", "strokeWidth");
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", "M0,0 L4,2 L0,4 L1.2,2 Z");
      p.setAttribute("fill", color);
      m.appendChild(p);
      return m;
    };
    defs.appendChild(mkMarker("lichess-sf-arrowhead-best", COLOR_BEST));
    defs.appendChild(mkMarker("lichess-sf-arrowhead-alt", COLOR_ALT));
    svg.appendChild(defs);

    const styles = [
      { op: 0.95, width: 1.9, color: COLOR_BEST, marker: "lichess-sf-arrowhead-best" },
      { op: 0.62, width: 1.5, color: COLOR_ALT,  marker: "lichess-sf-arrowhead-alt"  },
      { op: 0.42, width: 1.3, color: COLOR_ALT,  marker: "lichess-sf-arrowhead-alt"  },
      { op: 0.30, width: 1.2, color: COLOR_ALT,  marker: "lichess-sf-arrowhead-alt"  },
      { op: 0.22, width: 1.1, color: COLOR_ALT,  marker: "lichess-sf-arrowhead-alt"  }
    ];

    const drawn = new Set();
    for (let i = 0; i < Math.min(lines.length, maxArrows); i++) {
      const ln = lines[i];
      if (!ln || !ln.move) continue;
      const mv = ln.move;
      if (mv === "(none)" || mv === "0000" || mv.length < 4) continue;
      if (drawn.has(mv)) continue;
      drawn.add(mv);

      const xy = A.uciToBoardXY(mv, board);
      if (!xy) continue;
      const { from, to } = xy;
      const s = styles[i] || styles[styles.length - 1];

      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("opacity", s.op);

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const back = 4.5;
      const sTo = { x: to.x - (dx / len) * back, y: to.y - (dy / len) * back };

      const lineEl = document.createElementNS("http://www.w3.org/2000/svg", "line");
      lineEl.setAttribute("x1", from.x);
      lineEl.setAttribute("y1", from.y);
      lineEl.setAttribute("x2", sTo.x);
      lineEl.setAttribute("y2", sTo.y);
      lineEl.setAttribute("stroke", s.color);
      lineEl.setAttribute("stroke-width", s.width);
      lineEl.setAttribute("stroke-linecap", "round");
      lineEl.setAttribute("marker-end", "url(#" + s.marker + ")");
      g.appendChild(lineEl);
      svg.appendChild(g);
    }

    const cs = window.getComputedStyle(container);
    if (cs.position === "static") container.style.position = "relative";
    container.appendChild(svg);
  }

  // ===================================================================
  // Ortak: Otomatik hamle yapma
  // ===================================================================

  // Kullanıcının sırası mı? (Kullanıcı tahtanın alt tarafındadır;
  // flipped değilse beyaz, flipped ise siyah oynar.)
  function isUserTurn(board, turn) {
    if (!board) return false;
    const userColor = A.isFlipped(board) ? "b" : "w";
    return turn === userColor;
  }

  // Mouse + pointer event yapıcı
  function mkMouseEvent(type, x, y, isDown) {
    return new MouseEvent(type, {
      view: window, bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y,
      screenX: x, screenY: y,
      button: 0, buttons: isDown ? 1 : 0
    });
  }
  function mkPointerEvent(type, x, y, isDown) {
    try {
      return new PointerEvent(type, {
        view: window, bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y,
        screenX: x, screenY: y,
        button: 0, buttons: isDown ? 1 : 0,
        pointerType: "mouse", pointerId: 1, isPrimary: true,
        width: 1, height: 1, pressure: isDown ? 0.5 : 0
      });
    } catch (_) { return null; }
  }

  // Site-spesifik makeMove dispatch'i çağırır. Lichess Chessground ile
  // Chess.com farklı event akışları kullandığı için ayrı stratejiler.
  function makeMove(uciMove, board) {
    if (!uciMove || uciMove.length < 4) return;
    if (uciMove === "(none)" || uciMove === "0000") return;

    const fromFile = uciMove.charCodeAt(0) - 97;
    const fromRank = parseInt(uciMove[1], 10) - 1;
    const toFile = uciMove.charCodeAt(2) - 97;
    const toRank = parseInt(uciMove[3], 10) - 1;
    const promotion = uciMove[4] || null;
    if (isNaN(fromRank) || isNaN(toRank)) return;

    const boardRect = board.getBoundingClientRect();
    const sq = boardRect.width / 8;
    const flipped = A.isFlipped(board);

    const toScreen = (file, rank) => {
      let x = file, y = 7 - rank;
      if (flipped) { x = 7 - x; y = 7 - y; }
      return {
        x: boardRect.left + (x + 0.5) * sq,
        y: boardRect.top + (y + 0.5) * sq
      };
    };

    const from = toScreen(fromFile, fromRank);
    const to = toScreen(toFile, toRank);

    console.log("[SF-Yardimci/" + A.name + "] Otomatik hamle:", uciMove, from, "→", to);

    if (A.name === "lichess") {
      makeMoveLichess(board, from, to, promotion);
    } else {
      makeMoveGeneric(board, from, to, promotion);
    }
  }

  // Chess.com vb. için: pointer + mouse event'leri elementFromPoint hedeflerine
  function makeMoveGeneric(board, from, to, promotion) {
    const sourceEl = document.elementFromPoint(from.x, from.y) || board;
    const destEl   = document.elementFromPoint(to.x, to.y)   || board;

    const fire = (type, x, y, target, isDown) => {
      try { target.dispatchEvent(mkPointerEvent("pointer" + type, x, y, isDown)); } catch (_) {}
      target.dispatchEvent(mkMouseEvent("mouse" + type, x, y, isDown));
    };

    fire("down", from.x, from.y, sourceEl, true);
    setTimeout(() => fire("move", (from.x + to.x) / 2, (from.y + to.y) / 2, sourceEl, true), 40);
    setTimeout(() => fire("move", to.x, to.y, destEl, true), 80);
    setTimeout(() => {
      fire("up", to.x, to.y, destEl, false);
      if (promotion) setTimeout(() => handlePromotion(promotion), 220);
    }, 120);
  }

  // ----- Lichess page-script ile haberleşme -----
  // page-injector.js zaten document_start'ta page-script.js'i enjekte ediyor.
  // Burada sadece postMessage trafiğini dinliyoruz.
  function injectLichessPageHelper() {
    if (pageHelperInjected) return;
    pageHelperInjected = true;

    window.addEventListener("message", (e) => {
      if (e.source !== window || !e.data) return;
      if (e.data.type === "sfh-page-ready") {
        pageHelperReady = true;
        console.log("[SF-Yardimci] Lichess page helper hazır.");
      } else if (e.data.type === "sfh-move-result") {
        console.log("[SF-Yardimci] Hamle sonucu:", e.data.result, "→", e.data.move);
      }
    });

    // Eğer page-script bizden önce hazır olduysa, ready mesajını kaçırmış
    // olabiliriz. Bir kez kendisini yokla.
    window.postMessage({ type: "sfh-ping" }, "*");
  }

  // UCI hamle string'ini from/to/promotion'dan yeniden oluştur
  function reconstructUci(from, to, promotion, board) {
    // from/to ekran koordinatları, UCI'ye geri çevirmek için board metrics lazım
    const r = board.getBoundingClientRect();
    const sq = r.width / 8;
    const flipped = A.isFlipped(board);

    const screenToSquare = (sx, sy) => {
      let x = Math.round((sx - r.left - sq / 2) / sq);
      let y = Math.round((sy - r.top  - sq / 2) / sq);
      if (flipped) { x = 7 - x; y = 7 - y; }
      const file = String.fromCharCode(97 + x);
      const rank = String(8 - y);
      return file + rank;
    };

    return screenToSquare(from.x, from.y) + screenToSquare(to.x, to.y) + (promotion || "");
  }

  // Lichess için: önce page-script ile dene (Lichess'in kendi API'si),
  // başarısız olursa synthetic event drag fallback.
  function makeMoveLichess(board, from, to, promotion) {
    const uciMove = reconstructUci(from, to, promotion, board);
    const initialFen = lastFen;

    // === Strateji 0: Page-script (Lichess kendi API'si) ===
    if (pageHelperReady) {
      console.log("[SF-Yardimci/lichess] Page-script ile hamle gönderiliyor:", uciMove);
      window.postMessage({ type: "sfh-move", move: uciMove, id: Date.now() }, "*");

      // 500ms içinde hamle olmadıysa synthetic event drag'a düş
      setTimeout(() => {
        if (lastFen !== initialFen) return; // başarılı
        console.log("[SF-Yardimci/lichess] Page-script başarısız, synthetic event drag deneniyor...");
        makeMoveLichessFallback(board, from, to, promotion);
      }, 500);
      return;
    }

    // Page-script yoksa direkt fallback'e
    makeMoveLichessFallback(board, from, to, promotion);
  }

  // Synthetic event drag fallback (Chessground'un kendi event handler'larına çalışır)
  function makeMoveLichessFallback(board, from, to, promotion) {
    const initialFen = lastFen;

    const dispatchOnBoard = (type, x, y, isDown) => {
      // Hem cg-board hem cg-container'a dispatch (event delegation için)
      const targets = [board, board.parentElement].filter(Boolean);
      for (const t of targets) {
        try { t.dispatchEvent(mkPointerEvent("pointer" + type, x, y, isDown)); } catch (_) {}
        t.dispatchEvent(mkMouseEvent("mouse" + type, x, y, isDown));
      }
    };
    const dispatchOnDocument = (type, x, y, isDown) => {
      try { document.dispatchEvent(mkPointerEvent("pointer" + type, x, y, isDown)); } catch (_) {}
      document.dispatchEvent(mkMouseEvent("mouse" + type, x, y, isDown));
    };

    // === Strateji 1: drag ===
    dispatchOnBoard("down", from.x, from.y, true);

    setTimeout(() => {
      // 5px ötesinde küçük bir hareket — Chessground'un drag threshold'unu geç
      dispatchOnDocument("move", from.x + 8, from.y + 8, true);
    }, 25);

    setTimeout(() => {
      dispatchOnDocument("move", (from.x + to.x) / 2, (from.y + to.y) / 2, true);
    }, 55);

    setTimeout(() => {
      dispatchOnDocument("move", to.x, to.y, true);
    }, 95);

    setTimeout(() => {
      dispatchOnDocument("up", to.x, to.y, false);
      dispatchOnBoard("up", to.x, to.y, false);
      if (promotion) setTimeout(() => handlePromotion(promotion), 220);
    }, 130);

    // === Strateji 2: 400ms sonra hamle olmadıysa click-click ===
    setTimeout(() => {
      // Hamle gerçekleşti mi? lastFen scan döngüsünde güncellenir
      if (lastFen !== initialFen) return; // başarılı
      console.log("[SF-Yardimci/lichess] Drag başarısız, click-click deneniyor...");

      // Source'a tıkla (seç)
      dispatchOnBoard("down", from.x, from.y, true);
      setTimeout(() => {
        dispatchOnBoard("up", from.x, from.y, false);
        // Destination'a tıkla
        setTimeout(() => {
          dispatchOnBoard("down", to.x, to.y, true);
          setTimeout(() => {
            dispatchOnBoard("up", to.x, to.y, false);
            if (promotion) setTimeout(() => handlePromotion(promotion), 220);
          }, 50);
        }, 80);
      }, 50);
    }, 400);
  }

  // Promosyon dialog'unda doğru taşı seç (varsayılan: vezir)
  function handlePromotion(piece) {
    const wanted = (piece || "q").toLowerCase();

    // 1) Lichess (Chessground) — cg-promotion içinde <piece class="white queen">
    const cgPromo = document.querySelectorAll("cg-promotion piece, .promotion-choice piece");
    for (const p of cgPromo) {
      const cls = p.className.toLowerCase();
      if ((wanted === "q" && cls.includes("queen")) ||
          (wanted === "r" && cls.includes("rook")) ||
          (wanted === "b" && cls.includes("bishop")) ||
          (wanted === "n" && cls.includes("knight"))) {
        p.click();
        return;
      }
    }

    // 2) Chess.com — .promotion-window içinde .promotion-piece-wq vb.
    const ccPromo = document.querySelectorAll(".promotion-window .promotion-piece, .promotion-piece");
    for (const p of ccPromo) {
      const cls = p.className.toLowerCase();
      if ((wanted === "q" && /\b(promotion-)?piece-?[wb]?q\b/.test(cls)) ||
          (wanted === "r" && /\b(promotion-)?piece-?[wb]?r\b/.test(cls)) ||
          (wanted === "b" && /\b(promotion-)?piece-?[wb]?b\b/.test(cls)) ||
          (wanted === "n" && /\b(promotion-)?piece-?[wb]?n\b/.test(cls))) {
        p.click();
        return;
      }
    }
  }

  // ===================================================================
  // Ortak: Eval kutusu (sürüklenebilir + eval bar)
  // ===================================================================
  function ensureEvalBox() {
    if (evalBox && document.documentElement.contains(evalBox)) return evalBox;
    evalBox = document.createElement("div");
    evalBox.id = "lichess-sf-helper-eval";
    evalBox.innerHTML = `
      <div class="sfh-bar">
        <div class="sfh-bar-fill"></div>
        <div class="sfh-bar-label">0.0</div>
      </div>
      <div class="sfh-content">
        <div class="sfh-title" title="Sürüklemek için tut">Stockfish ⠿</div>
        <div class="sfh-row"><span class="sfh-label">En iyi hamle:</span> <span class="sfh-best">—</span></div>
        <div class="sfh-row"><span class="sfh-label">Skor:</span> <span class="sfh-score">—</span></div>
        <div class="sfh-row"><span class="sfh-label">Derinlik:</span> <span class="sfh-depth">—</span></div>
        <div class="sfh-row sfh-pv"><span class="sfh-label">Varyant:</span> <span class="sfh-pv-text">—</span></div>
      </div>
    `;
    document.documentElement.appendChild(evalBox);
    applyBoxPosition();
    attachDragHandlers(evalBox);
    return evalBox;
  }

  function applyBoxPosition() {
    if (!evalBox) return;
    if (boxPos && typeof boxPos.left === "number") {
      evalBox.style.setProperty("left", boxPos.left + "px", "important");
      evalBox.style.setProperty("top", boxPos.top + "px", "important");
      evalBox.style.setProperty("right", "auto", "important");
      evalBox.style.setProperty("bottom", "auto", "important");
    }
  }

  function attachDragHandlers(box) {
    const title = box.querySelector(".sfh-title");
    if (!title) return;

    let dragging = false;
    let offX = 0, offY = 0;

    const onDown = (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      dragging = true;
      const rect = box.getBoundingClientRect();
      offX = ev.clientX - rect.left;
      offY = ev.clientY - rect.top;
      document.body.style.userSelect = "none";
      ev.preventDefault();
    };

    const onMove = (ev) => {
      if (!dragging) return;
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      const x = Math.max(0, Math.min(window.innerWidth - w, ev.clientX - offX));
      const y = Math.max(0, Math.min(window.innerHeight - h, ev.clientY - offY));
      box.style.setProperty("left", x + "px", "important");
      box.style.setProperty("top", y + "px", "important");
      box.style.setProperty("right", "auto", "important");
      box.style.setProperty("bottom", "auto", "important");
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      const rect = box.getBoundingClientRect();
      boxPos = { left: Math.round(rect.left), top: Math.round(rect.top) };
      saveBoxPos();
    };

    title.addEventListener("mousedown", onDown);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);

    title.addEventListener("dblclick", () => {
      boxPos = null;
      browser.storage.local.remove(POS_KEY);
      box.style.removeProperty("left");
      box.style.removeProperty("top");
      box.style.removeProperty("right");
      box.style.removeProperty("bottom");
    });
  }

  function hideEvalBox() {
    if (evalBox) evalBox.style.display = "none";
  }

  function setStatusInBox(text) {
    if (!settings.enabled || !settings.showEval) return;
    const box = ensureEvalBox();
    const pvEl = box.querySelector(".sfh-pv-text");
    if (pvEl) pvEl.textContent = text;
  }

  function cpToWhitePct(cp) {
    const x = Math.max(-1500, Math.min(1500, cp));
    const k = 0.0045;
    return 50 + 50 * (2 / (1 + Math.exp(-k * x)) - 1);
  }

  function updateEvalBar(box, { cp, mate, turn }) {
    const fill = box.querySelector(".sfh-bar-fill");
    const label = box.querySelector(".sfh-bar-label");
    if (!fill || !label) return;

    let whitePct = 50;
    let labelText = "0.0";

    if (mate !== null && mate !== undefined) {
      const m = (turn === "b") ? -mate : mate;
      whitePct = m > 0 ? 100 : 0;
      labelText = "M" + Math.abs(m);
    } else if (cp !== null && cp !== undefined) {
      const c = (turn === "b") ? -cp : cp;
      whitePct = cpToWhitePct(c);
      const val = Math.abs(c / 100);
      labelText = val.toFixed(1);
    } else {
      return;
    }

    fill.style.height = whitePct + "%";

    if (whitePct >= 50) {
      label.style.color = "#1a1a22";
      label.style.bottom = "4px";
      label.style.top = "auto";
    } else {
      label.style.color = "#eaeaea";
      label.style.top = "4px";
      label.style.bottom = "auto";
    }
    label.textContent = labelText;
  }

  function updateEvalBox({ best, cp, mate, depth, pv, turn }) {
    if (!settings.showEval) { hideEvalBox(); return; }
    const box = ensureEvalBox();
    box.style.display = "flex";

    if (best !== undefined) {
      box.querySelector(".sfh-best").textContent = best || "—";
    }
    if (depth !== undefined && depth !== null) {
      box.querySelector(".sfh-depth").textContent = depth;
    }
    if (cp !== undefined || mate !== undefined) {
      let txt = "—";
      if (mate !== null && mate !== undefined) {
        const m = (turn === "b") ? -mate : mate;
        txt = (m > 0 ? "+M" : "-M") + Math.abs(m);
      } else if (cp !== null && cp !== undefined) {
        const c = (turn === "b") ? -cp : cp;
        const val = (c / 100).toFixed(2);
        txt = (c >= 0 ? "+" : "") + val;
      }
      box.querySelector(".sfh-score").textContent = txt;
      updateEvalBar(box, { cp, mate, turn });
    }
    if (pv && pv.length > 0) {
      box.querySelector(".sfh-pv-text").textContent = pv.slice(0, 6).join(" ");
    }
  }

  // ===================================================================
  // Ortak: Tarama
  // ===================================================================
  function scan() {
    if (!settings.enabled || !A) return;

    const board = A.findBoard();
    if (!board) {
      setStatusInBox("⚠ Tahta bulunamadı");
      return;
    }

    const grid = A.readGrid(board);
    const turn = A.detectTurn(board);
    const fen = buildFen(grid, turn);

    const flat = grid.flat().join("");
    if (!flat.includes("K") || !flat.includes("k")) {
      console.warn("[SF-Yardimci] Taşlar okunamadı. Grid:", grid,
        "Tahtadaki piece sayısı:", board.querySelectorAll(".piece, piece").length);
      setStatusInBox("⚠ Taşlar okunamadı (konsola bak)");
      return;
    }

    if (fen === lastFen) return;
    lastFen = fen;

    console.log("[SF-Yardimci/" + A.name + "] FEN:", fen);
    const requestId = ++lastRequestId;
    updateEvalBox({ best: "hesaplanıyor…", cp: null, mate: null, depth: null, pv: [], turn });

    browser.runtime.sendMessage({
      type: "analyze",
      fen,
      depth: settings.depth,
      movetime: settings.movetime,
      multipv: settings.multipv,
      limitStrength: settings.limitStrength,
      elo: settings.elo,
      requestId,
      turn
    }).catch((err) => {
      console.warn("[SF-Yardimci] Analiz isteği gönderilemedi:", err);
      setStatusInBox("⚠ Background'a ulaşılamadı");
    });
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      try { scan(); } catch (e) { console.error("[SF-Yardimci]", e); }
    }, 120);
  }

  // ===================================================================
  // Background mesajları
  // ===================================================================
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.requestId && msg.requestId !== lastRequestId) return;

    if (msg.type === "bestmove") {
      const board = A && A.findBoard();
      if (board) {
        const lines = (msg.lines && msg.lines.length > 0)
          ? msg.lines
          : (msg.move ? [{ move: msg.move }] : []);
        drawArrows(lines, board);

        // Otomatik hamle: sadece kullanıcının sırasıysa ve setting açıksa
        if (settings.autoPlay && msg.move && isUserTurn(board, msg.turn)) {
          const delay = Math.max(0, Math.min(10000, settings.autoPlayDelay || 0));
          setTimeout(() => {
            // Son güvenlik kontrolü — settings hâlâ açık mı, sıra hâlâ bizde mi?
            if (!settings.autoPlay) return;
            const stillBoard = A && A.findBoard();
            if (!stillBoard) return;
            const currentTurn = A.detectTurn(stillBoard);
            if (!isUserTurn(stillBoard, currentTurn)) return;
            makeMove(msg.move, stillBoard);
          }, delay);
        }
      }
      updateEvalBox({ best: msg.move, turn: msg.turn });
    } else if (msg.type === "evaluation") {
      updateEvalBox({
        cp: msg.cp, mate: msg.mate, depth: msg.depth,
        pv: msg.pv, turn: msg.turn
      });
    } else if (msg.type === "engine-error") {
      updateEvalBox({ best: "Motor hatası", cp: null, mate: null, depth: null, pv: [], turn: "w" });
      setStatusInBox(msg.message || "Bilinmeyen motor hatası");
    }
  });

  // ===================================================================
  // Tahta gözlemcisi & polling
  // ===================================================================
  function attachObserver() {
    if (!A) return false;
    const board = A.findBoard();
    if (!board) { observedBoard = null; return false; }
    if (board === observedBoard && observer) return true;

    if (observer) observer.disconnect();
    observer = new MutationObserver(() => scheduleScan());
    observer.observe(board, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"]
    });
    observedBoard = board;
    return true;
  }

  function onUrlChange() {
    lastFen = null;
    observedBoard = null;
    if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
    clearArrow();
    setTimeout(() => {
      selectAdapter();
      ensureEvalBox();
      attachObserver();
      scheduleScan();
    }, 600);
    setTimeout(() => { attachObserver(); scheduleScan(); }, 1800);
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (lastUrl !== location.href) {
        lastUrl = location.href;
        onUrlChange();
        return;
      }
      if (!observedBoard || !document.contains(observedBoard)) {
        if (attachObserver()) scheduleScan();
      } else if (A) {
        const current = A.findBoard();
        if (current && current !== observedBoard) {
          attachObserver();
          scheduleScan();
        }
      }
      if (settings.enabled && settings.showEval &&
          (!evalBox || !document.documentElement.contains(evalBox))) {
        ensureEvalBox();
      }
    }, 800);
  }

  // ===================================================================
  // Başlat
  // ===================================================================
  function init() {
    loadSettings().then(() => {
      selectAdapter();
      attachObserver();
      startPolling();
      scheduleScan();
    });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    window.addEventListener("DOMContentLoaded", init);
  }
})();
