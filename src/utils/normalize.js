function safeString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return String(value).trim() || null;
}

function normalizeArray(values) {
  if (Array.isArray(values)) {
    return values
      .map((entry) => {
        if (entry === null || entry === undefined) return null;
        if (typeof entry === 'string') {
          const normalized = entry.trim();
          return normalized === '' ? null : normalized;
        }
        return entry;
      })
      .filter((entry) => entry !== null && entry !== undefined && entry !== '');
  }
  return [];
}

module.exports = {
  safeString,
  normalizeArray
};
