// ---------------------------------------------------------------------------
// Modèle de données de Zones PDF : fonctions pures, sans DOM ni pdf.js,
// testables avec Node (voir test/model.test.mjs).
//
// Convention interne : toutes les coordonnées sont en points PDF (1 pt =
// 1/72 de pouce), origine en HAUT à gauche de la page telle qu'elle est
// affichée (comme dans un éditeur d'image). La conversion vers le repère
// natif du PDF (origine en BAS à gauche, rotation de page éventuelle) se
// fait avec la matrice `transform` de chaque page, fournie par pdf.js.
// ---------------------------------------------------------------------------

export const FORMAT_ID = "zones-pdf";
export const FORMAT_VERSION = 1;

export const ZONE_TYPES = {
  text: "Texte (une ligne)",
  multiline: "Paragraphe",
  checkbox: "Case à cocher",
  image: "Image",
};

export const FONTS = {
  Helvetica: "Helvetica (sans empattement)",
  TimesRoman: "Times (avec empattement)",
  Courier: "Courier (machine à écrire)",
};

// Taille par défaut d'une zone créée d'un simple clic (en points).
export const DEFAULT_SIZES = {
  text: { width: 150, height: 18 },
  multiline: { width: 250, height: 80 },
  checkbox: { width: 12, height: 12 },
  image: { width: 120, height: 80 },
};

export const isTextType = (type) => type === "text" || type === "multiline";

export const round2 = (n) => Math.round(n * 100) / 100;

// --- Noms -------------------------------------------------------------------

export function slugName(raw) {
  return String(raw ?? "").trim().replace(/\s+/g, "_");
}

/** Renvoie `base` ou `base_2`, `base_3`… pour éviter les doublons. */
export function uniqueName(base, zones, ignoreId = null) {
  const clean = slugName(base) || "zone";
  const taken = new Set(zones.filter((z) => z.id !== ignoreId).map((z) => z.name));
  if (!taken.has(clean)) return clean;
  let i = 2;
  while (taken.has(`${clean}_${i}`)) i++;
  return `${clean}_${i}`;
}

