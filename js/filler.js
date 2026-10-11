// ---------------------------------------------------------------------------
// Remplissage du PDF d'origine avec les valeurs saisies dans chaque zone,
// grâce à pdf-lib. Le fichier d'origine n'est jamais modifié : on produit
// une copie remplie.
// ---------------------------------------------------------------------------

import { PDFDocument, StandardFonts, degrees, rgb } from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import { toPdfPoint, displayAngle, wrapText, isChecked, isTextType } from "./model.js";

/** Remplace les caractères que la police standard ne sait pas écrire. */
function encodable(font, text) {
  let out = "";
  for (const ch of String(text)) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += ch === "\t" ? " " : "?";
    }
  }
  return out;
}

/**
 * @param {Uint8Array} bytes   PDF d'origine
 * @param {object}     doc     { pages: [{ width, height, transform }] }
 * @param {string}     fontKey Helvetica | TimesRoman | Courier
 * @param {Array}      zones
 * @param {Map}        images  id de zone → { bytes, mime }
 * @param {object}     opts    { outlines: bool }
 */
export async function fillPdf(bytes, doc, fontKey, zones, images, opts = {}) {
  let pdf;
  try {
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (err) {
    throw new Error("Ce PDF ne peut pas être modifié (" + err.message + ").");
  }
  const font = await pdf.embedFont(StandardFonts[fontKey] || StandardFonts.Helvetica);
  const dingbats = await pdf.embedFont(StandardFonts.ZapfDingbats);
  const pages = pdf.getPages();
  const black = rgb(0, 0, 0);
  let skippedChars = false;

  for (const z of zones) {
    const page = pages[z.page - 1];
    const info = doc.pages[z.page - 1];
    if (!page || !info) continue;
    const angle = degrees(displayAngle(info));
    // Point affiché (haut-gauche) → point natif du PDF.
    const at = (x, y) => toPdfPoint(info, x, y);

    if (opts.outlines) {
      const o = at(z.x, z.y + z.height);
      page.drawRectangle({
        x: o.x, y: o.y, width: z.width, height: z.height, rotate: angle,
        borderColor: rgb(0.1, 0.45, 0.9), borderWidth: 0.6, borderOpacity: 0.8,
      });
    }

    if (isTextType(z.type) && z.value) {
      const size = z.size || 11;
      const ascent = font.heightAtSize(size, { descender: false });
      const full = font.heightAtSize(size);
      const measure = (s) => font.widthOfTextAtSize(s, size);
      const raw = z.type === "multiline" ? z.value : z.value.replace(/\s*\r?\n\s*/g, " ");
      const safe = encodable(font, raw);
      if (safe !== raw) skippedChars = true;
      const lines = z.type === "multiline" ? wrapText(safe, z.width, measure) : [safe];
      const lineHeight = z.type === "multiline" ? z.lineHeight || size * 1.25 : 0;
      lines.forEach((line, i) => {
        if (!line) return;
        const w = measure(line);
        let x = z.x;
        if (z.align === "center") x = z.x + (z.width - w) / 2;
        else if (z.align === "right") x = z.x + z.width - w;
        const baseline = z.type === "multiline"
          ? z.y + ascent + i * lineHeight
          : z.y + (z.height - full) / 2 + ascent;
        const p = at(x, baseline);
        page.drawText(line, { x: p.x, y: p.y, size, font, color: black, rotate: angle });
      });
    } else if (z.type === "checkbox" && isChecked(z.value)) {
      const size = Math.min(z.width, z.height) * 0.9;
      const mark = "✔";
      const w = dingbats.widthOfTextAtSize(mark, size);
      const h = dingbats.heightAtSize(size);
      const p = at(z.x + (z.width - w) / 2, z.y + (z.height + h) / 2 - h * 0.1);
      page.drawText(mark, { x: p.x, y: p.y, size, font: dingbats, color: black, rotate: angle });
    } else if (z.type === "image" && images.has(z.id)) {
      const { bytes: imgBytes, mime } = images.get(z.id);
      const img = mime === "image/png" ? await pdf.embedPng(imgBytes) : await pdf.embedJpg(imgBytes);
      const scale = Math.min(z.width / img.width, z.height / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const p = at(z.x + (z.width - w) / 2, z.y + (z.height + h) / 2);
      page.drawImage(img, { x: p.x, y: p.y, width: w, height: h, rotate: angle });
    }
  }

  return { bytes: await pdf.save(), skippedChars };
}
