// ---------------------------------------------------------------------------
// Zones PDF — interface. Affichage du PDF avec pdf.js, zones dessinées en
// HTML par-dessus la page, coordonnées gardées en points PDF (voir model.js).
// ---------------------------------------------------------------------------

import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";
import {
  ZONE_TYPES, FONTS, DEFAULT_SIZES, isTextType, isChecked, round2,
  clampRect, makeZone, makeGridZones, gridRects, slugName,
  exportData, importData, exportCsv,
} from "./model.js";

const VENDOR = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR + "pdf.worker.min.mjs";

const CSS_UNITS = 96 / 72; // 100 % = taille réelle à l'écran
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const STORAGE_PREFIX = "zones-pdf:";
const FONT_CSS = {
  Helvetica: "Helvetica, Arial, sans-serif",
  TimesRoman: '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
};
const TOOL_HINTS = {
  select: "Cliquez sur une zone pour la sélectionner, glissez-la pour la déplacer, tirez ses coins pour la redimensionner.",
  text: "Cliquez pour poser un champ texte d'une ligne, ou glissez pour le dessiner à la bonne taille.",
  multiline: "Glissez pour dessiner un paragraphe : le texte reviendra à la ligne automatiquement.",
  checkbox: "Cliquez au centre d'une case du document pour poser une case à cocher.",
  image: "Glissez pour délimiter l'emplacement d'une image (photo, logo, signature…).",
  grid: "Glissez sur une zone répétitive (tableau, ligne de cases…) puis choisissez le nombre de colonnes et de lignes.",
};

const $ = (id) => document.getElementById(id);

// --- État ---------------------------------------------------------------------
const state = {
  pdf: null,          // document pdf.js
  bytes: null,        // copie des octets d'origine (pour le remplissage)
  doc: null,          // { name, size, pages: [{ width, height, transform, rotate }] }
  page: 1,
  zoom: 1,
  fitMode: true,
  tool: "select",
  font: "Helvetica",
  zones: [],
  selectedId: null,
  images: new Map(),  // id de zone → { bytes, mime, url }
  pendingGrid: null,  // { page, x, y, width, height }
};
let undoStack = [];
let redoStack = [];
let renderTask = null;
let renderSeq = 0;

const scale = () => state.zoom * CSS_UNITS;
const pageInfo = () => state.doc.pages[state.page - 1];
const selected = () => state.zones.find((z) => z.id === state.selectedId) || null;

// --- Messages -----------------------------------------------------------------
let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 6000 : 3200);
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const baseName = () => (state.doc?.name || "document").replace(/\.pdf$/i, "");

// --- Historique (annuler / rétablir) ------------------------------------------
const snapshot = () => JSON.stringify(state.zones);

function pushHistory(snap = snapshot()) {
  undoStack.push(snap);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  updateHistoryButtons();
}

function restore(snap) {
  state.zones = JSON.parse(snap);
  if (!selected()) state.selectedId = null;
  changed();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  updateHistoryButtons();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $("undo-btn").disabled = !undoStack.length;
  $("redo-btn").disabled = !redoStack.length;
}

// --- Sauvegarde locale (par fichier) -------------------------------------------
const storageKey = () => `${STORAGE_PREFIX}${state.doc.name}:${state.doc.size}`;
let saveTimer = null;

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!state.doc) return;
  try {
    if (state.zones.length) {
      localStorage.setItem(storageKey(), JSON.stringify({ font: state.font, zones: state.zones, savedAt: Date.now() }));
    } else {
      localStorage.removeItem(storageKey());
    }
  } catch { /* stockage indisponible (navigation privée…) : sans gravité */ }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
// Fermeture ou rechargement de l'onglet : on enregistre sans attendre.
window.addEventListener("pagehide", () => { if (saveTimer) saveNow(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && saveTimer) saveNow(); });

function loadSaved() {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.zones)) return null;
    const zones = data.zones.filter((z) => z && z.page >= 1 && z.page <= state.doc.pages.length && ZONE_TYPES[z.type]);
    return { font: FONTS[data.font] ? data.font : null, zones };
  } catch {
    return null;
  }
}

/** À appeler après toute modification des zones. */
function changed() {
  renderZones();
  renderList();
  renderProps();
  scheduleSave();
}

