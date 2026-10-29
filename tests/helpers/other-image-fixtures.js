// Minimal but structurally-correct synthetic fixtures for GIF/JPEG/WebP —
// test infrastructure only. These are not necessarily fully decodable
// images (e.g. the GIF's LZW image data is placeholder bytes), only
// correct enough to exercise this project's own magic-byte/dimension/
// structural-completeness parsers, which never decode pixel data for
// these three formats.

function makeGif(width, height) {
  const header = Buffer.from('GIF89a', 'ascii');

  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80; // global color table present, 2 colors
  lsd[5] = 0;
  lsd[6] = 0;

  const globalColorTable = Buffer.from([0, 0, 0, 255, 255, 255]);
  const imageDescriptor = Buffer.from([
    0x2c,
    0, 0, 0, 0,
    width & 0xff, (width >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff,
    0x00
  ]);
  const imageData = Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]); // placeholder LZW-ish bytes
  const trailer = Buffer.from([0x3b]);

  return Buffer.concat([header, lsd, globalColorTable, imageDescriptor, imageData, trailer]);
}

function makeJpeg(width, height) {
  const soi = Buffer.from([0xff, 0xd8]);

  const componentsData = Buffer.from([1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const payloadLength = 2 + 1 + 2 + 2 + 1 + componentsData.length;
  const lengthBuf = Buffer.alloc(2);
  lengthBuf.writeUInt16BE(payloadLength, 0);
  const heightBuf = Buffer.alloc(2);
  heightBuf.writeUInt16BE(height, 0);
  const widthBuf = Buffer.alloc(2);
  widthBuf.writeUInt16BE(width, 0);

  const sof0 = Buffer.concat([
    Buffer.from([0xff, 0xc0]),
    lengthBuf,
    Buffer.from([8]), // precision
    heightBuf,
    widthBuf,
    Buffer.from([3]), // numComponents
    componentsData
  ]);

  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, sof0, eoi]);
}

function makeWebpVp8x(width, height) {
  const vp8xPayload = Buffer.alloc(10);
  vp8xPayload[0] = 0x10;
  const w = (width - 1) & 0xffffff;
  vp8xPayload[4] = w & 0xff;
  vp8xPayload[5] = (w >> 8) & 0xff;
  vp8xPayload[6] = (w >> 16) & 0xff;
  const h = (height - 1) & 0xffffff;
  vp8xPayload[7] = h & 0xff;
  vp8xPayload[8] = (h >> 8) & 0xff;
  vp8xPayload[9] = (h >> 16) & 0xff;

  const vp8xChunkLen = Buffer.alloc(4);
  vp8xChunkLen.writeUInt32LE(vp8xPayload.length, 0);
  const vp8xChunk = Buffer.concat([Buffer.from('VP8X', 'ascii'), vp8xChunkLen, vp8xPayload]);

  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), vp8xChunk]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(body.length, 0);

  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riffSize, body]);
}

function makeAvif() {
  // Just enough for magic-byte detection (ftyp box with an avif brand) —
  // dimension parsing for AVIF is a disclosed, unimplemented gap.
  const box = Buffer.alloc(12);
  box.writeUInt32BE(12, 0);
  box.write('ftyp', 4, 'ascii');
  box.write('avif', 8, 'ascii');
  return box;
}

function makeSvg() {
  return Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf8');
}

module.exports = { makeGif, makeJpeg, makeWebpVp8x, makeAvif, makeSvg };
