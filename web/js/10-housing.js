// ---- custom house design editor (server-driven "design mode" — scene.houseDesign
// is present ONLY while the player has a foundation open for customization; the
// server (0xBF/0x20 + friends) decides when that starts and ends, this panel only
// REFLECTS scene.houseDesign and never asks to enter/leave design mode on its own).
// The design itself already renders through the ordinary world pipeline (0xD8
// viewing swaps the foundation's components for the current design tiles right in
// the scene — see DESIGN.md), so this panel is purely picker/action chrome; it
// never draws the house. Built dynamically — one window total, like .trade-win/
// .map-win — created when a session starts and torn down when it ends, not rebuilt
// every poll (see refreshHouseDesign's early-out below). ----
const HDESIGN_MODES = ["wall", "door", "floor", "stair", "roof", "misc", "teleporter"];
const HDESIGN_LABELS = { wall: "Wall", door: "Door", floor: "Floor", stair: "Stair", roof: "Roof", misc: "Misc", teleporter: "Teleporter" };
// Catalog JSON key per mode (GET /housecatalog — see loadHouseCatalog).
const HDESIGN_CATALOG_KEY = { wall: "walls", door: "doors", floor: "floors", stair: "stairs", roof: "roofs", misc: "misc", teleporter: "teleporters" };
// wall/roof/misc are CATEGORISED (an array of {category, items:[{comment,graphics}]}
// style groups); floor/door/stair are already a flat [{comment,graphics}] list — see
// hdesignStyles() below, which reduces both shapes to one for the picker.
const HDESIGN_GROUPED = new Set(["wall", "roof", "misc"]);
// Some catalog rows (newer Gargish-era styles, e.g. floors.txt category 52
// "Gargish Green Stone") legitimately list graphics at 0x4000+ — ClassicUO's
// own CustomHouse*.Parse never filters this, it just reflects whatever the
// data files say. But 0x4000 is the MULTI id range, not a placeable item/tile
// id, and ServUO's Designer_Build (`ValidPiece`) masks/rejects anything
// outside the item table it actually loaded — on an ordinary (non-Gargish)
// tiledata install that's every one of these. The rejection is entirely
// silent to the player: the server just drops the piece and appends one line
// to its own comp_val.log ("Invalid ItemID 0x4092" etc.) with no client-
// visible error at all, so a bad selection here is invisible without server
// log access. Treat it exactly like graphic `0` — never offer it, never send it.
const HDESIGN_MAX_GRAPHIC = 0x4000;
let hdesignWin = null;     // the single panel, once built ({ el, styleSel, grid, eraserCb, floorRow, floors })
let hdesignSerial = null;  // houseDesign.serial the panel is currently built for
let hdesignCatalog = null; // GET /housecatalog response — static, fetched once (see loadHouseCatalog)
let hdesignCatalogPromise = null;
let hdesignCatalogError = false;
let hdesignPending = null, hdesignPendingTimer = null, hdesignBusy = false;
let hdesignRoofZ = 0, hdesignConsumedAt = -Infinity, hdesignGeneration = 0;

function hdesignOption(text, value) {
  const option = document.createElement("option"); option.textContent = text; option.value = value; return option;
}
function hdesignStatus(text) {
  if (hdesignWin && hdesignWin.status.textContent !== text) hdesignWin.status.textContent = text;
}
function hdesignToolbar(bar) {
  bar.setAttribute("role", "toolbar"); bar.setAttribute("focusgroup", "toolbar wrap");
  if (typeof HTMLElement !== "undefined" && "focusGroup" in HTMLElement.prototype) return;
  [...bar.querySelectorAll("button")].forEach((b, i) => { b.tabIndex = i ? -1 : 0; });
  // The container outlives its pieces. Install once and query CURRENT controls;
  // retaining a captured button array on each rebuild leaks every old palette.
  if (bar.dataset.hdesignKeys === "ready") return;
  bar.dataset.hdesignKeys = "ready";
  bar.addEventListener("focusin", (e) => {
    const buttons = [...bar.querySelectorAll("button")];
    if (buttons.includes(e.target)) buttons.forEach((b) => { b.tabIndex = b === e.target ? 0 : -1; });
  });
  bar.addEventListener("keydown", (e) => {
    const buttons = [...bar.querySelectorAll("button")];
    const index = buttons.indexOf(e.target); if (index < 0) return;
    const rtl = getComputedStyle(bar).direction === "rtl";
    const step = e.key === "ArrowRight" ? (rtl ? -1 : 1) : e.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
    const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : step ? (index + step + buttons.length) % buttons.length : -1;
    if (next >= 0) { e.preventDefault(); buttons[next].focus(); }
  });
}
async function hdesignSend(cmd, message, waitRevision = false) {
  const hd = scene && scene.houseDesign;
  if (!hd || hd.serial !== hdesignSerial || REPLAY_MODE || sceneReloading || !sceneTransportAvailable) {
    hdesignStatus("Not connected to this design session. Reconnect before editing."); return false;
  }
  if (hdesignBusy || hdesignPending) { hdesignStatus("Waiting for the server. Do not repeat the edit; use Resync if needed."); return false; }
  hdesignBusy = true;
  const sessionId = scene.sessionId || "", serial = hd.serial, generation = hdesignGeneration;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  hdesignStatus(message + " — sending…");
  try {
    const response = await fetch("/input", { method: "POST", headers: { "X-Anima-Session": sessionId }, body: "hdesign:" + cmd, signal: controller.signal });
    if (!response.ok) throw new Error("input rejected");
    if (!hdesignWin || generation !== hdesignGeneration || hdesignSerial !== serial || (scene.sessionId || "") !== sessionId) return false;
    hdesignStatus(message + (waitRevision ? " — waiting for the server design." : " — request sent. Check the server response."));
    const requestedFloor = /^floor:[1-4]$/.test(cmd) ? Number(cmd.split(":")[1]) : null;
    if (requestedFloor && scene.houseDesign?.floor === requestedFloor) { hdesignStatus("Editing floor " + requestedFloor + " confirmed by the server."); }
    else if (waitRevision && scene.houseDesign?.revision !== hd.revision) { hdesignStatus("Server design updated. Commit when ready to save the house."); }
    else if (waitRevision || requestedFloor) {
      hdesignPending = { serial, revision: hd.revision, floor: requestedFloor };
      hdesignPendingTimer = setTimeout(() => {
        hdesignPending = null;
        hdesignStatus("No design change confirmed yet. Check the tile and building rules, then Resync. No edit was retried.");
      }, 5000);
    }
    return true;
  } catch {
    if (generation === hdesignGeneration && hdesignSerial === serial) hdesignStatus("Could not send the request. Check the connection, then Resync before trying again.");
    return false;
  } finally { clearTimeout(timer); if (generation === hdesignGeneration) hdesignBusy = false; }
}

let hdesignMode = "wall";  // active tab
const hdesignStyleIdx = { wall: 0, door: 0, floor: 0, stair: 0, roof: 0, misc: 0, teleporter: 0 }; // remembered <select> pick per mode
let hdesignPiece = null;   // { mode, graphic } currently selected to place, or null (nothing to place yet)
let hdesignEraser = false; // eraser toggle: a ground click deletes instead of placing
let hdesignFloor = 1;      // active floor confirmed by the server player position

// Static per-server catalog (same shape for every foundation) — fetch once and cache
// forever, same pattern as loadDyedPalette() above; re-entering design mode later
// (even for a different house) reuses it rather than refetching.
function loadHouseCatalog() {
  if (hdesignCatalog) return Promise.resolve(hdesignCatalog);
  if (!hdesignCatalogPromise) {
    hdesignCatalogError = false;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    hdesignCatalogPromise = fetch("/housecatalog", { signal: controller.signal })
      .then((r) => { if (!r.ok) throw new Error("catalog unavailable"); return r.json(); })
      .then((data) => {
        if (!data || !Object.values(HDESIGN_CATALOG_KEY).every((key) => Array.isArray(data[key]))) throw new Error("invalid catalog");
        hdesignCatalog = data; return data;
      })
      .catch(() => { hdesignCatalogError = true; hdesignCatalogPromise = null; return null; })
      .finally(() => {
        clearTimeout(timer);
        if (hdesignWin) {
          renderHouseDesignPicker();
          if (!hdesignCatalogError) hdesignStatus("Catalog ready. Choose a piece, then click the foundation or enter tile coordinates.");
        }
      });
  }
  return hdesignCatalogPromise;
}

// Reduce either catalog shape (grouped wall/roof/misc vs flat floor/door/stair) to
// one list of {comment, graphics, group} "styles" for the active mode's picker.
// `group` carries the server's numeric category (grouped modes only) as an optgroup
// label — it's purely cosmetic, nothing gates on it.
function hdesignStyles(mode) {
  const key = HDESIGN_CATALOG_KEY[mode];
  const list = (hdesignCatalog && hdesignCatalog[key]) || [];
  if (!HDESIGN_GROUPED.has(mode)) return list.filter((it) => it && Array.isArray(it.graphics)).map((it) => ({ ...it, comment: it.comment, graphics: it.graphics, group: null }));
  const out = [];
  for (const cat of list) {
    for (const it of (cat && Array.isArray(cat.items) ? cat.items : [])) {
      if (!it || !Array.isArray(it.graphics)) continue;
      out.push({ comment: it.comment, graphics: it.graphics || [], group: "Category " + (cat.category | 0) });
    }
  }
  return out;
}

