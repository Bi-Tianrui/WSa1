import { PDFDocument } from 'pdf-lib';
import {
  MAX_HISTORY_TOKENS,
  MAX_INLINE_PDF_KB,
  TOKENS_PER_IMAGE_PAGE,
  TOKENS_PER_PDF_PAGE,
  clampPageRange,
  estimateTokens,
  maxImagePagesWithinBudget,
  maxPdfPagesWithinBudget,
} from '../budget';
import { renderPageRange } from '../pdf/raster';
import { slicePdf } from '../pdf/slice';
import { BookMetadata } from '../pdf/storage';
import { ChatProvider, HistoryTurn, ProviderCredentials, TextbookExcerpt } from '../providers';
import { SseChannel } from '../sse';
import { RoutingDecision } from './route';

/**
 * STAGE 3 - Physical slicing and provider dispatch.
 * STAGE 4 - Streaming delivery.
 *
 * Whatever happens here, the payload is bounded twice: by page count and by token
 * budget. A provider only ever sees one chapter-sized excerpt, always as pages to look
 * at rather than as transcribed prose.
 */

/** Keeps the most recent turns that fit the history budget, oldest dropped first. */
export function normalizeHistory(history: any): HistoryTurn[] {
  if (!Array.isArray(history)) return [];

  const usable: HistoryTurn[] = [];
  for (const item of history) {
    if (!item?.content || typeof item.content !== 'string' || !item.content.trim()) continue;
    if (item.id && String(item.id).startsWith('sys-')) continue;
    if (item.isError) continue;
    usable.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content });
  }

  const kept: HistoryTurn[] = [];
  let tokens = 0;
  for (let i = usable.length - 1; i >= 0; i--) {
    const cost = estimateTokens(usable[i].content);
    if (tokens + cost > MAX_HISTORY_TOKENS) break;
    tokens += cost;
    kept.unshift(usable[i]);
  }
  return kept;
}

/**
 * Turns a routing decision into a provider-appropriate excerpt.
 *
 * Both transports carry the same thing - the pages themselves. Gemini takes the sliced
 * PDF; chat-completions endpoints take those pages rendered at reading resolution.
 */
export async function prepareExcerpt(
  decision: RoutingDecision,
  book: BookMetadata,
  provider: ChatProvider
): Promise<TextbookExcerpt> {
  const [startPage, requestedEnd] = clampPageRange(
    decision.startPage,
    decision.endPage,
    book.pageCount
  );

  const common = { bookName: book.name, chapterTitle: decision.chapterTitle };

  if (provider.excerptFormat === 'pdf') {
    // Token budget governs page span; byte budget then guards image-heavy scans.
    const budgetEnd = Math.min(requestedEnd, startPage + maxPdfPagesWithinBudget() - 1);
    let rangeEnd = Math.max(startPage, budgetEnd);
    let slice = await slicePdf(book.id, startPage, rangeEnd);

    while (slice.sizeKb > MAX_INLINE_PDF_KB && rangeEnd - startPage + 1 > 4) {
      rangeEnd = startPage + Math.floor((rangeEnd - startPage) / 2);
      console.log(`[answer] slice ${slice.sizeKb}KB exceeds cap, narrowing to P${startPage}-P${rangeEnd}`);
      slice = await slicePdf(book.id, startPage, rangeEnd);
    }

    const pages = slice.pageRange[1] - slice.pageRange[0] + 1;
    return {
      ...common,
      pageRange: slice.pageRange,
      pdfBase64: slice.buffer.toString('base64'),
      estimatedTokens: pages * TOKENS_PER_PDF_PAGE,
    };
  }

  // Rendered pages cost several times more than PDF pages, so the span is tighter.
  const imageEnd = Math.max(
    startPage,
    Math.min(requestedEnd, startPage + maxImagePagesWithinBudget() - 1)
  );
  const rendered = await renderPageRange(book.id, startPage, imageEnd);
  const totalKb = rendered.images.reduce((sum, image) => sum + image.sizeKb, 0);
  console.log(
    `[answer] rendered P${rendered.pageRange[0]}-P${rendered.pageRange[1]} as ${rendered.images.length} images (${totalKb}KB)`
  );

  return {
    ...common,
    pageRange: rendered.pageRange,
    images: rendered.images,
    estimatedTokens: rendered.images.length * TOKENS_PER_IMAGE_PAGE,
  };
}

function excerptPageCount(excerpt: TextbookExcerpt): number {
  return excerpt.pageRange[1] - excerpt.pageRange[0] + 1;
}

