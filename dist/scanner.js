/* Focused decoding uses temporary canvases; saved photos always use the full video. */
(() => {
  const linearFormats = ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'CODABAR', 'RSS_14'];
  const nativeFormats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar'];
  function createReader(ZXing) {
    const hints = new Map([
      [ZXing.DecodeHintType.POSSIBLE_FORMATS, linearFormats.map(name => ZXing.BarcodeFormat[name])],
      [ZXing.DecodeHintType.TRY_HARDER, true]
    ]);
    // This reader only instantiates 1D decoders; no QR, matrix, or PDF417 search.
    const reader = new ZXing.BrowserBarcodeReader(120, hints);
    configure(reader, ZXing);
    return reader;
  }
  async function nativeDetector(Detector) {
    const supported = typeof Detector.getSupportedFormats === 'function' ? await Detector.getSupportedFormats() : nativeFormats;
    const formats = nativeFormats.filter(format => supported.includes(format));
    return formats.length ? new Detector({ formats }) : null;
  }
  function configure(reader, ZXing) {
    // Yield between failed attempts so camera autofocus, native detection and UI can run.
    reader.timeBetweenDecodingAttempts = 70;
    const originalDecode = reader.decode.bind(reader);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let pass = 0;
    reader.decode = function(source) {
      const w = source.videoWidth, h = source.videoHeight;
      if (!w || !h || !context) return originalDecode(source);
      const mode = pass++ % 4;
      // Alternate full frame, horizontal band, rotated full frame, vertical band.
      const sx = mode === 3 ? Math.floor(w * .25) : 0;
      const sy = mode === 1 ? Math.floor(h * .3) : 0;
      const sw = mode === 3 ? Math.floor(w * .5) : w;
      const sh = mode === 1 ? Math.floor(h * .4) : h;
      const rotate = mode >= 2;
      const scale = Math.min(1, 1280 / Math.max(sw, sh));
      const dw = Math.round(sw * scale), dh = Math.round(sh * scale);
      canvas.width = rotate ? dh : dw;
      canvas.height = rotate ? dw : dh;
      if (rotate) { context.translate(canvas.width, 0); context.rotate(Math.PI / 2); }
      context.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
      const luminance = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
      return reader.decodeBitmap(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance)));
    };
  }
  function focusModes(track) {
    try { return track?.getCapabilities?.()?.focusMode || []; } catch (_) { return []; }
  }
  // Prefers continuous autofocus, falling back to single-shot. Resolves to the applied mode or null.
  async function focus(track) {
    const mode = ['continuous', 'single-shot'].find(m => focusModes(track).includes(m));
    if (!mode) return null;
    try {
      await track.applyConstraints({ advanced: [{ focusMode: mode }] });
      return mode;
    } catch (_) { return null; /* Optional camera tuning must never prevent scanning. */ }
  }
  // Refocuses on a point of the frame (x, y from 0 to 1). Resolves to the mode used or null.
  async function focusAt(track, x, y) {
    const modes = focusModes(track);
    const mode = ['single-shot', 'continuous'].find(m => modes.includes(m));
    if (!mode) return null;
    try {
      // Advanced sets are tried in order: cameras without pointsOfInterest still restart focusing.
      await track.applyConstraints({ advanced: [{ focusMode: mode, pointsOfInterest: [{ x, y }] }, { focusMode: mode }] });
      return mode;
    } catch (_) { return null; }
  }
  window.PocketScanner = { createReader, nativeDetector, configure, focus, focusAt };
})();