// Rebuild the grid of clickable piece art for one style (or clear it if none is
// selected yet / the mode has no styles). Graphic `0` means "no piece in this slot"
// (a style's list is padded to a fixed width), and graphic >= HDESIGN_MAX_GRAPHIC
// means "the server will silently drop this" (see that constant's doc) — both
// skipped, never rendered as a clickable cell and so never selectable/sendable.
function renderHouseDesignGrid(style) {
  if (!hdesignWin) return;
  const grid = hdesignWin.grid;
  grid.replaceChildren();
  if (!style) return;
  const pieces = [];
  (style.graphics || []).forEach((art, index) => {
    if (!Number.isInteger(art) || art <= 0 || art >= HDESIGN_MAX_GRAPHIC) return;
    if (hdesignMode === "stair" && index < 4) {
      const multi = style.multis && style.multis[index];
      if (Number.isInteger(multi) && multi > 0 && multi <= 65535)
        pieces.push({ graphic: multi, command: "stair", art, label: "Staircase " + ["North", "East", "South", "West"][index] });
    } else pieces.push({ graphic: art, command: "add", art, label: "Tile " + art.toString(16).toUpperCase() });
  });
  for (const piece of pieces) {
    const cell = document.createElement("button"); cell.type = "button";
    cell.className = "hdesign-piece";
    cell.setAttribute("aria-label", `${style.comment || HDESIGN_LABELS[hdesignMode]}: ${piece.label}`);
    cell.setAttribute("aria-pressed", String(!!hdesignPiece && hdesignPiece.mode === hdesignMode && hdesignPiece.graphic === piece.graphic));
    const img = document.createElement("img"); img.alt = ""; img.className = "hdesign-piece-icon";
    img.src = `art/static/${piece.art}.png`; img.onerror = () => { img.hidden = true; };
    const caption = document.createElement("span"); caption.textContent = piece.label;
    cell.append(img, caption);
    cell.addEventListener("click", () => {
      hdesignPiece = { mode: hdesignMode, ...piece }; hdesignEraser = false; hdesignWin.eraserCb.checked = false;
      grid.querySelectorAll("button").forEach((c) => c.setAttribute("aria-pressed", String(c === cell)));
      hdesignStatus(`${HDESIGN_LABELS[hdesignMode]} selected: ${piece.label}. Click the foundation, or enter a tile below.`);
      clearHouseDesignGhost();
    });
    grid.appendChild(cell);
  }
  if (!pieces.length) { const note = document.createElement("p"); note.textContent = "No supported pieces in this style. Choose another style."; grid.appendChild(note); }
  hdesignToolbar(grid);
}
// Rebuild the style <select> for the active mode (labelled by each style's own
// `comment`, grouped into <optgroup>s for wall/roof/misc) and its piece grid below
// it. Called on every tab switch and once the catalog finishes loading.
function renderHouseDesignPicker() {
  if (!hdesignWin) return;
  const sel = hdesignWin.styleSel;
  hdesignWin.retry.hidden = !hdesignCatalogError;
  if (!hdesignCatalog) {
    sel.replaceChildren(hdesignOption(hdesignCatalogError ? "Catalog unavailable" : "Loading catalog…", ""));
    sel.disabled = true; renderHouseDesignGrid(null);
    hdesignStatus(hdesignCatalogError ? "Building catalog could not load. Retry catalog to choose pieces. Existing pieces can still be erased." : "Loading the building catalog…");
    return;
  }
  sel.disabled = false;
  const styles = hdesignStyles(hdesignMode);
  const grouped = HDESIGN_GROUPED.has(hdesignMode);
  const kids = [];
  let group = null;
  styles.forEach((st, i) => {
    const opt = hdesignOption(st.comment || ("Style " + i), String(i));
    if (grouped) {
      if (!group || group.label !== st.group) { group = document.createElement("optgroup"); group.label = st.group; kids.push(group); }
      group.appendChild(opt);
    } else {
      kids.push(opt);
    }
  });
  sel.replaceChildren(...(kids.length ? kids : [hdesignOption("(none)", "")]));
  const idx = Math.min(hdesignStyleIdx[hdesignMode] || 0, Math.max(0, styles.length - 1));
  sel.value = String(idx);
  renderHouseDesignGrid(styles[idx] || null);
}
// Rebuild the 1..floors button row (only called when the panel is first built or
// `floors` actually changes — see refreshHouseDesign).
function renderHouseDesignFloors() {
  if (!hdesignWin) return;
  const row = hdesignWin.floorRow;
  const focusedFloor = row.contains(document.activeElement) ? document.activeElement.dataset.floor : null;
  row.innerHTML = "";
  for (let n = 1; n <= hdesignWin.floors; n++) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "dlg-btn hdesign-floor-btn";
    b.setAttribute("aria-pressed", String(n === hdesignFloor));
    b.setAttribute("aria-label", "Floor " + n); b.dataset.floor = String(n);
    b.textContent = String(n);
    b.addEventListener("click", () => {
      hdesignSend("floor:" + n, "Floor " + n + " requested");
    });
    row.appendChild(b);
  }
  hdesignToolbar(row);
  if (focusedFloor) (row.querySelector(`[data-floor="${focusedFloor}"]`) || row.querySelector("button"))?.focus();
}
function closeHouseDesignWindow() {
  if (hdesignWin) { hdesignWin.el.remove(); hdesignWin = null; }
  hdesignSerial = null; hdesignGeneration++; clearTimeout(hdesignPendingTimer); hdesignPending = null; hdesignBusy = false;
  clearHouseDesignGhost(); // don't leave a stale ghost sprite behind once the session/panel is gone
}
function buildHouseDesignWindow(hd) {
  hdesignGeneration++;
  const { el, body } = makeWindowFrame({
    cls: "hdesign-win", title: "House Design", pos: { left: Math.max(8, Math.min(260, innerWidth - 360)), top: 40 },
    onClose: () => hdesignSend("close", "Exit requested; uncommitted changes are not a saved house"),
  });
  el.setAttribute("role", "region"); el.setAttribute("aria-label", "House design editor");
  const closer = el.querySelector(".gump-close"); closer.textContent = "";
  const closeButton = document.createElement("button"); closeButton.type = "button"; closeButton.textContent = "×";
  closeButton.setAttribute("aria-label", "Exit house design"); closer.appendChild(closeButton);
  el.addEventListener("keydown", (e) => {
    e.stopPropagation(); // editor navigation must never walk, cast or open chat
    if (e.key === "Escape") { hdesignPiece = null; hdesignEraser = false; hdesignWin.eraserCb.checked = false; clearHouseDesignGhost(); renderHouseDesignPicker(); hdesignStatus("Tool cleared. Your working design is unchanged."); }
  });
  body.innerHTML =
    '<p class="hdesign-help">Choose a piece, then click your foundation. Commit opens the server confirmation; a request alone does not save the house.</p><div class="hdesign-tabs" aria-label="Piece category">' + HDESIGN_MODES.map((m) =>
        `<button type="button" class="hdesign-tab" aria-pressed="${m === hdesignMode}" data-mode="${m}">${HDESIGN_LABELS[m]}</button>`).join("")
    + '</div>'
    + '<label for="hdesign-style">Building style</label><select id="hdesign-style" class="hdesign-style"></select><button type="button" class="dlg-btn hdesign-retry" hidden>Retry catalog</button>'
    + '<div class="hdesign-grid" aria-label="Building pieces"></div>'
    + '<label class="hdesign-eraser"><input type="checkbox" class="hdesign-eraser-cb"> Eraser (click deletes)</label>'
    + '<p class="hdesign-floor-label">Editing floor <span class="hdesign-floor-value">1</span></p><div class="hdesign-floor-row" aria-label="Editing floor"></div>'
    + '<label for="hdesign-roof">Roof height above this floor</label><select id="hdesign-roof" class="hdesign-roof"><option value="-3">−3</option><option value="0" selected>0</option><option value="3">+3</option><option value="6">+6</option><option value="9">+9</option><option value="12">+12</option></select>'
    + '<details class="hdesign-coordinates"><summary>Place or erase by tile</summary><p>Offsets from the foundation center. Useful with a keyboard or overlapping pieces.</p><div class="hdesign-xy"><label>X <input class="hdesign-x" type="number" step="1" value="0"></label><label>Y <input class="hdesign-y" type="number" step="1" value="0"></label></div><button type="button" class="dlg-btn hdesign-apply">Apply to tile</button></details>'
    + '<p class="hdesign-status" role="status" aria-atomic="true"></p>'
    + '<div class="hdesign-actions" role="group" aria-label="Design actions">'
    + '<button type="button" class="dlg-btn" data-cmd="commit">Commit</button>'
    + '<button type="button" class="dlg-btn" data-cmd="revert">Revert</button>'
    + '<button type="button" class="dlg-btn" data-cmd="backup">Backup</button>'
    + '<button type="button" class="dlg-btn" data-cmd="restore">Restore</button>'
    + '<button type="button" class="dlg-btn" data-cmd="clear">Clear</button>'
    + '<button type="button" class="dlg-btn" data-cmd="close">Exit</button><button type="button" class="dlg-btn" data-cmd="sync">Resync</button>'
    + '</div>';
  hdesignWin = {
    el,
    status: el.querySelector(".hdesign-status"), retry: el.querySelector(".hdesign-retry"),
    styleSel: el.querySelector(".hdesign-style"),
    grid: el.querySelector(".hdesign-grid"),
    eraserCb: el.querySelector(".hdesign-eraser-cb"),
    floorRow: el.querySelector(".hdesign-floor-row"),
    floors: hd.floors | 0,
  };
  // (The ✕ is wired in makeWindowFrame above: like the Exit action it only ASKS
  // the server to leave design mode. The panel disappears when scene.houseDesign
  // actually goes away — dismiss:"none" on the family, because the panel never
  // decides for itself that the session is over.)
  el.querySelectorAll(".hdesign-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      hdesignMode = btn.dataset.mode; hdesignPiece = null; clearHouseDesignGhost();
      el.querySelectorAll(".hdesign-tab").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      renderHouseDesignPicker();
    });
  });
  hdesignWin.styleSel.addEventListener("change", () => {
    hdesignPiece = null; clearHouseDesignGhost();
    hdesignStyleIdx[hdesignMode] = parseInt(hdesignWin.styleSel.value, 10) || 0;
    renderHouseDesignGrid(hdesignStyles(hdesignMode)[hdesignStyleIdx[hdesignMode]] || null);
  });
  hdesignWin.eraserCb.addEventListener("change", () => { hdesignEraser = hdesignWin.eraserCb.checked; clearHouseDesignGhost(); hdesignStatus(hdesignEraser ? "Eraser active. Click an existing piece; no catalog selection is needed." : "Choose a piece to place."); });
  el.querySelectorAll(".hdesign-actions [data-cmd]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cmd = btn.dataset.cmd;
      // Commit and Clear are destructive (finalizes the layout / wipes it back to an
      // empty foundation) — confirm first, matching the character-delete confirm.
      if (cmd === "commit" && !window.confirm("Commit this house design? This finalizes the layout.")) return;
      if (cmd === "clear" && !window.confirm("Clear the entire design back to an empty foundation? This cannot be undone.")) return;
      if ((cmd === "revert" || cmd === "restore") && !window.confirm("Replace the current working design with the " + (cmd === "revert" ? "last committed house" : "backup") + "?")) return;
      if (cmd === "sync") { clearTimeout(hdesignPendingTimer); hdesignPending = null; }
      hdesignSend(cmd, cmd === "commit" ? "Commit requested. Review the server confirmation and cost" : btn.textContent + " requested", ["clear", "revert", "restore"].includes(cmd));
    });
  });
  hdesignToolbar(el.querySelector(".hdesign-tabs"));
  hdesignWin.retry.addEventListener("click", () => { loadHouseCatalog(); renderHouseDesignPicker(); });
  el.querySelector(".hdesign-roof").addEventListener("change", (e) => { hdesignRoofZ = Number(e.target.value); clearHouseDesignGhost(); });
  el.querySelector(".hdesign-apply").addEventListener("click", () => {
    const xInput = el.querySelector(".hdesign-x"), yInput = el.querySelector(".hdesign-y");
    if (!xInput.value.trim() || !yInput.value.trim()) { hdesignStatus("Enter both X and Y tile offsets before applying a tool."); return; }
    applyHouseDesignTile(Number(xInput.value), Number(yInput.value));
  });
  el.querySelector(".hdesign-floor-value").textContent = String(hdesignFloor);
  renderHouseDesignFloors();
  renderHouseDesignPicker();
}
// Show/hide the panel to match scene.houseDesign (absent outside design mode — see
// this section's opening comment) and keep its floor-count in sync. Cheap early-out:
// once the panel exists for the current house, an ordinary poll (only `revision`
// ticking as pieces are added) has nothing here to react to — the design itself
// renders through the normal world/tile pipeline, not this panel.
registerDialog({
  id: "houseDesign",
  source: (scene) => (scene && scene.houseDesign ? [scene.houseDesign] : []),
  key: (hd) => hd.serial >>> 0,
  // Only the floor count can change under a live session; `revision` ticks on
  // every placed piece and must NOT rebuild the panel (the design itself renders
  // through the world/tile pipeline, not here).
  sig: (hd) => [hd.floors, hd.floor, hd.revision, hd.tilesReady].join(":"),
  // dismiss:"none" — the ✕ asks the SERVER to end the session (hdesign:close)
  // and this panel waits for that to land, so there is never a locally-closed
  // window for a stale snapshot to resurrect.
  build: (hd, { key }) => {
    hdesignSerial = key;
    hdesignFloor = hd.floor || 1; hdesignRoofZ = 0; hdesignPiece = null; hdesignEraser = false; // fresh session, fresh picker state
    buildHouseDesignWindow(hd);
    loadHouseCatalog();
    return hdesignWin;
  },
  update: (win, hd) => {
    const changed = win.floors !== hd.floors || hdesignFloor !== (hd.floor || 1);
    win.floors = hd.floors; hdesignFloor = hd.floor || 1;
    win.el.querySelector(".hdesign-floor-value").textContent = String(hdesignFloor);
    if (changed) { renderHouseDesignFloors(); clearHouseDesignGhost(); }
    if (hdesignPending && (hdesignPending.floor ? hd.floor === hdesignPending.floor : hd.revision !== hdesignPending.revision)) {
      clearTimeout(hdesignPendingTimer); hdesignPending = null;
      hdesignStatus("Server design updated. Commit when ready to save the house.");
    }
  },
  close: closeHouseDesignWindow,
});
// Use authoritative relative bounds/tiles, never a guessed scene tile or the
// selected palette graphic, to erase. Roof additions use the protocol's height
// offset above the current floor; deletion uses the actual tile's relative z.
// Scene/static pointer hits take priority; keyboard tile application selects the
// highest piece in the current floor band. The server remains the final authority.
function houseDesignTileAllowed(dx, dy) {
  const hd = scene && scene.houseDesign, b = hd && hd.bounds;
  return !!hd && hd.tilesReady === true && Number.isInteger(dx) && Number.isInteger(dy) && !!b &&
    dx >= b.minX && dx <= b.maxX && dy >= b.minY && dy <= b.maxY;
}
function applyHouseDesignTile(dx, dy, picked = null) {
  const hd = scene && scene.houseDesign;
  if (!houseDesignTileAllowed(dx, dy)) { hdesignStatus("Choose a tile inside the loaded foundation. Resync if the design is still loading."); return; }
  if (hdesignEraser) {
    const tiles = (hd.tiles || []).filter((t) => t.x === dx && t.y === dy && (!picked || (t.graphic === picked.graphic && t.z === picked.z)));
    const tile = picked ? tiles[0] : tiles.filter((t) => t.z >= (hd.floorZ - 3) && t.z < hd.floorZ + 20).sort((a, b) => b.z - a.z)[0];
    if (!tile) { hdesignStatus("No design piece on that tile and floor. Click the piece itself, or choose another tile."); return; }
    const roof = hdesignStyles("roof").some((style) => style.graphics.includes(tile.graphic));
    hdesignSend(`${roof ? "roofdel" : "del"}:${tile.graphic}:${dx}:${dy}:${tile.z}`, "Erase requested", true);
  } else {
    if (!hdesignPiece) { hdesignStatus("Choose a building piece first, or turn on Eraser."); return; }
    const { mode, graphic, command } = hdesignPiece;
    if (mode === "roof" && ![-3, 0, 3, 6, 9, 12].includes(hdesignRoofZ)) { hdesignStatus("Choose a supported roof height."); return; }
    const cmd = mode === "roof" ? `roof:${graphic}:${dx}:${dy}:${hdesignRoofZ}` : `${command || "add"}:${graphic}:${dx}:${dy}`;
    hdesignSend(cmd, "Place requested", true);
  }
}
function handleHouseDesignStatic(st) {
  const hd = scene && scene.houseDesign;
  if (!hd || !hdesignEraser) return false;
  const dx = st.x - hd.x, dy = st.y - hd.y, z = st.z - hd.z;
  if (!(hd.tiles || []).some((t) => t.x === dx && t.y === dy && t.z === z && t.graphic === st.g)) return false;
  hdesignConsumedAt = performance.now(); applyHouseDesignTile(dx, dy, { graphic: st.g, z }); return true;
}
function handleHouseDesignClick(e) {
  const hd = scene && scene.houseDesign;
  if (!hd) return false;
  if (performance.now() - hdesignConsumedAt < 200) return true;
  const g = clientToGlobal(e.clientX, e.clientY), t = groundTileAt(g.x, g.y);
  applyHouseDesignTile(t.x - hd.x, t.y - hd.y);
  return true;
}

