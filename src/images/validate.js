const { detectImageFormat } = require('./magic-bytes');
const { parseDimensions } = require('./dimensions');

// Structural completeness checks — cheap, format-specific "does this file
// actually end the way this format requires" checks, not a full decode.
// Catches the common truncated-download case (connection dropped mid-file).
function isStructurallyComplete(buffer, format) {
  if (format === 'jpeg') {
    return buffer.length >= 4 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  }
  if (format === 'png') {
    if (buffer.length < 12) return false;
    const tail = buffer.slice(buffer.length - 8, buffer.length - 4).toString('ascii');
    return tail === 'IEND';
  }
  if (format === 'gif') {
    return buffer.length >= 1 && buffer[buffer.length - 1] === 0x3b;
  }
  if (format === 'webp') {
    if (buffer.length < 8) return false;
    const declaredSize = buffer.readUInt32LE(4);
    // RIFF chunk size excludes the 8-byte 'RIFF'+size header itself.
    return declaredSize === buffer.length - 8;
  }
  // avif: no structural-completeness check implemented (see dimensions.js
  // for the same disclosed limitation); treated as complete by default
  // rather than falsely rejecting a valid file we can't fully parse.
  return true;
}

function validateImage(buffer, {
  minWidth = 1,
  minHeight = 1,
  maxPixels = 50_000_000,
  maxBytes = 20 * 1024 * 1024
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { valid: false, reason: 'EMPTY_FILE', format: null };
  }
  if (buffer.length > maxBytes) {
    return { valid: false, reason: 'FILE_TOO_LARGE', format: null };
  }

  const format = detectImageFormat(buffer);
  if (format === 'svg') {
    return { valid: false, reason: 'SVG_REJECTED', format };
  }
  if (!format) {
    return { valid: false, reason: 'UNRECOGNIZED_FORMAT', format: null };
  }

  if (!isStructurallyComplete(buffer, format)) {
    return { valid: false, reason: 'CORRUPT_OR_TRUNCATED', format };
  }

  const dimensions = parseDimensions(buffer, format);

  if (dimensions) {
    if (dimensions.width < minWidth || dimensions.height < minHeight) {
      return { valid: false, reason: 'BELOW_MINIMUM_DIMENSIONS', format, ...dimensions };
    }
    if (dimensions.width * dimensions.height > maxPixels) {
      return { valid: false, reason: 'EXCEEDS_PIXEL_BUDGET', format, ...dimensions };
    }
  }

  return {
    valid: true,
    format,
    width: dimensions ? dimensions.width : null,
    height: dimensions ? dimensions.height : null
  };
}

module.exports = { validateImage, isStructurallyComplete };