// --- Ouverture du PDF -------------------------------------------------------------
async function openFile(file) {
  if (!file) return;
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) {
    toast("Ce fichier n'est pas un PDF.", true);
    return;
  }
  $("loading").hidden = false;
  $("loading").textContent = "Ouverture du PDF…";
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({
        data: bytes.slice(), // pdf.js s'approprie le tampon : on lui donne une copie
        cMapUrl: VENDOR + "cmaps/",
        cMapPacked: true,
        standardFontDataUrl: VENDOR + "standard_fonts/",
        wasmUrl: VENDOR + "wasm/",
        iccUrl: VENDOR + "iccs/",
        isEvalSupported: false,
      }).promise;
    } catch (err) {
      if (err?.name === "PasswordException") throw new Error("Ce PDF est protégé par un mot de passe : ouvrez-en une version non protégée.");
      throw new Error("Impossible de lire ce PDF (fichier abîmé ou format non reconnu).");
    }

    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      if (pdf.numPages > 20 && i % 10 === 0) $("loading").textContent = `Analyse des pages… ${i}/${pdf.numPages}`;
      const p = await pdf.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      pages.push({ width: vp.width, height: vp.height, transform: vp.transform.slice(), rotate: vp.rotation });
      p.cleanup();
    }

    if (saveTimer) saveNow();
    if (state.pdf) state.pdf.destroy();
    for (const img of state.images.values()) URL.revokeObjectURL(img.url);
    Object.assign(state, {
      pdf, bytes, doc: { name: file.name, size: file.size, pages },
      page: 1, fitMode: true, selectedId: null, zones: [], images: new Map(), pendingGrid: null,
    });
    undoStack = [];
    redoStack = [];
    updateHistoryButtons();

    const saved = loadSaved();
    if (saved?.zones.length) {
      state.zones = saved.zones;
      if (saved.font) state.font = saved.font;
      toast(`${saved.zones.length} zone(s) retrouvée(s) pour ce fichier.`);
    }
    $("font-select").value = state.font;
    $("doc-name").textContent = file.name;
    $("doc-name").title = file.name;
    $("page-count").textContent = pages.length;
    $("page-input").max = pages.length;
    $("empty").hidden = true;
    $("page-wrap").hidden = false;
    $("panel").hidden = false;
    $("nav").hidden = false;
    hideGridPanel();
    await showPage(1);
    changed();
  } catch (err) {
    toast(err.message, true);
  } finally {
    $("loading").hidden = true;
  }
}

// --- Affichage de la page ------------------------------------------------------------
function fitZoom() {
  const viewer = $("viewer");
  const info = pageInfo();
  const avail = viewer.clientWidth - 40;
  const z = avail / (info.width * CSS_UNITS);
  return Math.max(0.25, Math.min(z, 2));
}

async function showPage(n) {
  if (!state.pdf) return;
  n = Math.min(Math.max(1, n), state.doc.pages.length);
  if (n !== state.page && state.pendingGrid) hideGridPanel();
  state.page = n;
  if (state.fitMode) state.zoom = fitZoom();
  $("page-input").value = n;
  $("prev-page").disabled = n <= 1;
  $("next-page").disabled = n >= state.doc.pages.length;
  $("zoom-fit").textContent = Math.round(state.zoom * 100) + " %";
  const sel = selected();
  if (sel && sel.page !== n) state.selectedId = null;

  const seq = ++renderSeq;
  const page = await state.pdf.getPage(n);
  if (seq !== renderSeq) return;
  const viewport = page.getViewport({ scale: scale() });
  const ratio = window.devicePixelRatio || 1;
  const canvas = $("page-canvas");
  const w = Math.floor(viewport.width);
  const h = Math.floor(viewport.height);
  $("page-box").style.width = w + "px";
  $("page-box").style.height = h + "px";
  renderZones();
  renderList();
  renderProps();

  if (renderTask) renderTask.cancel();
  const off = document.createElement("canvas");
  // Limite la taille du canevas pour les très grandes pages (mémoire des mobiles).
  const maxPixels = 16e6;
  const outScale = Math.min(ratio, Math.sqrt(maxPixels / (viewport.width * viewport.height)));
  off.width = Math.floor(viewport.width * outScale);
  off.height = Math.floor(viewport.height * outScale);
  renderTask = page.render({
    canvas: off,
    canvasContext: off.getContext("2d"),
    viewport,
    transform: outScale !== 1 ? [outScale, 0, 0, outScale, 0, 0] : null,
  });
  try {
    await renderTask.promise;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") toast("Erreur d'affichage de la page : " + err.message, true);
    return;
  } finally {
    if (seq === renderSeq) renderTask = null;
  }
  if (seq !== renderSeq) return;
  // On ne remplace l'image affichée qu'une fois la nouvelle prête (pas de clignotement).
  canvas.width = off.width;
  canvas.height = off.height;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.getContext("2d").drawImage(off, 0, 0);
}

