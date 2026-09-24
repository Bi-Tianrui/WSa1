import path from 'path';
import { createRequire } from 'module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// CJK textbooks rely on predefined CMaps and standard font data. Without these two
// paths pdf.js silently drops every Chinese glyph and returns Latin punctuation only,
// which is what made text extraction useless for text-only models.
const requireFromHere = createRequire(import.meta.url);
const PDFJS_ROOT = path.dirname(requireFromHere.resolve('pdfjs-dist/package.json'));
const CMAP_URL = path.join(PDFJS_ROOT, 'cmaps') + path.sep;
const STANDARD_FONT_URL = path.join(PDFJS_ROOT, 'standard_fonts') + path.sep;

export type PdfDocument = any;

/** Opens a document with CJK-safe options and always releases the worker afterwards. */
export async function withPdfDocument<T>(
  data: Buffer,
  fn: (doc: PdfDocument) => Promise<T>
): Promise<T> {
  const doc = await pdfjs.getDocument({
    // pdf.js detaches the buffer it is given, so hand it a private copy.
    data: new Uint8Array(data),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_URL,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;

  try {
    return await fn(doc);
  } finally {
    try {
      await doc.destroy();
    } catch {}
  }
}

/** Extracts the text layer of a single page, preserving line breaks. */
export async function readPageText(doc: PdfDocument, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  try {
    const content = await page.getTextContent();
    let out = '';
    for (const item of content.items as any[]) {
      if (typeof item.str !== 'string') continue;
      out += item.str;
      if (item.hasEOL) out += '\n';
    }
    return out;
  } finally {
    try {
      page.cleanup();
    } catch {}
  }
}

/** Counts characters that actually carry meaning, ignoring layout whitespace. */
export function meaningfulCharCount(text: string): number {
  return text.replace(/\s+/g, '').length;
}

export type TextLayerQuality = 'rich' | 'sparse' | 'none';

export function classifyTextDensity(totalChars: number, pagesSampled: number): TextLayerQuality {
  if (pagesSampled <= 0) return 'none';
  const perPage = totalChars / pagesSampled;
  if (perPage < 50) return 'none';
  if (perPage < 200) return 'sparse';
  return 'rich';
}

/**
 * Samples pages spread across the document to decide whether a usable text layer exists.
 * Scanned textbooks return only a watermark or nothing at all, which text-only models
 * cannot work with no matter how the slice is prepared.
 */
export async function probeTextLayer(
  doc: PdfDocument,
  totalPages: number
): Promise<TextLayerQuality> {
  const wanted = Math.min(8, totalPages);
  const samples = new Set<number>();
  for (let i = 0; i < wanted; i++) {
    // Spread the samples so front matter alone cannot make a scan look readable.
    const ratio = (i + 1) / (wanted + 1);
    samples.add(Math.max(1, Math.min(totalPages, Math.round(totalPages * ratio))));
  }

  let chars = 0;
  let sampled = 0;
  for (const pageNumber of samples) {
    try {
      chars += meaningfulCharCount(await readPageText(doc, pageNumber));
      sampled++;
    } catch {}
  }

  return classifyTextDensity(chars, sampled);
}
