// Dimension parsing directly from file headers — no full pixel decode
// needed for this (see perceptual-hash.js for the one place a full PNG
// decode does happen). Genuinely implemented for PNG, GIF, JPEG, and the
// WebP VP8L/VP8X chunk forms. NOT implemented for AVIF or lossy WebP
// (VP8) — both require substantially more complex box/bitstream parsing;
// those formats still pass magic-byte detection, they just don't get
// dimension-based validation (min/max size, pixel budget) enforced. This
// is a disclosed limitation, not a silent gap.

function pngDimensions(buffer) {
  if (buffer.length < 24) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function gifDimensions(buffer) {
  if (buffer.length < 10) return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(buffer) {
  let offset = 2; // skip SOI (FF D8)
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) break; // EOI

    if (JPEG_SOF_MARKERS.has(marker)) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) break; // malformed; stop rather than loop forever
    offset += 2 + segmentLength;
  }
  return null;
}

function webpDimensions(buffer) {
  if (buffer.length < 30) return null;
  const fourcc = buffer.slice(12, 16).toString('ascii');

  if (fourcc === 'VP8L' && buffer.length >= 25) {
    const packed = buffer.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
  }

  if (fourcc === 'VP8X') {
    const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
    const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
    return { width, height };
  }

  return null; // VP8 (lossy) bitstream parsing not implemented
}

function parseDimensions(buffer, format) {
  try {
    switch (format) {
      case 'png': return pngDimensions(buffer);
      case 'gif': return gifDimensions(buffer);
      case 'jpeg': return jpegDimensions(buffer);
      case 'webp': return webpDimensions(buffer);
      default: return null;
    }
  } catch (error) {
    return null;
  }
}

module.exports = { parseDimensions };
