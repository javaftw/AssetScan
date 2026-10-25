/* PocketScan image store and self-contained photo PDF writer. No network requests. */
(() => {
  'use strict';

  const DB_NAME = 'pocketscan-photos-v1';
  const STORE = 'photos';
  let dbPromise;

  function database() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('Photo storage is not supported')); return; }
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Photo database unavailable'));
        request.onblocked = () => reject(new Error('Photo database is blocked'));
      });
    }
    return dbPromise;
  }

  async function transaction(mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Photo operation failed'));
      tx.onabort = () => reject(tx.error || new Error('Photo operation aborted'));
    });
  }

  const save = (record) => transaction('readwrite', (store) => store.put(record));
  const get = (id) => transaction('readonly', (store) => store.get(id));
  const remove = (id) => transaction('readwrite', (store) => store.delete(id));
  const keys = () => transaction('readonly', (store) => store.getAllKeys());

  function capture(source) {
    const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
    const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
    if (!sourceWidth || !sourceHeight) throw new Error('The camera frame is not ready');
    // Preserve the full photographed scene, including labels and packaging context.
    const scale = Math.min(1, 1280 / sourceWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    canvas.getContext('2d', { alpha: false }).drawImage(
      source, 0, 0, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height
    );
    const width = canvas.width;
    const height = canvas.height;
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) reject(new Error('Could not save the camera image'));
        else resolve({ blob, width, height });
      }, 'image/jpeg', .84);
    });
  }

  const encoder = new TextEncoder();
  const bytes = (value) => encoder.encode(value);
  const pdfEscape = (value) => String(value).replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, '\\$&');

  function makePdfWriter() {
    const objects = [null];
    const reserve = () => { objects.push(null); return objects.length - 1; };
    const set = (id, content) => { objects[id] = content; };
    function stream(dict, data) {
      return { prefix: `${dict.replace('>>', ` /Length ${data.length} >>`)}\nstream\n`, data, suffix: '\nendstream' };
    }
    function finish() {
      const chunks = [];
      let length = 0;
      const add = (data) => { const part = typeof data === 'string' ? bytes(data) : data; chunks.push(part); length += part.length; };
      add('%PDF-1.4\n');
      const offsets = [0];
      for (let i = 1; i < objects.length; i++) {
        offsets[i] = length;
        add(`${i} 0 obj\n`);
        const obj = objects[i];
        if (typeof obj === 'string') add(obj);
        else { add(obj.prefix); add(obj.data); add(obj.suffix); }
        add('\nendobj\n');
      }
      const startXref = length;
      add(`xref\n0 ${objects.length}\n0000000000 65535 f \n`);
      for (let i = 1; i < objects.length; i++) add(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
      add(`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`);
      return new Blob(chunks, { type: 'application/pdf' });
    }
    return { reserve, set, stream, finish };
  }

  function label(text, x, y, size = 11) {
    return `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfEscape(text)}) Tj ET\n`;
  }

  function line(x1, y1, x2, y2) { return `${x1} ${y1} m ${x2} ${y2} l S\n`; }

  async function report(codes) {
    const pdf = makePdfWriter();
    const catalogId = pdf.reserve();
    const pagesId = pdf.reserve();
    const fontId = pdf.reserve();
    const codeFontId = pdf.reserve();
    const pages = [];
    const photographed = [];
    for (const item of codes) {
      try { photographed.push(await get(item.id)); }
      catch (error) { photographed.push(null); }
    }

    const perPage = 3;
    const pagesCount = Math.ceil(codes.length / perPage);
    for (let pageIndex = 0; pageIndex < pagesCount; pageIndex++) {
      const pageId = pdf.reserve();
      const contentId = pdf.reserve();
      pages.push(pageId);
      const pictures = [];
      let content = '0.15 0.23 0.26 rg\n';
      content += label('POCKETSCAN  /  BARCODE PHOTO REPORT', 42, 801, 16);
      content += label(`Captured: ${codes.length}   |   Page ${pageIndex + 1} / ${pagesCount}`, 42, 781, 9);
      const left = 42, divider = 230, right = 553, tableTop = 758, bodyTop = 728, rowHeight = 214;
      const rowCount = Math.min(perPage, codes.length - pageIndex * perPage);
      const bottom = bodyTop - rowCount * rowHeight;
      content += '0.93 0.96 0.95 rg\n42 728 511 30 re f\n';
      content += '0.12 0.20 0.21 rg\n' + label('BARCODE NUMBER', 54, 739, 10) + label('PHOTO (FULL FRAME)', 242, 739, 10);
      content += '0.65 0.72 0.72 RG 0.6 w\n';
      [left, divider, right].forEach(x => { content += line(x, bottom, x, tableTop); });
      content += line(left, tableTop, right, tableTop) + line(left, bodyTop, right, bodyTop);
      for (let row = 0; row < rowCount; row++) {
        const i = pageIndex * perPage + row;
        const item = codes[i];
        const top = bodyTop - row * rowHeight;
        content += '0.12 0.20 0.21 rg\n';
        const chunks = String(item.value).match(/.{1,25}/g) || [''];
        const textSize = Math.min(11, 184 / (chunks.length * 1.25));
        chunks.forEach((chunk, j) => {
          content += label(chunk, 54, top - 24 - j * textSize * 1.25, textSize).replace('/F1', '/F2');
        });
        const photo = photographed[i];
        if (photo?.blob?.type === 'image/jpeg' && photo.width > 0 && photo.height > 0) {
          const binary = new Uint8Array(await photo.blob.arrayBuffer());
          const imageId = pdf.reserve();
          const imageName = `Im${i}`;
          pdf.set(imageId, pdf.stream(`<< /Type /XObject /Subtype /Image /Width ${photo.width} /Height ${photo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>`, binary));
          pictures.push(`/${imageName} ${imageId} 0 R`);
          // Contain the entire image in the right cell without cropping or distortion.
          const factor = Math.min((right - divider - 24) / photo.width, (rowHeight - 24) / photo.height);
          const width = photo.width * factor, height = photo.height * factor;
          const x = divider + (right - divider - width) / 2;
          const y = top - rowHeight + (rowHeight - height) / 2;
          content += `q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${imageName} Do Q\n`;
        } else {
          content += '0.40 0.44 0.46 rg\n' + label('No photograph available', 242, top - 108, 10);
        }
        content += '0.65 0.72 0.72 RG 0.6 w\n' + line(left, top - rowHeight, right, top - rowHeight);
      }

      content += '0.40 0.44 0.46 rg\n' + label('Original camera images and decoded barcode values - generated on your device.', 42, 24, 8);
      pdf.set(contentId, pdf.stream('<< >>', bytes(content)));
      const resources = `/Font << /F1 ${fontId} 0 R /F2 ${codeFontId} 0 R >> /XObject << ${pictures.join(' ')} >>`;
      pdf.set(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << ${resources} >> /Contents ${contentId} 0 R >>`);
    }

    pdf.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    pdf.set(pagesId, `<< /Type /Pages /Count ${pagesCount} /Kids [${pages.map((page) => `${page} 0 R`).join(' ')}] >>`);
    pdf.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    pdf.set(codeFontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
    return pdf.finish();
  }

  window.PocketMedia = { capture, save, get, remove, keys, report };
})();
