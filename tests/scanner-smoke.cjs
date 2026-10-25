const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createCanvas} = require('@napi-rs/canvas');
const ZXing = require('../dist/vendor/zxing.min.js');
const scope={window:{},document:{createElement(){return createCanvas(1,1)}}};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../dist/scanner.js'),'utf8'),scope);
const P=scope.window.PocketScanner;
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
 frame.videoWidth=1920;frame.videoHeight=1080;
 return frame;
}
const PASSES=6;
for(const vertical of [false,true]) for(const lowContrast of [false,true]) {
 const frame=draw(widths,vertical,lowContrast,4);
 const reader=P.createReader(ZXing);
 assert(reader.reader instanceof ZXing.MultiFormatOneDReader);
 let found=false;
 for(let i=0;i<PASSES;i++) {try {assert.equal(reader.decode(frame).getText(),value);found=true;}catch(e){if(e.name==='AssertionError')throw e}}
 assert(found,`Failed orientation=${vertical}, lowContrast=${lowContrast}`);
 assert.equal(reader.stats.attempts,PASSES);
}
// Retail EAN-13 product codes are no longer searched.
const L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G=['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const ean='5901234123457', parity='LGGLLG';
const bits='101'+[...ean.slice(1,7)].map((n,i)=>(parity[i]==='L'?L:G)[+n]).join('')+'01010'+[...ean.slice(7)].map(n=>L[+n].replace(/[01]/g,b=>b==='0'?'1':'0')).join('')+'101';
const eanWidths=bits.match(/1+|0+/g).map(run=>run.length);
const eanReader=P.createReader(ZXing);
for(let i=0;i<PASSES;i++) assert.throws(()=>eanReader.decode(draw(eanWidths,false,false,7)));
// The guide box region is honoured: a box away from the barcode misses it on band passes.
const boxed=P.createReader(ZXing,{region:()=>({x:0,y:0,width:1,height:.2})});
assert.throws(()=>boxed.decode(draw(widths,false,false,4)));
(async()=>{
 const matrix = new ZXing.QRCodeWriter().encode('POCKETSCAN-2D-MUST-BE-IGNORED', ZXing.BarcodeFormat.QR_CODE, 360, 360, new Map());
 const qr=createCanvas(1280,720), q=qr.getContext('2d');
 q.fillStyle='#fff';q.fillRect(0,0,1280,720);q.fillStyle='#000';
 for(let y=0;y<matrix.getHeight();y++) for(let x=0;x<matrix.getWidth();x++) if(matrix.get(x,y))q.fillRect(460+x,180+y,1,1);
 qr.videoWidth=1280;qr.videoHeight=720;
 const linearReader=scope.window.PocketScanner.createReader(ZXing);
 for(let pass=0;pass<PASSES;pass++) assert.throws(()=>linearReader.decode(qr));
 let options;
 class Native { static async getSupportedFormats(){return ['qr_code','data_matrix','ean_13','code_128','pdf417']} constructor(value){options=value} }
 await scope.window.PocketScanner.nativeDetector(Native);
 assert.deepEqual(Array.from(options.formats),['code_128']);
 class TwoDOnly { static async getSupportedFormats(){return ['qr_code','data_matrix']} constructor(){throw Error('Must not instantiate')} }
 assert.equal(await scope.window.PocketScanner.nativeDetector(TwoDOnly),null);
 let calls=0;
 await scope.window.PocketScanner.focus({getCapabilities(){return {focusMode:['continuous']}},async applyConstraints(c){assert.equal(c.advanced[0].focusMode,'continuous');calls++}});
 assert.equal(await scope.window.PocketScanner.focus({getCapabilities(){return {}}}),null);
 assert.equal(await scope.window.PocketScanner.focus({getCapabilities(){throw Error('unsupported')}}),null);
 assert.equal(calls,1);
 let applied;
 const singleShot={getCapabilities(){return {focusMode:['manual','single-shot']}},async applyConstraints(c){applied=c}};
 assert.equal(await scope.window.PocketScanner.focus(singleShot),'single-shot');
 assert.equal(applied.advanced[0].focusMode,'single-shot');
 assert.equal(await scope.window.PocketScanner.focusAt(singleShot,.25,.75),'single-shot');
 assert.deepEqual(JSON.parse(JSON.stringify(applied.advanced)),[{focusMode:'single-shot',pointsOfInterest:[{x:.25,y:.75}]},{focusMode:'single-shot'}]);
 assert.equal(await scope.window.PocketScanner.focusAt({getCapabilities(){return {focusMode:['continuous']}},async applyConstraints(c){applied=c}},.5,.5),'continuous');
 assert.equal(await scope.window.PocketScanner.focusAt({getCapabilities(){return {}}},.5,.5),null);
 assert.equal(await scope.window.PocketScanner.focusAt({getCapabilities(){return {focusMode:['continuous']}},async applyConstraints(){throw Error('rejected')}},.5,.5),null);
 let sent;
 const camera={getCapabilities(){return {zoom:{min:1,max:8},torch:true,focusMode:['continuous']}},async applyConstraints(c){sent=c}};
 assert.equal(await P.zoom(camera),1.5);
 await Promise.all([P.focus(camera),P.torch(camera,true)]);
 assert.deepEqual(JSON.parse(JSON.stringify(sent.advanced)),[{zoom:1.5,focusMode:'continuous',torch:true}],'Settings must accumulate, not replace each other');
 assert.equal(await P.zoom({getCapabilities(){return {zoom:{min:1,max:1}}}}),null);
 console.log('PASS: actual Code 128 decoding horizontal/vertical, normal/reduced contrast, guide-box region, EAN-13 ignored, zoom/torch/focus settings kept together, autofocus with single-shot fallback and tap-to-focus; QR ignored and native decoder restricted to 1D.');
})().catch(e=>{console.error(e);process.exitCode=1});
