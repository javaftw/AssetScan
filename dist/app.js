/* PocketScan. Barcodes are kept only in this browser until explicitly exported. */
(() => {
  'use strict';

  const DATA_KEY = 'pocketscan.batch.v1';
  const PREF_KEY = 'pocketscan.preferences.v1';
  const $ = (id) => document.getElementById(id);
  const ui = {
    headingCount: $('batch-heading-count'), list: $('batch-list'), empty: $('empty-batch'),
    video: $('camera-video'), viewport: $('camera-viewport'), focusRing: $('focus-ring'),
    viewfinder: $('viewfinder'), debug: $('debug-readout'), lens: $('lens-select'),
    scanToggle: $('scan-toggle'), scanIcon: $('scan-button-icon'), scanLabel: $('scan-button-label'),
    status: $('scan-status'), torch: $('torch-toggle'), sound: $('sound-toggle'),
    duplicate: $('skip-duplicates'),
    clear: $('clear-button'), undo: $('undo-button'),
    sharePdf: $('share-pdf-button'), toast: $('toast')
  };

  let codes = [];
  let scanner = null;
  let nativeDetector = null;
  let nativeTimer = null;
  let nativeBusy = false;
  let starting = false;
  let scanning = false;
  let session = 0;
  let torchEnabled = false;
  let beepEnabled = true;
  // The chosen rear lens. Browsers may issue new device IDs on each visit, so its label is kept to find it again.
  let lensId = '';
  let lensLabel = '';
  let audioContext = null;
  let lastDetection = { value: '', time: 0 };
  let lastDuplicateNotice = 0;
  let toastTimeout = null;
  let focusTimer = null;
  let focusRingTimer = null;
  let pendingRead = { value: '', time: 0 };
  let focusMode = null;
  let zoomLevel = null;
  let scanClock = 0;
  let lastScanMs = null;
  let debugTimer = null;
  const debug = new URLSearchParams(location.search).has('debug');
  let pdfFile = null;
  let sharing = false;
  let prepareTimer = null;
  let batchVersion = 0;
  const pendingPhotos = new Set();
  // Thumbnail object URLs by code id; null means the code has no photo.
  const thumbs = new Map();
  const loadingThumbs = new Set();
  // Camera scans whose photo is still being captured or saved.
  const capturing = new Set();
  let photoCells = new Map();
  // Undoable actions, newest last. Removed photos stay stored until their action is discarded.
  const UNDO_LIMIT = 50;
  let undoStack = [];

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(DATA_KEY) || '[]');
      if (Array.isArray(saved)) {
        codes = saved.filter((item) => item && typeof item.value === 'string').map((item) => ({
          id: String(item.id || makeId()), value: item.value,
          format: typeof item.format === 'string' ? item.format : 'Unknown',
          capturedAt: typeof item.capturedAt === 'string' ? item.capturedAt : new Date().toISOString()
        }));
      }
      const preferences = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      if (typeof preferences.skipDuplicates === 'boolean') ui.duplicate.checked = preferences.skipDuplicates;
      if (typeof preferences.beep === 'boolean') beepEnabled = preferences.beep;
      if (typeof preferences.lensId === 'string') lensId = preferences.lensId;
      if (typeof preferences.lensLabel === 'string') lensLabel = preferences.lensLabel;
      removeOrphanPhotos();
    } catch (error) {
      setStatus('Browser storage is unavailable. Export before leaving this page.', 'warn');
    }
    updateSoundButton();
    render();
  }

  function save() {
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify(codes));
      return true;
    } catch (error) {
      setStatus('Cannot save to browser storage. Export your batch before closing the page.', 'warn');
      return false;
    }
  }

  function savePreferences() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ skipDuplicates: ui.duplicate.checked, beep: beepEnabled, lensId, lensLabel }));
    } catch (error) { /* Preferences can be session-only. */ }
  }

  // Photos whose code is gone, e.g. removals that could still be undone when the page closed.
  function removeOrphanPhotos() {
    const live = new Set(codes.map((item) => item.id));
    PocketMedia.keys().then((ids) => {
      ids.filter((id) => !live.has(id)).forEach((id) => PocketMedia.remove(id).catch(() => {}));
    }).catch(() => {});
  }

  function remember(action) {
    undoStack.push(action);
    if (undoStack.length > UNDO_LIMIT) discard(undoStack.shift());
  }

  function discard(action) {
    if (action.type === 'remove') PocketMedia.remove(action.item.id).catch(() => {});
  }

  function isKept(id) {
    return codes.some((code) => code.id === id) || undoStack.some((action) => action.type === 'remove' && action.item.id === id);
  }

  function makeId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function setStatus(message, type = '') {
    ui.status.textContent = message;
    ui.status.className = `status ${type}`.trim();
  }

  function toast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => ui.toast.classList.remove('show'), 2100);
  }

  function showPhoto(item) {
    const photo = photoCells.get(item.id);
    if (!photo) return;
    if (!thumbs.has(item.id)) {
      photo.textContent = '…';
      photo.className = 'row-photo row-photo-pending';
      return;
    }
    const url = thumbs.get(item.id);
    if (!url) {
      photo.textContent = 'No photo';
      photo.className = 'row-photo row-photo-missing';
      photo.removeAttribute('href');
      return;
    }
    const img = document.createElement('img');
    img.src = url;
    img.alt = `Actual barcode photograph for ${item.value}`;
    img.loading = 'lazy';
    photo.replaceChildren(img);
    photo.className = 'row-photo row-photo-loaded';
    photo.href = url;
    photo.target = '_blank';
    photo.rel = 'noopener';
    photo.title = 'Tap to view full barcode photograph';
  }

  // Reads a stored photo once; later renders reuse the cached thumbnail.
  function loadPhoto(item) {
    if (thumbs.has(item.id) || capturing.has(item.id) || loadingThumbs.has(item.id)) return;
    loadingThumbs.add(item.id);
    PocketMedia.get(item.id).then((saved) => (saved?.blob ? URL.createObjectURL(saved.blob) : null), () => null).then((url) => {
      loadingThumbs.delete(item.id);
      if (thumbs.has(item.id) || !photoCells.has(item.id)) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      thumbs.set(item.id, url);
      showPhoto(item);
    });
  }

  function render() {
    batchVersion++;
    pdfFile = null;
    const live = new Set(codes.map((item) => item.id));
    for (const [id, url] of thumbs) {
      if (live.has(id)) continue;
      if (url) URL.revokeObjectURL(url);
      thumbs.delete(id);
    }
    photoCells = new Map();
    const n = codes.length;
    ui.headingCount.textContent = `(${n})`;
    ui.empty.hidden = n > 0;
    ui.list.hidden = n === 0;
    ui.list.replaceChildren();
    const fragment = document.createDocumentFragment();
    codes.forEach((item, i) => {
      const row = document.createElement('li');
      row.className = 'batch-row';
      const number = document.createElement('span');
      number.className = 'row-number';
      number.textContent = String(i + 1).padStart(2, '0');
      const main = document.createElement('div');
      main.className = 'row-main';
      const value = document.createElement('div');
      value.className = 'row-value';
      value.textContent = item.value;
      const photo = document.createElement('a');
      photo.setAttribute('aria-label', `Open barcode photo for ${item.value}`);
      main.append(value, photo);
      photoCells.set(item.id, photo);
      showPhoto(item);
      loadPhoto(item);
      const remove = document.createElement('button');
      remove.className = 'row-delete';
      remove.type = 'button';
      remove.title = `Remove code ${item.value}`;
      remove.setAttribute('aria-label', `Remove code ${item.value}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        const index = codes.findIndex((code) => code.id === item.id);
        if (index < 0) return;
        codes.splice(index, 1);
        remember({ type: 'remove', item, index });
        save();
        render();
        toast('Code removed');
      });
      row.append(number, main, remove);
      fragment.append(row);
    });
    ui.list.append(fragment);
    ui.clear.disabled = n === 0;
    ui.undo.disabled = undoStack.length === 0;
    ui.sharePdf.disabled = true;
    ui.sharePdf.querySelector('small').textContent = n ? 'Preparing PDF…' : 'PDF · codes + photos';
    clearTimeout(prepareTimer);
    if (n && !scanning && !starting) prepareTimer = setTimeout(preparePdf, 250);
    else if (n) {
      ui.sharePdf.disabled = false;
      ui.sharePdf.querySelector('small').textContent = 'PDF · codes + photos';
    }
  }

  function prepareBeep() {
    if (!beepEnabled) return;
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      if (!audioContext) audioContext = new Context();
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    } catch (error) { /* Haptic feedback is sufficient. */ }
  }

  function playNotes(pitches, { type, step, length, volume }) {
    if (!beepEnabled || !audioContext || audioContext.state !== 'running') return;
    try {
      const now = audioContext.currentTime;
      pitches.forEach((pitch, i) => {
        const begin = now + i * step;
        const end = begin + length;
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(pitch, begin);
        gain.gain.setValueAtTime(.0001, begin);
        gain.gain.exponentialRampToValueAtTime(volume, begin + .012);
        gain.gain.exponentialRampToValueAtTime(.0001, end);
        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start(begin);
        oscillator.stop(end + .01);
      });
    } catch (error) { /* Sound is optional. */ }
  }

  function signalSuccess() {
    if (navigator.vibrate) navigator.vibrate([75, 45, 90]);
    // Bright three-note major-chord arpeggio with a short, friendly tail.
    playNotes([659.25, 830.61, 987.77], { type: 'triangle', step: .14, length: .28, volume: .45 });
  }

  function signalDuplicate() {
    if (navigator.vibrate) navigator.vibrate(220);
    // Low falling "nope" (G4, E♭4, B3) in a buzzier tone, clearly unlike the success melody.
    playNotes([392, 311.13, 246.94], { type: 'square', step: .12, length: .2, volume: .18 });
  }

  function addCode(raw, format = 'Unknown', fromCamera = false) {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) return null;
    const now = Date.now();
    if (fromCamera) {
      // Refresh on every sighting so a code held in view is captured once, not every 1.9 s.
      const repeat = value === lastDetection.value && now - lastDetection.time < 1900;
      lastDetection = { value, time: now };
      if (repeat) return null;
    }
    if (ui.duplicate.checked && codes.some((item) => item.value === value)) {
      if (now - lastDuplicateNotice > 1600) {
        setStatus(`Already in batch: ${value}`, 'warn');
        lastDuplicateNotice = now;
        signalDuplicate();
      }
      return null;
    }
    const item = { id: makeId(), value, format, capturedAt: new Date().toISOString() };
    codes.push(item);
    remember({ type: 'add', item });
    if (fromCamera) capturing.add(item.id);
    const persisted = save();
    render();
    signalSuccess();
    setStatus(persisted ? `✓ Captured ${value} (${format}) — ${codes.length} in batch` : `Captured ${value}. Export now; device storage failed.`, persisted ? 'good' : 'warn');
    return item;
  }

  function rememberPhoto(item, source) {
    if (!item) return;
    // drawImage runs immediately, preserving the decoded camera frame before it changes.
    const task = PocketMedia.capture(source).then(async (image) => {
      if (!isKept(item.id)) return null;
      await PocketMedia.save({ id: item.id, ...image });
      return URL.createObjectURL(image.blob);
    }).catch(() => {
      setStatus(`Captured ${item.value}, but the photo could not be stored. Check browser storage space.`, 'warn');
      return null;
    }).then((url) => {
      capturing.delete(item.id);
      // Update only this row; the rest of the list is unchanged.
      if (photoCells.has(item.id)) {
        thumbs.set(item.id, url);
        showPhoto(item);
      } else if (url) URL.revokeObjectURL(url);
    });
    pendingPhotos.add(task);
    task.finally(() => pendingPhotos.delete(task));
  }

  function updateCameraUi() {
    const live = scanning || starting;
    ui.scanToggle.classList.toggle('scanning', live);
    ui.scanLabel.textContent = starting ? 'Opening camera…' : scanning ? 'Stop camera' : 'Start camera';
    ui.scanIcon.textContent = scanning ? '■' : '▷';
    ui.scanToggle.disabled = starting;
    ui.lens.disabled = starting;
    ui.viewport.classList.toggle('live', live);
    if (!live) {
      ui.torch.disabled = true;
      ui.torch.setAttribute('aria-pressed', 'false');
      ui.torch.title = 'Flashlight unavailable until camera starts';
      torchEnabled = false;
      ui.torch.classList.remove('is-on');
    }
  }

  // Formats with weak or no checksums need two matching reads (from either decoder) in quick succession.
  function confirmedRead(value, format) {
    if (!PocketScanner.weakFormats.includes(format)) return true;
    const now = Date.now();
    if (pendingRead.value === value && now - pendingRead.time < 1500) {
      pendingRead = { value: '', time: 0 };
      return true;
    }
    pendingRead = { value, time: now };
    return false;
  }

  function cameraRead(raw, format) {
    const value = String(raw == null ? '' : raw).trim();
    if (!value || !confirmedRead(value, format)) return;
    const item = addCode(value, format, true);
    if (!item) return;
    rememberPhoto(item, ui.video);
    const now = Date.now();
    lastScanMs = now - scanClock;
    scanClock = now;
  }

  async function startNativeDecoder(currentSession) {
    if (typeof window.BarcodeDetector !== 'function') {
      return;
    }
    try {
      // A native implementation is faster on many Android Chrome devices.
      const detector = await PocketScanner.nativeDetector(window.BarcodeDetector);
      if (currentSession !== session || !scanning) return;
      nativeDetector = detector;
      if (!detector) return;
    } catch (error) {
      nativeDetector = null;
      return;
    }
    // The native detector leads; ZXing keeps running as a slower backup so it does not crowd it out.
    scanner?.setBackup(true);
    const tick = async () => {
      if (currentSession !== session || !scanning || !nativeDetector) return;
      if (!nativeBusy && ui.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        nativeBusy = true;
        try {
          const detected = await nativeDetector.detect(ui.video);
          if (currentSession === session) {
            for (const result of detected) {
              cameraRead(result.rawValue, (result.format || 'Barcode').replaceAll('_', ' ').toUpperCase());
            }
          }
        } catch (error) {
          // Some browsers expose BarcodeDetector but do not implement video detection.
          nativeDetector = null;
          scanner?.setBackup(false);
        } finally {
          nativeBusy = false;
        }
      }
      if (currentSession === session && scanning && nativeDetector) nativeTimer = setTimeout(tick, 100);
    };
    tick();
  }

  async function startCamera() {
    if (starting || scanning) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('Camera access requires HTTPS and a compatible browser. Open this page in Chrome or Safari.', 'bad');
      return;
    }
    if (!window.PocketScanner) {
      setStatus('The barcode decoder did not load. Please refresh the page.', 'bad');
      return;
    }
    prepareBeep();
    clearTimeout(prepareTimer);
    const currentSession = ++session;
    starting = true;
    updateCameraUi();
    setStatus('Opening rear camera at HD resolution…');
    try {
      const stream = await openCamera();
      if (session !== currentSession) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      ui.video.srcObject = stream;
      await ui.video.play();
      if (session !== currentSession) return;
      // One scanner (and its decode worker) is kept for the page's lifetime and restarted per session.
      scanner ||= PocketScanner.createScanner({
        video: ui.video,
        region: guideRegion,
        onResult: (result) => {
          if (scanning) cameraRead(result.text, (result.format || 'Barcode').replaceAll('_', ' '));
        }
      });
      starting = false;
      scanning = true;
      updateCameraUi();
      scanner.setBackup(false);
      scanner.start();
      setStatus('Scanning… Tap the picture to focus.');
      const track = ui.video.srcObject?.getVideoTracks?.()[0];
      zoomLevel = null;
      focusMode = null;
      PocketScanner.zoom(track).then((level) => { zoomLevel = level; });
      PocketScanner.focus(track).then((mode) => {
        focusMode = mode;
        if (mode === 'single-shot' && currentSession === session) keepFocusing(track, currentSession);
      });
      updateTorchAvailability();
      updateLenses();
      startNativeDecoder(currentSession);
      scanClock = Date.now();
      if (debug) startDebug(currentSession);
      setTimeout(() => {
        if (currentSession === session && scanning && !codes.length) {
          setStatus('Still no match? Try more light or move the camera slightly farther away.', 'warn');
        }
      }, 11000);
    } catch (error) {
      if (session !== currentSession) return;
      stopCamera();
      const name = error?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setStatus('Camera permission denied. Allow the camera for this website in your browser settings, then try again.', 'bad');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setStatus('No camera was found on this device.', 'bad');
      } else if (name === 'NotReadableError') {
        setStatus('The camera is busy. Close other camera apps and retry.', 'bad');
      } else {
        setStatus(`Camera could not start: ${error?.message || 'Unknown error'}`, 'bad');
      }
    }
  }

  function stopCamera() {
    session++;
    starting = false;
    scanning = false;
    if (nativeTimer) clearTimeout(nativeTimer);
    nativeTimer = null;
    clearTimeout(focusTimer);
    ui.focusRing.classList.remove('show');
    clearInterval(debugTimer);
    ui.debug.hidden = true;
    nativeDetector = null;
    scanner?.stop();
    try { ui.video.srcObject?.getTracks().forEach((track) => track.stop()); } catch (error) {}
    ui.video.srcObject = null;
    updateCameraUi();
    clearTimeout(prepareTimer);
    if (codes.length && !pdfFile) prepareTimer = setTimeout(preparePdf, 250);
  }

  // Single-shot cameras focus once per request, so refocus regularly. After a tap-focus this
  // also restores the default mode, which hands control back to continuous autofocus.
  function keepFocusing(track, currentSession, delay = 3000) {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      if (currentSession !== session || !scanning) return;
      PocketScanner.focus(track).then((mode) => {
        if (mode === 'single-shot' && currentSession === session && scanning) keepFocusing(track, currentSession);
      });
    }, delay);
  }

  // Maps a screen point to the camera frame (0 to 1 inside it). The frame fills the video element
  // (object-fit: cover), so a portrait feed is cropped top and bottom rather than letterboxed and
  // the guide box always lies on the picture.
  function toFrame(clientX, clientY) {
    const rect = ui.video.getBoundingClientRect();
    const vw = ui.video.videoWidth, vh = ui.video.videoHeight;
    if (!vw || !vh || !rect.width || !rect.height) return null;
    const scale = Math.max(rect.width / vw, rect.height / vh);
    const w = vw * scale, h = vh * scale;
    return { x: (clientX - rect.left - (rect.width - w) / 2) / w, y: (clientY - rect.top - (rect.height - h) / 2) / h };
  }

  function framePoint(event) {
    const point = toFrame(event.clientX, event.clientY);
    return point && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 ? point : null;
  }

  // The on-screen guide box in frame coordinates, so the decoder reads exactly what it outlines.
  function guideRegion() {
    const box = ui.viewfinder.getBoundingClientRect();
    const a = toFrame(box.left, box.top), b = toFrame(box.right, box.bottom);
    if (!a || !b) return null;
    const unit = (value) => Math.min(1, Math.max(0, value));
    const x = unit(a.x), y = unit(a.y), width = unit(b.x) - x, height = unit(b.y) - y;
    return width > .05 && height > .05 ? { x, y, width, height } : null;
  }

  // Open the page with ?debug to show decoder speed and camera settings while scanning.
  function startDebug(currentSession) {
    ui.debug.hidden = false;
    let last = Date.now();
    const update = () => {
      if (currentSession !== session || !scanner?.stats) return;
      const now = Date.now(), seconds = Math.max(.001, (now - last) / 1000), stats = scanner.stats;
      const rate = stats.attempts / seconds;
      const average = stats.attempts ? stats.busyMs / stats.attempts : 0;
      ui.debug.textContent = [
        `ZXing ${stats.mode} ${rate.toFixed(0)}/s · ${average.toFixed(0)} ms each · grab ${(stats.attempts ? stats.grabMs / stats.attempts : 0).toFixed(0)} ms`,
        `native ${nativeDetector ? 'on' : 'off'}`,
        `zoom ${zoomLevel ? `${zoomLevel}×` : 'n/a'}`,
        `focus ${focusMode || 'n/a'}`,
        `last scan ${lastScanMs == null ? '–' : `${(lastScanMs / 1000).toFixed(1)} s`}`
      ].join(' · ');
      stats.attempts = 0;
      stats.busyMs = 0;
      stats.grabMs = 0;
      last = now;
    };
    update();
    debugTimer = setInterval(update, 1000);
  }

  function showFocusRing(event) {
    const rect = ui.viewport.getBoundingClientRect();
    ui.focusRing.style.left = `${event.clientX - rect.left}px`;
    ui.focusRing.style.top = `${event.clientY - rect.top}px`;
    ui.focusRing.classList.add('show');
    clearTimeout(focusRingTimer);
    focusRingTimer = setTimeout(() => ui.focusRing.classList.remove('show'), 900);
  }

  function tapToFocus(event) {
    if (event.target === ui.lens) return;
    const track = ui.video.srcObject?.getVideoTracks?.()[0];
    if (!scanning || !track) return;
    const point = framePoint(event);
    if (!point) return;
    showFocusRing(event);
    const currentSession = session;
    PocketScanner.focusAt(track, point.x, point.y).then((mode) => {
      if (currentSession !== session) return;
      if (!mode) {
        ui.focusRing.classList.remove('show');
        toast('This camera does not support tap-to-focus');
        return;
      }
      keepFocusing(track, currentSession);
    });
  }

  // Opens the chosen rear lens, or lets the browser pick the rear camera on "Auto".
  async function openCamera() {
    const video = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    const open = (id) => navigator.mediaDevices.getUserMedia({ audio: false, video: id
      ? { ...video, deviceId: { exact: id } }
      : { ...video, facingMode: { ideal: 'environment' } } });
    if (!lensId) return open();
    try {
      return await open(lensId);
    } catch (error) {
      if (!['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(error?.name)) throw error;
    }
    // The saved ID is stale or busy. Open automatically (which also makes labels readable), then
    // look the lens up by its label and switch to it if it is still there.
    const stream = await open();
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const match = PocketScanner.rearLenses(devices.filter((device) => device.kind === 'videoinput'))
      .find((lens) => lensLabel && lens.label === lensLabel);
    lensId = match ? match.id : '';
    if (!match) lensLabel = '';
    savePreferences();
    if (!match || stream.getVideoTracks()[0]?.getSettings?.().deviceId === match.id) return stream;
    stream.getTracks().forEach((track) => track.stop());
    return open(match.id).catch(() => open());
  }

  // Shows the lens picker when the browser lists more than one rear camera. "Auto" names the lens
  // the browser picked, so an accidental ultra-wide choice is visible.
  async function updateLenses() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (error) { return; }
    const cameras = devices.filter((device) => device.kind === 'videoinput');
    const lenses = cameras.some((device) => device.label) ? PocketScanner.rearLenses(cameras) : [];
    const active = ui.video.srcObject?.getVideoTracks?.()[0]?.getSettings?.().deviceId;
    const current = lenses.find((lens) => lens.id === active);
    const auto = new Option(!lensId && current ? `Auto · ${current.name}` : 'Auto', '');
    ui.lens.replaceChildren(auto, ...lenses.map((lens) => {
      const option = new Option(lens.name, lens.id);
      option.dataset.label = lens.label;
      return option;
    }));
    ui.lens.value = lenses.some((lens) => lens.id === lensId) ? lensId : '';
    ui.lens.hidden = lenses.length < 2;
  }

  function updateTorchAvailability() {
    const track = ui.video.srcObject?.getVideoTracks?.()[0];
    const supportsTorch = Boolean(track?.getCapabilities?.()?.torch);
    ui.torch.disabled = !supportsTorch;
    ui.torch.title = supportsTorch ? 'Turn flashlight on' : 'Flashlight unavailable on this camera';
  }

  async function toggleTorch() {
    const track = ui.video.srcObject?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      await PocketScanner.torch(track, !torchEnabled);
      torchEnabled = !torchEnabled;
      ui.torch.classList.toggle('is-on', torchEnabled);
      ui.torch.setAttribute('aria-pressed', String(torchEnabled));
      ui.torch.title = torchEnabled ? 'Turn flashlight off' : 'Turn flashlight on';
    } catch (error) {
      setStatus('This camera does not support flashlight control.', 'warn');
      ui.torch.disabled = true;
    }
  }

  function updateSoundButton() {
    ui.sound.classList.toggle('is-off', !beepEnabled);
    ui.sound.setAttribute('aria-pressed', String(beepEnabled));
    ui.sound.title = beepEnabled ? 'Mute scan melody' : 'Enable scan melody';
  }

  function fileName() {
    const date = new Date();
    const stamp = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    return `barcodes-${stamp}-photos.pdf`;
  }

  async function preparePdf() {
    if (!codes.length) return;
    const version = batchVersion;
    try {
      await Promise.allSettled([...pendingPhotos]);
      if (version !== batchVersion || scanning || starting) return;
      const pdf = await PocketMedia.report(codes.slice());
      if (version !== batchVersion) return;
      pdfFile = new File([pdf], fileName(), { type: 'application/pdf' });
      ui.sharePdf.disabled = false;
      ui.sharePdf.querySelector('small').textContent = `Choose WhatsApp · ${(pdf.size / 1024).toFixed(0)} KB`;
    } catch (error) {
      if (version !== batchVersion) return;
      ui.sharePdf.disabled = false;
      ui.sharePdf.querySelector('small').textContent = 'Tap to retry preparation';
      setStatus(`Could not prepare the PDF: ${error.message || 'Unknown error'}`, 'bad');
    }
  }

  function savePdfForSharing(file, reason) {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus(`${reason} PDF download started. Open it from Downloads and use Share → WhatsApp.`, 'warn');
  }

  async function sharePdf() {
    if (sharing) return;
    if (!pdfFile) {
      stopCamera();
      ui.sharePdf.disabled = true;
      ui.sharePdf.querySelector('small').textContent = 'Preparing PDF…';
      await preparePdf();
      if (pdfFile) setStatus('PDF ready. Tap Share again and choose WhatsApp.', 'good');
      return;
    }
    const file = pdfFile;
    const data = { files: [file] };
    stopCamera();
    sharing = true;
    ui.sharePdf.disabled = true;
    try {
      // Keep the native share call in the tap handler, before any await.
      // Older browsers can implement share without canShare.
      if (!navigator.share || (navigator.canShare && !navigator.canShare(data))) {
        savePdfForSharing(file, 'This browser cannot share files directly.');
        return;
      }
      await navigator.share(data);
      setStatus('PDF handed to your chosen app.', 'good');
    } catch (error) {
      if (error?.name === 'AbortError') {
        setStatus('Sharing cancelled. Your batch is still saved; tap Share to retry.');
      } else {
        savePdfForSharing(file, `Direct sharing failed (${error?.name || 'UnknownError'}).`);
      }
    } finally {
      sharing = false;
      ui.sharePdf.disabled = !codes.length;
    }
  }

  function bindEvents() {
    ui.scanToggle.addEventListener('click', () => {
      if (scanning) { stopCamera(); setStatus('Camera stopped.'); }
      else startCamera();
    });
    ui.torch.addEventListener('click', toggleTorch);
    ui.viewport.addEventListener('click', tapToFocus);
    ui.lens.addEventListener('change', () => {
      lensId = ui.lens.value;
      lensLabel = ui.lens.selectedOptions[0]?.dataset.label || '';
      savePreferences();
      if (scanning) { stopCamera(); startCamera(); }
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', updateLenses);
    ui.sound.addEventListener('click', () => {
      beepEnabled = !beepEnabled;
      if (beepEnabled) prepareBeep();
      updateSoundButton();
      savePreferences();
      toast(beepEnabled ? 'Scan melody enabled' : 'Scan melody muted');
    });
    ui.duplicate.addEventListener('change', savePreferences);
    ui.undo.addEventListener('click', () => {
      const action = undoStack.pop();
      if (!action) return;
      if (action.type === 'add') {
        codes = codes.filter((code) => code.id !== action.item.id);
        PocketMedia.remove(action.item.id).catch(() => {});
        toast('Last scan undone');
      } else {
        codes.splice(Math.min(action.index, codes.length), 0, action.item);
        toast('Code restored');
      }
      save(); render();
    });
    ui.clear.addEventListener('click', () => {
      if (!codes.length) return;
      const okay = window.confirm(`Permanently clear all ${codes.length} captured barcodes from this device? Export first if you need them.`);
      if (!okay) return;
      const removed = codes.map((item) => item.id);
      codes = [];
      undoStack.forEach(discard);
      undoStack = [];
      removed.forEach((id) => PocketMedia.remove(id).catch(() => {}));
      save(); render();
      setStatus('Batch cleared. Ready to scan a new set.');
      toast('Batch cleared');
    });
    ui.sharePdf.addEventListener('click', sharePdf);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && (scanning || starting)) {
        stopCamera();
        setStatus('Camera paused. Tap Start camera to resume.');
      }
    });
    window.addEventListener('pagehide', stopCamera);
  }

  bindEvents();
  load();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
})();
