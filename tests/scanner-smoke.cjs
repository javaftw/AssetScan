const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createCanvas} = require('@napi-rs/canvas');
const ZXing = require('../dist/vendor/zxing.min.js');
const dist = (file) => path.join(__dirname, '../dist', file);
const source = (file) => fs.readFileSync(dist(file), 'utf8');

// A page-like scope (window === self === globalThis) whose <script> tags run dist files in it.
function page(Worker) {
 const scope = {Worker, setTimeout, clearTimeout, Date, document: {
  createElement(name) {
   if (name !== 'script') return createCanvas(1,1);
   return {};
  },
  head: {append(script) { setTimeout(() => { vm.runInContext(source(script.src), scope); script.onload(); }); }}
 }};
 scope.window = scope; scope.self = scope;
 vm.createContext(scope);
 vm.runInContext(source('scanner.js'), scope);
 return scope;
}
// Runs decode-worker.js the way a browser would, with importScripts resolved against dist/.
function workerClass({fail = false} = {}) {
 return class FakeWorker {
  constructor(url) {
   assert.equal(url, './decode-worker.js');
   if (fail) throw Error('Workers blocked');
   const ctx = {Date, importScripts: (...files) => files.forEach(f => vm.runInContext(source(f), ctx)),
    postMessage: (message) => setTimeout(() => this.onmessage?.({data: message}))};
   ctx.self = ctx;
   vm.createContext(ctx);
   vm.runInContext(source('decode-worker.js'), ctx);
   this.ctx = ctx;
  }
  postMessage(message, transfer) {
   assert.equal(transfer[0], message.buffer, 'Frame pixels must be transferred, not copied');
   setTimeout(() => this.ctx.onmessage({data: message}));
  }
  terminate() {}
 };
}

const P = page(workerClass()).PocketScanner;
const decoderScope = {}; decoderScope.self = decoderScope; vm.createContext(decoderScope);
vm.runInContext(source('decoder.js'), decoderScope);
const decode = decoderScope.PocketDecoder.create(ZXing);

