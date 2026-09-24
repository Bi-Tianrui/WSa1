import fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import { clampPageRange } from '../budget';
import { getBookPath } from './storage';
import {
  TextLayerQuality,
  classifyTextDensity,
  meaningfulCharCount,
  readPageText,
  withPdfDocument,
} from './document';

export interface PdfSlice {
  buffer: Buffer;
  pageRange: [number, number];
  sizeKb: number;
}

export interface PageRangeText {
  text: string;
  pageRange: [number, number];
  charCount: number;
  quality: TextLayerQuality;
}

/**
 * Physically copies a page range out of the stored textbook into a standalone PDF.
 * The range is clamped to MAX_SLICE_PAGES, so a whole book can never be assembled here.
 */
export async function slicePdf(
  bookId: string,
  startPage: number,
  endPage: number
): Promise<PdfSlice> {
  const filePath = getBookPath(bookId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`教材文件未找到: ${bookId}`);
  }

  const srcDoc = await PDFDocument.load(fs.readFileSync(filePath), { ignoreEncryption: true });
  const [safeStart, safeEnd] = clampPageRange(startPage, endPage, srcDoc.getPageCount());

  const subDoc = await PDFDocument.create();
  const pageIndices: number[] = [];
  for (let i = safeStart - 1; i < safeEnd; i++) pageIndices.push(i);

  const copied = await subDoc.copyPages(srcDoc, pageIndices);
  copied.forEach((p) => subDoc.addPage(p));

  const buffer = Buffer.from(await subDoc.save());

  return { buffer, pageRange: [safeStart, safeEnd], sizeKb: Math.round(buffer.length / 1024) };
}

/**
 * Extracts plain text for a page range straight from the stored original.
 *
 * Reading the original rather than a pdf-lib slice preserves the font resources that
 * text extraction depends on, and the reported quality lets callers refuse to forward
 * empty context harvested from a scanned book.
 */
export async function extractPageRangeText(
  bookId: string,
  startPage: number,
  endPage: number
): Promise<PageRangeText> {
  const filePath = getBookPath(bookId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`教材文件未找到: ${bookId}`);
  }

  return withPdfDocument(fs.readFileSync(filePath), async (doc) => {
    const [safeStart, safeEnd] = clampPageRange(startPage, endPage, doc.numPages);

    const sections: string[] = [];
    let chars = 0;
    let pagesRead = 0;

    for (let pageNumber = safeStart; pageNumber <= safeEnd; pageNumber++) {
      let pageText = '';
      try {
        pageText = await readPageText(doc, pageNumber);
      } catch {}
      chars += meaningfulCharCount(pageText);
      pagesRead++;
      if (pageText.trim()) sections.push(`【第 ${pageNumber} 页】\n${pageText.trim()}`);
    }

    return {
      text: sections.join('\n\n'),
      pageRange: [safeStart, safeEnd] as [number, number],
      charCount: chars,
      quality: classifyTextDensity(chars, pagesRead),
    };
  });
}
