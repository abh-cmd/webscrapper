const { fetchImage } = require('./image-fetcher');
const { validateImage } = require('./validate');
const { computeContentHash } = require('./content-hash');
const imageQueue = require('./image-queue-repository');
const imageStore = require('./image-store-repository');

// The single real workflow gluing together everything Block 3 built:
// fetch (with conditional GET, Referer/session reuse) -> placeholder
// check -> validate -> content-hash dedup/store -> reference with the
// correct role. This is what an image worker actually calls per claimed
// job; it is also what makes placeholder occurrences and rejection
// reasons queryable for observability (src/observability/run-metrics.js),
// which they were not before this file existed — placeholder-detector.js
// and validate.js previously existed only as unwired utilities.
async function processImageJob(job, { placeholderDetector = null, session = null, validationOptions = {} } = {}) {
  try {
    const fetched = await fetchImage(job.imageUrl, {
      refererUrl: job.refererUrl,
      etag: job.etag,
      lastModified: job.lastModified,
      headers: session?.cookieHeader ? { Cookie: session.cookieHeader } : {}
    });

    if (fetched.notModified) {
      await imageQueue.markImageSucceeded(job.id, { etag: job.etag, lastModified: job.lastModified });
      return { status: 'unchanged' };
    }

    const contentHash = computeContentHash(fetched.buffer);
    const isPlaceholder = placeholderDetector
      ? placeholderDetector.isPlaceholder({ sourceName: job.sourceName, contentHash, imageUrl: job.imageUrl })
      : false;

    const validation = validateImage(fetched.buffer, validationOptions);
    if (!validation.valid) {
      await imageQueue.markImageFailed(job.id, {
        errorType: `VALIDATION_${validation.reason}`,
        errorMessage: `Image failed validation: ${validation.reason}`
      });
      return { status: 'rejected', reason: validation.reason };
    }

    const stored = await imageStore.storeValidatedImage(fetched.buffer, {
      sourceUrl: job.imageUrl,
      validation: validationOptions
    });

    const reference = await imageStore.addImageReference({
      imageId: stored.image.id,
      itemNumber: job.itemNumber,
      sourceName: job.sourceName,
      sourceUrl: job.imageUrl,
      role: isPlaceholder ? 'placeholder' : job.role
    });

    await imageQueue.markImageSucceeded(job.id, { etag: fetched.etag, lastModified: fetched.lastModified });

    return { status: isPlaceholder ? 'placeholder' : 'stored', reference, image: stored.image, deduped: stored.deduped };
  } catch (error) {
    await imageQueue.markImageFailed(job.id, {
      errorType: error.code || 'FETCH_ERROR',
      errorMessage: error.message
    });
    return { status: 'failed', error: { type: error.code || 'FETCH_ERROR', message: error.message } };
  }
}

module.exports = { processImageJob };
