import fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import { probeTextLayer, withPdfDocument } from '../pdf/document';
import { extractOutline, synthesizeOutline } from '../pdf/outline';
import { BookMetadata } from '../pdf/storage';

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

/**
 * Builds the local index for one textbook: page count, chapter outline, and whether a
 * text-only model will be able to read it. This index is the only thing consulted when
 * routing a question.
 */
export async function ingestBook(
  filePath: string,
  safeName: string,
  fileSize: number,
  bookId: string
): Promise<BookMetadata> {
  const rawBuffer = fs.readFileSync(filePath);
  const pageCount = await resolvePageCount(rawBuffer, fileSize);

  let toc = synthesizeOutline(pageCount);
  let tocSource: BookMetadata['tocSource'] = 'synthesized';
  let textLayer: BookMetadata['textLayer'] = 'none';

  try {
    await withPdfDocument(rawBuffer, async (doc) => {
      const pages = doc.numPages || pageCount;
      textLayer = await probeTextLayer(doc, pages);
      const outline = await extractOutline(doc, pages);
      toc = outline.toc;
      tocSource = outline.source;
    });
  } catch (err) {
    console.warn('[ingest] document unreadable, falling back to even chunks:', err);
  }

  return {
    id: bookId,
    name: safeName,
    sizeMb: parseFloat((fileSize / (1024 * 1024)).toFixed(2)) || 0.1,
    pageCount,
    toc,
    uploadTime: formatUploadTime(),
    tocSource,
    textLayer,
  };
}