function wholeFileDecision(book: BookMetadata, endPage: number): RoutingDecision {
  return {
    bookId: book.id,
    bookName: book.name,
    chapterTitle: '全文',
    startPage: 1,
    endPage,
    source: 'keyword',
  };
}

/** Concatenates whole-file and chapter excerpts into one provider payload. */
export async function mergeExcerpts(parts: TextbookExcerpt[]): Promise<TextbookExcerpt | null> {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];

  const names = [...new Set(parts.map((part) => part.bookName))];
  const titles = parts.map((part) => `《${part.bookName}》${part.chapterTitle}`).join(' · ');
  const totalPages = parts.reduce((sum, part) => sum + excerptPageCount(part), 0);
  const estimatedTokens = parts.reduce((sum, part) => sum + part.estimatedTokens, 0);

  if (parts.every((part) => part.pdfBase64)) {
    const out = await PDFDocument.create();
    for (const part of parts) {
      const src = await PDFDocument.load(Buffer.from(part.pdfBase64!, 'base64'), { ignoreEncryption: true });
      const copied = await out.copyPages(src, src.getPageIndices());
      copied.forEach((page) => out.addPage(page));
    }
    const bytes = await out.save();
    return {
      bookName: names.join('、'),
      chapterTitle: titles,
      pageRange: [1, totalPages],
      pdfBase64: Buffer.from(bytes).toString('base64'),
      estimatedTokens,
    };
  }

  return {
    bookName: names.join('、'),
    chapterTitle: titles,
    pageRange: [1, totalPages],
    images: parts.flatMap((part) => part.images || []),
    estimatedTokens,
  };
}

export interface AssembleReadingOptions {
  wholeBooks: BookMetadata[];
  chapterDecision: RoutingDecision | null;
  chapterBook?: BookMetadata;
  provider: ChatProvider;
  onNotice: (level: 'info' | 'warn', message: string) => void;
}

/**
 * Whole-mode files take the remaining page budget first; any leftover goes to the
 * chapter slice. Each file is still clamped by the same 6–10 page channel cap.
 */
export async function assembleReadingPayload(
  options: AssembleReadingOptions
): Promise<TextbookExcerpt | null> {
  const { wholeBooks, chapterDecision, chapterBook, provider, onNotice } = options;
  const maxPages =
    provider.excerptFormat === 'pdf' ? maxPdfPagesWithinBudget() : maxImagePagesWithinBudget();
  const parts: TextbookExcerpt[] = [];
  let used = 0;

  for (const book of wholeBooks) {
    if (used >= maxPages) {
      onNotice('warn', `《${book.name}》未送入：本轮页数已满。`);
      continue;
    }
    const take = Math.min(book.pageCount, maxPages - used);
    const excerpt = await prepareExcerpt(wholeFileDecision(book, take), book, provider);
    const sent = excerptPageCount(excerpt);
    parts.push(excerpt);
    used += sent;
    if (sent < book.pageCount) {
      onNotice(
        'warn',
        `《${book.name}》共 ${book.pageCount} 页，本轮只送入前 ${sent} 页（通道上限）。`
      );
    }
  }

  if (chapterDecision && chapterBook && used < maxPages) {
    const remaining = maxPages - used;
    const span = chapterDecision.endPage - chapterDecision.startPage + 1;
    const clipped: RoutingDecision = {
      ...chapterDecision,
      endPage: chapterDecision.startPage + Math.min(span, remaining) - 1,
    };
    parts.push(await prepareExcerpt(clipped, chapterBook, provider));
  } else if (chapterDecision && chapterBook && used >= maxPages) {
    onNotice('warn', `章节切片未送入：整份文件已占满本轮页数预算。`);
  }

  return mergeExcerpts(parts);
}

export interface AnswerOptions {
  provider: ChatProvider;
  model: string;
  credentials: ProviderCredentials;
  systemInstruction: string;
  prompt: string;
  history: any;
  excerpt: TextbookExcerpt | null;
  channel: SseChannel;
}

/** Streams the answer, forwarding text and reasoning deltas to the SSE channel. */
export async function streamAnswer(options: AnswerOptions): Promise<void> {
  const { provider, model, credentials, systemInstruction, prompt, excerpt, channel } = options;

  await provider.streamAnswer({
    model,
    credentials,
    systemInstruction,
    history: normalizeHistory(options.history),
    prompt,
    excerpt,
    signal: channel.aborter.signal,
    shouldStop: () => channel.isClosed,
    onRetry: (attempt, failure) =>
      channel.stage(`连接模型失败（${failure.message}），正在第 ${attempt} 次自动重试…`),
    onText: (chunk) => channel.send({ text: chunk }),
    onReasoning: (chunk) => channel.send({ reasoning: chunk }),
  });
}