// The worn backpack is the equip entry on layer 21 (0x15).
function backpackSerial() {
  const p = scene && scene.player;
  if (!p || !p.equip) return null;
  const bp = p.equip.find((e) => e.layer === BACKPACK_LAYER);
  return bp ? (bp.serial >>> 0) : null;
}
// Open the backpack window AND ask the server to push its latest contents.
function openBackpack() {
  const s = backpackSerial();
  if (s == null) return;
  openContainer(s);
  sendInput("use:" + s);
}
// Rebuild the paperdoll body only when stats/equip actually changed (no flicker).
function refreshPaperdoll() {
  if (!paperdollOn) return;
  const pd = document.getElementById("paperdoll"), body = document.getElementById("pd-body");
  // Source: our own doll (pdTarget null) → scene.player; else the clicked mobile.
  const isSelf = pdTarget == null;
  const p = isSelf ? (scene && scene.player)
    : ((scene && scene.mobiles) || []).find((m) => (m.serial >>> 0) === (pdTarget >>> 0));
  if (!p) {
    set("pd-name", "—");
    body.innerHTML = '<div class="cont-empty">' + (isSelf ? "no character data" : "(out of view)") + "</div>";
    return;
  }
  const equip = (p.equip || []).slice().sort((a, b) => (a.layer | 0) - (b.layer | 0));
  // Prefer the server's own title line (0x88 DisplayPaperdoll — e.g. "Anima the
  // Adventurer") over the plain mobile name, when it's for THIS target.
  const targetSerial = isSelf ? ((scene && scene.player && scene.player.serial) >>> 0) : (pdTarget >>> 0);
  const serverTitle = (pdServerInfo && (pdServerInfo.serial >>> 0) === targetSerial) ? pdServerInfo.title : null;
  const sig = [isSelf ? "s" : pdTarget, p.name, serverTitle, p.str, p.dex, p.int, p.hits, p.hitsMax, p.mana, p.manaMax,
    p.stam, p.stamMax, p.gold, p.body, p.hue,
    // Include each item's OPL name so the list re-renders (slot label → real name)
    // the moment its OPL arrives.
    equip.map((e) => `${e.layer}:${e.g}:${e.hue | 0}:${e.serial >>> 0}:${oplName(e.serial)}`).join(",")].join("|");
  if (pd._sig === sig) return;
  pd._sig = sig;
  set("pd-name", serverTitle || p.name || (isSelf ? "(unnamed)" : "(mobile)"));
  // The paperdoll DOLL: the base body gump (male 0x0C / female 0x0D) hued by skin,
  // then each worn item's paperdoll gump (AnimID + gender offset, hued by item),
  // stacked back→front at the same origin (ClassicUO style). Held weapons included.
  const female = p.body === 401 || p.body === 403;
  const dollBody = female ? 13 : 12;
  const gOff = female ? FEMALE_GUMP_OFFSET : MALE_GUMP_OFFSET;
  const skinQ = p.hue ? `?hue=${p.hue}` : "";
  const byLayer = {};
  for (const e of equip) if ((e.anim | 0) > 0) byLayer[e.layer] = e;
  let h = `<div id="pd-doll"><img src="gump/${dollBody}.png${skinQ}" alt="" crossorigin="anonymous">`;
  for (const layer of PAPERDOLL_ORDER) {
    // Layer 15 (Face) is a server pseudo-item — the face is already part of the body
    // gump and has no paperdoll art, so drawing it 404'd and showed a broken-image
    // "?" at the doll's top-left. Skip it here too (the equip list already skips it).
    if (layer === 15) continue;
    const e = byLayer[layer];
    if (!e) continue;
    const hueQ = e.hue ? `?hue=${e.hue}` : "";
    // Equipconv.def override: the server already resolved a gender-correct
    // absolute gump id (anima-net `equip_conv_gump`) when this item's (wearer
    // body, AnimID) has a conversion — use it as-is. Otherwise fall back to the
    // plain AnimID + gender-offset convention.
    const gid = e.gump != null ? e.gump : e.anim + gOff;
    // Hide any item whose paperdoll gump is missing rather than show a broken "?".
    // Female items (no explicit override) may lack a female gump → fall back to
    // the male offset first; an explicit `gump` is already gender-resolved, so it
    // just hides on error instead of guessing another id.
    const hide = "this.onerror=null;this.style.display='none'";
    const onerr = (e.gump == null && female)
      ? `this.onerror=function(){${hide}};this.src='gump/${e.anim + MALE_GUMP_OFFSET}.png${hueQ}'`
      : hide;
    // Tag each layer so hovering the figure (per-pixel hit-test) can resolve the item.
    h += `<img src="gump/${gid}.png${hueQ}" alt="" crossorigin="anonymous" draggable="false"`
      + ` data-serial="${e.serial >>> 0}" data-layer="${e.layer}" data-g="${e.g}" data-hue="${e.hue | 0}" onerror="${onerr}">`;
  }
  h += "</div>";
  // Stats: our own doll shows the full sheet; another mobile shows only what the
  // server actually sent for it (usually name + HP, sometimes nothing).
  h += '<div class="pd-stats">';
  if (p.str != null) h += `<div class="row"><span class="k">STR / DEX / INT</span><span>${p.str} / ${p.dex} / ${p.int}</span></div>`;
  if ((p.hitsMax | 0) > 0) h += `<div class="row"><span class="k">HP</span><span>${p.hits} / ${p.hitsMax}</span></div>`;
  if (isSelf) {
    h += `<div class="row"><span class="k">Mana</span><span>${p.mana} / ${p.manaMax}</span></div>`;
    h += `<div class="row"><span class="k">Stamina</span><span>${p.stam} / ${p.stamMax}</span></div>`;
    h += `<div class="row"><span class="k">Gold</span><span>${p.gold}</span></div>`;
  }
  h += "</div>";
  h += `<div class="pd-profile-actions"><button type="button" class="dlg-btn pd-profile"`
    + ` data-profile="${targetSerial}">PROFILE</button></div>`;
  // Appearance: hair & facial hair are part of the body, not worn gear — show them
  // in their own section with an inline dye-colour swatch (no OPL/weight/AR exists).
  const hairItems = equip.filter((e) => e.layer === 11 || e.layer === 16);
  if (hairItems.length) {
    h += '<div id="pd-appear">';
    for (const e of hairItems) {
      const nm = e.layer === 11 ? "Hair" : "Beard";
      const hue = e.hue | 0;
      h += `<div class="ap-row"><span class="ap-k">${nm}</span>`
        + (hue ? `<span class="hue-sw" data-hue="${hue}"></span><span class="ap-hue">Hue ${hue & 0x3FFF}</span>`
               : '<span class="ap-hue">default</span>')
        + "</div>";
    }
    h += "</div>";
  }
  h += '<div id="pd-equip">';
  // Worn gear only. Hair (11) / beard (16) are shown in Appearance above; the Face
  // layer (15) is the character's virtual face (a server pseudo-item with no real
  // item art → it rendered as the "UNUSED" placeholder), not wearable gear — skip it.
  const worn = equip.filter((e) => e.layer !== 11 && e.layer !== 16 && e.layer !== 15);
  if (!worn.length) h += '<div class="cont-empty">(nothing equipped)</div>';
  for (const e of worn) {
    const serial = e.serial >>> 0;
    // Show the REAL item name (OPL line 0, e.g. "wide-brim hat") rather than the
    // generic slot label ("Head"). Request the OPL once; until it lands we show
    // the slot name as a placeholder, then re-render swaps in the real name.
    const nm = oplName(serial);
    if (!nm && !oplReq.has(serial)) { oplReq.add(serial); sendInput("oplreq:" + serial); }
    const slot = nm || EQUIP_SLOTS[e.layer] || ("Layer " + e.layer);
    // Backpack: our own → open it; another mobile's → SNOOP (a crime, warned).
    const isBp = e.layer === BACKPACK_LAYER;
    const attr = isBp ? (isSelf ? ' data-bp="1"' : ' data-snoop="1"') : "";
    // Tint the icon by the item's dye hue (server recolors the tile via ?hue=), so a
    // dyed robe/cloak/etc. shows its real colour in the list instead of base art.
    const hueQ = (e.hue | 0) ? `?hue=${e.hue | 0}` : "";
    h += `<div class="eq-row${isBp ? " bp" : ""}"${attr}>`
      + `<img class="eq-icon" src="art/static/${e.g}.png${hueQ}" alt="" draggable="false"`
      + ` data-serial="${e.serial >>> 0}" data-g="${e.g}" data-amount="1"`
      + ` data-layer="${e.layer}" data-hue="${e.hue | 0}"`
      + ` onerror="this.style.visibility='hidden'">`
      + `<span class="eq-slot">${slot}</span>`
      + (isBp ? `<span class="eq-open">${isSelf ? "open" : "snoop"} ▸</span>` : "")
      + "</div>";
  }
  h += "</div>";
  body.innerHTML = h;
  applyHueSwatches();
}
// Fill the inline hair/beard colour swatches (async hue→rgb; re-applied on load).
function applyHueSwatches() {
  const pd = document.getElementById("pd-body");
  if (!pd) return;
  for (const sw of pd.querySelectorAll(".hue-sw[data-hue]")) {
    const hx = hueHex((+sw.dataset.hue) | 0);
    if (hx) sw.style.background = hx;
  }
}
// Fill the character-creation wizard's appearance swatches (step 4) — same
// async hue→rgb pattern as applyHueSwatches above, scoped to `.wiz-hue` since
// the wizard and the paperdoll are never mounted at the same time but share
// the same cache/fetch path.
function applyWizHueSwatches() {
  for (const sw of document.querySelectorAll(".wiz-hue[data-hue]")) {
    const hx = hueHex((+sw.dataset.hue) | 0);
    if (hx) sw.style.background = hx;
  }
}

// --- container windows (one per serial; openContainer focuses an existing one) ---
const containerCascade = { n: 0, left: 220, top: 70, wrap: 9, step: 26 };
// Item graphics that are spellbooks (double-click opens the spell-cast UI, not a
// container). Magery 0x0EFA plus the AOS+ school books for completeness.
const SPELLBOOK_GRAPHICS = new Set([0x0efa, 0x2252, 0x2253, 0x238c, 0x23a0, 0x2d50, 0x2d9d]);
function isSpellbook(g) { return SPELLBOOK_GRAPHICS.has((g | 0) & 0xffff); }

// Amount-tiered stackables show a bigger pile as the stack grows, like the real UO
// client: gold coins (0x0EED) become a small pile (0x0EEE) then a big pile (0x0EEF).
function stackGraphic(g, amount) {
  if ((g | 0) === 0x0eed) return amount > 5 ? 0x0eef : amount > 1 ? 0x0eee : 0x0eed;
  return g | 0;
}
// `?hue=<n>` for an item art request, or "" when the item is undyed. The server
// recolors the tile (partial-hue items already carry bit 0x8000 — see scene.rs
// `item_art_hue`), so every icon of a dyed item — grid cell, trade cell, vendor
// row, drag ghost — asks for it the same way.
function hueQuery(hue) {
  return (hue | 0) ? `?hue=${hue | 0}` : "";
}

// ClassicUO's corpse gump id. The container's own art is what identifies it —
// `scene.contGumps` carries the id ServUO named on 0x24 — rather than the
// corpse item's graphic, which we may not have in view.
const CORPSE_GUMP = 9;
// Natural pixel width of each container gump, learned from the loaded <img> and
// cached by gump id so an authentic window sizes to the art synchronously on
// reopen (no 252→art flash). Browser-side because the play server ships no gump
// dimensions and the texture is already loaded for free.
const gumpArtSize = new Map();
// Per-gump container open/close sounds, ported from ClassicUO's ContainerManager
// defaults (`[gumpId] = new ContainerData(gump, OPEN, CLOSE, ...)`). Only the
// non-silent gumps are listed; anything absent is silent, exactly as ClassicUO's
// `Get()` returns a default with sound 0. The sounds are keyed by the 0x24 gump
// id, which is what we already hold in `scene.contGumps`. Corpses (gump 9) and
// most special gumps are silent and so simply not here.
const CONTAINER_SOUNDS = {
  0x3C:[0x48,0x58], 0x3D:[0x48,0x58], 0x3E:[0x2F,0x2E], 0x3F:[0x4F,0x58], 0x40:[0x2D,0x2C],
  0x41:[0x4F,0x58], 0x42:[0x2D,0x2C], 0x43:[0x2D,0x2C], 0x44:[0x2D,0x2C], 0x48:[0x2F,0x2E],
  0x49:[0x2D,0x2C], 0x4A:[0x2D,0x2C], 0x4B:[0x2D,0x2C], 0x4C:[0x2D,0x2C], 0x4D:[0x2F,0x2E],
  0x4E:[0x2D,0x2C], 0x4F:[0x2D,0x2C], 0x51:[0x2F,0x2E], 0x102:[0x4F,0x58], 0x103:[0x48,0x58],
  0x104:[0x2F,0x2E], 0x105:[0x2F,0x2E], 0x106:[0x2F,0x2E], 0x107:[0x2F,0x2E], 0x108:[0x4F,0x58],
  0x109:[0x2D,0x2C], 0x10A:[0x2D,0x2C], 0x10B:[0x2D,0x2C], 0x10C:[0x2F,0x2E], 0x10D:[0x2F,0x2E],
  0x10E:[0x2F,0x2E], 0x2A63:[0x187,0x1C9], 0x775E:[0x48,0x58], 0x7760:[0x48,0x58], 0x7762:[0x48,0x58],
};
// ClassicUO `ContainerData.IconizedGraphic` + `MinimizerArea` (always 16×16).
// Only the gumps that actually ship an iconized art + pin; the rest cannot
// collapse (`IconizedGraphic == 0` → empty MinimizerArea).
const CONTAINER_ICONIZE = {
  0x3C: { icon: 0x50, mx: 105, my: 162 },
  0x775E: { icon: 0x775F, mx: 105, my: 178 },
  0x7760: { icon: 0x7761, mx: 105, my: 178 },
  0x7762: { icon: 0x7763, mx: 105, my: 178 },
};
const CONT_MIN_DRAG = 5; // ClassicUO MIN_PICKUP_DRAG_DISTANCE_PIXELS
function containerScaleFor(gump) {
  return (gump === 0x091A || gump === 0x092E)
    ? 1
    : Math.max(50, Math.min(200, (settings.containerScale | 0) || 100)) / 100;
}
function sizeContainerToGump(win, gumpId, scale) {
  const sizeTo = (w) => {
    const sw = Math.round(w * scale);
    win.el.style.width = (sw + 2) + "px";
    win.body.style.width = w + "px";
  };
  const known = gumpArtSize.get(gumpId);
  if (known) sizeTo(known);
  return sizeTo;
}
function applyContainerMinimized(win, gump) {
  const spec = CONTAINER_ICONIZE[gump];
  if (!spec || !win.minimized) {
    win.el.classList.remove("cont-iconized");
    return;
  }
  win.el.classList.add("cont-iconized");
  const scale = containerScaleFor(gump);
  const sizeTo = sizeContainerToGump(win, spec.icon, scale);
  const bg = win.body.querySelector(".cont-bg");
  if (!bg) return;
  bg.src = `gump/${spec.icon}.png`;
  bg.onload = () => { gumpArtSize.set(spec.icon, bg.naturalWidth); sizeTo(bg.naturalWidth); };
}
function attachContainerMinimizer(win, gump) {
  const spec = CONTAINER_ICONIZE[gump];
  if (!spec) return;
  const hit = document.createElement("div");
  hit.className = "cont-min";
  hit.style.left = spec.mx + "px";
  hit.style.top = spec.my + "px";
  hit.title = "Minimize";
  hit.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const ox = e.clientX, oy = e.clientY;
    const up = (ev) => {
      window.removeEventListener("mouseup", up);
      if (ev.button !== 0) return;
      // ClassicUO skips minimize while an item is on the cursor
      // (`ItemHold.Enabled`) and when the press became a drag.
      if (cursorItem) return;
      if (Math.abs(ev.clientX - ox) < CONT_MIN_DRAG && Math.abs(ev.clientY - oy) < CONT_MIN_DRAG) {
        win.minimized = true;
        applyContainerMinimized(win, gump);
      }
    };
    window.addEventListener("mouseup", up);
  });
  win.body.appendChild(hit);
}
// Play a container open/close sound, respecting the same mute/sfx gate the
// server-sound path uses (playSfx itself does not check it).
function containerSfx(id) {
  if (id && !audioMuted && settings.sfx && typeof playSfx === "function") playSfx(id);
}
function isCorpseContainer(serial) {
  return ((scene && scene.contGumps && scene.contGumps[String(serial >>> 0)]) | 0) === CORPSE_GUMP;
}
// One-click loot: pick the item up and drop it into the pack with **no
// position**, which is a real wire value and not a guess — ServUO's
// `Item.DropToItem` reads `x == -1 && y == -1` (0xFFFF on the wire, as Int16)
// as "onto the container" and routes to `Container.DropItem`, which places it
// itself. ServUO uses the same sentinel internally
// (`DropToItem(from, pack, new Point3D(-1, -1, 0))`), and ClassicUO's
// `GameActions.GrabItem` is exactly this pair of packets.
//
// The lift is required: a drop with nothing held is discarded server-side.
function grabItem(serial) {
  const bp = backpackSerial();
  if (bp == null) { addSysMessage("No backpack to loot into."); return; }
  sendInput("pickup:" + (serial >>> 0));
  sendPlacement(`drop:${serial >>> 0}:65535:65535:0:${bp}`, serial >>> 0);
}

// ---- auto-open corpses (ClassicUO PlayerMobile.TryOpenCorpses) --------------
//
// A newly seen corpse near you is double-clicked for you. ClassicUO triggers it
// from three places — a 0x2006 arriving on the ground (PacketHandlers.cs:5729,
// :6394), the death animation (:3745), and every step you take
// (PlayerMobile.OnPositionChanged) — which together amount to "whenever the set
// of nearby corpses may have changed". Driven off the poll here, which is the
// same set of moments and one scan instead of three call sites.
//
// `CORPSE_GRAPHIC` is ClassicUO's `Item.IsCorpse`; the serial set is its
// `AutoOpenedCorpses`, so a corpse you close by hand does not immediately
// re-open.
const CORPSE_GRAPHIC = 0x2006;
const autoOpenedCorpses = new Set();
// ClassicUO's `ManualOpenedCorpses`: a corpse you double-clicked yourself is
// never the one `SkipEmptyCorpse` hides, even if we had auto-opened it earlier.
// Filled by the double-click path in 12-input.js.
const manualOpenedCorpses = new Set();
const AUTO_CORPSE_MEMORY = 512;   // ServUO recycles serials; don't remember forever
function autoOpenCorpses(s) {
  if (!settings.autoOpenCorpses) return;
  const me = s && s.player;
  if (!me) return;
  // ClassicUO's `CorpseOpenOptions`, whose default (3) is both guards at once:
  // don't open while a target cursor is up (the window would swallow the click
  // the cursor is waiting for) and don't open while hidden (a window opening on
  // its own is a giveaway). Fixed at that default rather than adding two more
  // settings for a pair that is on by default and rarely changed.
  if (typeof targetingActive === "function" && targetingActive()) return;
  if (me.hidden) return;
  const range = Math.max(1, settings.autoOpenCorpseRange | 0);
  for (const it of (s.items || [])) {
    if ((it.g | 0) !== CORPSE_GRAPHIC) continue;
    const serial = it.serial >>> 0;
    if (autoOpenedCorpses.has(serial)) continue;
    // UO "Distance" is Chebyshev.
    if (Math.max(Math.abs((it.x | 0) - (me.x | 0)), Math.abs((it.y | 0) - (me.y | 0))) > range) continue;
    autoOpenedCorpses.add(serial);
    // ClassicUO queues a real double-click and lets the reply open the window.
    // Same here: `use:` and the server's 0x24 lands in `ingestContainerOpens`,
    // so a corpse the server refuses (out of range, already gone) never leaves
    // an empty window behind.
    sendInput("use:" + serial);
  }
  // Sets iterate in insertion order, so the oldest serials are the ones dropped.
  while (autoOpenedCorpses.size > AUTO_CORPSE_MEMORY) {
    autoOpenedCorpses.delete(autoOpenedCorpses.values().next().value);
  }
  while (manualOpenedCorpses.size > AUTO_CORPSE_MEMORY) {
    manualOpenedCorpses.delete(manualOpenedCorpses.values().next().value);
  }
}