function setZoom(z, keepCenter = true) {
  const viewer = $("viewer");
  const cx = (viewer.scrollLeft + viewer.clientWidth / 2) / (state.zoom || 1);
  const cy = (viewer.scrollTop + viewer.clientHeight / 2) / (state.zoom || 1);
  state.fitMode = false;
  state.zoom = Math.max(0.25, Math.min(5, z));
  showPage(state.page).then(() => {
    if (!keepCenter) return;
    viewer.scrollLeft = cx * state.zoom - viewer.clientWidth / 2;
    viewer.scrollTop = cy * state.zoom - viewer.clientHeight / 2;
  });
}

function zoomStep(dir) {
  const z = state.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
  if (next) setZoom(next);
}

// --- Zones sur la page -----------------------------------------------------------------
function zoneValueEl(z, s) {
  if (!$("show-values").checked) return null;
  if (z.type === "image") {
    const img = state.images.get(z.id);
    if (!img) return null;
    const el = document.createElement("img");
    el.className = "zimg";
    el.src = img.url;
    el.alt = "";
    return el;
  }
  if (z.type === "checkbox") {
    if (!isChecked(z.value)) return null;
    const el = document.createElement("div");
    el.className = "zvalue checkmark";
    el.style.fontSize = Math.min(z.width, z.height) * 0.9 * s + "px";
    el.textContent = "✔";
    return el;
  }
  if (!z.value) return null;
  const el = document.createElement("div");
  el.className = "zvalue";
  el.style.fontFamily = FONT_CSS[state.font];
  el.style.fontSize = z.size * s + "px";
  el.style.textAlign = z.align || "left";
  if (z.type === "text") {
    el.textContent = z.value.replace(/\s*\r?\n\s*/g, " ");
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = { left: "flex-start", center: "center", right: "flex-end" }[z.align || "left"];
  } else {
    el.textContent = z.value;
    el.style.lineHeight = (z.lineHeight || z.size * 1.25) * s + "px";
    // Le CSS centre chaque ligne dans son interligne, le PDF la colle en haut :
    // on remonte le bloc pour aligner la première ligne sur le rendu PDF.
    el.style.top = ((z.size - (z.lineHeight || z.size * 1.25)) / 2) * s + "px";
  }
  return el;
}

function renderZones() {
  const overlay = $("overlay");
  overlay.querySelectorAll(".zone").forEach((el) => el.remove());
  if (!state.doc) return;
  const s = scale();
  for (const z of state.zones) {
    if (z.page !== state.page) continue;
    const el = document.createElement("div");
    el.className = `zone t-${z.type}` + (z.id === state.selectedId ? " selected" : "");
    el.dataset.id = z.id;
    el.style.left = z.x * s + "px";
    el.style.top = z.y * s + "px";
    el.style.width = z.width * s + "px";
    el.style.height = z.height * s + "px";
    el.title = `${z.name} — ${ZONE_TYPES[z.type]}`;
    const v = zoneValueEl(z, s);
    if (v) el.appendChild(v);
    const label = document.createElement("span");
    label.className = "zlabel";
    label.textContent = z.name;
    el.appendChild(label);
    if (z.id === state.selectedId) {
      for (const h of ["nw", "ne", "sw", "se"]) {
        const hd = document.createElement("div");
        hd.className = "handle " + h;
        hd.dataset.handle = h;
        el.appendChild(hd);
      }
    }
    overlay.appendChild(el);
  }
  overlay.classList.toggle("hide-labels", s < 0.9);
}