// Code 128 (set B) drawn from ZXing's own pattern table: start, data, checksum, stop.
const value='PS-12345';
const symbols=[104,...[...value].map(ch=>ch.charCodeAt(0)-32)];
symbols.push(symbols.reduce((sum,v,i)=>sum+v*Math.max(1,i),0)%103,106);
const widths=symbols.flatMap(v=>Array.from(ZXing.Code128Reader.CODE_PATTERNS[v]));
function draw(pattern,vertical,lowContrast,module){
 const frame=createCanvas(1920,1080), c=frame.getContext('2d');
 c.fillStyle=lowContrast?'#ccc':'#fff';c.fillRect(0,0,1920,1080);
 c.translate(960,540);if(vertical)c.rotate(Math.PI/2);
 c.fillStyle=lowContrast?'#666':'#000';
 let x=-pattern.reduce((a,b)=>a+b,0)*module/2;
 pattern.forEach((w,i)=>{if(i%2===0)c.fillRect(x,-130,w*module,260);x+=w*module});
 frame.videoWidth=1920;frame.videoHeight=1080;frame.readyState=4;
 return frame;
}
const PASSES=6;
const reads=(frame,grab=P.frameGrabber())=>Array.from({length:PASSES},()=>{const f=grab(frame);return decode(f.data,f.width,f.height,f.tryHarder)});
for(const vertical of [false,true]) for(const lowContrast of [false,true]) {
 const found=reads(draw(widths,vertical,lowContrast,4)).filter(Boolean);
 assert(found.length,`Failed orientation=${vertical}, lowContrast=${lowContrast}`);
 found.forEach(r=>assert.deepEqual({...r},{text:value,format:'CODE_128'}));
}
// Retail EAN-13 product codes are read too.
const L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G=['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const ean='5901234123457', parity='LGGLLG';
const bits='101'+[...ean.slice(1,7)].map((n,i)=>(parity[i]==='L'?L:G)[+n]).join('')+'01010'+[...ean.slice(7)].map(n=>L[+n].replace(/[01]/g,b=>b==='0'?'1':'0')).join('')+'101';
const eanReads=reads(draw(bits.match(/1+|0+/g).map(run=>run.length),false,false,7)).filter(Boolean);
assert(eanReads.length,'EAN-13 not read');
eanReads.forEach(r=>assert.deepEqual({...r},{text:ean,format:'EAN_13'}));
// The guide box region is honoured: a box away from the barcode misses it on band passes.
const boxed=P.frameGrabber(()=>({x:0,y:0,width:1,height:.2}))(draw(widths,false,false,4));
assert.equal(boxed.height,216);
assert.equal(decode(boxed.data,boxed.width,boxed.height,boxed.tryHarder),null);

function scanOnce(Worker){
 const scope=page(Worker), video=draw(widths,false,false,4);
 return new Promise((resolve)=>{
  const scanner=scope.PocketScanner.createScanner({video,onResult(result){scanner.stop();resolve({result,stats:scanner.stats});}});
  scanner.start();
 });
}
(async()=>{
 // The real worker script decodes frames sent by the scanner loop.
 const viaWorker=await scanOnce(workerClass());
 assert.deepEqual({...viaWorker.result},{text:value,format:'CODE_128'});
 assert.equal(viaWorker.stats.mode,'worker');
 assert(viaWorker.stats.attempts>=1);
 // Without workers, ZXing and decoder.js are loaded onto the page and decoding continues there.
 const onPage=await scanOnce(workerClass({fail:true}));
 assert.deepEqual({...onPage.result},{text:value,format:'CODE_128'});
 assert.equal(onPage.stats.mode,'main');
 // Stopping discards a result still in flight.
 const scope=page(workerClass());
 let late=0;
 const stopped=scope.PocketScanner.createScanner({video:draw(widths,false,false,4),onResult(){late++}});
 stopped.start(); stopped.stop();
 await new Promise(r=>setTimeout(r,300));
 assert.equal(late,0);

 const matrix = new ZXing.QRCodeWriter().encode('POCKETSCAN-2D-MUST-BE-IGNORED', ZXing.BarcodeFormat.QR_CODE, 360, 360, new Map());
 const qr=createCanvas(1280,720), q=qr.getContext('2d');
 q.fillStyle='#fff';q.fillRect(0,0,1280,720);q.fillStyle='#000';
 for(let y=0;y<matrix.getHeight();y++) for(let x=0;x<matrix.getWidth();x++) if(matrix.get(x,y))q.fillRect(460+x,180+y,1,1);
 qr.videoWidth=1280;qr.videoHeight=720;
 assert.deepEqual(reads(qr),Array(PASSES).fill(null));
 let options;
 class Native { static async getSupportedFormats(){return ['qr_code','data_matrix','ean_13','code_128','pdf417']} constructor(value){options=value} }
 await P.nativeDetector(Native);
 assert.deepEqual(Array.from(options.formats),['code_128','ean_13']);
 class TwoDOnly { static async getSupportedFormats(){return ['qr_code','data_matrix']} constructor(){throw Error('Must not instantiate')} }
 assert.equal(await P.nativeDetector(TwoDOnly),null);
 let calls=0;
 await P.focus({getCapabilities(){return {focusMode:['continuous']}},async applyConstraints(c){assert.equal(c.advanced[0].focusMode,'continuous');calls++}});
 assert.equal(await P.focus({getCapabilities(){return {}}}),null);
 assert.equal(await P.focus({getCapabilities(){throw Error('unsupported')}}),null);
 assert.equal(calls,1);
 let applied;
 const singleShot={getCapabilities(){return {focusMode:['manual','single-shot']}},async applyConstraints(c){applied=c}};
 assert.equal(await P.focus(singleShot),'single-shot');
 assert.equal(applied.advanced[0].focusMode,'single-shot');
 assert.equal(await P.focusAt(singleShot,.25,.75),'single-shot');
 assert.deepEqual(JSON.parse(JSON.stringify(applied.advanced)),[{focusMode:'single-shot',pointsOfInterest:[{x:.25,y:.75}]},{focusMode:'single-shot'}]);
 assert.equal(await P.focusAt({getCapabilities(){return {focusMode:['continuous']}},async applyConstraints(c){applied=c}},.5,.5),'continuous');
 assert.equal(await P.focusAt({getCapabilities(){return {}}},.5,.5),null);
 assert.equal(await P.focusAt({getCapabilities(){return {focusMode:['continuous']}},async applyConstraints(){throw Error('rejected')}},.5,.5),null);
 let sent;
 const camera={getCapabilities(){return {zoom:{min:1,max:8},torch:true,focusMode:['continuous']}},async applyConstraints(c){sent=c}};
 assert.equal(await P.zoom(camera),1.5);
 await Promise.all([P.focus(camera),P.torch(camera,true)]);
 assert.deepEqual(JSON.parse(JSON.stringify(sent.advanced)),[{zoom:1.5,focusMode:'continuous',torch:true}],'Settings must accumulate, not replace each other');
 assert.equal(await P.zoom({getCapabilities(){return {zoom:{min:1,max:1}}}}),null);
 console.log('PASS: Code 128 decoding horizontal/vertical, normal/reduced contrast, guide-box region, EAN-13 read, QR ignored; decoding through the worker script and the on-page fallback, stale results dropped; zoom/torch/focus kept together, single-shot fallback, tap-to-focus, native decoder restricted to 1D.');
})().catch(e=>{console.error(e);process.exitCode=1});