function openContainer(serial) {
  serial = serial >>> 0;
  const existing = dialogWindow("containers", serial);
  if (existing) { bringToFront(existing.el); existing._sig = null; refreshContainer(serial); return; }
  const { el, body, label } = makeWindowFrame({
    cls: "container-win", title: "Container", bodyCls: "cont-grid", cascade: containerCascade,
    onClose: () => closeContainer(serial),
  });
  // Leaving the window entirely clears any item OPL tooltip it was showing (there's
  // no PIXI pointerout for DOM cells to fall back on).
  el.addEventListener("mouseleave", () => { if (tipSerial != null) { tipSerial = null; hideTip(); } });
  // Chromeless authentic mode hides the title bar, so the art itself is the drag
  // handle: `makeDraggable` on the body moves the window (it already bails on a
  // `.cont-item` so grabbing an item lifts it instead). Harmless in grid mode
  // too (dragging empty grid space just moves the window).
  makeDraggable(el, body);
  // Right-click closes the container, as in ClassicUO (`CanCloseWithRightClick`,
  // ContainerGump.cs:151) — the only close affordance once the title bar's ✕ is
  // hidden. stopPropagation keeps it off the world canvas behind.
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault(); e.stopPropagation();
    closeContainer(serial);
  });
  // ClassicUO restores an iconized container on double-click of the collapsed
  // gump (`GumpPicContainerOnMouseDoubleClick`), not a single click — a single
  // click still drags it out of the way.
  el.addEventListener("dblclick", (e) => {
    const w = dialogWindow("containers", serial);
    if (!w || !w.minimized) return;
    e.preventDefault(); e.stopPropagation();
    w.minimized = false;
    w._sig = null;
    refreshContainer(serial);
  });
  dialogWindows("containers").set(serial, { el, body, label, _sig: null });
  refreshContainer(serial);
}
// Re-draw every OPEN container window. The container-view toggles change how an
// already-open window renders, and the guarded refresh only runs when the
// signature moved — so clear `_sig` first.
function refreshOpenContainers() {
  for (const cs of dialogWindows("containers").keys()) {
    const w = dialogWindow("containers", cs);
    if (w) { w._sig = null; refreshContainer(cs); }
  }
}
function closeContainer(serial) {
  serial = serial >>> 0;
  // ClassicUO plays the container's ClosedSound on close, client-side — closing
  // sends no packet, so the server never sounds it (ContainerGump.cs:728). The
  // sound is per-gump (CONTAINER_SOUNDS): a backpack thumps, a corpse is silent.
  // Only when a window is actually here to close.
  if (dialogWindow("containers", serial)) {
    const gump = (scene && scene.contGumps && scene.contGumps[String(serial)]) | 0;
    const snd = CONTAINER_SOUNDS[gump];
    if (snd) containerSfx(snd[1]);
  }
  closeDialog("containers", serial);
}
// Rebuild a container's grid only when its contents changed. Double-click an item →
// use it; also openContainer(itemSerial) so nested bags pop open (a non-container
// just opens an empty window the user can close — acceptable).
function containerSignature(scene, serial) {
  // The gump id, the container's own graphic/name, and the two view toggles all
  // change how the window renders WITHOUT changing the item set — so they must
  // be in the signature or `syncDialogFamily` skips the redraw. Bug found live:
  // a late 0x24 arriving after the items were stable left the window stuck as a
  // grid because the item-only signature never changed.
  // "?" when 0x24 has not named this container yet, which is a DIFFERENT state
  // from a named gump id of 0 (see `refreshContainer`'s `gumpKnown`). Folding
  // both to 0 would leave the signature unchanged when the id finally lands, so
  // the wait branch would never re-render out of its invisible placeholder.
  const g = scene && scene.contGumps && scene.contGumps[String(serial)];
  const gid = g === undefined ? "?" : g | 0;
  const info = (scene && scene.contInfo && scene.contInfo[String(serial)]) || {};
  const head = `${gid}:${info.g | 0}:${info.name || ""}:${settings.gridContainers ? 1 : 0}:${settings.gridLoot ? 1 : 0}:${settings.containerScale | 0}`;
  return head + "|" + ((scene && scene.contItems) || [])
    .filter((it) => (it.cont >>> 0) === serial)
    // `hue` belongs here for the same reason the amount does: a dye changes the
    // icon's art request without touching serial/graphic/amount, and a signature
    // that missed it would leave the grid showing the item's old colour.
    .map((it) => `${it.serial >>> 0}:${it.g}:${it.amount | 0}:${it.hue | 0}`).join(",");
}
function refreshContainer(serial) {
  serial = serial >>> 0;
  const win = dialogWindow("containers", serial);
  if (!win) return;
  const items = (scene && scene.contItems || []).filter((it) => (it.cont >>> 0) === serial);
  // ClassicUO's `SkipEmptyCorpse` (ContainerGump.cs:98-104): a corpse that WE
  // opened automatically and that turns out to be empty stays hidden rather than
  // covering the screen after every kill. Hidden, not closed — 0x3C contents
  // arrive after the 0x24 that opened the window, so an empty corpse and one
  // whose items are still in flight look identical at this instant; the next
  // refresh reveals it the moment anything lands in it. A corpse you opened by
  // hand is never hidden (ClassicUO's `ManualOpenedCorpses`).
  //
  // The reveal is UNCONDITIONAL, outside the guard. It used to sit inside it,
  // which meant turning the option off never reached the line that would put the
  // window back: an already-hidden corpse stayed invisible until it was closed
  // and reopened, even though the Options row does re-render on change. Shedding
  // the previous mode is exactly what the other toggles do here too.
  win.el.style.display = "";
  if (settings.skipEmptyCorpse && autoOpenedCorpses.has(serial)
      && !manualOpenedCorpses.has(serial) && isCorpseContainer(serial)
      && !items.length) {
    win.el.style.display = "none";
  }
  // No signature check here: every caller already means "rebuild now". The
  // dialog driver stamps `win._sig = sig` BEFORE calling update() (dialogs.js
  // syncDialogFamily), so a second guard against that same field could only
  // ever compare equal — it silently swallowed every server-driven change, and
  // the grid only ever refreshed when the window was (re)opened. Found live: a
  // `[set Hue` on an item in an open backpack left its icon in the old colour.
  const body = win.body;
  body.innerHTML = "";
  // Draw the container's real gump art and place each item at the (x, y) the
  // server stored for it, instead of a uniform grid. Both halves were already
  // on the wire and thrown away: 0x3C carries a position per item, and 0x24
  // names the gump (retained by `World::container_gumps`, since the open event
  // ring ages out while the window stays open).
  //
  // Coordinates are the gump's own pixel space and go in raw, exactly as
  // ClassicUO does (`itemControl.X = (short)item.X`) — note the SIGNED read,
  // which is why a `| 0` here would be wrong for a negative x. ClassicUO also
  // clamps into a per-gump bounds table so a stray position cannot draw
  // outside the bag; we clip with `overflow: hidden` instead, which needs no
  // 78-entry table to be ported and cannot disagree with the server about
  // where the item actually is.
  const gump = (scene && scene.contGumps && scene.contGumps[String(serial)]) | 0;
  // Did 0x24 actually NAME a gump for this container, or have we simply not
  // heard it yet? `contGumps` is keyed by serial (`World::container_gumps`), so
  // presence is the answer — not the id being nonzero. Only the second state is
  // worth waiting on: a server-initiated open (`ingestContainerOpens`) exists
  // BECAUSE 0x24 arrived, so nothing more is coming even when the id it carried
  // is 0 (ServUO writes `Container.GumpID`, which a shard can `[set GumpID 0`),
  // and reading that as "not heard yet" would leave the window chromeless and
  // transparent — i.e. invisible — for good.
  const gumpKnown = !!(scene && scene.contGumps && String(serial) in scene.contGumps);
  // ClassicUO plays the OpenSound when the container gump is created — which for
  // us is the moment the 0x24 gump id first arrives (a locally-opened window
  // waits in the pending state below until then). Play it once per open, for
  // both views (opening makes the sound regardless of how it's drawn).
  if (gump > 0 && !win._openSounded) {
    win._openSounded = true;
    const snd = CONTAINER_SOUNDS[gump];
    if (snd) containerSfx(snd[0]);
  }
  // Which container this is — its own item graphic + tiledata name (`contInfo`,
  // resolved server-side from `world.items` because a pouch and a backpack share
  // gump 0x3C and only the item can tell them apart). `oplName` beats the
  // tiledata baseline when a dyed/renamed container's OPL has landed.
  const info = (scene && scene.contInfo && scene.contInfo[String(serial)]) || {};
  const cname = (typeof oplName === "function" && oplName(serial)) || info.name || "";
  // Grid loot: a corpse's authentic layout is exactly the wrong shape for
  // looting — items scattered under a body sprite, each needing a drag. So a
  // corpse falls back to the uniform grid and gains click-to-take, which is
  // what ClassicUO's separate `GridLootGump` exists to do. Switchable in
  // Options for anyone who wants the real corpse art back.
  const loot = settings.gridLoot && isCorpseContainer(serial);
  // `gridContainers` forces the titled grid for EVERY container (the owner's
  // customized view); authentic is the traditional gump otherwise.
  const authentic = gump > 0 && !loot && !settings.gridContainers;
  if (!authentic || !CONTAINER_ICONIZE[gump]) {
    win.minimized = false;
    win.el.classList.remove("cont-iconized");
  }
  // Until the server's 0x24 has NAMED this container at all, an authentic
  // container has nothing to draw. Show an empty chromeless window
  // (transparent → invisible) rather than flashing the grid and then swapping
  // to the art one poll later — the signature carries whether the gump id has
  // arrived, so this refresh re-runs the instant it does. Grid mode and
  // corpse-loot have their final look immediately, so they never hit this wait.
  if (gump === 0 && !gumpKnown && !loot && !settings.gridContainers) {
    win.el.classList.add("cont-authentic");
    body.className = "gump-body cont-art";
    win.el.style.width = ""; body.style.width = "";
    if (win.label) win.label.textContent = "";
    return;
  }
  // Title bar: the container's name, and — in grid mode — a small icon of the
  // container itself so a pouch reads differently from a box. Authentic mode
  // stays icon-less (its whole window IS the container art). The title is set
  // here every refresh so a late-arriving name/OPL repaints it (the signature
  // includes the name, so this refresh actually runs).
  if (win.label) {
    win.label.textContent = cname || "Container";
    const old = win.label.querySelector(".cont-title-icon");
    if (old) old.remove();
    if (!authentic && (info.g | 0) > 0) {
      const ic = document.createElement("img");
      ic.className = "cont-title-icon";
      ic.src = `art/static/${info.g | 0}.png` + (typeof hueQuery === "function" ? hueQuery(info.hue | 0) : "");
      ic.draggable = false;
      ic.onerror = () => { ic.style.display = "none"; };
      win.label.insertBefore(ic, win.label.firstChild);
    }
  }
  body.classList.toggle("cont-loot", loot);
  if (loot) {
    const bar = document.createElement("div");
    bar.className = "loot-bar";
    const all = document.createElement("button");
    all.type = "button"; all.className = "loot-all"; all.textContent = "Loot all";
    all.addEventListener("click", () => {
      // Snapshot first: `grabItem` mutates the container we are iterating (each
      // reply removes an item), and the pack can fill part-way through, which
      // simply leaves the rest on the corpse.
      for (const it of items) grabItem(it.serial >>> 0);
    });
    bar.appendChild(all);
    const hint = document.createElement("span");
    hint.className = "loot-hint"; hint.textContent = "click an item to take it";
    bar.appendChild(hint);
    body.appendChild(bar);
  }
  body.classList.toggle("cont-art", authentic);
  body.classList.toggle("cont-grid", !authentic);
  win.el.classList.toggle("cont-authentic", authentic);
  if (authentic) {
    const bg = document.createElement("img");
    bg.className = "cont-bg";
    bg.src = `gump/${gump}.png`;
    bg.draggable = false;
    // Size the window to the gump texture, like ClassicUO's ContainerGump
    // (`Width = _gumpPicContainer.Width`), instead of a fixed 252px that clips a
    // wide gump (a 282px chessboard) and gutters a narrow one. The natural size
    // is only known after the image loads, so use a per-gump cache to size
    // synchronously on reopen (no flash) and learn it on first load.
    // Chess/backgammon stay at 1× (ClassicUO ContainerGump.GetScale).
    const scale = containerScaleFor(gump);
    const sizeTo = win.minimized ? null : sizeContainerToGump(win, gump, scale);
    body.style.zoom = scale !== 1 ? String(scale) : "";
    bg.onload = () => { gumpArtSize.set(gump, bg.naturalWidth); if (sizeTo && !win.minimized) sizeTo(bg.naturalWidth); };
    // A gump we cannot fetch must not leave an empty window: fall back to the
    // grid rather than to nothing, and drop the authentic sizing with it.
    bg.onerror = () => {
      bg.remove();
      body.classList.remove("cont-art");
      body.classList.add("cont-grid");
      win.el.classList.remove("cont-authentic");
      win.el.style.width = ""; body.style.width = ""; body.style.zoom = "";
    };
    body.appendChild(bg);
    // ClassicUO corpse gump: blinking eye overlay (gump 0x45/0x46, 750ms).
    if (gump === CORPSE_GUMP) {
      const eye = document.createElement("img");
      eye.className = "cont-eye";
      eye.src = "gump/69.png";
      eye.draggable = false;
      eye.alt = "";
      body.appendChild(eye);
    }
    if (!win.minimized) attachContainerMinimizer(win, gump);
    applyContainerMinimized(win, gump);
  } else {
    // Grid mode: shed any authentic sizing left from a previous mode.
    win.el.style.width = ""; body.style.width = ""; body.style.zoom = "";
  }
  if (!items.length) {
    if (!authentic) body.innerHTML = '<div class="cont-empty">(empty)</div>';
    return;
  }
  for (const it of items) {
    const itemSerial = it.serial >>> 0;
    const cell = document.createElement("div");
    cell.className = "cont-item";
    cell.draggable = false;                // pointer-drag (held-on-cursor), not native HTML5 drag
    cell.dataset.serial = itemSerial;
    cell.dataset.g = it.g;
    cell.dataset.amount = (it.amount | 0) || 1;
    cell.dataset.st = it.st ? "1" : "0";
    cell.dataset.hue = it.hue | 0;          // carried into the drag ghost on lift
    if (authentic) {
      // Signed, per ClassicUO's `(short)item.X` — a `| 0` on an already-u16
      // value would place a negative x off at 65000-odd instead.
      const sx = (it.x << 16) >> 16, sy = (it.y << 16) >> 16;
      cell.style.position = "absolute";
      cell.style.left = sx + "px";
      cell.style.top = sy + "px";
    }
    const img = document.createElement("img");
    img.className = "cont-icon"; img.src = `art/static/${stackGraphic(it.g, it.amount | 0)}.png${hueQuery(it.hue)}`;
    img.draggable = false;                  // let the cell own the drag
    img.onerror = () => { img.style.visibility = "hidden"; };
    cell.appendChild(img);
    if ((it.amount | 0) > 1) {
      const a = document.createElement("span");
      a.className = "cont-amt"; a.textContent = it.amount;
      cell.appendChild(a);
    }
    if (loot) {
      // Single click takes it. Safe to add alongside the drag machinery below:
      // a click that became a drag never fires `click`, so dragging an item off
      // a corpse still works for anyone who wants to place it precisely.
      cell.addEventListener("click", () => grabItem(itemSerial));
    }
    cell.addEventListener("dblclick", () => {
      // Belt and braces: a completed double-click on this cell means the press
      // was a click, not a drag, no matter what — disarm a still-pending
      // groundDrag for this same serial so a stray later pointermove (or the
      // dialog/gump that "use" may pop, covering the cell) can't still promote
      // it into a lift out from under the click that just resolved.
      if (groundDrag && (groundDrag.serial >>> 0) === itemSerial) groundDrag = null;
      // A spellbook opens the spell-casting UI, not a container view.
      if (isSpellbook(it.g)) { if (!spellbookOn) toggleSpellbook(); return; }
      sendInput("use:" + itemSerial);
      // Only open a container window if this item is ACTUALLY a container (`c`).
      // Otherwise (bandages, potions, food, …) double-click just uses it — opening
      // an empty container gump for those was the bug.
      if (it.c) openContainer(itemSerial);
    });
    body.appendChild(cell);
  }
}
registerDialog({
  id: "containers",
  // open:"local" — a container window exists because the PLAYER opened it (a
  // double-click, or the server's 0x24 container-open event), never because it
  // appears in a snapshot list. The snapshot only supplies the contents, so
  // there is nothing here to auto-open, auto-close, or guard against.
  open: "local",
  sig: containerSignature,
  update: (win, scene, { key }) => refreshContainer(key),
});

