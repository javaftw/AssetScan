# AssetScan v14

Phone barcode scanner that collects codes with photos and shares them as a PDF.

Live: https://javaftw.github.io/AssetScan/

Scan with your phone to open it:

<img src="docs/qr-code.svg" alt="QR code for https://javaftw.github.io/AssetScan/" width="200">

## Application

Buildless HTML, CSS and JavaScript in `dist/`. No installation or build is
needed to serve the application. Camera access needs HTTPS (or localhost).

- Camera and List tabs at the top; tap or swipe sideways to switch. The camera
  pauses while the list is shown (so nothing is captured unseen and the PDF is
  prepared) and resumes on return.
- Minimal camera controls, flash and sound toggle.
- 1D barcodes: Code 128, Code 39, Code 93, ITF and Codabar for warehouse
  labels, plus EAN-13, EAN-8, UPC-A and UPC-E product codes. Only Code 128
  and Code 93 are accepted on a single read. The others are voted on over
  1.5 s by both decoders: two matching reads, or three that lead when another
  value was also read, because Code 39, ITF and Codabar have no mandatory
  checksum and a blurry product code can misread into another valid number.
- A falling three-note sound and a long buzz when a scan is already in the
  batch (with "Skip duplicates" on).
- ZXing decodes in a background worker (`decode-worker.js`), so scanning never
  stalls the camera preview or the buttons. Without worker support it falls
  back to decoding on the page.
- Duplicate skipping, undo and clear.
- Tap-to-focus, mild zoom and continuous or single-shot autofocus where the
  browser allows camera control.
- Rear-lens picker on the live camera picture when the browser lists more than
  one rear camera (front cameras are never offered). The choice is remembered,
  by label as well as ID, because browsers may issue new camera IDs per visit.
- Open the page with `?debug` to show decoder speed, camera resolution and
  settings, and the last raw reads (`✓` accepted, `·` not yet). Add `&zoom=1`
  to turn the mild zoom off, `&native=0` to scan with ZXing only, or
  `&box=20` to `&box=90` to try another guide-box width (percent of the picture).
- The guide box is sized so a standard 37 mm product barcode fills it at about
  18 cm, a distance most phone cameras can focus at: 28% of the picture's width
  without zoom, scaled up by the zoom actually applied (42% at 1.5x).
- Device-local barcode/photo storage.
- PDF sharing: two-column table, barcode left and uncropped photograph right.
- Three-note scan confirmation melody.

## Tests

The Node test tools require `sharp` and `@napi-rs/canvas`:

    npm install --no-save sharp@0.33.5 @napi-rs/canvas@1.0.10
    node --check dist/app.js
    node --check dist/scanner.js
    node --check dist/decoder.js
    node --check dist/decode-worker.js
    node --check dist/media.js
    node tests/scanner-smoke.cjs
    node tests/share-smoke.cjs
    node tests/report-smoke.cjs
    node tests/read-smoke.cjs

The report test writes sample files to `/tmp`; adjust those test paths for
Windows.

## Deployment

Every push to `main` publishes `dist/` to GitHub Pages through
`.github/workflows/pages.yml`.

Scans and photos stay in each device's browser storage and are never uploaded.
