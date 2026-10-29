// Format detection by magic bytes (file signature), not Content-Type —
// a mislabeled or spoofed Content-Type header must never cause an SVG (or
// anything else) to be accepted as a raster image.

function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'png';
  }

  if (buffer.length >= 6) {
    const sig = buffer.slice(0, 6).toString('ascii');
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'gif';
  }

  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }

  if (buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }

  // SVG is text-based (possibly with a BOM/whitespace/XML prolog before the
  // <svg> tag), so it needs a content sniff rather than a fixed byte offset.
  const head = buffer.slice(0, 300).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype svg')) {
    return 'svg';
  }

  return null;
}

module.exports = { detectImageFormat };
