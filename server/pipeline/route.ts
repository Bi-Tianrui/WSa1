import { MAX_CATALOG_TOKENS, MAX_SLICE_PAGES, clampPageRange, estimateTokens } from '../budget';
import { TocItem } from '../pdf/outline';
import { BookMetadata } from '../pdf/storage';
import { ChatProvider, ProviderCredentials } from '../providers';
import { SseChannel } from '../sse';

/**
 * STAGE 2 - Chapter routing.
 *
 * Only the outline tree is ever sent to a model here, costing a few hundred tokens.
 * If that call fails or returns junk, deterministic keyword matching takes over so a
 * broken router degrades to a narrower slice rather than to no textbook at all.
 */

export interface RoutingDecision {
  bookId: string;
  bookName: string;
  chapterTitle: string;
  startPage: number;
  endPage: number;
  rationale?: string;
  source: 'model' | 'keyword';
}

/** Widens a thin section entry into a usable reading window, still under the page cap. */
export function expandRange(
  startPage: number,
  endPage: number,
  totalPages: number
): [number, number] {
  const span = endPage - startPage + 1;
  const target = span >= 8 ? endPage : startPage + MAX_SLICE_PAGES - 1;
  return clampPageRange(startPage, Math.min(target, totalPages), totalPages);
}

/**
 * Picks a representative subset of outline entries.
 *
 * Taking the first N would show the router nothing but front matter on books with deep
 * outlines, so the deepest level that still fits is preferred and the remaining slots
 * are filled with an even sample.
 */
export function selectCatalogEntries(toc: TocItem[], limit: number): TocItem[] {
  if (!Array.isArray(toc) || toc.length === 0) return [];
  if (toc.length <= limit) return toc;

  let selected: TocItem[] = [];
  for (const maxLevel of [0, 1, 2, 3]) {
    const candidates = toc.filter((item) => (item.level ?? 0) <= maxLevel);
    if (candidates.length <= limit && candidates.length > selected.length) selected = candidates;
  }

  const remaining = limit - selected.length;
  if (remaining > 0) {
    const chosen = new Set(selected);
    const rest = toc.filter((item) => !chosen.has(item));
    const step = Math.max(1, Math.ceil(rest.length / remaining));
    rest.forEach((item, index) => {
      if (index % step === 0 && selected.length < limit) selected.push(item);
    });
  }

  return selected.sort((a, b) => a.startPage - b.startPage);
}

function renderCatalog(books: BookMetadata[], entriesPerBook: number): string {
  const lines: string[] = [];

  books.forEach((book, index) => {
    lines.push(`【教材 ${index + 1}】《${book.name}》（ID: ${book.id}，共 ${book.pageCount} 页）`);

    for (const item of selectCatalogEntries(book.toc || [], entriesPerBook)) {
      const indent = '  '.repeat(1 + Math.min(2, item.level ?? 0));
      const range =
        item.endPage && item.endPage !== item.startPage
          ? `P${item.startPage}-P${item.endPage}`
          : `P${item.startPage}`;
      lines.push(`${indent}• ${item.title} (${range})`);
    }
  });

  return lines.join('\n');
}

/** Renders the outline tree, shrinking per-book detail until it fits the token budget. */
export function buildCatalog(books: BookMetadata[]): string {
  let entriesPerBook = Math.max(10, Math.floor(60 / Math.max(1, books.length)));
  let catalog = renderCatalog(books, entriesPerBook);

  while (estimateTokens(catalog) > MAX_CATALOG_TOKENS && entriesPerBook > 6) {
    entriesPerBook = Math.floor(entriesPerBook * 0.7);
    catalog = renderCatalog(books, entriesPerBook);
  }

  return catalog;
}

function tokenizeForMatching(text: string): Set<string> {
  const tokens = new Set<string>();
  const cleaned = String(text || '').toLowerCase();

  // CJK has no word delimiters, so compare overlapping bigrams.
  const cjkRun = (cleaned.match(/[\u3400-\u9fff]/g) || []).join('');
  for (let i = 0; i + 1 < cjkRun.length; i++) tokens.add(cjkRun.slice(i, i + 2));

  for (const word of cleaned.match(/[a-z]{3,}/g) || []) tokens.add(word);

  return tokens;
}

/** Deterministic keyword routing used whenever the routing model is unusable. */
export function matchChapterLocally(
  prompt: string,
  books: BookMetadata[]
): RoutingDecision | null {
  const promptTokens = tokenizeForMatching(prompt);
  if (promptTokens.size === 0) return null;

  let best: (RoutingDecision & { score: number }) | null = null;

  for (const book of books) {
    for (const item of book.toc || []) {
      const titleTokens = tokenizeForMatching(item.title);
      if (titleTokens.size === 0) continue;

      let overlap = 0;
      for (const token of titleTokens) if (promptTokens.has(token)) overlap++;
      if (overlap === 0) continue;

      const score = overlap / titleTokens.size;
      if (!best || score > best.score) {
        const [startPage, endPage] = expandRange(
          item.startPage,
          item.endPage ?? item.startPage,
          book.pageCount
        );
        best = {
          bookId: book.id,
          bookName: book.name,
          chapterTitle: item.title,
          startPage,
          endPage,
          rationale: '模型路由不可用，已按目录关键词本地匹配定位。',
          source: 'keyword',
          score,
        };
      }
    }
  }

  if (!best || best.score < 0.34) return null;
  const { score, ...decision } = best;
  return decision;
}

