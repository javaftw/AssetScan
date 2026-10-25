const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../dist/app.js'), 'utf8');
const scanner = fs.readFileSync(path.join(__dirname, '../dist/scanner.js'), 'utf8');
const rule = source.slice(source.indexOf('  function confirmedRead('), source.indexOf('  function cameraRead('));
const scope = { window: {}, document: {}, recentReads: [], Date: { now: () => scope.now }, now: 0 };
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
// A misread in between does not cancel the correct reads, but a disagreement needs a third read.
assert.equal(read('6001234567892', 'EAN 13', 1000), false);
assert.equal(read('6001234567885', 'EAN 13', 1050), false);
assert.equal(read('6001234567892', 'EAN 13', 1100), false);
assert.equal(read('6001234567892', 'EAN 13', 1150), true);
// Alternating values: a 2-2 tie is not enough, the leader with three wins.
assert.equal(read('6001234567892', 'EAN 13', 3000), false);
assert.equal(read('6001234567885', 'EAN 13', 3050), false);
assert.equal(read('6001234567892', 'EAN 13', 3100), false);
assert.equal(read('6001234567885', 'EAN 13', 3150), false, 'tied 2-2 must not accept');
assert.equal(read('6001234567892', 'EAN 13', 3200), true);
// Reads too far apart do not confirm each other.
assert.equal(read('12345670', 'EAN 8', 5000), false);
assert.equal(read('12345670', 'EAN 8', 6600), false);
assert.equal(read('12345670', 'EAN 8', 6700), true);
for (const format of ['UPC A', 'UPC E', 'CODE 39', 'ITF', 'CODABAR']) {
  assert.equal(read('X', format, 9000), false, format);
  assert.equal(read('X', format, 9050), true, format);
}
console.log('PASS: Code 128/93 accepted on one read; EAN/UPC, Code 39, ITF and Codabar need two matching reads within 1.5 s, or three that lead when values disagree.');
