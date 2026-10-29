const zlib = require('node:zlib');

// A minimal, real, spec-compliant PNG encoder — used ONLY to synthesize
// test fixtures (this is test infrastructure, not a production feature;
// the project explicitly does not implement image generation/editing).
// 8-bit RGB, non-interlaced, single IDAT chunk, filter type 0 (None).

const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
}

// pixelFn(x, y) -> [r, g, b]
function makePng(width, height, pixelFn = () => [128, 128, 128]) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0; // compression, filter method, interlace = none

  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: None
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelFn(x, y);
      const base = y * (stride + 1) + 1 + x * 3;
      raw[base] = r;
      raw[base + 1] = g;
      raw[base + 2] = b;
    }
  }

  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function solidColorPng(width, height, [r, g, b]) {
  return makePng(width, height, () => [r, g, b]);
}

module.exports = { makePng, solidColorPng, crc32 };
