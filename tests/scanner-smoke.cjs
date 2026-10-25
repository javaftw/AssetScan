const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createCanvas} = require('@napi-rs/canvas');
const ZXing = require('../dist/vendor/zxing.min.js');
const scope={window:{},document:{createElement(){return createCanvas(1,1)}}};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../dist/scanner.js'),'utf8'),scope);
const L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G=['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const value='5901234123457', parity='LGGLLG';
const bits='101'+[...value.slice(1,7)].map((n,i)=>(parity[i]==='L'?L:G)[+n]).join('')+'01010'+[...value.slice(7)].map(n=>L[+n].replace(/[01]/g,b=>b==='0'?'1':'0')).join('')+'101';
for(const vertical of [false,true]) for(const lowContrast of [false,true]) {
 const frame=createCanvas(1920,1080), c=frame.getContext('2d');
 c.fillStyle=lowContrast?'#ccc':'#fff';c.fillRect(0,0,1920,1080);
 c.translate(960,540);if(vertical)c.rotate(Math.PI/2);
 c.fillStyle=lowContrast?'#666':'#000';
 [...bits].forEach((bit,i)=>{if(bit==='1')c.fillRect((i-bits.length/2)*7,-130,7,260)});
 frame.videoWidth=1920;frame.videoHeight=1080;
 const reader=scope.window.PocketScanner.createReader(ZXing);
 assert(reader.reader instanceof ZXing.MultiFormatOneDReader);
 let found=false;
 for(let i=0;i<4;i++) {try {assert.equal(reader.decode(frame).getText(),value);found=true;}catch(e){if(e.name==='AssertionError')throw e}}
 assert(found,`Failed orientation=${vertical}, lowContrast=${lowContrast}`);
}
(async()=>{
 const matrix = new ZXing.QRCodeWriter().encode('POCKETSCAN-2D-MUST-BE-IGNORED', ZXing.BarcodeFormat.QR_CODE, 360, 360, new Map());
 const qr=createCanvas(1280,720), q=qr.getContext('2d');
 q.fillStyle='#fff';q.fillRect(0,0,1280,720);q.fillStyle='#000';
 for(let y=0;y<matrix.getHeight();y++) for(let x=0;x<matrix.getWidth();x++) if(matrix.get(x,y))q.fillRect(460+x,180+y,1,1);
 qr.videoWidth=1280;qr.videoHeight=720;
 const linearReader=scope.window.PocketScanner.createReader(ZXing);
 for(let pass=0;pass<4;pass++) assert.throws(()=>linearReader.decode(qr));
 let options;
 class Native { static async getSupportedFormats(){return ['qr_code','data_matrix','ean_13','code_128','pdf417']} constructor(value){options=value} }
 await scope.window.PocketScanner.nativeDetector(Native);
 assert.deepEqual(Array.from(options.formats),['ean_13','code_128']);
 class TwoDOnly { static async getSupportedFormats(){return ['qr_code','data_matrix']} constructor(){throw Error('Must not instantiate')} }
 assert.equal(await scope.window.PocketScanner.nativeDetector(TwoDOnly),null);
 let calls=0;
 await scope.window.PocketScanner.focus({getCapabilities(){return {focusMode:['continuous']}},async applyConstraints(c){assert.equal(c.advanced[0].focusMode,'continuous');calls++}});
 await scope.window.PocketScanner.focus({getCapabilities(){return {}}});
 await scope.window.PocketScanner.focus({getCapabilities(){throw Error('unsupported')}});
 assert.equal(calls,1);
 console.log('PASS: actual EAN-13 decoding horizontal/vertical, normal/reduced contrast, optional autofocus; QR ignored and native decoder restricted to 1D.');
})().catch(e=>{console.error(e);process.exitCode=1});