/** Prochain nom automatique : `champ_1`, `champ_2`… */
export function nextAutoName(prefix, zones) {
  const taken = new Set(zones.map((z) => z.name));
  let i = 1;
  while (taken.has(`${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}

const AUTO_PREFIX = { text: "texte", multiline: "paragraphe", checkbox: "case", image: "image" };

// --- Création ---------------------------------------------------------------

let idCounter = 0;
export function newId() {
  idCounter += 1;
  return `z${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** Normalise un rectangle (largeur/hauteur positives) et le garde dans la page. */
export function clampRect(rect, pageW, pageH, minSize = 4) {
  let { x, y, width, height } = rect;
  if (width < 0) { x += width; width = -width; }
  if (height < 0) { y += height; height = -height; }
  width = Math.min(Math.max(width, minSize), pageW);
  height = Math.min(Math.max(height, minSize), pageH);
  x = Math.min(Math.max(x, 0), pageW - width);
  y = Math.min(Math.max(y, 0), pageH - height);
  return { x, y, width, height };
}

export function makeZone(type, rect, page, zones, opts = {}) {
  const zone = {
    id: newId(),
    name: opts.name ? uniqueName(opts.name, zones) : nextAutoName(AUTO_PREFIX[type] || "zone", zones),
    page,
    type,
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    value: "",
  };
  if (isTextType(type)) {
    zone.align = opts.align || "left";
    zone.size = opts.size || (type === "text" ? Math.max(6, Math.round(rect.height * 0.65)) : 11);
    if (type === "multiline") zone.lineHeight = opts.lineHeight || Math.round(zone.size * 1.25 * 10) / 10;
  }
  return zone;
}

/** Découpe une zone rectangulaire en colonnes × lignes de zones identiques. */
export function gridRects(area, { cols, rows, gapX = 0, gapY = 0 }) {
  cols = Math.max(1, Math.floor(cols) || 1);
  rows = Math.max(1, Math.floor(rows) || 1);
  const cellW = (area.width - gapX * (cols - 1)) / cols;
  const cellH = (area.height - gapY * (rows - 1)) / rows;
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({ row: r, col: c, x: area.x + c * (cellW + gapX), y: area.y + r * (cellH + gapY), width: cellW, height: cellH });
    }
  }
  return out;
}

export function makeGridZones(area, cfg, page, zones) {
  const rects = gridRects(area, cfg);
  if (rects.some((r) => r.width <= 0 || r.height <= 0)) {
    throw new Error("Les espacements sont trop grands pour cette zone.");
  }
  const base = slugName(cfg.baseName) || "champ";
  const created = [];
  const all = [...zones];
  const single = Math.max(1, Math.floor(cfg.rows) || 1) === 1;
  rects.forEach((r, i) => {
    const wanted = single ? `${base}_${i + 1}` : `${base}_l${r.row + 1}c${r.col + 1}`;
    const z = makeZone(cfg.type, r, page, all, { name: wanted, align: cfg.align, size: cfg.size });
    created.push(z);
    all.push(z);
  });
  return created;
}

// --- Repères ----------------------------------------------------------------

/**
 * Convertit un point affiché (origine haut-gauche, en points) vers le repère
 * natif du PDF, en inversant la matrice `transform` de pdf.js (échelle 1).
 */
export function toPdfPoint(pageInfo, x, y) {
  const [a, b, c, d, e, f] = pageInfo.transform;
  const det = a * d - b * c;
  // `+ 0` transforme un éventuel -0 en 0.
  return {
    x: (d * (x - e) - c * (y - f)) / det + 0,
    y: (-b * (x - e) + a * (y - f)) / det + 0,
  };
}

/** Rectangle affiché → rectangle englobant dans le repère natif du PDF. */
export function toPdfRect(pageInfo, rect) {
  const pts = [
    toPdfPoint(pageInfo, rect.x, rect.y),
    toPdfPoint(pageInfo, rect.x + rect.width, rect.y),
    toPdfPoint(pageInfo, rect.x, rect.y + rect.height),
    toPdfPoint(pageInfo, rect.x + rect.width, rect.y + rect.height),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Angle (degrés, sens trigonométrique) de l'axe horizontal affiché dans le repère PDF. */
export function displayAngle(pageInfo) {
  const p0 = toPdfPoint(pageInfo, 0, 0);
  const p1 = toPdfPoint(pageInfo, 1, 0);
  return Math.round((Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI);
}

// --- Texte ------------------------------------------------------------------

/**
 * Coupe un texte en lignes qui tiennent dans `maxWidth`, avec une fonction de
 * mesure `measure(str) => largeur`. Respecte les retours à la ligne saisis.
 */
export function wrapText(text, maxWidth, measure) {
  const lines = [];
  for (const para of String(text ?? "").split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (!line || measure(candidate) <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
      // Mot plus long que la zone : on le coupe caractère par caractère.
      while (measure(line) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

export function isChecked(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v !== "" && !["0", "non", "no", "false", "faux"].includes(v);
}

// --- Export / import ----------------------------------------------------------

export function exportData(doc, font, zones) {
  return {
    format: FORMAT_ID,
    version: FORMAT_VERSION,
    generator: "Zones PDF",
    document: {
      name: doc.name,
      pageCount: doc.pages.length,
      pages: doc.pages.map((p, i) => ({ page: i + 1, width: round2(p.width), height: round2(p.height), rotate: p.rotate || 0 })),
    },
    units: "pt",
    font,
    zones: zones.map((z) => {
      const info = doc.pages[z.page - 1];
      const pdf = toPdfRect(info, z);
      const out = {
        name: z.name,
        page: z.page,
        type: z.type,
        x: round2(z.x), y: round2(z.y), width: round2(z.width), height: round2(z.height),
        pdf: { x: round2(pdf.x), y: round2(pdf.y), width: round2(pdf.width), height: round2(pdf.height) },
      };
      if (isTextType(z.type)) {
        out.align = z.align || "left";
        out.size = z.size;
        if (z.type === "multiline") out.lineHeight = z.lineHeight;
      }
      if (z.value && z.type !== "image") out.value = z.value;
      return out;
    }),
  };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

/**
 * Lit un fichier exporté. Renvoie { font, zones, warnings }. Les zones dont la
 * page n'existe pas dans le PDF ouvert sont ignorées (avec un avertissement).
 */
export function importData(text, doc) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Ce fichier n'est pas un JSON valide."); }
  if (!data || data.format !== FORMAT_ID || !Array.isArray(data.zones)) {
    throw new Error("Ce fichier n'a pas été créé par Zones PDF.");
  }
  const warnings = [];
  if (data.document?.pageCount && data.document.pageCount !== doc.pages.length) {
    warnings.push(`Le fichier décrit un PDF de ${data.document.pageCount} page(s), celui ouvert en a ${doc.pages.length}.`);
  }
  const zones = [];
  let skipped = 0;
  for (const raw of data.zones) {
    const page = Math.floor(num(raw.page));
    const rect = { x: num(raw.x), y: num(raw.y), width: num(raw.width), height: num(raw.height) };
    if (!(page >= 1 && page <= doc.pages.length) || Object.values(rect).some(Number.isNaN) || !ZONE_TYPES[raw.type]) {
      skipped++;
      continue;
    }
    const info = doc.pages[page - 1];
    const z = makeZone(raw.type, clampRect(rect, info.width, info.height), page, zones, {
      name: raw.name, align: raw.align, size: num(raw.size) || undefined, lineHeight: num(raw.lineHeight) || undefined,
    });
    if (raw.value && raw.type !== "image") z.value = String(raw.value);
    zones.push(z);
  }
  if (skipped) warnings.push(`${skipped} zone(s) ignorée(s) (page absente ou données incomplètes).`);
  return { font: FONTS[data.font] ? data.font : null, zones, warnings };
}

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV séparé par des points-virgules (ouverture directe dans Excel / LibreOffice en français). */
export function exportCsv(doc, zones) {
  const head = ["nom", "page", "type", "x", "y", "largeur", "hauteur", "pdf_x", "pdf_y", "alignement", "taille", "interligne", "valeur"];
  const fr = (n) => (n === "" || n === undefined ? "" : String(round2(n)).replace(".", ","));
  const rows = zones.map((z) => {
    const p = toPdfRect(doc.pages[z.page - 1], z);
    return [
      z.name, z.page, z.type, fr(z.x), fr(z.y), fr(z.width), fr(z.height), fr(p.x), fr(p.y),
      z.align || "", fr(z.size), fr(z.lineHeight), z.type === "image" ? "" : z.value,
    ].map(csvCell).join(";");
  });
  return "﻿" + [head.join(";"), ...rows].join("\r\n") + "\r\n";
}
