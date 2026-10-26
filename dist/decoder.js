/* ZXing 1D decoding of one RGBA frame. Shared by the decode worker and the main-thread fallback. */
(() => {
  // Warehouse label symbologies plus retail product codes (EAN/UPC).
  const formats = ['CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'CODABAR', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E'];
  function create(ZXing) {
    const fast = new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS, formats.map(name => ZXing.BarcodeFormat[name])]]);
    const thorough = new Map(fast).set(ZXing.DecodeHintType.TRY_HARDER, true);
    // Only 1D decoders are instantiated; no QR, matrix, or PDF417 search.
    const reader = new ZXing.MultiFormatOneDReader(fast);
    const misses = [ZXing.NotFoundException, ZXing.ChecksumException, ZXing.FormatException];
    // Resolves to { text, format } or null when this frame holds no readable barcode.
    return function decode(rgba, width, height, tryHarder) {
      const luminance = new Uint8ClampedArray(width * height);
      for (let i = 0, j = 0; i < luminance.length; i++, j += 4) {
        luminance[i] = (306 * rgba[j] + 601 * rgba[j + 1] + 117 * rgba[j + 2] + 0x200) >> 10;
      }
      const source = new ZXing.RGBLuminanceSource(luminance, width, height);
      // Sideways reads have their own pass; stop TRY_HARDER from doubling its cost by retrying rotated.
      source.isRotateSupported = () => false;
      try {
        const result = reader.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source)), tryHarder ? thorough : fast);
        return { text: result.getText(), format: ZXing.BarcodeFormat[result.getBarcodeFormat()] };
      } catch (error) {
        if (misses.some(type => error instanceof type)) return null;
        throw error;
      }
    };
  }
  self.AssetDecoder = { create, formats };
})();
