const fs = require('node:fs');
const path = require('node:path');

// Local filesystem storage, content-addressed by hash. The root directory
// is configurable (IMAGE_STORAGE_ROOT) — no external cloud provider is
// hard-coded here; swapping in S3/GCS/etc. later only means replacing this
// one module, nothing else in Block 3 needs to change.

const EXTENSION_BY_FORMAT = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif' };

function storageRoot(env = process.env) {
  return env.IMAGE_STORAGE_ROOT || path.join(process.cwd(), 'output', 'images');
}

function pathForContentHash(contentHash, format, env = process.env) {
  const extension = EXTENSION_BY_FORMAT[format] || 'bin';
  const prefix = contentHash.slice(0, 2);
  return path.join(storageRoot(env), prefix, `${contentHash}.${extension}`);
}

function storeBytes(buffer, contentHash, format, env = process.env) {
  const filePath = pathForContentHash(contentHash, format, env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, buffer);
  }
  return filePath;
}

function readBytes(storagePath) {
  return fs.readFileSync(storagePath);
}

module.exports = { storageRoot, pathForContentHash, storeBytes, readBytes };
