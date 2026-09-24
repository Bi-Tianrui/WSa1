import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Hard ceiling on the physical pages that may ever reach the LLM in a single turn. */
export const MAX_SLICE_PAGES = 30;

/** Hard ceiling on textbook context tokens injected into a single request. */
export const MAX_CONTEXT_TOKENS = 30_000;

/** How many leading pages the text-scan fallback reads when bookmarks are unusable. */
const TOC_SCAN_PAGES = 30;

export type TextLayerQuality = 'rich' | 'sparse' | 'none';
export type TocSource = 'bookmarks' | 'text-scan' | 'synthesized';

export interface TocItem {
  title: string;
  startPage: number;
  endPage?: number;
  level?: number;
}

export interface BookMetadata {
  id: string;
  name: string;
  sizeMb: number;
  pageCount: number;
  toc: TocItem[];
  uploadTime: string;
  tocSource: TocSource;
  textLayer: TextLayerQuality;
}

export interface PageRangeText {
  text: string;
  pageRange: [number, number];
  charCount: number;
  quality: TextLayerQuality;
}

const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'books');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// CJK textbooks rely on predefined CMaps and standard font data. Without these two
// paths pdf.js silently drops every Chinese glyph and returns Latin punctuation only.
const requireFromHere = createRequire(import.meta.url);
const PDFJS_ROOT = path.dirname(requireFromHere.resolve('pdfjs-dist/package.json'));
const CMAP_URL = path.join(PDFJS_ROOT, 'cmaps') + path.sep;
const STANDARD_FONT_URL = path.join(PDFJS_ROOT, 'standard_fonts') + path.sep;

export function getBookPath(bookId: string): string {
  return path.join(UPLOADS_DIR, `${bookId}.pdf`);
}

export function getBookTocPath(bookId: string): string {
  return path.join(UPLOADS_DIR, `${bookId}_toc.json`);
}