// --- generic server gumps / dialogs (0xB0 / 0xDD) ------------------------
// Each scene.gumps entry is a server dialog (quest/NPC menu/confirm box) parsed
// (server-side) into positioned elements, each tagged with its gump "page"
// (0 = always visible; see scene.rs parse_gump_layout). We mirror one draggable
// .gump-win per serial: build on first sight, rebuild when its content signature
// changes, and remove when it's gone from scene.gumps. Every window tracks its
// own current page (starts at 1); "page-jump" buttons (pageflag 0) just flip
// that locally via applyGumpPage() — no packet is ever sent for those. A real
// reply button (pageflag 1) collects the on-state of all checkboxes/radios +
// text-entry values (across every page, not just the visible one — they stay
// in the DOM, just hidden) and sends a `gump:` reply, then closes locally; the
// ✕ sends button 0 (cancel). These are normal windows — they don't block the
// rest of the game.
const gumpCascade = { n: 0, left: 160, top: 90, step: 24 };
// Remembered screen position per gump KIND (gumpId), like ClassicUO's saved gump
// locations. ServUO craft/menu gumps close and REOPEN with a fresh serial on every
// selection, so keying position by serial (or cascading each build) walked the
// window down-right across the screen. Reopening the same kind now lands where the
// last one of that kind sat; a user drag updates the remembered spot.
const gumpPos = new Map();       // gumpId → { left, top }
function gumpSignature(g) {
  return JSON.stringify([g.gumpId >>> 0, g.w | 0, g.h | 0, g.elements || []]);
}
registerDialog({
  id: "gumps",
  source: (scene) => (scene && scene.gumps) || [],
  key: (g) => g.serial >>> 0,
  sig: gumpSignature,
  // No update(): a re-sent gump is a whole new server-authored layout, so the
  // window is rebuilt — carrying the player's current page across (see build).
  dismiss: "content",
  build: buildGumpWindow,
});

// ── Legacy item/question menus (0x7C → 0x7D) ──────────────────────────────
// Several may be open at once. Each window is keyed by the server menu serial;
// answering removes it locally immediately and suppresses the same snapshot
// until the server consumes the response (avoids one-poll flicker/reopening).
const legacyMenuCascade = { n: 0, left: 220, top: 110 };

function legacyMenuSignature(menu) {
  return JSON.stringify([menu.menuId | 0, menu.question || "", menu.kind || "question", menu.entries || []]);
}

function answerLegacyMenu(serial, index) {
  if (!dialogWindow("legacyMenus", serial)) return;
  dismissDialog("legacyMenus", serial);
  sendInput("menusel:" + serial + ":" + index);
}

function buildLegacyMenuWindow(menu) {
  const serial = menu.serial >>> 0;
  const entries = menu.entries || [];
  const itemMenu = menu.kind === "items";
  const { el, body } = makeWindowFrame({
    cls: "legacy-menu-win", title: "Menu", bodyCls: "legacy-menu-body", cascade: legacyMenuCascade,
    onClose: () => answerLegacyMenu(serial, 0),
  });
  body.innerHTML = '<div class="legacy-menu-question"></div>'
    + '<div class="legacy-menu-entries"></div><div class="legacy-menu-actions">'
    + '<button class="dlg-btn legacy-menu-continue">Continue</button>'
    + '<button class="dlg-btn legacy-menu-cancel">Cancel</button></div>';
  el.querySelector(".legacy-menu-question").textContent = menu.question || "Choose an option";
  const list = el.querySelector(".legacy-menu-entries");
  if (itemMenu) list.classList.add("legacy-item-grid");

  const state = { el, selected: entries.length ? (entries[0].index | 0) : 0 };
  for (const entry of entries) {
    const index = entry.index | 0;
    const label = document.createElement("label");
    label.className = itemMenu ? "legacy-item-choice" : "legacy-question-choice";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "legacy-menu-" + serial;
    radio.value = String(index);
    radio.checked = index === state.selected;
    radio.addEventListener("change", () => { state.selected = index; });
    label.appendChild(radio);
    if (itemMenu) {
      const img = document.createElement("img");
      img.src = "art/static/" + (entry.graphic | 0) + ".png" + ((entry.hue | 0) ? ("?hue=" + (entry.hue | 0)) : "");
      img.alt = "";
      img.draggable = false;
      img.addEventListener("error", () => { img.style.visibility = "hidden"; });
      label.appendChild(img);
      label.addEventListener("dblclick", (event) => {
        event.preventDefault();
        answerLegacyMenu(serial, index);
      });
    }
    const text = document.createElement("span");
    text.textContent = entry.text || ("Option " + index);
    label.appendChild(text);
    list.appendChild(label);
  }

  const proceed = el.querySelector(".legacy-menu-continue");
  proceed.disabled = state.selected === 0;
  proceed.addEventListener("click", () => {
    if (state.selected) answerLegacyMenu(serial, state.selected);
  });
  el.querySelector(".legacy-menu-cancel").addEventListener("click", () => answerLegacyMenu(serial, 0));
  el.addEventListener("keydown", (event) => {
    if (event.code === "Escape") {
      event.preventDefault(); event.stopPropagation(); answerLegacyMenu(serial, 0);
    } else if (event.code === "Enter" || event.code === "NumpadEnter") {
      event.preventDefault(); event.stopPropagation();
      if (state.selected) answerLegacyMenu(serial, state.selected);
    }
  });
  return state;
}

registerDialog({
  id: "legacyMenus",
  source: (scene) => (scene && scene.legacyMenus) || [],
  key: (menu) => menu.serial >>> 0,
  sig: legacyMenuSignature,
  dismiss: "content",
  build: buildLegacyMenuWindow,
});

// ── Server dye hue pickers (0x95 request/response) ─────────────────────────
// ClassicUO presents 1000 ordinary dyed hues as five 20×10 grids. Graduation
// g contains hues `2 + g + cell*5`, covering exactly ServUO's clipped 2..1001
// range. A server-owned picker has no cancel packet, so these windows have no X.
const huePickerCascade = { n: 0, left: 250, top: 90 };
let dyedPalettePromise = null;

function loadDyedPalette() {
  if (!dyedPalettePromise) {
    dyedPalettePromise = fetch("hues/dyed.json", { cache: "force-cache" })
      .then((response) => {
        if (!response.ok) throw new Error("palette HTTP " + response.status);
        return response.json();
      })
      .then((data) => {
        if ((data.start | 0) !== 2 || !Array.isArray(data.colors) || data.colors.length !== 1000) {
          throw new Error("invalid dyed palette");
        }
        return data.colors;
      })
      .catch((error) => {
        console.warn("dye palette unavailable", error);
        dyedPalettePromise = null; // allow a later picker to retry
        return Array(1000).fill("#444");
      });
  }
  return dyedPalettePromise;
}

function huePickerSignature(picker) {
  return JSON.stringify([picker.graphic | 0]);
}

function dyedHue(graduation, cell) {
  return 2 + (graduation | 0) + (cell | 0) * 5;
}

function updateHuePickerPreview(state) {
  state.label.textContent = "Hue " + state.selectedHue;
  state.preview.src = "art/static/" + state.graphic + ".png?hue=" + state.selectedHue;
}

function renderHuePickerGrid(state) {
  state.grid.innerHTML = "";
  for (let cell = 0; cell < 200; cell++) {
    const hue = dyedHue(state.graduation, cell);
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "hue-picker-swatch" + (hue === state.selectedHue ? " selected" : "");
    swatch.style.backgroundColor = state.colors[hue - 2] || "#444";
    swatch.title = "Hue " + hue;
    swatch.setAttribute("aria-label", "Hue " + hue);
    swatch.addEventListener("click", () => {
      state.selectedCell = cell;
      state.selectedHue = hue;
      for (const old of state.grid.querySelectorAll(".selected")) old.classList.remove("selected");
      swatch.classList.add("selected");
      updateHuePickerPreview(state);
    });
    swatch.addEventListener("dblclick", () => answerHuePicker(state.serial, hue));
    state.grid.appendChild(swatch);
  }
}

function answerHuePicker(serial, hue) {
  if (!dialogWindow("huePickers", serial)) return;
  dismissDialog("huePickers", serial);
  sendInput("huepick:" + serial + ":" + hue);
}

function buildHuePickerWindow(picker) {
  const serial = picker.serial >>> 0;
  const graphic = (picker.graphic | 0) || 0x0FAB;
  // A server-owned picker has no cancel packet, so this frame keeps no ✕ — the
  // only ways out are Apply (answerHuePicker) and the server dropping it.
  const { el, body, closer } = makeWindowFrame({
    cls: "hue-picker-win", title: "Dye color", bodyCls: "hue-picker-body", cascade: huePickerCascade,
  });
  closer.remove();
  body.innerHTML = '<div class="hue-picker-toolbar">'
    + '<div class="hue-picker-preview"><img alt="Dye preview" draggable="false"></div>'
    + '<div class="hue-picker-controls"><span class="hue-picker-label">Hue 3</span>'
    + '<label>Graduation <input class="hue-picker-slider" type="range" min="0" max="4" step="1" value="1"></label>'
    + '</div></div><div class="hue-picker-grid" aria-label="Dye colors"></div>'
    + '<button class="dlg-btn hue-picker-apply">Apply color</button>';
  const state = {
    el, serial, graphic, graduation: 1, selectedCell: 0, selectedHue: 3, colors: null,
    grid: el.querySelector(".hue-picker-grid"),
    preview: el.querySelector(".hue-picker-preview img"),
    label: el.querySelector(".hue-picker-label"),
  };
  updateHuePickerPreview(state);
  state.preview.addEventListener("error", () => { state.preview.style.visibility = "hidden"; });
  const slider = el.querySelector(".hue-picker-slider");
  slider.addEventListener("input", () => {
    state.graduation = slider.value | 0;
    // ClassicUO keeps the selected grid cell while changing graduation.
    state.selectedHue = dyedHue(state.graduation, state.selectedCell);
    if (state.colors) renderHuePickerGrid(state);
    updateHuePickerPreview(state);
  });
  el.querySelector(".hue-picker-apply").addEventListener("click", () => {
    answerHuePicker(serial, state.selectedHue);
  });
  el.addEventListener("keydown", (event) => {
    if (event.code === "Escape") {
      // ClassicUO sets CanCloseWithRightClick=false for server-owned pickers.
      event.preventDefault(); event.stopPropagation();
    } else if (event.code === "Enter" || event.code === "NumpadEnter") {
      event.preventDefault(); event.stopPropagation(); answerHuePicker(serial, state.selectedHue);
    }
  });
  state.grid.textContent = "Loading colors…";
  loadDyedPalette().then((colors) => {
    if (dialogWindow("huePickers", serial) !== state) return; // window went away mid-fetch
    state.colors = colors;
    renderHuePickerGrid(state);
  });
}

registerDialog({
  id: "huePickers",
  source: (scene) => (scene && scene.huePickers) || [],
  key: (picker) => picker.serial >>> 0,
  sig: huePickerSignature,
  dismiss: "content",
  build: buildHuePickerWindow,
});

const RACE_CHANGE_NAMES = { 1: "Human", 2: "Elf", 3: "Gargoyle" };
function raceChangeSignature(p) {
  return (p.female ? "f" : "m") + ":" + (p.race | 0);
}
function buildRaceChangeWindow(p) {
  const race = p.race | 0;
  const female = !!p.female;
  const raceName = RACE_CHANGE_NAMES[race] || ("Race " + race);
  const hasBeard = !female && race !== 2;
  const confirm = () => {
    dismissDialog("raceChange", 1);
    sendInput("racechange:" + num(".rc-skin") + ":" + num(".rc-hair") + ":" + num(".rc-hairhue")
      + ":" + (hasBeard ? num(".rc-beard") : 0) + ":" + (hasBeard ? num(".rc-beardhue") : 0));
  };
  const cancel = () => {
    dismissDialog("raceChange", 1);
    sendInput("racechangecancel");
  };
  const { el, body } = makeWindowFrame({
    cls: "race-change-win", title: "Change race", bodyCls: "race-change-body",
    onClose: cancel,
  });
  body.innerHTML = '<div class="race-change-meta">' + (female ? "Female " : "Male ") + raceName + "</div>"
    + '<label>Skin hue <input class="rc-skin" type="number" min="0" max="65535" value="33770"></label>'
    + '<label>Hair style <input class="rc-hair" type="number" min="0" max="65535" value="8251"></label>'
    + '<label>Hair hue <input class="rc-hairhue" type="number" min="0" max="65535" value="1102"></label>'
    + (hasBeard
      ? '<label>Beard style <input class="rc-beard" type="number" min="0" max="65535" value="0"></label>'
        + '<label>Beard hue <input class="rc-beardhue" type="number" min="0" max="65535" value="0"></label>'
      : "")
    + '<div class="race-change-actions">'
    + '<button type="button" class="dlg-btn rc-ok">Confirm</button>'
    + '<button type="button" class="dlg-btn rc-cancel">Cancel</button></div>';
  const num = (sel) => (body.querySelector(sel) ? (body.querySelector(sel).value | 0) : 0);
  body.querySelector(".rc-ok").addEventListener("click", confirm);
  body.querySelector(".rc-cancel").addEventListener("click", cancel);
  el.addEventListener("keydown", (event) => {
    if (event.code === "Escape") { event.preventDefault(); cancel(); }
    else if (event.code === "Enter" || event.code === "NumpadEnter") { event.preventDefault(); confirm(); }
  });
  return { el };
}