function renderList() {
  const list = $("zone-list");
  list.innerHTML = "";
  if (!state.doc) return;
  const all = $("list-all").checked;
  const zones = all ? state.zones : state.zones.filter((z) => z.page === state.page);
  $("zone-count").textContent = state.zones.length;
  $("zone-list-empty").hidden = zones.length > 0;
  $("zone-list-empty").textContent = all
    ? "Aucune zone pour l'instant. Choisissez un outil puis cliquez ou glissez sur le document."
    : "Aucune zone sur cette page. Choisissez un outil puis cliquez ou glissez sur le document.";
  for (const z of zones) {
    const li = document.createElement("li");
    li.className = `t-${z.type}` + (z.id === state.selectedId ? " selected" : "");
    li.tabIndex = 0;
    li.title = ZONE_TYPES[z.type];
    const dot = document.createElement("span");
    dot.className = "dot";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = z.name;
    li.append(dot, nm);
    if (all) {
      const pg = document.createElement("span");
      pg.className = "pg";
      pg.textContent = "p. " + z.page;
      li.appendChild(pg);
    }
    const go = () => {
      if (z.page !== state.page) showPage(z.page).then(() => select(z.id, true));
      else select(z.id, true);
    };
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    list.appendChild(li);
  }
  list.querySelector("li.selected")?.scrollIntoView({ block: "nearest" });
}

