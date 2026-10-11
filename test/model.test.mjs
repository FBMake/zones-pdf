// Tests du modèle et du remplissage : `npm test` (Node 18 ou plus récent).
import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, degrees } from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import {
  uniqueName, nextAutoName, clampRect, makeZone, makeGridZones, gridRects,
  toPdfPoint, toPdfRect, displayAngle, wrapText, isChecked,
  exportData, importData, exportCsv,
} from "../js/model.js";
import { fillPdf } from "../js/filler.js";

// Matrices `transform` de pdf.js (échelle 1) pour une page A4 sans rotation et tournée à 90°.
const A4 = { width: 595, height: 842, transform: [1, 0, 0, -1, 0, 842], rotate: 0 };
const A4_ROT90 = { width: 842, height: 595, transform: [0, 1, 1, 0, 0, 0], rotate: 90 };
const doc = { name: "essai.pdf", pages: [A4, A4] };

test("noms uniques et automatiques", () => {
  const zones = [{ id: "a", name: "nom" }, { id: "b", name: "nom_2" }];
  assert.equal(uniqueName("nom", zones), "nom_3");
  assert.equal(uniqueName("nom", zones, "a"), "nom");
  assert.equal(uniqueName("  prénom client ", zones), "prénom_client");
  assert.equal(nextAutoName("texte", [{ name: "texte_1" }]), "texte_2");
});

test("clampRect normalise et garde le rectangle dans la page", () => {
  assert.deepEqual(clampRect({ x: 100, y: 100, width: -50, height: -20 }, 595, 842), { x: 50, y: 80, width: 50, height: 20 });
  assert.deepEqual(clampRect({ x: 580, y: -5, width: 40, height: 10 }, 595, 842), { x: 555, y: 0, width: 40, height: 10 });
});

test("grille : cellules et noms", () => {
  const rects = gridRects({ x: 0, y: 0, width: 100, height: 20 }, { cols: 4, rows: 1, gapX: 4 });
  assert.equal(rects.length, 4);
  assert.equal(rects[1].x, 26);
  assert.equal(rects[0].width, 22);
  const zones = makeGridZones({ x: 0, y: 0, width: 90, height: 60 }, { cols: 3, rows: 2, type: "text", baseName: "stat" }, 1, []);
  assert.deepEqual(zones.map((z) => z.name), ["stat_l1c1", "stat_l1c2", "stat_l1c3", "stat_l2c1", "stat_l2c2", "stat_l2c3"]);
  assert.throws(() => makeGridZones({ x: 0, y: 0, width: 10, height: 10 }, { cols: 3, rows: 1, gapX: 10, type: "text" }, 1, []));
});

test("conversion vers le repère natif du PDF", () => {
  assert.deepEqual(toPdfPoint(A4, 10, 20), { x: 10, y: 822 });
  assert.deepEqual(toPdfRect(A4, { x: 10, y: 20, width: 100, height: 30 }), { x: 10, y: 792, width: 100, height: 30 });
  assert.equal(displayAngle(A4), 0);
  // Page tournée de 90° : le haut-gauche affiché correspond à l'origine native.
  assert.deepEqual(toPdfPoint(A4_ROT90, 0, 0), { x: 0, y: 0 });
  assert.deepEqual(toPdfPoint(A4_ROT90, 100, 0), { x: 0, y: 100 });
  assert.equal(displayAngle(A4_ROT90), 90);
});

test("retour à la ligne", () => {
  const measure = (s) => s.length; // 1 caractère = 1 unité
  assert.deepEqual(wrapText("un deux trois quatre", 9, measure), ["un deux", "trois", "quatre"]);
  assert.deepEqual(wrapText("ligne 1\nligne 2", 50, measure), ["ligne 1", "ligne 2"]);
  assert.deepEqual(wrapText("abcdefghij", 4, measure), ["abcd", "efgh", "ij"]);
});

test("case cochée", () => {
  assert.ok(isChecked("x"));
  assert.ok(isChecked("oui"));
  assert.ok(!isChecked(""));
  assert.ok(!isChecked("non"));
});

test("export puis import JSON : aller-retour", () => {
  const zones = [];
  zones.push(makeZone("text", { x: 10, y: 20, width: 100, height: 18 }, 1, zones, { name: "nom", size: 12 }));
  zones[0].value = "Dupont";
  zones.push(makeZone("multiline", { x: 10, y: 60, width: 200, height: 80 }, 2, zones, { name: "notes" }));
  zones.push(makeZone("checkbox", { x: 300, y: 20, width: 12, height: 12 }, 1, zones, { name: "accord" }));
  const data = exportData(doc, "TimesRoman", zones);
  assert.equal(data.format, "zones-pdf");
  assert.equal(data.zones[0].pdf.y, 804);
  assert.equal(data.zones[0].value, "Dupont");
  assert.equal(data.zones[1].lineHeight, zones[1].lineHeight);

  const back = importData(JSON.stringify(data), doc);
  assert.equal(back.font, "TimesRoman");
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.zones.map((z) => [z.name, z.page, z.type, z.x, z.y, z.width, z.height]),
    zones.map((z) => [z.name, z.page, z.type, z.x, z.y, z.width, z.height]));

  const oneProblem = importData(JSON.stringify({ ...data, zones: [...data.zones, { ...data.zones[0], page: 9 }] }), doc);
  assert.equal(oneProblem.zones.length, 3);
  assert.equal(oneProblem.warnings.length, 1);
  assert.throws(() => importData("{}", doc), /Zones PDF/);
  assert.throws(() => importData("pas du json", doc), /JSON/);
});

test("export CSV", () => {
  const z = makeZone("text", { x: 10.5, y: 20, width: 100, height: 18 }, 1, [], { name: "nom" });
  z.value = 'Dupont; "Jean"';
  const csv = exportCsv(doc, [z]);
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith("nom;1;text;10,5;20;100;18;10,5;804;"));
  assert.ok(lines[1].endsWith('"Dupont; ""Jean"""'));
});

test("remplissage d'un PDF (page normale et page tournée)", async () => {
  const src = await PDFDocument.create();
  src.addPage([595, 842]);
  const rotated = src.addPage([595, 842]);
  rotated.setRotation(degrees(90));
  const bytes = await src.save();
  const fillDoc = { pages: [A4, { width: 842, height: 595, transform: [0, 1, 1, 0, 0, 0], rotate: 90 }] };

  const zones = [];
  const add = (type, rect, page, value) => {
    const z = makeZone(type, rect, page, zones);
    z.value = value;
    zones.push(z);
  };
  add("text", { x: 50, y: 50, width: 200, height: 20 }, 1, "Bonjour, ça marche ! 🙂");
  add("multiline", { x: 50, y: 100, width: 120, height: 100 }, 1, "Un texte assez long pour revenir à la ligne plusieurs fois.");
  add("checkbox", { x: 50, y: 250, width: 12, height: 12 }, 1, "x");
  add("text", { x: 50, y: 50, width: 200, height: 20 }, 2, "Page tournée");

  const { bytes: out, skippedChars } = await fillPdf(bytes, fillDoc, "Helvetica", zones, new Map(), { outlines: true });
  assert.ok(skippedChars, "l'emoji doit être signalé");
  const filled = await PDFDocument.load(out);
  assert.equal(filled.getPageCount(), 2);
});
