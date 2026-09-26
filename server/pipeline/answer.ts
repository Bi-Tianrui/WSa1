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