const FAST_MODEL_HINTS = ['flash', 'mini', 'turbo', 'lite', 'small', 'haiku'];
const SLOW_MODEL_HINTS = ['reason', 'thinking', 'r1', 'o1', 'o3', 'pro', 'opus', 'max'];

/**
 * Picks a cheap model for the routing hop.
 *
 * Reusing the answering model would turn a few-hundred-token lookup into a full
 * reasoning pass when the user has selected something like deepseek-reasoner.
 */
export function pickRoutingModel(candidates: string[], answerModel: string): string {
  const usable = (candidates || []).filter(Boolean);
  if (usable.length === 0) return answerModel;

  const fast = usable.find((name) => {
    const lowered = name.toLowerCase();
    return FAST_MODEL_HINTS.some((h) => lowered.includes(h)) && !SLOW_MODEL_HINTS.some((h) => lowered.includes(h));
  });
  if (fast) return fast;

  const answerIsSlow = SLOW_MODEL_HINTS.some((h) => answerModel.toLowerCase().includes(h));
  if (!answerIsSlow) return answerModel;

  const notSlow = usable.find((name) => !SLOW_MODEL_HINTS.some((h) => name.toLowerCase().includes(h)));
  return notSlow || answerModel;
}

/** Strips markdown fences and recovers the outermost JSON object. */
export function parseRoutingJson(raw: string): any | null {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(text);
  } catch {}

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {}
  }
  return null;
}

function buildRoutingPrompt(catalog: string, prompt: string): string {
  return `你是一位高校硬核学术图书管理员。
请根据以下教材微型目录索引，审阅学生的提问，精确定位出：该问题属于哪一本教材的哪一具体章节，以及最核心的研读起止页码范围。

【严格约束】
1. startPage 与 endPage 的跨度必须控制在 ${MAX_SLICE_PAGES} 页以内。
2. 只输出严格合法的 JSON 对象，不要输出任何多余文字：
{
  "matched": true,
  "bookId": "教材的真实ID",
  "bookName": "教材书名",
  "chapterTitle": "具体章节名",
  "startPage": 18,
  "endPage": 35,
  "rationale": "定位该章节的原因简述"
}
若问题与所列教材无关，输出: { "matched": false }

【已挂载教材微型目录树】：
${catalog}

【学生提问】：
${prompt}`;
}

export interface RouteOptions {
  prompt: string;
  books: BookMetadata[];
  provider: ChatProvider;
  routingModel: string;
  credentials: ProviderCredentials;
  channel: SseChannel;
}

/** Runs the model routing hop, falling back to keyword matching on any failure. */
export async function routeQuestion(options: RouteOptions): Promise<RoutingDecision | null> {
  const { prompt, provider, routingModel, credentials, channel } = options;

  // A book with no outline has nothing to route against; it is skipped rather than
  // guessed at, so the model is never pointed to an arbitrary page.
  const books = options.books.filter((book) => (book.toc || []).length > 0);
  if (books.length === 0) return null;

  if (!routingModel || !credentials.apiKey) return matchChapterLocally(prompt, books);

  const catalog = buildCatalog(books);
  console.log(`[route] catalog ≈ ${estimateTokens(catalog)} tokens via ${routingModel}`);

  let raw = '';
  try {
    raw = await provider.requestRouting({
      model: routingModel,
      credentials,
      prompt: buildRoutingPrompt(catalog, prompt),
      signal: channel.aborter.signal,
      onRetry: () => channel.stage('目录定位请求超时，正在自动重试…'),
    });
  } catch (err) {
    console.warn('[route] model routing failed, using keyword fallback:', err);
    return matchChapterLocally(prompt, books);
  }

  const parsed = parseRoutingJson(raw);
  if (!parsed?.matched || !parsed.bookId) return matchChapterLocally(prompt, books);

  const book = books.find((b) => b.id === String(parsed.bookId));
  if (!book) return matchChapterLocally(prompt, books);

  const [startPage, endPage] = expandRange(
    Number(parsed.startPage) || 1,
    Number(parsed.endPage) || Number(parsed.startPage) || 1,
    book.pageCount
  );

  return {
    bookId: book.id,
    bookName: book.name,
    chapterTitle: String(parsed.chapterTitle || '核心章节'),
    startPage,
    endPage,
    rationale: parsed.rationale ? String(parsed.rationale) : undefined,
    source: 'model',
  };
}
