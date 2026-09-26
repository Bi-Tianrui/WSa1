import fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import { withPdfDocument } from '../pdf/document';
import { extractOutline, extractVisualOutline, synthesizeOutline } from '../pdf/outline';
import { BookMetadata } from '../pdf/storage';
import { ChatProvider, ProviderCredentials } from '../providers';

/**
 * STAGE 1 - Textbook ingest, at zero token cost.
 *
 * This module is deliberately free of any network client. Mounting a textbook reads its
 * outline and probes its text layer locally; no model, no Files API, and no cloud
 * context cache is ever contacted here.
 */

/** Determines the page count with layered fallbacks for damaged or encrypted files. */
async function resolvePageCount(rawBuffer: Buffer, fileSize: number): Promise<number> {
  try {
    const count = (await PDFDocument.load(rawBuffer, { ignoreEncryption: true })).getPageCount();
    if (count > 0) return count;
  } catch (err) {
    console.warn('[ingest] pdf-lib page count failed, trying pdf.js:', err);
  }

  try {
    const count = await withPdfDocument(rawBuffer, async (doc) => doc.numPages);
    if (count > 0) return count;
  } catch (err) {
    console.warn('[ingest] pdf.js page count failed, trying raw scan:', err);
  }

  try {
    const head = rawBuffer.subarray(0, Math.min(rawBuffer.length, 10 * 1024 * 1024)).toString('latin1');
    const countMatch = head.match(/\/Count\s+(\d+)/);
    if (countMatch?.[1]) {
      const count = parseInt(countMatch[1], 10);
      if (count > 0) return count;
    }
    const pageMatches = head.match(/\/Type\s*\/Page\b/g);
    if (pageMatches && pageMatches.length > 0) return pageMatches.length;
  } catch {}

  return Math.max(1, Math.round(fileSize / (120 * 1024)));
}

function formatUploadTime(): string {
  const now = new Date();
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
}

/** Everything needed to read a contents page with the user's configured vision model. */
export interface VisionContext {
  provider: ChatProvider;
  model: string;
  credentials: ProviderCredentials;
  signal?: AbortSignal;
}

/**
 * Builds the local index for one textbook: page count and chapter outline. This index is
 * the only thing consulted when routing a question, and it is written once.
 *
 * Three tiers, cheapest first:
 *   1. Native bookmarks or a parseable printed contents page - free, no model involved.
 *   2. The front pages read by the configured vision model - only for scans, which have
 *      neither, and only when credentials are available.
 *   3. Fixed-size page blocks - a guess, kept solely so a book is never unusable.
 */
export async function ingestBook(
  filePath: string,
  safeName: string,
  fileSize: number,
  bookId: string,
  vision?: VisionContext | null
): Promise<BookMetadata> {
  const rawBuffer = fs.readFileSync(filePath);
  const pageCount = await resolvePageCount(rawBuffer, fileSize);

  let toc: BookMetadata['toc'] = [];
  let tocSource: BookMetadata['tocSource'] = 'none';

  try {
    await withPdfDocument(rawBuffer, async (doc) => {
      const outline = await extractOutline(doc, doc.numPages || pageCount);
      toc = outline.toc;
      tocSource = outline.source;
    });
  } catch (err) {
    console.warn('[ingest] parsing passes failed, falling through to visual reading:', err);
  }

  let visionAttempted = false;

  if (toc.length === 0 && vision) {
    visionAttempted = true;
    try {
      const visual = await extractVisualOutline({
        bookId,
        totalPages: pageCount,
        provider: vision.provider,
        model: vision.model,
        credentials: vision.credentials,
        signal: vision.signal ?? new AbortController().signal,
      });
      if (visual.length > 0) {
        toc = visual;
        tocSource = 'vision';
      }
    } catch (err) {
      console.warn('[ingest] visual outline read failed, falling back to page blocks:', err);
    }
  }

  if (toc.length === 0) {
    toc = synthesizeOutline(pageCount);
    tocSource = 'synthesized';
  }

  return {
    id: bookId,
    name: safeName,
    sizeMb: parseFloat((fileSize / (1024 * 1024)).toFixed(2)) || 0.1,
    pageCount,
    toc,
    uploadTime: formatUploadTime(),
    tocSource,
    visionAttempted,
  };
}
