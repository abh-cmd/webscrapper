// Per-source placeholder detection registry. No real placeholder
// signatures from any of the four approved production sources are known
// yet — every real page has been blocked/never-requested, so nobody has
// actually seen what those sites' placeholder images look like. This
// ships with an honestly-empty registry (never registers fabricated
// signatures), extensible per source once real placeholder images are
// observed.

class PlaceholderDetector {
  constructor() {
    this.contentHashesBySource = new Map(); // sourceName -> Set<contentHash>
    this.urlPatternsBySource = new Map(); // sourceName -> RegExp[]
  }

  registerContentHash(sourceName, contentHash) {
    if (!this.contentHashesBySource.has(sourceName)) {
      this.contentHashesBySource.set(sourceName, new Set());
    }
    this.contentHashesBySource.get(sourceName).add(contentHash);
  }

  registerUrlPattern(sourceName, pattern) {
    if (!this.urlPatternsBySource.has(sourceName)) {
      this.urlPatternsBySource.set(sourceName, []);
    }
    this.urlPatternsBySource.get(sourceName).push(pattern);
  }

  isPlaceholder({ sourceName, contentHash = null, imageUrl = null }) {
    const knownHashes = this.contentHashesBySource.get(sourceName);
    if (knownHashes && contentHash && knownHashes.has(contentHash)) return true;

    const patterns = this.urlPatternsBySource.get(sourceName);
    if (patterns && imageUrl) {
      return patterns.some((pattern) => pattern.test(imageUrl));
    }

    return false;
  }
}

module.exports = { PlaceholderDetector };
