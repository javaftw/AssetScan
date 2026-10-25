/* Focused decoding uses temporary canvases; saved photos always use the full video. */
(() => {
  // The same warehouse symbologies as decoder.js, in BarcodeDetector naming.
  const nativeFormats = ['code_128', 'code_39', 'code_93', 'itf', 'codabar', 'ean_13', 'ean_8', 'upc_a', 'upc_e'];
  // Accepted only after two matching reads: Code 39, ITF and Codabar have no mandatory checksum, and
  // a blurry EAN/UPC can misread into another number that still passes its single check digit.
  const weakFormats = ['CODE 39', 'ITF', 'CODABAR', 'EAN 13', 'EAN 8', 'UPC A', 'UPC E'];
  // [area, rotated, thorough] per attempt. Most attempts are quick reads of the guide box at full
  // camera resolution; whole-frame, sideways and exhaustive (TRY_HARDER) reads are interleaved.
  const passes = [
    ['band', false, false], ['full', false, false], ['band', false, false],
    ['full', true, false], ['band', false, false], ['band', false, true]
  ];
  async function nativeDetector(Detector) {
    const supported = typeof Detector.getSupportedFormats === 'function' ? await Detector.getSupportedFormats() : nativeFormats;
    const formats = nativeFormats.filter(format => supported.includes(format));
    return formats.length ? new Detector({ formats }) : null;
  }
  const unit = (value) => Math.min(1, Math.max(0, value));

  // Copies the next pass's crop of the video into RGBA pixels. region() returns the guide box in
  // frame coordinates (0 to 1) and defaults to the middle 40%.
  function frameGrabber(region) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let pass = 0;
    return function grab(video) {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h || !context) return null;
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
      context.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      return { data: image.data, width: image.width, height: image.height, tryHarder };
    };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.append(script);
    });
  }

  // Decodes video frames with ZXing in a worker, one frame in flight at a time, so decoding never
  // blocks the page. If workers are unavailable it decodes on the page between short pauses instead.
  function createScanner({ video, region, onResult, workerUrl = './decode-worker.js' }) {
    const grab = frameGrabber(region);
    const stats = { attempts: 0, busyMs: 0, grabMs: 0, mode: 'worker' };
    let worker = null, local = null, running = false, busy = false, timer = null, id = 0, backup = false;
    const pause = () => backup ? 200 : worker ? 15 : 30;
    function schedule(ms) {
      clearTimeout(timer);
      timer = running ? setTimeout(tick, ms) : null;
    }
    function finish(result) {
      busy = false;
      if (!running) return;
      if (result) onResult(result);
      schedule(result ? 120 : pause());
    }
    function useMainThread() {
      worker?.terminate();
      worker = null;
      stats.mode = 'main';
      busy = false;
      // ZXing is only loaded onto the page when the worker cannot run it.
      const ready = window.ZXing ? Promise.resolve() : loadScript('./vendor/zxing.min.js');
      local = ready.then(() => window.PocketDecoder || loadScript('./decoder.js'))
        .then(() => window.PocketDecoder.create(window.ZXing));
      local.then(() => schedule(0), () => { stats.mode = 'unavailable'; });
    }
    try {
      worker = new Worker(workerUrl);
      worker.onmessage = ({ data }) => {
        if (data.id !== id) return; // From before the camera was restarted.
        stats.attempts++;
        stats.busyMs += data.ms;
        finish(data.result);
      };
      worker.onerror = (event) => { event.preventDefault?.(); useMainThread(); };
    } catch (_) { useMainThread(); }

    function tick() {
      timer = null;
      if (!running || busy) return;
      if (video.readyState < 2) { schedule(50); return; }
      const started = Date.now();
      const frame = grab(video);
      stats.grabMs += Date.now() - started;
      if (!frame) { schedule(50); return; }
      busy = true;
      if (worker) {
        worker.postMessage({ id: ++id, buffer: frame.data.buffer, width: frame.width, height: frame.height, tryHarder: frame.tryHarder }, [frame.data.buffer]);
        return;
      }
      local.then((decode) => {
        const decodeStarted = Date.now();
        let result = null;
        try { result = decode(frame.data, frame.width, frame.height, frame.tryHarder); } catch (_) { /* Lose only this frame. */ }
        stats.attempts++;
        stats.busyMs += Date.now() - decodeStarted;
        finish(result);
      }, () => { busy = false; });
    }
    return {
      stats,
      start() { running = true; busy = false; id++; schedule(0); },
      stop() { running = false; busy = false; id++; schedule(0); },
      // While the native detector leads, ZXing only runs as a slower backup.
      setBackup(on) { backup = on; }
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

  const frontLens = /front|user|facetime|selfie/i;
  // Rear cameras with readable names: iPhone "Back Ultra Wide Camera" becomes "Ultra Wide" and
  // "Back Camera" becomes "Wide". Android labels such as "camera2 2, facing back" carry no lens
  // type, so those are numbered. Labels are empty until camera permission is granted.
  function rearLenses(devices) {
    return devices.filter(d => d.kind === 'videoinput' && d.deviceId && !frontLens.test(d.label)).map((d, i) => {
      if (/^back camera$/i.test(d.label.trim())) return { id: d.deviceId, label: d.label, name: 'Wide' };
      const name = d.label.replace(/camera2 \d+/gi, '').replace(/\b(back|rear|camera|facing|environment)\b/gi, '')
        .replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();
      return { id: d.deviceId, label: d.label, name: name || `Lens ${i + 1}` };
    });
  }
  window.PocketScanner = { createScanner, frameGrabber, nativeDetector, focus, focusAt, zoom, torch, rearLenses, weakFormats };
})();
