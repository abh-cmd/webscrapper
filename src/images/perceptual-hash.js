const zlib = require('node:zlib');

// Perceptual-hash deduplication "where practical" (per requirements):
// implemented genuinely for PNG only, using Node's built-in zlib to
// inflate the IDAT stream and a real (if minimal) PNG unfiltering
// implementation — no external image library. JPEG/WebP/AVIF/GIF pixel
// decoding is substantially more involved (DCT/Huffman, VP8, etc.) and is
// NOT implemented here; averageHash() returns null for those formats
// rather than fabricating a hash. Content-hash deduplication
// (content-hash.js) still works for every format regardless.
//
// Only the common case is supported: 8-bit depth, non-interlaced,
// non-palette PNGs (color types 0/2/4/6). Anything else returns null.

function readPngChunks(buffer) {
  const chunks = [];
  let offset = 8; // skip the 8-byte PNG signature
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.slice(offset + 4, offset + 8).toString('ascii');
    const data = buffer.slice(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 8 + length + 4; // + 4-byte CRC
    if (type === 'IEND') break;
  }
  return chunks;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 }; // 3 (palette) unsupported

function decodePng(buffer) {
  const chunks = readPngChunks(buffer);
  const ihdrChunk = chunks.find((c) => c.type === 'IHDR');
  if (!ihdrChunk) return null;

  const ihdr = ihdrChunk.data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];

  if (bitDepth !== 8 || interlace !== 0) return null;
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (!channels) return null;

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  if (idat.length === 0) return null;

  let raw;
  try {
    raw = zlib.inflateSync(idat);
  } catch (error) {
    return null;
  }

  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let rawOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const rowStart = y * stride;

    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[rawOffset + x];
      const a = x >= channels ? pixels[rowStart + x - channels] : 0;
      const b = y > 0 ? pixels[rowStart - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[rowStart - stride + x - channels] : 0;

      let value;
      switch (filterType) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + Math.floor((a + b) / 2); break;
        case 4: value = rawByte + paethPredictor(a, b, c); break;
        default: value = rawByte;
      }
      pixels[rowStart + x] = value & 0xff;
    }
    rawOffset += stride;
  }

  return { width, height, channels, pixels };
}

function toGrayscale({ width, height, channels, pixels }) {
  const gray = new Float64Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const base = i * channels;
    gray[i] = channels === 1
      ? pixels[base]
      : 0.299 * pixels[base] + 0.587 * pixels[base + 1] + 0.114 * pixels[base + 2];
  }
  return gray;
}

// Classic average-hash (aHash): downscale to `size` x `size` grayscale,
// threshold each pixel against the mean, pack the bits into a hex string.
function averageHashPng(buffer, { size = 8 } = {}) {
  const decoded = decodePng(buffer);
  if (!decoded) return null;

  const gray = toGrayscale(decoded);
  const { width, height } = decoded;
  const small = new Float64Array(size * size);

  for (let sy = 0; sy < size; sy += 1) {
    for (let sx = 0; sx < size; sx += 1) {
      const srcX = Math.min(width - 1, Math.floor(((sx + 0.5) * width) / size));
      const srcY = Math.min(height - 1, Math.floor(((sy + 0.5) * height) / size));
      small[sy * size + sx] = gray[srcY * width + srcX];
    }
  }

  const average = small.reduce((sum, v) => sum + v, 0) / small.length;
  let bits = '';
  for (let i = 0; i < small.length; i += 1) bits += small[i] >= average ? '1' : '0';

  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function hammingDistance(hashA, hashB) {
  if (!hashA || !hashB || hashA.length !== hashB.length) return null;
  const nibbleBits = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
  let distance = 0;
  for (let i = 0; i < hashA.length; i += 1) {
    distance += nibbleBits[parseInt(hashA[i], 16) ^ parseInt(hashB[i], 16)];
  }
  return distance;
}

module.exports = { decodePng, averageHashPng, hammingDistance };
