const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sharp = require('sharp');

const saved = new Map();
const database = {
  createObjectStore() {},
  transaction() {
    return {
      objectStore() {
        const request = (value) => {
          const req = { result: value };
          queueMicrotask(() => req.onsuccess?.());
          return req;
        };
        return {
          put: (record) => { saved.set(record.id, record); return request(record.id); },
          get: (id) => request(saved.get(id)),
          delete: (id) => { saved.delete(id); return request(undefined); }
        };
      }
    };
  }
};

const fakeIndexedDB = {
  open() {
    const req = { result: database };
    queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); });
    return req;
  }
};
const window = { indexedDB: fakeIndexedDB };
const crops = [];
const document = {
  createElement(name) {
    assert.equal(name, 'canvas');
    return {
      width: 0, height: 0,
      getContext() { return { drawImage: (...args) => crops.push(args) }; },
      toBlob(callback) { callback(new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })); }
    };
  }
};
const context = { window, document, indexedDB: fakeIndexedDB, Blob, TextEncoder, Date };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/media.js'), 'utf8'), context);

(async () => {
  const fakeVideo = { videoWidth: 1280, videoHeight: 720 };
  const captured = await window.PocketMedia.capture(fakeVideo, { x: 380, y: 310, width: 520, height: 64 });
  assert.equal(captured.blob.type, 'image/jpeg');
  assert.deepEqual(crops[0].slice(1, 5), [0, 0, 1280, 720], 'Entire camera frame should be preserved');

  const jpeg = await sharp({ create: { width: 640, height: 180, channels: 3, background: '#f5fff7' } }).jpeg().toBuffer();
  await window.PocketMedia.save({ id: 'first', blob: new Blob([jpeg], { type: 'image/jpeg' }), width: 640, height: 180 });
  const codes = [
    { id: 'first', value: '000123450001', format: 'EAN 13', capturedAt: new Date().toISOString() },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `manual-${i}`, value: `80000000000${i}`, format: 'Manual', capturedAt: new Date().toISOString() }))
  ];
  const portrait = await sharp({ create: { width: 180, height: 640, channels: 3, background: '#e1ebff' } }).jpeg().toBuffer();
  await window.PocketMedia.save({ id: 'manual-3', blob: new Blob([portrait], { type: 'image/jpeg' }), width: 180, height: 640 });
  const pdf = await window.PocketMedia.report(codes);
  const data = Buffer.from(await pdf.arrayBuffer());
  const body = data.toString('latin1');
  assert(body.startsWith('%PDF-1.4'));
  assert(body.includes('/Count 2'));
  assert(body.includes('/Subtype /Image'));
  assert(body.includes('/DCTDecode'));
  assert(body.includes('000123450001'));
  assert(body.includes('800000000003'));
  fs.writeFileSync('/tmp/pocketscan-report-smoke.pdf', data);
  console.log(`PDF test passed: ${codes.length} codes, 2 pages, camera JPEG embedded, ${data.length} bytes`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
