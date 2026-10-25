/* Focused decoding uses temporary canvases; saved photos always use the full video. */
(() => {
  // Warehouse label symbologies; retail product codes (EAN/UPC) are deliberately not searched.
  const linearFormats = ['CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'CODABAR'];
  const nativeFormats = ['code_128', 'code_39', 'code_93', 'itf', 'codabar'];
  // No mandatory checksum: the app only accepts these after two matching reads.
  const weakFormats = ['CODE 39', 'ITF', 'CODABAR'];
  // [area, rotated, thorough] per attempt. Most attempts are quick reads of the guide box at full
  // camera resolution; whole-frame, sideways and exhaustive (TRY_HARDER) reads are interleaved.
  const passes = [
    ['band', false, false], ['full', false, false], ['band', false, false],
    ['full', true, false], ['band', false, false], ['band', false, true]
  ];
  function createReader(ZXing, options) {
    const hints = new Map([
      [ZXing.DecodeHintType.POSSIBLE_FORMATS, linearFormats.map(name => ZXing.BarcodeFormat[name])]
    ]);
    // This reader only instantiates 1D decoders; no QR, matrix, or PDF417 search.
    const reader = new ZXing.BrowserBarcodeReader(120, hints);
    configure(reader, ZXing, options);
    return reader;
  }
  async function nativeDetector(Detector) {
    const supported = typeof Detector.getSupportedFormats === 'function' ? await Detector.getSupportedFormats() : nativeFormats;
    const formats = nativeFormats.filter(format => supported.includes(format));
    return formats.length ? new Detector({ formats }) : null;
  }
  const unit = (value) => Math.min(1, Math.max(0, value));
  // region() returns the guide box in frame coordinates (0 to 1); defaults to the middle 40%.
  function configure(reader, ZXing, { region } = {}) {
    // Yield between failed attempts so camera autofocus, native detection and UI can run.
    reader.timeBetweenDecodingAttempts = 30;
    const fast = reader.hints;
    const thorough = new Map(fast).set(ZXing.DecodeHintType.TRY_HARDER, true);
    const originalDecode = reader.decode.bind(reader);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const stats = { attempts: 0, busyMs: 0 };
    reader.stats = stats;
    let pass = 0;
    reader.decode = function(source) {
      const w = source.videoWidth, h = source.videoHeight;
      if (!w || !h || !context) return originalDecode(source);
      const started = Date.now();
      const [area, rotate, tryHarder] = passes[pass++ % passes.length];
      let sx = 0, sy = 0, sw = w, sh = h;
      if (area === 'band') {
        const box = region?.() || { x: 0, y: .3, width: 1, height: .4 };
        sx = Math.floor(unit(box.x) * w);
        sy = Math.floor(unit(box.y) * h);
        sw = Math.max(1, Math.min(w - sx, Math.round(unit(box.width) * w)));
        sh = Math.max(1, Math.min(h - sy, Math.round(unit(box.height) * h)));
      }
      // The guide box keeps full resolution so thin bars survive; whole frames are reduced for speed.
      const scale = Math.min(1, (area === 'band' ? 1920 : 1280) / Math.max(sw, sh));
      const dw = Math.round(sw * scale), dh = Math.round(sh * scale);
      canvas.width = rotate ? dh : dw;
      canvas.height = rotate ? dw : dh;
      if (rotate) { context.translate(canvas.width, 0); context.rotate(Math.PI / 2); }
      context.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
      const luminance = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
      // Sideways reads have their own pass; stop TRY_HARDER from doubling its cost by retrying rotated.
      luminance.isRotateSupported = () => false;
      try {
        return reader.reader.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance)), tryHarder ? thorough : fast);
      } finally {
        stats.attempts++;
        stats.busyMs += Date.now() - started;
      }
    };
  }
  // applyConstraints replaces earlier advanced constraints, so every call re-sends the settings in force.
  // Calls are queued per track so concurrent zoom, focus and torch changes cannot overwrite each other.
  const applied = new WeakMap();
  const queues = new WeakMap();
  function apply(track, settings, pointsOfInterest) {
    const run = async () => {
      const next = { ...applied.get(track), ...settings };
      // Advanced sets are tried in order: cameras without pointsOfInterest still get the rest.
      const sets = pointsOfInterest ? [{ ...next, pointsOfInterest }, next] : [next];
      await track.applyConstraints({ advanced: sets });
      applied.set(track, next);
    };
    const queued = (queues.get(track) || Promise.resolve()).then(run, run);
    queues.set(track, queued.catch(() => {}));
    return queued;
  }
  function capabilities(track) {
    try { return track?.getCapabilities?.() || {}; } catch (_) { return {}; }
  }
  // Prefers continuous autofocus, falling back to single-shot. Resolves to the applied mode or null.
  async function focus(track) {
    const mode = ['continuous', 'single-shot'].find(m => (capabilities(track).focusMode || []).includes(m));
    if (!mode) return null;
    try {
      await apply(track, { focusMode: mode });
      return mode;
    } catch (_) { return null; /* Optional camera tuning must never prevent scanning. */ }
  }
  // Refocuses on a point of the frame (x, y from 0 to 1). Resolves to the mode used or null.
  async function focusAt(track, x, y) {
    const modes = capabilities(track).focusMode || [];
    const mode = ['single-shot', 'continuous'].find(m => modes.includes(m));
    if (!mode) return null;
    try {
      await apply(track, { focusMode: mode }, [{ x, y }]);
      return mode;
    } catch (_) { return null; }
  }
  // Mild zoom lets people hold the phone beyond its close-focus limit while the bars stay large.
  async function zoom(track, level = 1.5) {
    const range = capabilities(track).zoom;
    if (!range || !(range.max > 1)) return null;
    const value = Math.min(range.max, Math.max(range.min || 1, level));
    try {
      await apply(track, { zoom: value });
      return value;
    } catch (_) { return null; }
  }
  const torch = (track, on) => apply(track, { torch: on });
  window.PocketScanner = { createReader, nativeDetector, configure, focus, focusAt, zoom, torch, weakFormats };
})();