registerDialog({
  id: "raceChange",
  source: (scene) => (scene && scene.raceChange) ? [scene.raceChange] : [],
  key: () => 1,
  sig: raceChangeSignature,
  dismiss: "session",
  build: buildRaceChangeWindow,
});
// ── Right-click context (popup) menu (0xBF/0x14) ───────────────────────────
// scene.popup = { serial, entries:[{ index, text }] } | null. We show a small
// menu div at the last cursor position; a row click sends popupsel and hides it;
// click-away / Esc / the popup clearing also hides it.
// The menu is a singleton, so the family below holds at most one window; these
// two mirror it for the click-away/Esc paths that don't know the serial.
let popupEl = null;            // the live menu element (null = hidden)
let popupSerial = 0;           // serial the menu was opened for
// The server keeps its popup set until we select or its target is removed, so a
// user-closed menu needs the family's session guard or it would reopen next poll.
function hidePopup(dismissed) {
  if (popupSerial) {
    if (dismissed) dismissDialog("popup", popupSerial);
    else closeDialog("popup", popupSerial);
  }
  popupEl = null; popupSerial = 0;
}
function buildPopupMenu(p, { key }) {
  const serial = key;
  const el = document.createElement("div");
  el.className = "popup-menu";
  // Anchor at the cursor, clamped to stay on-screen.
  const x = Math.min(lastMenuX, window.innerWidth - 200);
  const y = Math.min(lastMenuY, window.innerHeight - (p.entries.length * 26 + 12));
  el.style.left = Math.max(4, x) + "px";
  el.style.top = Math.max(4, y) + "px";
  for (const e of p.entries) {
    const row = document.createElement("div");
    row.className = "popup-row" + (e.hl ? " popup-row-hl" : ""); // 0x01 = highlighted default action
    row.textContent = e.text || ("#" + e.index);
    const index = e.index | 0;
    row.addEventListener("click", (ev) => {
      ev.stopPropagation();
      sendInput("popupsel:" + serial + ":" + index);
      hidePopup();
    });
    el.appendChild(row);
  }
  document.body.appendChild(el);
  popupEl = el;
  popupSerial = serial;
  return { el };
}

registerDialog({
  id: "popup",
  // A singleton is just a list of at most one — no special case needed.
  source: (scene) => {
    const p = scene && scene.popup;
    return p && p.entries && p.entries.length ? [p] : [];
  },
  key: (p) => p.serial >>> 0,
  // Entries only: the menu is anchored at the cursor it opened with, so a
  // stable signature must not include position. Same entries → leave it;
  // a different list rebuilds once (still at lastMenuX/Y).
  sig: (p) => JSON.stringify((p.entries || []).map((e) => [e.index, e.text, e.hl])),
  dismiss: "session",
  build: buildPopupMenu,
  close: (win) => { win.el.remove(); if (popupEl === win.el) { popupEl = null; popupSerial = 0; } },
});


// ---- client-side context menus (ClassicUO ContextMenuControl) ---------------
//
// A different thing from the SERVER popup menu right above, which this reuses
// the markup and CSS of: that one's entries arrive on the wire (0xBF/0x13 →
// 0xBF/0x14) and are answered with `popupsel:`; these are ours and run a local
// function. ClassicUO's is `ContextMenuControl` + `ContextMenuItemEntry`,
// triggered from `Control.cs:641-646` when a right-click lands on a gump that
// declines to close (`CanCloseWithRightClick == false`), and it uses it in only
// three places — the world map (WorldMapGump.cs:266-345), the resizable
// journal's tabs, and the counter bar.
//
// Two things a wire menu never needs and this does: a checkmark column for
// toggle entries (ClassicUO's `ContextMenuItemEntry(text, action, canBeSelected,
// defaultValue)`) and separators (its `new ContextMenuItemEntry("")`).
//
// entries: [{ label, run, checked, disabled }]; an entry with no `label` is a
// separator. `checked` may be a boolean or a function, so an open menu that
// toggles something re-reads it rather than showing a stale tick.
let clientMenuEl = null;
let clientMenuAway = null;   // the dismiss listeners, while one is open
function hideClientMenu() {
  if (!clientMenuEl) return;
  clientMenuEl.remove();
  clientMenuEl = null;
  if (clientMenuAway) { clientMenuAway(); clientMenuAway = null; }
}
function openClientMenu(x, y, entries) {
  hideClientMenu();
  const rows = entries.filter((e) => e && e.label);
  const el = document.createElement("div");
  el.className = "popup-menu client-menu";
  // Same cursor anchoring + clamp as the server menu; the height estimate uses
  // the real row count (separators are thinner, so this over-reserves slightly,
  // which is the safe direction).
  el.style.left = Math.max(4, Math.min(x, window.innerWidth - 220)) + "px";
  el.style.top = Math.max(4, Math.min(y, window.innerHeight - (rows.length * 26 + 12))) + "px";
  for (const ent of entries) {
    if (!ent || !ent.label) {
      const sep = document.createElement("div");
      sep.className = "popup-sep";
      el.appendChild(sep);
      continue;
    }
    const row = document.createElement("div");
    row.className = "popup-row" + (ent.disabled ? " popup-row-off" : "");
    const on = typeof ent.checked === "function" ? ent.checked() : ent.checked;
    // A checkable entry keeps its tick column even when unticked, so a column of
    // toggles doesn't jitter left and right as they're switched.
    row.textContent = (ent.checked === undefined ? "" : on ? "\u2713 " : "\u2003 ") + ent.label;
    if (!ent.disabled) {
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        hideClientMenu();
        if (ent.run) ent.run();
      });
    }
    el.appendChild(row);
  }
  document.body.appendChild(el);
  clientMenuEl = el;
  // Dismissal: a click anywhere outside (rows stop propagation and close
  // themselves first) or Escape. Both are registered in the CAPTURE phase and
  // removed with the menu, so Escape closes the menu WITHOUT also reaching the
  // window-closing Escape chain in setupInput underneath it.
  const away = (ev) => { if (!el.contains(ev.target)) hideClientMenu(); };
  const esc = (ev) => {
    if (ev.code !== "Escape") return;
    ev.preventDefault(); ev.stopPropagation();
    hideClientMenu();
  };
  window.addEventListener("mousedown", away, true);
  window.addEventListener("keydown", esc, true);
  clientMenuAway = () => {
    window.removeEventListener("mousedown", away, true);
    window.removeEventListener("keydown", esc, true);
  };
  return el;
}

