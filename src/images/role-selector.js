// Selects exactly one primary image per product from a set of candidates,
// per the adapter-defined role vocabulary. Placeholders are never
// eligible to become the primary image, regardless of role.

const ROLE_PREFERENCE_ORDER = ['hero', 'packaging', 'label', 'lifestyle'];

function selectPrimaryImage(candidates = []) {
  // Recognizes both conventions: an explicit isPlaceholder flag (used by
  // callers building candidates in memory) and role === 'placeholder'
  // (how a persisted image_references row records it — see
  // src/images/process-image-job.js). Either one excludes a candidate.
  const real = candidates.filter((candidate) => !candidate.isPlaceholder && candidate.role !== 'placeholder');
  if (real.length === 0) return null;

  for (const role of ROLE_PREFERENCE_ORDER) {
    const match = real.find((candidate) => candidate.role === role);
    if (match) return match;
  }

  // No candidate matched a known preferred role (e.g. only 'lifestyle' or
  // an unrecognized role string) — fall back to the first real image
  // rather than having no primary image at all.
  return real[0];
}

module.exports = { selectPrimaryImage, ROLE_PREFERENCE_ORDER };
