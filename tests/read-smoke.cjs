const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8');
const scanner = fs.readFileSync(path.join(__dirname, '../dist/scanner.js'), 'utf8');
const rule = source.slice(source.indexOf('  function confirmedRead('), source.indexOf('  function cameraRead('));
const scope = { window: {}, document: {}, pendingRead: { value: '', time: 0 }, Date: { now: () => scope.now }, now: 0 };
vm.createContext(scope);
vm.runInContext(scanner, scope);
scope.PocketScanner = scope.window.PocketScanner;
vm.runInContext(rule, scope);
const read = (value, format, at) => { scope.now = at; return scope.confirmedRead(value, format); };
// Strong checksums are accepted on the first read.
assert.equal(read('PS-12345', 'CODE 128', 0), true);
assert.equal(read('PS-12345', 'CODE 93', 10), true);
// Product codes need a second matching read within 1.5 s.
assert.equal(read('6001234567892', 'EAN 13', 100), false);
assert.equal(read('6001234567892', 'EAN 13', 180), true);
// A different (misread) value in between starts over.
assert.equal(read('6001234567892', 'EAN 13', 1000), false);
assert.equal(read('6001234567885', 'EAN 13', 1050), false);
assert.equal(read('6001234567892', 'EAN 13', 1100), false);
assert.equal(read('6001234567892', 'EAN 13', 1150), true);
// Reads too far apart do not confirm each other.
assert.equal(read('12345670', 'EAN 8', 5000), false);
assert.equal(read('12345670', 'EAN 8', 6600), false);
assert.equal(read('12345670', 'EAN 8', 6700), true);
for (const format of ['UPC A', 'UPC E', 'CODE 39', 'ITF', 'CODABAR']) {
  assert.equal(read('X', format, 9000), false, format);
  assert.equal(read('X', format, 9050), true, format);
}
console.log('PASS: Code 128/93 accepted on one read; EAN/UPC, Code 39, ITF and Codabar need two matching reads within 1.5 s.');
