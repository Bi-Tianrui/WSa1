import path from 'path';
import { createRequire } from 'module';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

// Text extraction here serves one purpose only: reading a printed contents page while
// building the local index. CJK books need predefined CMaps and standard font data, or
// pdf.js silently drops every Chinese glyph and returns Latin punctuation alone.
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