function buildGumpWindow(g, { previous } = {}) {
  const serial = g.serial >>> 0;
  const gumpId = g.gumpId >>> 0;
  // Reopen at the remembered spot for this gump KIND; only a first-seen kind
  // cascades (so distinct dialogs don't stack exactly). This keeps a craft/menu
  // gump anchored across its close-and-reopen-with-a-new-serial cycle.
  const saved = gumpPos.get(gumpId);
  const { el, bar: title, body } = makeWindowFrame({
    cls: "dialog-win", title: "Dialog", cascade: gumpCascade, pos: saved, resizable: true,
    onClose: () => { sendInput(`gump:${serial}:${gumpId}:0`); closeGump(serial); },
    draggable: false, // wired below so the drag can also update gumpPos
  });
  if (!saved) gumpPos.set(gumpId, { left: parseInt(el.style.left, 10), top: parseInt(el.style.top, 10) });
  const w = Math.max(80, g.w | 0), h = Math.max(48, g.h | 0);
  const canvas = document.createElement("div");
  canvas.className = "dialog-canvas";
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  body.appendChild(canvas);

  // `page` is this window's *local* current page (the server never sees it —
  // UO pages are a pure client-side layout concept, ClassicUO's Gump.ActivePage).
  // Page 1 is shown initially. Every element is built once and stays in the DOM
  // (so checkbox/text-entry state on a page you navigate away from survives);
  // applyGumpPage() just toggles which ones are visible. Elements with no
  // "page" token before them in the layout parsed to page 0 and are shown on
  // every page.
  // Carry the player's page across a server-driven rebuild (the server resending
  // the same gump shouldn't kick them back to page 1), clamped to the new
  // layout's highest real page — a refreshed gump with FEWER pages would
  // otherwise show only its page-0 chrome, with no page ever matching.
  const maxPage = (g.elements || []).reduce((m, e) => Math.max(m, e.page | 0), 0);
  const page = previous ? Math.min(previous.page, maxPage || 1) : 1;
  const win = { el, serial, gumpId, canvas, page, nodes: [] };
  const labelledElements = [];
  for (const e of (g.elements || [])) {
    const node = buildGumpElement(win, e);
    // A tooltip/itemproperty is not a box: UO attaches it to whatever element
    // was added last, so it decorates the previous node instead of taking a
    // slot of its own.
    if (node && node.tooltip !== undefined) {
      const prev = win.nodes[win.nodes.length - 1];
      if (prev) prev.title = node.tooltip;
      continue;
    }
    node.dataset.page = e.page | 0;
    win.nodes.push(node);
    labelledElements.push({ element: e, node });
    canvas.appendChild(node);
  }
  labelGumpButtons(win, labelledElements);
  applyGumpPage(win);
  // Remember where the user drags this window, keyed by kind, so the next reopen
  // (fresh serial) lands there too.
  makeDraggable(el, title, (x, y) => gumpPos.set(gumpId, { left: x, top: y }));
  return win;
}
// The wire layout has no label references. Recognize only the conventional
// single adjacent label on the same page/row, and retain a neutral fallback
// for ambiguous layouts. Reference the sanitized visible DOM, never raw HTML.
function labelGumpButtons(win, elements) {
  const buttons = elements.filter(({ element: e }) => e.t === "button" || e.t === "btnart");
  const labels = elements.filter(({ element: e, node }) => e.t === "text" && node.textContent.trim());
  const adjacent = (button, label) => {
    const b = button.element, t = label.element;
    return (b.page | 0) === (t.page | 0) && Math.abs((b.y | 0) - (t.y | 0)) <= 4
      && (t.x | 0) - (b.x | 0) >= 24 && (t.x | 0) - (b.x | 0) <= 48;
  };
  for (const button of buttons) {
    const candidates = labels.filter((label) => adjacent(button, label));
    if (candidates.length !== 1) continue;
    const label = candidates[0];
    if (buttons.filter((other) => adjacent(other, label)).length !== 1) continue;
    label.node.id = `gump-label-${win.serial}-${win.gumpId}-${elements.indexOf(label)}`;
    button.node.setAttribute("aria-labelledby", label.node.id);
  }
}
// Show/hide this window's elements for its current local page: page-0
// elements are always visible; everything else only shows while it's the
// active page. Called on first build and again whenever a pageflag-0 button
// flips `win.page` — that's a pure local redraw, no packet goes to the server
// (ClassicUO Button.ButtonAction.SwitchPage).
function applyGumpPage(win) {
  for (const node of win.nodes) {
    const p = Number(node.dataset.page) || 0;
    node.style.display = (p === 0 || p === win.page) ? "" : "none";
  }
}
// ── UO gump HTML mini-parser ────────────────────────────────────────────
// Servers embed a small HTML subset in gump text — both `text`/`croppedtext`
// strings AND resolved `htmlgump`/`xmfhtml*` blocks arrive as the same "t":
// "text" JSON shape (anima-core's gump_layout.rs keeps both raw; anima-net's
// scene.rs shapes them identically — see those files' doc comments). E.g.
// ServUO's CraftGump sends literal `<CENTER>ALCHEMY MENU</CENTER>`. This
// turns that string into safe DOM nodes: CENTER/LEFT/RIGHT become a
// block-level wrapper with the matching text-align (.gh-center/.gh-left/
// .gh-right, scoped under .dialog-win in index.html), B/I/U/BIG/SMALL become
// inline <span> classes, BASEFONT COLOR sets a running text color (sanitized
// — #rrggbb/#rgb or a small named-color whitelist, never the raw attribute
// text), BR is a line break, and any other tag (<A HREF>, <P>, …) is
// stripped but its inner text kept.
//
// SAFETY: the string is tokenized by hand on '<'/'>' and every node is built
// with createElement/createTextNode — never innerHTML/outerHTML and never a
// tag name taken from the server — so a malicious server string (even
// `<script>…</script>`) can only ever become inert text content, never a
// real element, attribute, or executable markup.
const GUMP_NAMED_COLORS = new Set([
  "red", "cyan", "blue", "darkblue", "lightblue", "purple", "yellow", "lime",
  "magenta", "white", "silver", "gray", "grey", "black", "orange", "brown",
  "maroon", "green", "olive",
]);
// `raw` is whatever came after `color=` in a BASEFONT tag, already isolated
// by a regex that stops at the first quote/space — validate it's an actual
// #rrggbb/#rgb hex or one of the whitelisted names before it ever reaches
// `style.color`; anything else (an attempted CSS/style-breakout string,
// junk) is dropped (returns null, meaning "leave color unset").
function gumpSanitizeColor(raw) {
  const hex = (raw || "").trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(hex) || /^[0-9a-fA-F]{3}$/.test(hex)) return "#" + hex.toLowerCase();
  const name = (raw || "").trim().toLowerCase();
  return GUMP_NAMED_COLORS.has(name) ? name : null;
}
// Decode the handful of entities UO gump text actually uses. Deliberately a
// fixed whitelist regex (not a generic &name; decoder) — only ever produces
// plain characters, never re-introduces '<'/'>' as anything but literal text
// (the result is inserted via createTextNode, so it can't become markup
// even if it contains those characters).
function gumpDecodeEntities(s) {
  return s.replace(/&(amp|lt|gt|nbsp|quot|apos|#39);/gi, (m, name) => {
    switch (name.toLowerCase()) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "nbsp": return "\u00A0";
      case "quot": return '"';
      case "apos": case "#39": return "'";
      default: return m;
    }
  });
}
// Parse a gump text/html string into a DocumentFragment of safe DOM nodes.
// `boxWidth` isn't consulted directly (an alignment wrapper is a `width:100%`
// block div — it centers within whatever explicit CSS width the caller has
// already set on the element, e.g. croppedtext's `w`); a `null`/absent width
// (a plain unbounded `text`) still parses fine, it just has no box to center
// within. Malformed input (unclosed tags, stray closes, no `>`) degrades
// gracefully — it never throws and never drops trailing text.
function renderGumpHtml(raw, boxWidth) {
  const root = document.createDocumentFragment();
  const str = String(raw == null ? "" : raw);
  // One stack frame per currently-open recognized/unknown tag: `el` is where
  // new nodes get appended (the fragment for the untouched root, or the
  // span/div pushed for a recognized tag, or the PARENT's `el` again for an
  // unknown tag — so it's tracked for matching but contributes no DOM node).
  // `name` is the upper-cased tag name a closing tag must match.
  const stack = [{ el: root, name: null }];
  // BASEFONT's color is a running property, not a stack frame (real gump
  // text rarely closes it) — applies to every later text run until changed
  // or reset by a bare <basefont>.
  let color = null;

  const top = () => stack[stack.length - 1];
  const appendText = (chunk) => {
    if (!chunk) return;
    const text = gumpDecodeEntities(chunk);
    if (!text) return;
    if (color) {
      const span = document.createElement("span");
      span.style.color = color; // already sanitized — see gumpSanitizeColor
      span.appendChild(document.createTextNode(text));
      top().el.appendChild(span);
    } else {
      top().el.appendChild(document.createTextNode(text));
    }
  };
  const openBlock = (cls, name) => {
    const div = document.createElement("div");
    div.className = cls;
    top().el.appendChild(div);
    stack.push({ el: div, name });
  };
  const openInline = (cls, name) => {
    const span = document.createElement("span");
    span.className = cls;
    top().el.appendChild(span);
    stack.push({ el: span, name });
  };
  const closeTag = (name) => {
    // Pop back to (and including) the nearest matching open frame; a stray
    // close with no match (or one that would pop the implicit root) is
    // simply ignored rather than throwing.
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].name === name) { stack.length = i; return; }
    }
  };

  let i = 0;
  while (i < str.length) {
    const lt = str.indexOf("<", i);
    if (lt === -1) { appendText(str.slice(i)); break; }
    appendText(str.slice(i, lt));
    const gt = str.indexOf(">", lt);
    if (gt === -1) {
      // Unterminated '<' — nothing left can parse as a tag; keep the rest
      // as literal text instead of throwing or silently dropping it.
      appendText(str.slice(lt));
      break;
    }
    const body = str.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!body) continue;
    const closing = body[0] === "/";
    const rest = closing ? body.slice(1) : body;
    const m = rest.match(/^[A-Za-z][A-Za-z0-9]*/);
    if (!m) continue; // "<>", "</>", "<123>" — not a tag we can name; skip
    const name = m[0].toUpperCase();

    if (closing) { closeTag(name); continue; }

    switch (name) {
      case "CENTER": openBlock("gh-center", name); break;
      case "LEFT": openBlock("gh-left", name); break;
      case "RIGHT": openBlock("gh-right", name); break;
      case "BR": top().el.appendChild(document.createElement("br")); break;
      case "B": case "BOLD": openInline("gh-b", name); break;
      case "I": case "EM": openInline("gh-i", name); break;
      case "U": openInline("gh-u", name); break;
      case "BIG": openInline("gh-big", name); break;
      case "SMALL": openInline("gh-small", name); break;
      case "BASEFONT": {
        const cm = rest.match(/color\s*=\s*"?([^"\s>]+)"?/i);
        color = cm ? gumpSanitizeColor(cm[1]) : null; // bare <basefont> resets
        break;
      }
      // Unknown tag (<A HREF>, <P>, …): stripped, inner text kept — track it
      // (so a later matching close pops cleanly) without adding a DOM node.
      default: stack.push({ el: top().el, name }); break;
    }
  }
  return root;
}
function buildGumpElement(win, e) {
  const { serial, gumpId } = win;
  const node = document.createElement(e.t === "button" || e.t === "btnart" ? "button" : "div");
  node.className = "dlg-el";
  node.style.left = (e.x | 0) + "px";
  node.style.top = (e.y | 0) + "px";
  if (e.t === "bg") {
    node.classList.add("dlg-bg");
    if (e.w) node.style.width = (e.w | 0) + "px";
    if (e.h) node.style.height = (e.h | 0) + "px";
  } else if (e.t === "text") {
    node.classList.add("dlg-text");
    // croppedtext (w present) gets a clip box (.dlg-text-crop: overflow
    // hidden at exactly w px) — it never wraps, it clips. Plain text (no w,
    // scene.rs's parse_gump_layout never emits one for it) gets no width and
    // no clip, just runs on past its start point; both are single-line
    // (.dlg-text: white-space: nowrap, in index.html). This same shape also
    // carries a resolved htmlgump/xmfhtml* block (anima-net's scene.rs shapes
    // both identically, `w` always present for those) — either way `s` may
    // carry raw UO gump-HTML (`<CENTER>…</CENTER>`, `<basefont color=…>`,
    // …), which renderGumpHtml turns into safe, styled DOM nodes instead of
    // literal tag text.
    if (e.w) { node.classList.add("dlg-text-crop"); node.style.width = (e.w | 0) + "px"; }
    node.appendChild(renderGumpHtml(e.s || "", e.w ? (e.w | 0) : null));
  } else if (e.t === "button") {
    node.classList.add("dlg-btn");
    node.type = "button";
    // Draw the real button gump art (a small image sized to the art) so it sits in
    // the slot the gump intended — not a wide numbered box that overlaps the text.
    // Fall back to the reply id text if the art is missing.
    if (e.g) {
      node.classList.add("img");
      const img = document.createElement("img");
      img.className = "dlg-btn-img";
      img.src = `gump/${e.g | 0}.png`;
      img.alt = "";
      img.onerror = () => { img.remove(); node.classList.remove("img"); node.textContent = (e.id | 0) || "?"; };
      node.appendChild(img);
    } else {
      node.textContent = (e.id | 0) || "?";
    }
    // pageflag 0 = local page-jump (switch to page `param`, never touches the
    // network); pageflag 1 (or absent, for callers that never set it) = a real
    // reply button that sends 0xB1 GumpResponse with this element's reply id.
    if ((e.pageflag | 0) === 0) {
      node.setAttribute("aria-label", "Go to page " + (e.param | 0));
      node.addEventListener("click", () => { win.page = e.param | 0; applyGumpPage(win); });
    } else {
      node.setAttribute("aria-label", "Reply " + (e.id | 0));
      node.addEventListener("click", () => submitGump(serial, gumpId, e.id | 0));
    }
  } else if (e.t === "check" || e.t === "radio") {
    const input = document.createElement("input");
    input.type = e.t === "check" ? "checkbox" : "radio";
    input.dataset.swid = (e.id | 0);
    // Radios are mutually exclusive only within their `{ group N }`. Without a
    // per-group name the browser treats every radio in the window as one set,
    // so a two-question gump can only ever hold one answer. Scoped by window
    // too — two open gumps must not fight over a group number.
    if (e.t === "radio") input.name = `g${serial >>> 0}-${e.g | 0}`;
    if (e.on) input.checked = true;
    node.appendChild(input);
  } else if (e.t === "entry") {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "dlg-entry";
    input.dataset.entryid = (e.id | 0);
    input.value = e.s || "";
    // textentrylimited: the server will reject anything longer, so stop it here.
    if (e.lim) input.maxLength = e.lim | 0;
    if (e.w) input.style.width = (e.w | 0) + "px";
    node.appendChild(input);
  } else if (e.t === "tilepic") {
    // Item ART, not gump art — a different endpoint. Craft menus and vendor
    // gumps are mostly these, and they used to be dropped entirely.
    node.classList.add("dlg-tile");
    const img = document.createElement("img");
    img.src = `art/static/${e.g | 0}.png` + ((e.hue | 0) ? `?hue=${e.hue | 0}` : "");
    img.alt = "";
    img.onerror = () => img.remove();
    node.appendChild(img);
  } else if (e.t === "tiled") {
    // gumppictiled: one graphic repeated to fill the rectangle.
    node.classList.add("dlg-tiled");
    node.style.width = (e.w | 0) + "px";
    node.style.height = (e.h | 0) + "px";
    node.style.backgroundImage = `url(gump/${e.g | 0}.png)`;
  } else if (e.t === "trans") {
    node.classList.add("dlg-trans");
    node.style.width = (e.w | 0) + "px";
    node.style.height = (e.h | 0) + "px";
  } else if (e.t === "picinpic") {
    // A crop of a gump graphic: show the window, offset the image inside it.
    node.classList.add("dlg-crop");
    node.style.width = (e.w | 0) + "px";
    node.style.height = (e.h | 0) + "px";
    const img = document.createElement("img");
    img.src = `gump/${e.g | 0}.png`;
    img.alt = "";
    img.style.left = `${-(e.sx | 0)}px`;
    img.style.top = `${-(e.sy | 0)}px`;
    img.onerror = () => img.remove();
    node.appendChild(img);
  } else if (e.t === "btnart") {
    // buttontileart: an ordinary button whose face is item art.
    node.type = "button";
    node.setAttribute("aria-label", (e.pf | 0) === 0 ? "Go to page " + (e.param | 0) : "Reply " + (e.id | 0));
    node.classList.add("dlg-btn", "img");
    const img = document.createElement("img");
    img.src = `art/static/${e.art | 0}.png` + ((e.hue | 0) ? `?hue=${e.hue | 0}` : "");
    img.alt = "";
    img.onerror = () => img.remove();
    node.appendChild(img);
    if ((e.pf | 0) === 0) {
      node.addEventListener("click", () => { win.page = e.param | 0; applyGumpPage(win); });
    } else {
      node.addEventListener("click", () => submitGump(serial, gumpId, e.id | 0));
    }
  } else if (e.t === "tip" || e.t === "oplTip") {
    // Both attach to the element BEFORE them (UO tooltips decorate whatever was
    // added last), so this contributes no box of its own — it just annotates.
    return { tooltip: e.t === "tip" ? (e.text || "") : `opl:${e.serial >>> 0}` };
  }
  return node;
}
// Collect every checked switch + text-entry value in this gump and send the reply.
function submitGump(serial, gumpId, button) {
  const win = dialogWindow("gumps", serial >>> 0);
  let cmd = `gump:${serial}:${gumpId}:${button}`;
  if (win) {
    const switches = [...win.el.querySelectorAll("input[data-swid]")]
      .filter((i) => i.checked).map((i) => i.dataset.swid);
    if (switches.length) cmd += ":sw=" + switches.join(",");
    // Text entries: skip commas/colons/equals which would break the delimited form.
    const entries = [...win.el.querySelectorAll("input[data-entryid]")]
      .map((i) => `${i.dataset.entryid}=${(i.value || "").replace(/[,:=]/g, " ")}`);
    if (entries.length) cmd += ":e=" + entries.join(",");
  }
  sendInput(cmd);
  closeGump(serial);
}
function closeGump(serial) {
  dismissDialog("gumps", serial >>> 0);
}

// ── book reader (0x93/0xD4 header + 0x66 pages) ────────────────────────────
// scene.book = { serial, title, author, writable, pageCount, pages:[[line,…],…] }
// | null. A dark gump opens when a book appears; if its pages are still empty we
// auto-request them (outgoing 0x66 via `bookreq`). ✕ closes the reader.
//
// A `writable` book is editable in place: the page becomes a textarea and the
// title/author become inputs. Neither edit is acknowledged by the server — it
// applies them and says nothing — and ServUO validates all-or-nothing, so an
// over-long title or a ninth line silently discards the whole packet. The
// builders clamp to what it accepts; see `build_book_header_change` /
// `build_book_page_write`.
//
// Editing is safe against the poll because `registerDialog` only calls
// `update` when the signature changes (`sig` covers title/author/pages), and
// the server sends no new book data in response to our writes. A page turn
// saves first when the text differs from the server's, so an edit is not lost
// to a stray click on Next.
let bookWin = null;        // the live reader element (null = closed)
let bookSerial = 0;        // serial of the book being shown
let bookPage = 0;          // current page index (0-based)
let bookRequested = 0;     // serial we've already sent a page request for
function closeBook() {
  if (bookSerial) dismissDialog("book", bookSerial); // stays closed until a NEW book
}
registerDialog({
  id: "book",
  source: (scene) => (scene && scene.book ? [scene.book] : []),
  key: (b) => b.serial >>> 0,
  sig: (b) => JSON.stringify([b.title, b.author, b.writable, b.pageCount, b.pages]),
  dismiss: "session",
  build: (b, { key }) => {
    bookSerial = key;
    bookPage = 0;                       // a new book always starts at page 1
    return { el: buildBookWindow(b) };
  },
  update: (win, b, { key }) => {
    // Ask for the text once if the header arrived with empty pages.
    const empty = !b.pages || b.pages.every((p) => !p || p.length === 0);
    if (empty && (b.pageCount | 0) > 0 && bookRequested !== key) {
      bookRequested = key;
      sendInput("bookreq:" + key + ":" + (b.pageCount | 0));
    }
    renderBookPage(b);
  },
  close: (win) => {
    saveBookPageIfDirty();   // don't lose an edit to a stray ✕
    win.el.remove();
    bookWin = null; bookSerial = 0; bookRequested = 0; bookPage = 0;
  },
});


function buildBookWindow(b) {
  const el = document.createElement("div");
  el.className = "gump-win book-win";
  const title = document.createElement("div");
  title.className = "gump-title";
  const name = (b.title || "Book") + (b.author ? " · " + b.author : "");
  const t = document.createElement("span");
  t.textContent = name;
  const x = document.createElement("span");
  x.className = "gump-close"; x.textContent = "✕";
  x.addEventListener("click", closeBook);
  title.appendChild(t); title.appendChild(x);
  el.appendChild(title);

  const body = document.createElement("div");
  body.className = "gump-body";
  // Title/author editor — only meaningful on a writable book, and hidden
  // otherwise so a read-only book looks exactly as it did.
  const hdr = document.createElement("div");
  hdr.className = "book-hdr";
  const titleIn = document.createElement("input");
  titleIn.className = "book-title-in"; titleIn.placeholder = "title"; titleIn.maxLength = 60;
  const authorIn = document.createElement("input");
  authorIn.className = "book-author-in"; authorIn.placeholder = "author"; authorIn.maxLength = 30;
  const hdrSave = document.createElement("button");
  hdrSave.type = "button"; hdrSave.className = "book-btn"; hdrSave.textContent = "Save title";
  hdrSave.addEventListener("click", () => {
    if (!bookSerial) return;
    sendInput(`bookhdr:${bookSerial}:${titleIn.value}|${authorIn.value}`);
  });
  hdr.appendChild(titleIn); hdr.appendChild(authorIn); hdr.appendChild(hdrSave);
  body.appendChild(hdr);
  const text = document.createElement("div");
  text.className = "book-text";
  body.appendChild(text);
  const edit = document.createElement("textarea");
  edit.className = "book-edit"; edit.rows = 8; edit.spellcheck = false;
  body.appendChild(edit);
  const nav = document.createElement("div");
  nav.className = "book-nav";
  const prev = document.createElement("button");
  prev.type = "button"; prev.className = "book-btn"; prev.textContent = "‹ Prev";
  const label = document.createElement("span");
  label.className = "book-pageno";
  const next = document.createElement("button");
  next.type = "button"; next.className = "book-btn"; next.textContent = "Next ›";
  prev.addEventListener("click", () => {
    if (bookPage > 0) { saveBookPageIfDirty(); bookPage--; renderBookPage(scene && scene.book); }
  });
  next.addEventListener("click", () => {
    const bk = scene && scene.book;
    const last = bk ? (bk.pageCount | 0) - 1 : 0;
    if (bookPage < last) { saveBookPageIfDirty(); bookPage++; renderBookPage(bk); }
  });
  nav.appendChild(prev); nav.appendChild(label); nav.appendChild(next);
  const save = document.createElement("button");
  save.type = "button"; save.className = "book-btn book-save"; save.textContent = "Save page";
  save.addEventListener("click", () => saveBookPageIfDirty(true));
  nav.appendChild(save);
  body.appendChild(nav);
  el.appendChild(body);
  el._text = text; el._label = label; el._prev = prev; el._next = next;
  el._edit = edit; el._hdr = hdr; el._titleIn = titleIn; el._authorIn = authorIn;
  el._save = save; el._name = t;

  makeDraggable(el, title);
  document.body.appendChild(el);
  bookWin = el;
  return el;
}
function renderBookPage(b) {
  if (!bookWin || !b) return;
  const count = b.pageCount | 0;
  if (bookPage > count - 1) bookPage = Math.max(0, count - 1);
  const lines = (b.pages && b.pages[bookPage]) || [];
  const rw = !!b.writable;
  // The title bar is built once but the book can be renamed under it — a
  // writable book's whole point — so refresh it here rather than leaving the
  // name the book happened to have when the window opened.
  bookWin._name.textContent = (b.title || "Book") + (b.author ? " · " + b.author : "");
  bookWin._hdr.style.display = rw ? "flex" : "none";
  bookWin._save.style.display = rw ? "" : "none";
  bookWin._text.style.display = rw ? "none" : "";
  bookWin._edit.style.display = rw ? "" : "none";
  if (rw) {
    bookWin._edit.value = lines.join("\n");
    // Remember what the server gave us, so a page turn can tell a real edit
    // from an untouched page and not send a pointless write.
    bookWin._edit._server = bookWin._edit.value;
    bookWin._titleIn.value = b.title || "";
    bookWin._authorIn.value = b.author || "";
  } else {
    bookWin._text.textContent = lines.length ? lines.join("\n") : "(blank page)";
  }
  bookWin._label.textContent = "page " + (bookPage + 1) + " / " + Math.max(1, count);
  bookWin._prev.disabled = bookPage <= 0;
  bookWin._next.disabled = bookPage >= count - 1;
}
// Write the current page back if the text differs from what the server sent.
// `force` (the Save button) sends regardless, which is the escape hatch when a
// write was silently refused and the local text now matches a stale copy.
function saveBookPageIfDirty(force) {
  const b = scene && scene.book;
  if (!bookWin || !b || !b.writable || !bookSerial) return;
  const ta = bookWin._edit;
  if (!force && ta.value === ta._server) return;
  ta._server = ta.value;
  // The page is 1-based on the wire; an empty textarea still sends one blank
  // line, which is how a page gets cleared.
  const lines = ta.value.split("\n");
  sendInput(`bookpage:${bookSerial}:${bookPage + 1}:${lines.join("|")}`);
}

