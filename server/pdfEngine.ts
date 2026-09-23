import fs from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';

export interface TocItem {
  title: string;
  startPage: number;
  endPage?: number;
}

export interface BookMetadata {
  id: string;
  name: string;
  sizeMb: number;
  pageCount: number;
  toc: TocItem[];
  uploadTime: string;
}

const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'books');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export function getBookPath(bookId: string): string {
  return path.join(UPLOADS_DIR, `${bookId}.pdf`);
}

export function getBookTocPath(bookId: string): string {
  return path.join(UPLOADS_DIR, `${bookId}_toc.json`);
}

/**
 * Robustly inspects a PDF file on disk with multiple fallbacks to extract
 * page count, metadata, and outline even if the PDF is partially encrypted or has xref errors.
 */
export async function resolvePdfMetadata(
  filePath: string,
  safeName: string,
  fileSize: number,
  bookId: string
): Promise<BookMetadata> {
  const rawBuffer = fs.readFileSync(filePath);
  let pageCount = 0;

  // Attempt 1: pdf-lib (Fastest and handles most standard PDFs)
  try {
    const pdfDoc = await PDFDocument.load(rawBuffer, { ignoreEncryption: true });
    pageCount = pdfDoc.getPageCount();
  } catch (pdfLibErr) {
    console.warn('[resolvePdfMetadata] pdf-lib pageCount check failed, trying pdf-parse fallback:', pdfLibErr);
  }

  // Attempt 2: pdf-parse fallback
  if (!pageCount || pageCount <= 0) {
    let parser: PDFParse | null = null;
    try {
      parser = new PDFParse({ data: rawBuffer });
      const info = await parser.getInfo();
      if (info && typeof info.total === 'number' && info.total > 0) {
        pageCount = info.total;
      }
    } catch (parseErr) {
      console.warn('[resolvePdfMetadata] pdf-parse fallback failed:', parseErr);
    } finally {
      if (parser) {
        try { await parser.destroy(); } catch {}
      }
    }
  }

  // Attempt 3: Regex scan xref / page count markers in raw buffer
  if (!pageCount || pageCount <= 0) {
    try {
      const bufferString = rawBuffer.slice(0, Math.min(rawBuffer.length, 10 * 1024 * 1024)).toString('latin1');
      const countMatch = bufferString.match(/\/Count\s+(\d+)/);
      if (countMatch && countMatch[1]) {
        pageCount = parseInt(countMatch[1], 10);
      } else {
        const pageMatches = bufferString.match(/\/Type\s*\/Page\b/g);
        if (pageMatches && pageMatches.length > 0) {
          pageCount = pageMatches.length;
        }
      }
    } catch {}
  }

  // Safe fallback if page count could not be deduced
  if (!pageCount || pageCount <= 0) {
    pageCount = Math.max(1, Math.round(fileSize / (120 * 1024)));
  }

  const sizeMb = parseFloat((fileSize / (1024 * 1024)).toFixed(2)) || 0.1;

  // Extract outline with fallbacks
  let toc: TocItem[] = [];
  try {
    toc = await extractBookOutline(rawBuffer, pageCount);
  } catch (tocErr) {
    console.warn('[resolvePdfMetadata] extractBookOutline error, synthesizing chunks:', tocErr);
  }

  if (!toc || toc.length === 0) {
    const chunkSize = Math.max(20, Math.min(35, Math.ceil(pageCount / 12)));
    let curr = 1;
    let chNum = 1;
    while (curr <= pageCount) {
      const end = Math.min(pageCount, curr + chunkSize - 1);
      toc.push({
        title: `第 ${chNum} 讲/单元 (P${curr} - P${end})`,
        startPage: curr,
        endPage: end,
      });
      curr = end + 1;
      chNum++;
    }
  }

  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');

  return {
    id: bookId,
    name: safeName,
    sizeMb,
    pageCount,
    toc,
    uploadTime: `${hours}:${minutes}`,
  };
}

/**
 * Extract outline (bookmarks) or fallback from first 15 pages using PDFParse
 */
