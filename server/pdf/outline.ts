import { MAX_SLICE_PAGES } from '../budget';
import { PdfDocument, readPageText } from './document';

export type TocSource = 'bookmarks' | 'text-scan' | 'synthesized';

export interface TocItem {
  title: string;
  startPage: number;
  endPage?: number;
  level?: number;
}

/** How many leading pages the text-scan fallback reads when bookmarks are unusable. */
const TOC_SCAN_PAGES = 30;

const MAX_OUTLINE_ENTRIES = 400;

export function sanitizeTitle(raw: unknown): string {
  return String(raw ?? '')
    // Producer tools frequently leave NUL / control bytes inside bookmark strings.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Resolves a pdf.js outline destination to a 1-based physical page number.
 *
 * A destination is either a named string or an array whose head is a page *Ref object*
 * ({num, gen}) - never a plain page index. Checking `typeof dest[0] === 'number'` there
 * fails for every real textbook and collapses the whole outline onto page 1, so the
 * ref must be resolved through getPageIndex.
 */
async function resolveDestinationPage(
  doc: PdfDocument,
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

/** Tier 1: native PDF bookmarks with properly resolved destination pages. */
async function fromBookmarks(doc: PdfDocument, totalPages: number): Promise<TocItem[]> {
  const outline = await doc.getOutline();
  if (!Array.isArray(outline) || outline.length === 0) return [];

  const cache = new Map<string, number>();
  const items: TocItem[] = [];

  const walk = async (nodes: any[], level: number): Promise<void> => {
    for (const node of nodes) {
      if (items.length >= MAX_OUTLINE_ENTRIES) return;
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

  // An outline that collapses onto a single page means resolution failed; treat it as
  // unusable rather than shipping an index that routes every question to page 1.
  if (items.length < 2 || new Set(items.map((i) => i.startPage)).size < 2) return [];

  return assignEndPages(items, totalPages);
}

const TOC_LINE_PATTERNS: RegExp[] = [
  // 第1章 / 第一章 / 第 3 节 —— 标题 —— 页码 (dot leaders or wide gap)
  /^(第\s*[0-9０-９一二三四五六七八九十百]{1,4}\s*[章节節篇卷部讲講])[\s:：.、·]*(.{0,60}?)[\s.·…—-]{2,}(\d{1,4})$/,
  // 1.2.3 标题 ...... 页码
  /^(\d{1,2}(?:[.．]\d{1,2}){1,2})[\s:：.、]+(.{1,60}?)[\s.·…—-]{2,}(\d{1,4})$/,
  // Chapter 3 / Section II — Title ..... 42
  /^((?:Chapter|Section|Part|Lecture)\s+[0-9IVXLC]{1,5})[\s:.、]*(.{0,60}?)[\s.·…—-]{2,}(\d{1,4})$/i,
  // Looser: a chapter marker line that simply ends in a page number
  /^(第\s*[0-9０-９一二三四五六七八九十百]{1,4}\s*[章节節篇卷部讲講])[\s:：.、·]*(.{0,60}?)\s+(\d{1,4})$/,
];

/**
 * Builds a printed-label to physical-page map so page numbers scraped off a printed
 * contents page land on the right sheet despite front-matter offsets.
 */
async function buildPrintedPageMap(doc: PdfDocument): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  try {
    const labels = await doc.getPageLabels();
    if (!Array.isArray(labels)) return map;
    labels.forEach((label: string, index: number) => {
      const printed = parseInt(String(label).trim(), 10);
      if (!Number.isNaN(printed) && !map.has(printed)) map.set(printed, index + 1);
    });
  } catch {}
  return map;
}

/** Tier 2: scrape the printed contents pages out of the first N pages of body text. */
async function fromPrintedContents(doc: PdfDocument, totalPages: number): Promise<TocItem[]> {
  const scanLimit = Math.min(TOC_SCAN_PAGES, totalPages);
  const lines: string[] = [];

  for (let pageNumber = 1; pageNumber <= scanLimit; pageNumber++) {
    try {
      for (const line of (await readPageText(doc, pageNumber)).split('\n')) {
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

  if (items.length < 3 || new Set(items.map((i) => i.startPage)).size < 3) return [];

  return assignEndPages(items, totalPages);
}

/** Tier 3: even chunking so routing and slicing always have a target range. */
export function synthesizeOutline(totalPages: number): TocItem[] {
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
 * Extracts a chapter outline: native bookmarks, then printed contents pages, then even
 * chunks. Never returns an empty list, so slicing always has somewhere to aim.
 */
export async function extractOutline(
  doc: PdfDocument,
  totalPages: number
): Promise<{ toc: TocItem[]; source: TocSource }> {
  try {
    const bookmarks = await fromBookmarks(doc, totalPages);
    if (bookmarks.length > 0) return { toc: bookmarks, source: 'bookmarks' };
  } catch (err) {
    console.warn('[outline] bookmark pass failed:', err);
  }

  try {
    const printed = await fromPrintedContents(doc, totalPages);
    if (printed.length > 0) return { toc: printed, source: 'text-scan' };
  } catch (err) {
    console.warn('[outline] printed-contents pass failed:', err);
  }

  return { toc: synthesizeOutline(totalPages), source: 'synthesized' };
}