// --- bulletin board (0x71) -----------------------------------------------
// scene.bboard = { serial, name, summaries:[{serial,parent,poster,subject,
// datetime}], message:{serial,poster,subject,datetime,body}|null } | null.
//
// A summary line carries no text, so clicking one asks for the body (sub 3) and
// the reply lands in `.message`. Posting takes a subject and at least one line —
// ServUO refuses either empty — and is rate-limited per thread/reply with a
// journal line rather than a packet, so the confirmation is the board itself
// re-listing.
let bbWin = null, bbSerial = 0, bbSelected = 0;
const bbSummaryAsked = new Map();   // message serial -> ms we last asked for its header
// Opening a board sends the message list as CONTAINER CONTENTS (0x3C), not as
// summaries — ServUO's `OnDoubleClick` follows `BBDisplayBoard` with a
// `ContainerContent`. The subject/poster/date of each message arrives only in
// answer to a per-message header request (sub 4), so without this the board
// shows nothing at all however many threads it holds.
//
// Throttled by TIME rather than asked once per serial, which was the first cut
// and deadlocked: re-opening a board makes the server resend sub 0, and our
// decoder treats that as a fresh board and clears the summaries — so a
// once-ever guard leaves every message permanently unasked and the list
// permanently empty. Re-asking at most once a second per missing message
// recovers from that and from a dropped reply, and an arrival drops the entry.
//
// Driven from the poll rather than the dialog's `update`: `update` only runs
// when the board's own signature changes, and the container contents naming
// the messages are not part of that signature — so the very first board, whose
// contents arrive without changing it, would never be asked about.
const BB_SUMMARY_RETRY_MS = 1000;
function requestMissingBBSummaries(scene, board) {
  const have = new Set((board.summaries || []).map((m) => m.serial >>> 0));
  const now = performance.now();
  for (const it of scene.contItems || []) {
    if ((it.cont >>> 0) !== (board.serial >>> 0)) continue;
    const serial = it.serial >>> 0;
    if (have.has(serial)) { bbSummaryAsked.delete(serial); continue; }
    if (now - (bbSummaryAsked.get(serial) || 0) < BB_SUMMARY_RETRY_MS) continue;
    bbSummaryAsked.set(serial, now);
    sendInput(`bbsum:${board.serial >>> 0}:${serial}`);
  }
}
function closeBBoard() {
  if (bbSerial) dismissDialog("bboard", bbSerial);
}
function buildBBoardWindow(b) {
  const { el, body } = makeWindowFrame({
    cls: "bboard-win", title: b.name || "Bulletin Board",
    cascade: { n: 0, left: 300, top: 100 },
    onClose: closeBBoard, resizable: true,
  });
  body.innerHTML = '<div class="bb-list"></div><div class="bb-body"></div>'
    + '<div class="bb-compose">'
    + '<input class="bb-subject" placeholder="subject">'
    + '<textarea class="bb-lines" rows="3" placeholder="message"></textarea>'
    + '<div class="bb-actions">'
    + '<button class="bb-post">Post</button>'
    + '<button class="bb-reply">Reply to selected</button>'
    + '<button class="bb-del">Delete selected</button></div></div>';
  const q = (c) => el.querySelector(c);
  q(".bb-list").addEventListener("click", (e) => {
    const row = e.target.closest(".bb-row");
    if (!row) return;
    bbSelected = row.dataset.serial >>> 0;
    sendInput(`bbmsg:${bbSerial}:${bbSelected}`);
    for (const r of el.querySelectorAll(".bb-row")) r.classList.toggle("sel", r === row);
  });
  const post = (replyTo) => {
    const subject = q(".bb-subject").value.trim();
    const lines = q(".bb-lines").value.split("\n").filter((l) => l.length);
    if (!subject || !lines.length) {
      addSysMessage("A bulletin post needs both a subject and a message.");
      return;
    }
    sendInput(`bbpost:${bbSerial}:${replyTo}:${subject}|${lines.join("|")}`);
    q(".bb-subject").value = ""; q(".bb-lines").value = "";
  };
  q(".bb-post").addEventListener("click", () => post(0));
  q(".bb-reply").addEventListener("click", () => {
    if (!bbSelected) { addSysMessage("Select a message to reply to first."); return; }
    post(bbSelected);
  });
  q(".bb-del").addEventListener("click", () => {
    if (!bbSelected) { addSysMessage("Select a message to delete first."); return; }
    sendInput(`bbdel:${bbSerial}:${bbSelected}`);
  });
  return { el };
}
function renderBBoard(win, b) {
  const el = win.el;
  const list = el.querySelector(".bb-list");
  list.innerHTML = (b.summaries || []).map((m) => {
    // A reply is indented under whatever it answers; the wire gives us the
    // parent serial, not a tree, so one level of indent is all it supports.
    const reply = (m.parent >>> 0) !== 0;
    return `<div class="bb-row${reply ? " reply" : ""}${(m.serial >>> 0) === bbSelected ? " sel" : ""}"`
      + ` data-serial="${m.serial >>> 0}">`
      + `<span class="bb-subj">${reply ? "↳ " : ""}${m.subject || "(no subject)"}</span>`
      + `<span class="bb-meta">${m.poster || ""} · ${m.datetime || ""}</span></div>`;
  }).join("") || '<div class="bb-empty">(no messages)</div>';
  const bodyEl = el.querySelector(".bb-body");
  const msg = b.message;
  bodyEl.textContent = msg
    ? `${msg.subject}\n${msg.poster} · ${msg.datetime}\n\n${msg.body}`
    : "(select a message)";
}
registerDialog({
  id: "bboard",
  source: (scene) => (scene && scene.bboard ? [scene.bboard] : []),
  key: (b) => b.serial >>> 0,
  sig: (b) => JSON.stringify([b.name, b.summaries, b.message]),
  dismiss: "session",
  build: (b, { key }) => { bbSerial = key; bbSelected = 0; return buildBBoardWindow(b); },
  update: (win, b) => renderBBoard(win, b),
  close: (win) => {
    win.el.remove();
    bbWin = null; bbSerial = 0; bbSelected = 0; bbSummaryAsked.clear();
  },
});

// --- vendor shop window (BUY + SELL) -------------------------------------
// Auto-opens when scene.shop arrives (a vendor was double-clicked). BUY lists the
// vendor's stock (its container's contItems matched to scene.shop.buy.prices by
// index) with a qty + Buy button; SELL lists pack items the vendor will buy with a
// qty + Sell button. ✕ closes (and suppresses reopen until the vendor window is
// gone). Mirrors the dark gump chrome; only acts via sendInput().
let shopWin = null;        // { el, body, sig }
let shopSort = { key: "name", dir: 1 }; // buy-list sort: key name|price|amount, dir 1/-1
// One vendor window at a time, keyed by the vendor whose stock it shows.
const SHOP_KEY = "vendor";
registerDialog({
  id: "shop",
  source: (scene) => (scene && scene.shop ? [scene.shop] : []),
  key: () => SHOP_KEY,
  // renderShop() does its own change detection off shopWin.sig, so this family
  // only needs to know the window exists; it pushes every snapshot through.
  dismiss: "session",
  build: () => { openShop(); return { el: shopWin.el }; },
  update: (win, shop) => renderShop(shop),
  close: () => closeShop(),
});
function openShop() {
  const { el } = makeWindowFrame({
    title: "Vendor", bodyCls: "shop-body",
    onClose: () => dismissDialog("shop", SHOP_KEY),
  });
  el.id = "shop-win";
  // One delegated click handler for all Buy/Sell buttons.
  const body = el.querySelector(".shop-body");
  body.addEventListener("click", (e) => {
    // sort header: click a column to sort by it (click again toggles direction)
    const sk = e.target.closest(".shop-sortk");
    if (sk) {
      const k = sk.dataset.k;
      shopSort = { key: k, dir: shopSort.key === k ? -shopSort.dir : 1 };
      shopWin.sig = null; renderShop(scene && scene.shop);
      return;
    }
    const btn = e.target.closest(".shop-btn");
    if (!btn) return;
    const row = btn.closest(".shop-row");
    const qtyEl = row.querySelector(".shop-qty");
    let qty = Math.max(1, Math.min(60000, parseInt(qtyEl.value, 10) || 1));
    const serial = (+btn.dataset.serial) >>> 0;
    const vendor = (+btn.dataset.vendor) >>> 0;
    sendInput(`${btn.dataset.act}:${vendor}:${serial}x${qty}`);
  });
  shopWin = { el, body, sig: null };
}
function closeShop() {
  if (shopWin) { shopWin.el.remove(); shopWin = null; }
}
function renderShop(shop) {
  if (!shopWin) return;
  const buy = shop.buy, sell = shop.sell;
  // Match the vendor container's contItems to the price list by index.
  const buyItems = buy
    ? (scene && scene.contItems || []).filter((it) => (it.cont >>> 0) === (buy.cont >>> 0))
    : [];
  // Signature → only rebuild on change (preserves typed quantities; no flicker).
  const sig = JSON.stringify({
    sort: shopSort,
    bv: buy ? (buy.vendor >>> 0) : 0,
    bp: buy ? buy.prices : 0,
    bi: buyItems.map((it) => [it.serial >>> 0, it.g, it.amount | 0, it.hue | 0]),
    sv: sell ? (sell.vendor >>> 0) : 0,
    si: sell ? sell.items.map((it) => [it.serial >>> 0, it.g, it.amount | 0, it.price, it.hue | 0]) : 0,
  });
  if (shopWin.sig === sig) return;
  shopWin.sig = sig;
  let h = "";
  if (buy && buy.prices && buy.prices.length) {
    const vendor = buy.vendor >>> 0;
    // Pair each price to its container item by the item's X slot. ServUO's buy list
    // (0x74) is in sorted forward order, while the container-content packet (0x3C) is
    // written REVERSED but stamps each item with X = its 1-based position (Packets.cs
    // VendorBuyContent). Our items live in a HashMap (arrival order lost), so neither
    // forward nor reverse indexing is reliable — sorting by that X restores the exact
    // 0x74 order (this is also why ClassicUO sorts the vendor container by X).
    const pairItems = buyItems.slice().sort((a, b) => (a.x | 0) - (b.x | 0));
    let rows = pairItems.map((it, i) => ({ it, pr: buy.prices[i] })).filter((r) => r.pr)
      .map((r) => ({ g: r.it.g, serial: r.it.serial >>> 0, amount: r.it.amount | 0,
        hue: r.it.hue | 0, name: r.pr.name || ("item " + r.it.g), price: r.pr.price | 0 }));
    const k = shopSort.key, d = shopSort.dir;
    rows.sort((a, b) => d * (k === "name" ? a.name.localeCompare(b.name) : (a[k] | 0) - (b[k] | 0)));
    const arrow = (key) => shopSort.key === key ? (shopSort.dir > 0 ? " ▲" : " ▼") : "";
    h += '<div class="shop-sect">Buy</div>';
    h += '<div class="shop-sortbar">Sort: '
      + `<span class="shop-sortk" data-k="name">Name${arrow("name")}</span>`
      + `<span class="shop-sortk" data-k="price">Price${arrow("price")}</span>`
      + `<span class="shop-sortk" data-k="amount">Qty${arrow("amount")}</span></div>`;
    for (const r of rows) {
      h += '<div class="shop-row">'
        + `<img class="shop-icon" src="art/static/${r.g}.png${hueQuery(r.hue)}" onerror="this.style.visibility='hidden'">`
        + `<span class="shop-name" title="${esc(r.name)}">${esc(r.name)}</span>`
        + `<span class="shop-stock" title="vendor stock">x${r.amount || 1}</span>`
        + `<span class="shop-price">${r.price}gp</span>`
        + `<input class="shop-qty" type="number" min="1" max="${r.amount || 1}" value="1">`
        + `<button class="shop-btn" data-act="buy" data-vendor="${vendor}" data-serial="${r.serial}">Buy</button>`
        + "</div>";
    }
  }
  if (sell && sell.items && sell.items.length) {
    const vendor = sell.vendor >>> 0;
    h += '<div class="shop-sect">Sell</div>';
    for (const it of sell.items) {
      const name = it.name || ("item " + it.g);
      h += '<div class="shop-row">'
        + `<img class="shop-icon" src="art/static/${it.g}.png${hueQuery(it.hue)}" onerror="this.style.visibility='hidden'">`
        + `<span class="shop-name" title="${esc(name)}">${esc(name)} (x${it.amount | 0})</span>`
        + `<span class="shop-price">${it.price}gp</span>`
        + `<input class="shop-qty" type="number" min="1" max="${it.amount | 0}" value="${it.amount | 0}">`
        + `<button class="shop-btn" data-act="sell" data-vendor="${vendor}" data-serial="${it.serial >>> 0}">Sell</button>`
        + "</div>";
    }
  }
  if (!h) h = '<div class="cont-empty">(vendor has nothing)</div>';
  shopWin.body.innerHTML = h;
}
// Minimal HTML-escape for vendor item names (server-supplied strings).
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