/** Opens a document with CJK-safe options and always releases the worker afterwards. */
async function withPdfDocument<T>(data: Buffer, fn: (doc: any) => Promise<T>): Promise<T> {
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

function sanitizeTitle(raw: unknown): string {
  return String(raw ?? '')
    // Producer tools frequently leave NUL / control bytes inside bookmark strings.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Rough token estimate tuned for mixed Chinese/LaTeX textbook prose.
 * CJK codepoints cost close to one token each, Latin runs roughly four chars per token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** Cuts text down until it provably fits the token budget. */
export function truncateToTokenBudget(text: string, budgetTokens: number): string {
  if (!text) return '';
  let out = text;
  // Proportional cut first, then shrink until the estimate really fits.
  while (estimateTokens(out) > budgetTokens && out.length > 0) {
    const ratio = budgetTokens / estimateTokens(out);
    const nextLen = Math.max(1, Math.floor(out.length * ratio * 0.95));
    if (nextLen >= out.length) {
      out = out.slice(0, out.length - 1);
    } else {
      out = out.slice(0, nextLen);
    }
  }
  return out;
}

/** Counts characters that actually carry meaning, ignoring pdf.js page separators. */
function meaningfulCharCount(text: string): number {
  return text.replace(/\s+/g, '').length;
}

function classifyTextDensity(totalChars: number, pagesSampled: number): TextLayerQuality {
  if (pagesSampled <= 0) return 'none';
  const perPage = totalChars / pagesSampled;
  if (perPage < 50) return 'none';
  if (perPage < 200) return 'sparse';
  return 'rich';
}

async function readPageText(doc: any, pageNumber: number): Promise<string> {
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

/**
 * Samples pages spread across the document to decide whether a usable text layer exists.
 * Scanned textbooks return only a watermark or nothing at all, which text-only models
 * cannot work with.
 */
async function probeTextLayer(doc: any, totalPages: number): Promise<TextLayerQuality> {
  const samples: number[] = [];
  const wanted = Math.min(8, totalPages);
  for (let i = 0; i < wanted; i++) {
    // Skip front matter, which is often the only vector-text part of a scanned book.
    const ratio = (i + 1) / (wanted + 1);
    samples.push(Math.max(1, Math.min(totalPages, Math.round(totalPages * ratio))));
  }

  let chars = 0;
  let sampled = 0;
  for (const pageNumber of Array.from(new Set(samples))) {
    try {
      chars += meaningfulCharCount(await readPageText(doc, pageNumber));
      sampled++;
    } catch {}
  }

  return classifyTextDensity(chars, sampled);
}

/**
 * Resolves a pdf.js outline destination to a 1-based physical page number.
 * Destinations are either a named string or an array whose head is a page Ref object,
 * never a plain page index, which is why naive `typeof dest[0] === 'number'` checks
 * collapse every bookmark onto page 1.
 */
async function resolveDestinationPage(
  doc: any,
  dest: unknown,
  cache: Map<string, number>
): Promise<number | null> {
  let resolved: any = dest;
  if (typeof resolved === 'string') {
    resolved = await doc.getDestination(resolved);
  }
  if (!Array.isArray(resolved) || resolved.length === 0) return null;

  const target = resolved[0];
  if (typeof target === 'number') return target + 1;
  if (!target || typeof target.num !== 'number') return null;

  const key = `${target.num}_${target.gen}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const pageNumber = (await doc.getPageIndex(target)) + 1;
  cache.set(key, pageNumber);
  return pageNumber;
}

/** Assigns each entry an end page from the next entry that starts on a later page. */
function assignEndPages(items: TocItem[], totalPages: number): TocItem[] {
  const sorted = [...items].sort((a, b) => a.startPage - b.startPage);
  for (let i = 0; i < sorted.length; i++) {
    let end = totalPages;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startPage > sorted[i].startPage) {
        end = sorted[j].startPage - 1;
        break;
      }
    }
    sorted[i].endPage = Math.max(sorted[i].startPage, Math.min(end, totalPages));
  }
  return sorted;
}

/** Strategy 1: native PDF bookmarks with properly resolved destination pages. */
async function extractOutlineFromBookmarks(doc: any, totalPages: number): Promise<TocItem[]> {
  const outline = await doc.getOutline();
  if (!Array.isArray(outline) || outline.length === 0) return [];

  const cache = new Map<string, number>();
  const items: TocItem[] = [];

  const walk = async (nodes: any[], level: number): Promise<void> => {
    for (const node of nodes) {
      if (items.length >= 400) return;
      const title = sanitizeTitle(node?.title);
      if (title) {
        let page: number | null = null;
        try {
          page = await resolveDestinationPage(doc, node?.dest, cache);
        } catch {}
        if (page !== null && page >= 1 && page <= totalPages) {
          items.push({ title, startPage: page, level });
        }
      }
      if (Array.isArray(node?.items) && node.items.length > 0) {
        await walk(node.items, level + 1);
      }
    }
  };

  await walk(outline, 0);

  // A bookmark tree that collapses onto a single page means destination resolution
  // failed; treat it as unusable rather than shipping a useless index.
  const distinctPages = new Set(items.map((i) => i.startPage));
  if (items.length < 2 || distinctPages.size < 2) return [];

  return assignEndPages(items, totalPages);
}

const TOC_LINE_PATTERNS: RegExp[] = [
  // 第1章 / 第一章 / 第 3 节 —— 标题 —— 页码 (dot leaders or wide gap)
  /^(第\s*[0-9０-９一二三四五六七八九十百]{1,4}\s*[章节節篇卷部讲講])[\s:：.、·]*(.{0,60}?)[\s.·…—-]{2,}(\d{1,4})$/,
  // 1.2.3 标题 ...... 页码
  /^(\d{1,2}(?:[.．]\d{1,2}){1,2})[\s:：.、]+(.{1,60}?)[\s.·…—-]{2,}(\d{1,4})$/,
  // Chapter 3 / Section II — Title ..... 42
  /^((?:Chapter|Section|Part|Lecture)\s+[0-9IVXLC]{1,5})[\s:.、]*(.{0,60}?)[\s.·…—-]{2,}(\d{1,4})$/i,
  // Looser: chapter marker line that simply ends in a page number
  /^(第\s*[0-9０-９一二三四五六七八九十百]{1,4}\s*[章节節篇卷部讲講])[\s:：.、·]*(.{0,60}?)\s+(\d{1,4})$/,
];

/**
 * Builds a printed-label to physical-page map so page numbers scraped off a printed
 * contents page land on the right physical sheet despite front matter offsets.
 */
async function buildPrintedPageMap(doc: any): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  try {
    const labels = await doc.getPageLabels();
    if (!Array.isArray(labels)) return map;
    labels.forEach((label: string, index: number) => {
      const printed = parseInt(String(label).trim(), 10);
      if (!Number.isNaN(printed) && !map.has(printed)) {
        map.set(printed, index + 1);
      }
    });
  } catch {}
  return map;
}

/** Strategy 2: scrape the printed contents pages from the first N pages of body text. */
async function extractOutlineFromText(doc: any, totalPages: number): Promise<TocItem[]> {
  const scanLimit = Math.min(TOC_SCAN_PAGES, totalPages);
  const lines: string[] = [];

  for (let pageNumber = 1; pageNumber <= scanLimit; pageNumber++) {
    try {
      const pageText = await readPageText(doc, pageNumber);
      for (const line of pageText.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) lines.push(trimmed);
      }
    } catch {}
  }

  if (lines.length === 0) return [];

  const printedMap = await buildPrintedPageMap(doc);
  const items: TocItem[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    for (const pattern of TOC_LINE_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;

      const marker = sanitizeTitle(match[1]);
      const label = sanitizeTitle(match[2]);
      const printedPage = parseInt(match[3], 10);
      if (!printedPage || Number.isNaN(printedPage)) break;

      const physical = printedMap.get(printedPage) ?? printedPage;
      if (physical < 1 || physical > totalPages) break;

      const title = [marker, label].filter(Boolean).join(' ').trim();
      if (!title || seen.has(title)) break;

      seen.add(title);
      items.push({ title, startPage: physical, level: /^\d/.test(marker) ? 1 : 0 });
      break;
    }
    if (items.length >= 200) break;
  }

  const distinctPages = new Set(items.map((i) => i.startPage));
  if (items.length < 3 || distinctPages.size < 3) return [];

  return assignEndPages(items, totalPages);
}

/** Strategy 3: last-resort even chunking so routing and slicing always have targets. */
function synthesizeOutline(totalPages: number): TocItem[] {
  const items: TocItem[] = [];
  const chunkSize = Math.max(20, Math.min(MAX_SLICE_PAGES, Math.ceil(totalPages / 12)));
  let current = 1;
  let index = 1;

  while (current <= totalPages) {
    const end = Math.min(totalPages, current + chunkSize - 1);
    items.push({
      title: `第 ${index} 部分 (P${current} - P${end})`,
      startPage: current,
      endPage: end,
      level: 0,
    });
    current = end + 1;
    index++;
  }

  return items;
}

/**
 * Extracts a chapter outline using bookmarks, then printed contents pages, then even
 * chunks. Never returns an empty list, so the slicing stage always has a target range.
 */
export async function extractBookOutline(
  pdfBuffer: Buffer,
  totalPages: number
): Promise<{ toc: TocItem[]; source: TocSource; textLayer: TextLayerQuality }> {
  try {
    return await withPdfDocument(pdfBuffer, async (doc) => {
      const pageCount = doc.numPages || totalPages;
      const textLayer = await probeTextLayer(doc, pageCount);

      try {
        const fromBookmarks = await extractOutlineFromBookmarks(doc, pageCount);
        if (fromBookmarks.length > 0) {
          return { toc: fromBookmarks, source: 'bookmarks' as TocSource, textLayer };
        }
      } catch (err) {
        console.warn('[extractBookOutline] bookmark pass failed:', err);
      }

      try {
        const fromText = await extractOutlineFromText(doc, pageCount);
        if (fromText.length > 0) {
          return { toc: fromText, source: 'text-scan' as TocSource, textLayer };
        }
      } catch (err) {
        console.warn('[extractBookOutline] text-scan pass failed:', err);
      }

      return { toc: synthesizeOutline(pageCount), source: 'synthesized' as TocSource, textLayer };
    });
  } catch (err) {
    console.warn('[extractBookOutline] document could not be opened:', err);
    return { toc: synthesizeOutline(totalPages), source: 'synthesized', textLayer: 'none' };
  }
}

/** Determines the page count with layered fallbacks for damaged or encrypted files. */
async function resolvePageCount(rawBuffer: Buffer, fileSize: number): Promise<number> {
  try {
    const pdfDoc = await PDFDocument.load(rawBuffer, { ignoreEncryption: true });
    const count = pdfDoc.getPageCount();
    if (count > 0) return count;
  } catch (err) {
    console.warn('[resolvePageCount] pdf-lib failed, trying pdf.js:', err);
  }

  try {
    const count = await withPdfDocument(rawBuffer, async (doc) => doc.numPages);
    if (count > 0) return count;
  } catch (err) {
    console.warn('[resolvePageCount] pdf.js failed, trying raw scan:', err);
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

/**
 * Inspects an uploaded PDF and produces the lightweight index used for routing:
 * page count, chapter outline, and whether a text-only model can read this book.
 */
export async function resolvePdfMetadata(
  filePath: string,
  safeName: string,
  fileSize: number,
  bookId: string
): Promise<BookMetadata> {
  const rawBuffer = fs.readFileSync(filePath);
  const pageCount = await resolvePageCount(rawBuffer, fileSize);
  const { toc, source, textLayer } = await extractBookOutline(rawBuffer, pageCount);

  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');

  return {
    id: bookId,
    name: safeName,
    sizeMb: parseFloat((fileSize / (1024 * 1024)).toFixed(2)) || 0.1,
    pageCount,
    toc,
    uploadTime: `${hours}:${minutes}`,
    tocSource: source,
    textLayer,
  };
}

/** Clamps a requested range to the document and to MAX_SLICE_PAGES. */
export function clampPageRange(
  startPage: number,
  endPage: number,
  totalPages: number
): [number, number] {
  const safeTotal = Math.max(1, totalPages);
  const safeStart = Math.max(1, Math.min(Math.floor(startPage) || 1, safeTotal));
  const hardEnd = Math.min(safeTotal, safeStart + MAX_SLICE_PAGES - 1);
  const safeEnd = Math.max(safeStart, Math.min(Math.floor(endPage) || safeStart, hardEnd));
  return [safeStart, safeEnd];
}

/**
 * Surgically copies a page range out of the stored textbook.
 * The range is clamped to MAX_SLICE_PAGES so a whole book can never be assembled here.
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

  const srcDoc = await PDFDocument.load(fs.readFileSync(filePath), { ignoreEncryption: true });
  const [safeStart, safeEnd] = clampPageRange(startPage, endPage, srcDoc.getPageCount());

  const subDoc = await PDFDocument.create();
  const pageIndices: number[] = [];
  for (let i = safeStart - 1; i < safeEnd; i++) {
    pageIndices.push(i);
  }

  const copiedPages = await subDoc.copyPages(srcDoc, pageIndices);
  copiedPages.forEach((p) => subDoc.addPage(p));

  const sliceBuffer = Buffer.from(await subDoc.save());

  return {
    buffer: sliceBuffer,
    pageRange: [safeStart, safeEnd],
    sizeKb: Math.round(sliceBuffer.length / 1024),
  };
}

/**
 * Extracts plain text for a page range straight from the stored original.
 * Reading the original rather than a pdf-lib slice preserves the font resources that
 * text extraction depends on, and the reported quality lets callers refuse to send
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

  const rawBuffer = fs.readFileSync(filePath);

  return withPdfDocument(rawBuffer, async (doc) => {
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
      if (pageText.trim()) {
        sections.push(`【第 ${pageNumber} 页】\n${pageText.trim()}`);
      }
    }

    const text = sections.join('\n\n');

    return {
      text,
      pageRange: [safeStart, safeEnd] as [number, number],
      charCount: chars,
      quality: classifyTextDensity(chars, pagesRead),
    };
  });
}
