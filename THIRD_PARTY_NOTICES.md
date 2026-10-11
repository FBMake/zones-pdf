# Composants tiers

Ces bibliothèques sont embarquées dans `vendor/` (aucun appel à un CDN) :

| Composant | Version | Licence | Fichiers |
|---|---|---|---|
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`, build « legacy » pour les navigateurs plus anciens) | 5.7.284 | Apache-2.0 | `vendor/pdfjs/` — licence : `vendor/pdfjs/LICENSE` |
| Polices standard, CMaps, modules WebAssembly et profil ICC fournis avec PDF.js | 5.7.284 | voir les fichiers `LICENSE*` de chaque dossier (Foxit, Liberation, OpenJPEG, JBIG2, QCMS…) | `vendor/pdfjs/standard_fonts/`, `cmaps/`, `wasm/`, `iccs/` |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT | `vendor/pdf-lib/` — licence : `vendor/pdf-lib/LICENSE.md` |

Pour mettre à jour : `npm pack pdfjs-dist@<version> pdf-lib@<version>`, puis
recopier `legacy/build/pdf.min.mjs`, `legacy/build/pdf.worker.min.mjs` et les
dossiers `cmaps`, `standard_fonts`, `wasm` (sans `quickjs-eval.*`, inutile ici)
et `iccs` de PDF.js, et `dist/pdf-lib.esm.min.js` de pdf-lib.
