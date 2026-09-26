import fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import { clampPageRange } from '../budget';
import { getBookPath } from './storage';

export interface PdfSlice {
  buffer: Buffer;
  pageRange: [number, number];
  sizeKb: number;
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
