/* Runs ZXing off the main thread so decoding never stalls the camera preview or the buttons. */
importScripts('./vendor/zxing.min.js', './decoder.js');

const decode = self.AssetDecoder.create(self.ZXing);

self.onmessage = ({ data }) => {
  const started = Date.now();
  let result = null;
  try {
    result = decode(new Uint8ClampedArray(data.buffer), data.width, data.height, data.tryHarder);
  } catch (error) { /* An unexpected decoder error only loses this frame. */ }
  self.postMessage({ id: data.id, result, ms: Date.now() - started });
};
