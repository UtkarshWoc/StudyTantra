import Document from '../../models/Document.js';
import { ingestDocument } from './ingest.js';
import { logger } from '../../config/logger.js';

// Limit background concurrency to 1 to stay well within memory limits (Render 512MB RAM).
const CONCURRENCY = 1;
const pending = [];
const queued = new Set();
let running = 0;
let idleResolvers = [];

const settleIdle = () => {
  if (running === 0 && pending.length === 0) {
    idleResolvers.forEach((resolve) => resolve());
    idleResolvers = [];
  }
};

const pump = () => {
  while (running < CONCURRENCY && pending.length) {
    const item = pending.shift();
    running += 1;
    ingestDocument(item.id, item.buffer)
      .catch((err) => logger.error({ err }, 'Ingestion job crashed'))
      .finally(() => {
        queued.delete(item.id);
        running -= 1;
        pump();
        settleIdle();
      });
  }
};

export const enqueueIngestion = (documentId, initialBuffer = null) => {
  const id = String(documentId);
  if (queued.has(id)) return;
  queued.add(id);
  pending.push({ id, buffer: initialBuffer });
  pump();
};

/** Resolves when no jobs are queued or running (used by tests and shutdown). */
export const whenIdle = () =>
  new Promise((resolve) => {
    idleResolvers.push(resolve);
    settleIdle();
  });

/**
 * On boot: clean up documents interrupted mid-processing.
 * Any document left in 'processing' when the server boots was abruptly aborted
 * (e.g. by an OOM crash or container restart). Marking them 'failed' prevents an
 * infinite crash-restart loop on memory-constrained servers (Render free tier).
 */
export const resumePendingIngestion = async () => {
  try {
    const interrupted = await Document.updateMany(
      { status: 'processing' },
      {
        status: 'failed',
        processingError: 'Processing was interrupted by a server restart or memory limit. Use the Retry button to try again.',
      }
    );
    if (interrupted.modifiedCount > 0) {
      logger.warn({ count: interrupted.modifiedCount }, 'Marked interrupted processing documents as failed');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not clean up interrupted documents');
  }

  // Only index documents uploaded before ingestion existed (no status field at all)
  const legacyDocs = await Document.find({ status: { $exists: false } }).select('_id');
  if (legacyDocs.length) {
    logger.info({ count: legacyDocs.length }, 'Queueing legacy documents for ingestion');
    legacyDocs.forEach((d) => enqueueIngestion(d._id));
  }
};