function select(id, scrollTo = false) {
  state.selectedId = id;
  $("p-name-error").hidden = true;
  renderZones();
  renderList();
  renderProps();
  if (scrollTo && id) {
    const el = $("overlay").querySelector(`.zone[data-id="${id}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

// --- Panneau des propriétés --------------------------------------------------------------
function renderProps() {
  const z = selected();
  $("props").hidden = !z;
  if (!z) return;
  const active = document.activeElement;
  const set = (id, v) => { if ($(id) !== active) $(id).value = v; };
  set("p-name", z.name);
  set("p-type", z.type);
  set("p-x", round2(z.x));
  set("p-y", round2(z.y));
  set("p-w", round2(z.width));
  set("p-h", round2(z.height));
  const text = isTextType(z.type);
  $("p-text-opts").hidden = !text;
  $("p-check-row").hidden = z.type !== "checkbox";
  $("p-image-row").hidden = z.type !== "image";
  if (text) {
    set("p-align", z.align || "left");
    set("p-size", z.size);
    $("p-lh-row").hidden = z.type !== "multiline";
    set("p-lh", z.lineHeight || round2(z.size * 1.25));
    set("p-value", z.value || "");
    $("p-value").rows = z.type === "multiline" ? 4 : 1;
  }
  $("p-checked").checked = isChecked(z.value);
  $("p-image-clear").hidden = !state.images.has(z.id);
  if (!state.images.has(z.id)) $("p-image").value = "";
}

// Une modification saisie au clavier ne crée qu'une entrée d'historique :
// instantané pris à l'entrée dans le champ, enregistré à la sortie s'il a changé.
let editSnap = null;
function bindProp(id, apply, { live = true } = {}) {
  const el = $(id);
  el.addEventListener("focus", () => { editSnap = snapshot(); });
  const run = () => {
    const z = selected();
    if (!z) return;
    if (editSnap === null) editSnap = snapshot();
    apply(z, el);
    renderZones();
    renderList();
    scheduleSave();
  };
  if (live) el.addEventListener("input", run);
  el.addEventListener("change", () => {
    run();
    renderProps();
    if (editSnap !== null && editSnap !== snapshot()) pushHistory(editSnap);
    editSnap = document.activeElement === el ? snapshot() : null;
  });
  el.addEventListener("blur", () => { editSnap = null; });
}

const numVal = (el, fallback) => {
  const v = parseFloat(String(el.value).replace(",", "."));
  return Number.isFinite(v) ? v : fallback;
};

function applyGeometry(z) {
  const info = state.doc.pages[z.page - 1];
  Object.assign(z, clampRect(z, info.width, info.height, 1));
}

bindProp("p-name", (z, el) => {
  const wanted = slugName(el.value);
  const clash = state.zones.some((o) => o.id !== z.id && o.name === wanted);
  $("p-name-error").hidden = !(clash || !wanted);
  $("p-name-error").textContent = !wanted ? "Le nom ne peut pas être vide." : "Ce nom est déjà utilisé.";
  if (wanted && !clash) z.name = wanted;
});
$("p-name").addEventListener("blur", () => { $("p-name-error").hidden = true; renderProps(); });
bindProp("p-type", (z, el) => {
  const type = el.value;
  if (type === z.type) return;
  z.type = type;
  if (isTextType(type)) {
    z.align ||= "left";
    z.size ||= 11;
    if (type === "multiline") z.lineHeight ||= round2(z.size * 1.25);
  }
  if (type === "checkbox" || type === "image") z.value = "";
  if (type !== "image" && state.images.has(z.id)) {
    URL.revokeObjectURL(state.images.get(z.id).url);
    state.images.delete(z.id);
  }
  renderProps();
}, { live: false });
bindProp("p-x", (z, el) => { z.x = numVal(el, z.x); applyGeometry(z); });
bindProp("p-y", (z, el) => { z.y = numVal(el, z.y); applyGeometry(z); });
bindProp("p-w", (z, el) => { z.width = Math.max(1, numVal(el, z.width)); applyGeometry(z); });
bindProp("p-h", (z, el) => { z.height = Math.max(1, numVal(el, z.height)); applyGeometry(z); });
bindProp("p-align", (z, el) => { z.align = el.value; });
bindProp("p-size", (z, el) => { z.size = Math.min(200, Math.max(4, numVal(el, z.size))); });
bindProp("p-lh", (z, el) => { z.lineHeight = Math.min(300, Math.max(4, numVal(el, z.lineHeight))); });
bindProp("p-value", (z, el) => { z.value = el.value; });
bindProp("p-checked", (z, el) => { z.value = el.checked ? "x" : ""; }, { live: false });

$("p-image").addEventListener("change", async () => {
  const z = selected();
  const file = $("p-image").files[0];
  if (!z || !file) return;
  try {
    let blob = file;
    if (file.type !== "image/png" && file.type !== "image/jpeg") blob = await toPng(file);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (state.images.has(z.id)) URL.revokeObjectURL(state.images.get(z.id).url);
    state.images.set(z.id, { bytes, mime: blob.type, url: URL.createObjectURL(blob) });
    renderZones();
    renderProps();
  } catch {
    toast("Cette image n'a pas pu être lue.", true);
  }
});

$("p-image-clear").addEventListener("click", () => {
  const z = selected();
  if (!z || !state.images.has(z.id)) return;
  URL.revokeObjectURL(state.images.get(z.id).url);
  state.images.delete(z.id);
  renderZones();
  renderProps();
});

/** Convertit une image (WebP, GIF…) en PNG, seul format accepté avec le JPEG par pdf-lib. */
async function toPng(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("png"))), "image/png"));
}

function deleteSelected() {
  const z = selected();
  if (!z) return;
  pushHistory();
  state.zones = state.zones.filter((o) => o.id !== z.id);
  if (state.images.has(z.id)) {
    URL.revokeObjectURL(state.images.get(z.id).url);
    state.images.delete(z.id);
  }
  state.selectedId = null;
  changed();
}

function duplicateSelected() {
  const z = selected();
  if (!z) return;
  pushHistory();
  const info = pageInfo();
  const copy = makeZone(z.type, clampRect({ ...z, x: z.x + 10, y: z.y + 10 }, info.width, info.height), z.page, state.zones, {
    name: z.name.replace(/_\d+$/, ""), align: z.align, size: z.size, lineHeight: z.lineHeight,
  });
  copy.value = z.value;
  state.zones.push(copy);
  state.selectedId = copy.id;
  changed();
}

$("p-delete").addEventListener("click", deleteSelected);
$("p-duplicate").addEventListener("click", duplicateSelected);

// --- Outils ----------------------------------------------------------------------------
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll(".tool").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === tool);
    b.setAttribute("aria-checked", String(b.dataset.tool === tool));
  });
  $("overlay").classList.toggle("drawing", tool !== "select");
  $("tool-hint").textContent = TOOL_HINTS[tool];
  if (tool !== "grid") hideGridPanel();
}
document.querySelectorAll(".tool").forEach((b) => {
  b.setAttribute("role", "radio");
  b.addEventListener("click", () => setTool(b.dataset.tool));
});

// --- Grille ------------------------------------------------------------------------------
function gridConfig() {
  return {
    baseName: $("grid-basename").value,
    cols: parseInt($("grid-cols").value, 10) || 1,
    rows: parseInt($("grid-rows").value, 10) || 1,
    gapX: Math.max(0, numVal($("grid-gapx"), 0)),
    gapY: Math.max(0, numVal($("grid-gapy"), 0)),
    type: $("grid-type").value,
    align: $("grid-align").value,
    size: numVal($("grid-size"), 11),
  };
}

function drawGridDraft() {
  const overlay = $("overlay");
  overlay.querySelectorAll(".draft").forEach((el) => el.remove());
  const area = state.pendingGrid;
  if (!area || area.page !== state.page) return;
  const s = scale();
  const cfg = gridConfig();
  const outer = document.createElement("div");
  outer.className = "draft";
  Object.assign(outer.style, { left: area.x * s + "px", top: area.y * s + "px", width: area.width * s + "px", height: area.height * s + "px" });
  overlay.appendChild(outer);
  const rects = gridRects(area, cfg);
  if (rects.length <= 2000) {
    for (const r of rects) {
      const c = document.createElement("div");
      c.className = "draft cell";
      Object.assign(c.style, { left: r.x * s + "px", top: r.y * s + "px", width: Math.max(0, r.width) * s + "px", height: Math.max(0, r.height) * s + "px" });
      overlay.appendChild(c);
    }
  }
  const cell = rects[0];
  $("grid-info").textContent = cell.width > 0 && cell.height > 0
    ? `${rects.length} zone(s) de ${round2(cell.width)} × ${round2(cell.height)} pt.`
    : "Les espacements sont trop grands pour cette zone.";
  $("grid-text-opts").hidden = !isTextType(cfg.type);
}

function showGridPanel(area) {
  state.pendingGrid = area;
  $("grid-area-info").textContent = `Zone de ${round2(area.width)} × ${round2(area.height)} pt.`;
  $("grid-panel").hidden = false;
  drawGridDraft();
  $("grid-panel").scrollIntoView({ block: "nearest" });
}

function hideGridPanel() {
  state.pendingGrid = null;
  $("grid-panel").hidden = true;
  $("overlay").querySelectorAll(".draft").forEach((el) => el.remove());
}

["grid-cols", "grid-rows", "grid-gapx", "grid-gapy", "grid-type"].forEach((id) => $(id).addEventListener("input", drawGridDraft));
$("grid-cancel").addEventListener("click", hideGridPanel);
$("grid-create").addEventListener("click", () => {
  const area = state.pendingGrid;
  if (!area) return;
  const cfg = gridConfig();
  if (cfg.cols * cfg.rows > 2000) { toast("2000 zones maximum par grille.", true); return; }
  let created;
  try {
    created = makeGridZones(area, cfg, area.page, state.zones);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  pushHistory();
  state.zones.push(...created);
  state.selectedId = created[0]?.id || null;
  hideGridPanel();
  setTool("select");
  changed();
  toast(`${created.length} zone(s) créée(s).`);
});

// --- Souris / tactile sur la page --------------------------------------------------------
let drag = null;

function pointerPos(e) {
  const r = $("overlay").getBoundingClientRect();
  const s = scale();
  // Arrondi au demi-point : bien assez précis, et des valeurs lisibles.
  const snap = (v) => Math.round(v * 2) / 2;
  return { x: snap((e.clientX - r.left) / s), y: snap((e.clientY - r.top) / s) };
}

$("overlay").addEventListener("pointerdown", (e) => {
  if (!state.doc || e.button > 0) return;
  const p = pointerPos(e);
  const handle = e.target.closest(".handle");
  const zoneEl = e.target.closest(".zone");
  const overlay = $("overlay");

  if (zoneEl) {
    const z = state.zones.find((o) => o.id === zoneEl.dataset.id);
    if (!z) return;
    e.preventDefault();
    if (state.selectedId !== z.id) select(z.id);
    drag = { kind: handle ? "resize" : "move", handle: handle?.dataset.handle, id: z.id, start: p, orig: { ...z }, snap: snapshot(), moved: false };
    overlay.setPointerCapture(e.pointerId);
    return;
  }

  if (state.tool === "select") {
    if (state.selectedId) select(null);
    return;
  }
  e.preventDefault();
  if (state.tool === "grid") hideGridPanel();
  const draft = document.createElement("div");
  draft.className = "draft";
  overlay.appendChild(draft);
  drag = { kind: "draw", start: p, current: p, draft, pointerType: e.pointerType };
  overlay.setPointerCapture(e.pointerId);
});

$("overlay").addEventListener("pointermove", (e) => {
  if (!drag) return;
  const p = pointerPos(e);
  const info = pageInfo();
  const s = scale();
  if (drag.kind === "draw") {
    drag.current = p;
    const r = clampRect({ x: drag.start.x, y: drag.start.y, width: p.x - drag.start.x, height: p.y - drag.start.y }, info.width, info.height, 0);
    Object.assign(drag.draft.style, { left: r.x * s + "px", top: r.y * s + "px", width: r.width * s + "px", height: r.height * s + "px" });
    return;
  }
  const z = state.zones.find((o) => o.id === drag.id);
  if (!z) return;
  const dx = p.x - drag.start.x;
  const dy = p.y - drag.start.y;
  if (!drag.moved && Math.hypot(dx, dy) * s < 3) return;
  drag.moved = true;
  const o = drag.orig;
  if (drag.kind === "move") {
    Object.assign(z, clampRect({ x: o.x + dx, y: o.y + dy, width: o.width, height: o.height }, info.width, info.height, 1));
  } else {
    let x1 = o.x, y1 = o.y, x2 = o.x + o.width, y2 = o.y + o.height;
    if (drag.handle.includes("w")) x1 += dx; else x2 += dx;
    if (drag.handle.includes("n")) y1 += dy; else y2 += dy;
    Object.assign(z, clampRect({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, info.width, info.height, 2));
  }
  const el = $("overlay").querySelector(`.zone[data-id="${z.id}"]`);
  if (el) Object.assign(el.style, { left: z.x * s + "px", top: z.y * s + "px", width: z.width * s + "px", height: z.height * s + "px" });
  if (selected() === z) {
    $("p-x").value = round2(z.x); $("p-y").value = round2(z.y);
    $("p-w").value = round2(z.width); $("p-h").value = round2(z.height);
  }
});

function endDrag(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind !== "draw") {
    if (d.moved) {
      pushHistory(d.snap);
      changed();
    }
    return;
  }
  d.draft.remove();
  if (e.type === "pointercancel") return;
  const info = pageInfo();
  const s = scale();
  const raw = { x: d.start.x, y: d.start.y, width: d.current.x - d.start.x, height: d.current.y - d.start.y };
  const isClick = Math.abs(raw.width) * s < 6 && Math.abs(raw.height) * s < 6;

  if (state.tool === "grid") {
    if (isClick) { toast("Glissez pour délimiter la zone à découper en grille."); return; }
    showGridPanel({ page: state.page, ...clampRect(raw, info.width, info.height, 2) });
    return;
  }

  let rect;
  if (isClick) {
    const def = DEFAULT_SIZES[state.tool];
    // Clic : la case est centrée sur le clic, les autres zones partent du clic.
    rect = state.tool === "checkbox"
      ? { x: d.start.x - def.width / 2, y: d.start.y - def.height / 2, ...def }
      : { x: d.start.x, y: d.start.y - def.height / 2, ...def };
  } else {
    rect = raw;
  }
  rect = clampRect(rect, info.width, info.height, 2);
  pushHistory();
  const z = makeZone(state.tool, rect, state.page, state.zones);
  state.zones.push(z);
  state.selectedId = z.id;
  changed();
  if (d.pointerType === "mouse") {
    $("p-name").focus();
    $("p-name").select();
  }
}
$("overlay").addEventListener("pointerup", endDrag);
$("overlay").addEventListener("pointercancel", endDrag);

// --- Clavier ------------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (!state.doc || $("help-dialog").open) return;
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (e.key === "Escape") {
    if (inField) { e.target.blur(); return; }
    if (state.pendingGrid) hideGridPanel();
    else if (state.selectedId) select(null);
    else setTool("select");
    return;
  }
  if (mod && key === "z" && !e.shiftKey && !inField) { e.preventDefault(); undo(); return; }
  if (mod && (key === "y" || (key === "z" && e.shiftKey)) && !inField) { e.preventDefault(); redo(); return; }
  if (inField) return;
  if (mod && key === "d") { e.preventDefault(); duplicateSelected(); return; }
  if (mod) return;

  const tools = { v: "select", t: "text", p: "multiline", c: "checkbox", i: "image", g: "grid" };
  if (tools[key]) { setTool(tools[key]); return; }
  if (e.key === "PageDown") { e.preventDefault(); showPage(state.page + 1); return; }
  if (e.key === "PageUp") { e.preventDefault(); showPage(state.page - 1); return; }
  if (e.key === "+" || e.key === "=") { zoomStep(1); return; }
  if (e.key === "-") { zoomStep(-1); return; }

  const z = selected();
  if (!z) return;
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); return; }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key]) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    if (!e.repeat || !undoStack.length) pushHistory();
    z.x += arrows[e.key][0] * step;
    z.y += arrows[e.key][1] * step;
    applyGeometry(z);
    changed();
  }
});

// --- Exports --------------------------------------------------------------------------------
$("export-json").addEventListener("click", () => {
  if (!state.zones.length) { toast("Aucune zone à exporter pour l'instant."); return; }
  const data = exportData(state.doc, state.font, state.zones);
  download(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), `${baseName()}-zones.json`);
});

$("export-csv").addEventListener("click", () => {
  if (!state.zones.length) { toast("Aucune zone à exporter pour l'instant."); return; }
  download(new Blob([exportCsv(state.doc, state.zones)], { type: "text/csv;charset=utf-8" }), `${baseName()}-zones.csv`);
});

$("import-json").addEventListener("click", () => $("json-input").click());
$("json-input").addEventListener("change", async () => {
  const file = $("json-input").files[0];
  $("json-input").value = "";
  if (!file) return;
  try {
    const { font, zones, warnings } = importData(await file.text(), state.doc);
    if (!zones.length) throw new Error("Aucune zone utilisable dans ce fichier.");
    if (state.zones.length && !confirm(`Remplacer les ${state.zones.length} zone(s) actuelle(s) par les ${zones.length} du fichier ?`)) return;
    pushHistory();
    state.zones = zones;
    if (font) { state.font = font; $("font-select").value = font; }
    state.selectedId = null;
    changed();
    toast([`${zones.length} zone(s) importée(s).`, ...warnings].join(" "));
  } catch (err) {
    toast(err.message, true);
  }
});

$("clear-all").addEventListener("click", () => {
  if (!state.zones.length) return;
  if (!confirm(`Effacer les ${state.zones.length} zone(s) de ce document ? (Vous pourrez annuler avec Ctrl+Z.)`)) return;
  pushHistory();
  state.zones = [];
  state.selectedId = null;
  changed();
});

$("fill-btn").addEventListener("click", async () => {
  if (!state.zones.length) { toast("Ajoutez d'abord des zones et un texte d'essai."); return; }
  const btn = $("fill-btn");
  btn.disabled = true;
  btn.textContent = "Préparation du PDF…";
  try {
    const { fillPdf } = await import("./filler.js");
    const { bytes, skippedChars } = await fillPdf(state.bytes, state.doc, state.font, state.zones, state.images, {
      outlines: $("fill-outlines").checked,
    });
    download(new Blob([bytes], { type: "application/pdf" }), `${baseName()}-rempli.pdf`);
    if (skippedChars) toast("Certains caractères (emoji, alphabets non latins…) ne sont pas pris en charge par la police et ont été remplacés par « ? ».");
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Télécharger le PDF rempli";
  }
});

// --- Divers ------------------------------------------------------------------------------------
for (const [key, label] of Object.entries(FONTS)) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = label;
  $("font-select").appendChild(opt);
}
$("font-select").addEventListener("change", (e) => { state.font = e.target.value; renderZones(); scheduleSave(); });
$("show-values").addEventListener("change", renderZones);
$("list-all").addEventListener("change", renderList);

$("open-btn").addEventListener("click", () => $("pdf-input").click());
$("empty-open").addEventListener("click", () => $("pdf-input").click());
$("pdf-input").addEventListener("change", () => {
  openFile($("pdf-input").files[0]);
  $("pdf-input").value = "";
});

$("prev-page").addEventListener("click", () => showPage(state.page - 1));
$("next-page").addEventListener("click", () => showPage(state.page + 1));
$("page-input").addEventListener("change", (e) => showPage(parseInt(e.target.value, 10) || 1));
$("zoom-in").addEventListener("click", () => zoomStep(1));
$("zoom-out").addEventListener("click", () => zoomStep(-1));
$("zoom-fit").addEventListener("click", () => { state.fitMode = true; showPage(state.page); });
$("undo-btn").addEventListener("click", undo);
$("redo-btn").addEventListener("click", redo);
$("help-btn").addEventListener("click", () => $("help-dialog").showModal());

// Ctrl + molette : zoom.
$("viewer").addEventListener("wheel", (e) => {
  if (!state.doc || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  zoomStep(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.doc && state.fitMode) showPage(state.page); }, 150);
});

// Glisser-déposer d'un PDF n'importe où dans la zone d'affichage.
const viewer = $("viewer");
["dragenter", "dragover"].forEach((t) => viewer.addEventListener(t, (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  viewer.classList.add("dragover");
}));
["dragleave", "drop"].forEach((t) => viewer.addEventListener(t, (e) => {
  if (t === "dragleave" && viewer.contains(e.relatedTarget)) return;
  viewer.classList.remove("dragover");
}));
viewer.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])][0];
  if (file) openFile(file);
});
// Évite que le navigateur ouvre le fichier s'il est lâché à côté.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

setTool("select");