export async function extractBookOutline(pdfBuffer: Buffer, totalPages: number): Promise<TocItem[]> {
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: pdfBuffer });
    const info = await parser.getInfo();

    const toc: TocItem[] = [];

    // Helper to traverse outline nodes
    const traverseOutline = (nodes: any[]) => {
      if (!Array.isArray(nodes)) return;
      for (const node of nodes) {
        if (node && node.title) {
          let pageNum = 1;
          if (typeof node.dest === 'number') {
            pageNum = node.dest;
          } else if (Array.isArray(node.dest) && typeof node.dest[0] === 'number') {
            pageNum = node.dest[0];
          } else if (typeof node.pageNumber === 'number') {
            pageNum = node.pageNumber;
          }

          const cleanTitle = String(node.title).trim();
          if (cleanTitle) {
            toc.push({
              title: cleanTitle,
              startPage: Math.max(1, Math.min(pageNum, totalPages)),
            });
          }
        }
        if (node.items && Array.isArray(node.items) && toc.length < 100) {
          traverseOutline(node.items);
        }
      }
    };

    if (info.outline && info.outline.length > 0) {
      traverseOutline(info.outline);
    }

    if (toc.length >= 2) {
      // Calculate end pages
      for (let i = 0; i < toc.length; i++) {
        if (i < toc.length - 1) {
          toc[i].endPage = Math.max(toc[i].startPage, toc[i + 1].startPage - 1);
        } else {
          toc[i].endPage = totalPages;
        }
      }
      return toc;
    }

    // If native bookmarks didn't yield enough, parse text from first 15 pages
    const textRes = await parser.getText({ first: 1, last: Math.min(15, totalPages) });
    const fullText = textRes.text || '';
    const lines = fullText.split('\n').map((l: string) => l.trim()).filter(Boolean);

    const chapterRegex = /(?:第[0-9一二三四五六七八九十百]+[章篇卷部分]|Chapter\s+\d+|Section\s+\d+|§\s*\d+)[\s:：]+([^\d\n]+?)(?:\.{2,}|…+|\s+)+(\d{1,4})/i;
    const fallbackRegex = /^([0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?|[0-9]{1,2})\s+([^\d\n]{2,30}?)(?:\.{2,}|…+|\s+)+(\d{1,4})$/;

    const parsedItems: TocItem[] = [];
    for (const line of lines) {
      let match = line.match(chapterRegex);
      if (!match) match = line.match(fallbackRegex);
      if (match) {
        const title = match[1].trim();
        const page = parseInt(match[2] || match[3] || '1', 10);
        if (title && !isNaN(page) && page > 0 && page <= totalPages) {
          parsedItems.push({
            title: title.slice(0, 50),
            startPage: page,
          });
        }
      }
    }

    // Deduplicate
    const cleanItems: TocItem[] = [];
    const seen = new Set<string>();
    for (const item of parsedItems) {
      if (!seen.has(item.title) && cleanItems.length < 50) {
        seen.add(item.title);
        cleanItems.push(item);
      }
    }

    if (cleanItems.length >= 2) {
      cleanItems.sort((a, b) => a.startPage - b.startPage);
      for (let i = 0; i < cleanItems.length; i++) {
        if (i < cleanItems.length - 1) {
          cleanItems[i].endPage = Math.max(cleanItems[i].startPage, cleanItems[i + 1].startPage - 1);
        } else {
          cleanItems[i].endPage = totalPages;
        }
      }
      return cleanItems;
    }
  } catch (err) {
    console.warn('extractBookOutline warning:', err);
  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch {}
    }
  }

  // Final synthesized outline in 20-30 page chunks
  const synthesized: TocItem[] = [];
  const chunkSize = Math.max(20, Math.min(35, Math.ceil(totalPages / 12)));
  let curr = 1;
  let chNum = 1;
  while (curr <= totalPages) {
    const end = Math.min(totalPages, curr + chunkSize - 1);
    synthesized.push({
      title: `第 ${chNum} 讲/单元 (P${curr} - P${end})`,
      startPage: curr,
      endPage: end,
    });
    curr = end + 1;
    chNum++;
  }
  return synthesized;
}

/**
 * Surgically slices a target page range [startPage, endPage] from the original PDF file
 * Produces a lightweight ~200-800KB buffer (15-30 pages)
 */
export async function slicePdf(
  bookId: string,
  startPage: number,
  endPage: number
): Promise<{ buffer: Buffer; pageRange: [number, number]; sizeKb: number }> {
  const filePath = getBookPath(bookId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`教材文件未找到: ${bookId}`);
  }

  const rawBuffer = fs.readFileSync(filePath);
  const srcDoc = await PDFDocument.load(rawBuffer, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();

  const safeStart = Math.max(1, Math.min(startPage, totalPages));
  // Limit surgical slice to max 30 pages
  const maxEnd = Math.min(totalPages, safeStart + 29);
  const safeEnd = Math.max(safeStart, Math.min(endPage, maxEnd));

  const subDoc = await PDFDocument.create();
  const pageIndices: number[] = [];
  for (let i = safeStart - 1; i < safeEnd; i++) {
    pageIndices.push(i);
  }

  const copiedPages = await subDoc.copyPages(srcDoc, pageIndices);
  copiedPages.forEach((p) => subDoc.addPage(p));

  const sliceBytes = await subDoc.save();
  const sliceBuffer = Buffer.from(sliceBytes);

  return {
    buffer: sliceBuffer,
    pageRange: [safeStart, safeEnd],
    sizeKb: Math.round(sliceBuffer.length / 1024),
  };
}
