const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../dist/app.js'), 'utf8');
const handler = source.slice(source.indexOf('  async function sharePdf()'), source.indexOf('  function bindEvents()'));
async function scenario(navigator) {
  const file = { name: 'barcodes.pdf', type: 'application/pdf' };
  const downloaded = [], statuses = [];
  const c = {navigator, sharing:false, pdfFile:file, codes:[{}], ui:{sharePdf:{disabled:false}}, stopCamera(){}, savePdfForSharing(f,r){downloaded.push({f,r})}, setStatus(s){statuses.push(s)}};
  vm.createContext(c); vm.runInContext(handler, c);
  const result=c.sharePdf();
  await result;
  assert.equal(c.sharing,false);
  assert.equal(c.ui.sharePdf.disabled,false);
  return {downloaded,statuses,file};
}
(async()=>{
 const prep = source.slice(source.indexOf('  async function preparePdf()'), source.indexOf('  function savePdfForSharing('));
 const p = { codes:[{}], batchVersion:1, pendingPhotos:new Set(), scanning:false, starting:false, File, PocketMedia:{async report(){return new Blob(['%PDF-1.4'],{type:'application/pdf'})}}, fileName(){return 'test.pdf'},ui:{sharePdf:{querySelector(){return {}}}},setStatus(){},pdfFile:null};
 vm.createContext(p); vm.runInContext(prep,p); await p.preparePdf();
 assert.equal(p.pdfFile.type,'application/pdf');
 assert.equal(p.pdfFile.name,'test.pdf');
 let sent;
 const native=await scenario({share(data){sent=data;return Promise.resolve()}});
 assert.equal(sent.files[0],native.file); assert.equal(native.downloaded.length,0);
 const unsupported=await scenario({canShare(){return false},share(){throw Error('Must not call')}});
 assert.equal(unsupported.downloaded.length,1);
 assert.equal((await scenario({})).downloaded.length,1);
 const denied=await scenario({share(){return Promise.reject({name:'NotAllowedError'})}});
 assert.equal(denied.downloaded.length,1); assert.match(denied.downloaded[0].r,/NotAllowedError/);
 const cancelled=await scenario({share(){return Promise.reject({name:'AbortError'})}});
 assert.equal(cancelled.downloaded.length,0); assert.match(cancelled.statuses[0],/cancelled/);
 console.log('PASS: native PDF share without canShare, unsupported browser fallback, denied share fallback, and cancellation.');
})().catch(e=>{console.error(e);process.exitCode=1});
