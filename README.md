# PocketScan v7

Phone barcode scanner that collects codes with photos and shares them as a PDF.

Live: https://javaftw.github.io/PocketScan/

Scan with your phone to open it:

<img src="docs/qr-code.svg" alt="QR code for https://javaftw.github.io/PocketScan/" width="200">

## Application

Buildless HTML, CSS and JavaScript in `dist/`. No installation or build is
needed to serve the application. Camera access needs HTTPS (or localhost).

- Minimal camera controls, flash and sound toggle.
- 1D-only barcode decoding, with duplicate skipping, undo and clear.
- Device-local barcode/photo storage.
- PDF sharing: two-column table, barcode left and uncropped photograph right.
- Three-note scan confirmation melody.

## Tests

The Node test tools require `sharp` and `@napi-rs/canvas`:

    npm install --no-save sharp @napi-rs/canvas
    node --check dist/app.js
    node --check dist/scanner.js
    node --check dist/media.js
    node tests/scanner-smoke.cjs
    node tests/share-smoke.cjs
    node tests/report-smoke.cjs

The report test writes sample files to `/tmp`; adjust those test paths for
Windows.

## Deployment

Every push to `main` publishes `dist/` to GitHub Pages through
`.github/workflows/pages.yml`.

Scans and photos stay in each device's browser storage and are never uploaded.
