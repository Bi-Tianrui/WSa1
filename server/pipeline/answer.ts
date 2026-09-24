import {
  MAX_CONTEXT_TOKENS,
  MAX_HISTORY_TOKENS,
  MAX_INLINE_PDF_KB,
  TOKENS_PER_PDF_PAGE,
  clampPageRange,
  estimateTokens,
  maxPdfPagesWithinBudget,
  truncateToTokenBudget,
} from '../budget';
import { extractPageRangeText, slicePdf } from '../pdf/slice';
import { BookMetadata } from '../pdf/storage';
import { ChatProvider, HistoryTurn, ProviderCredentials, TextbookExcerpt } from '../providers';
import { SseChannel } from '../sse';
import { RoutingDecision } from './route';

/**
 * STAGE 3 - Physical slicing and provider dispatch.
 * STAGE 4 - Streaming delivery.
 *
 * Whatever happens here, the payload is bounded twice: by page count and by token
 * budget. A provider only ever sees one chapter-sized excerpt.
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
 * Multimodal providers get the physically sliced PDF; text-only providers get prose
 * extracted from those same pages. Returns null when there is nothing usable to send,
 * which is preferable to shipping empty context harvested from a scan.
 */
export async function prepareExcerpt(
  decision: RoutingDecision,
  book: BookMetadata,
  provider: ChatProvider,
  channel: SseChannel
): Promise<TextbookExcerpt | null> {
  const [startPage, requestedEnd] = clampPageRange(
    decision.startPage,
    decision.endPage,
    book.pageCount
  );

  if (provider.acceptsPdf) {
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
      bookName: book.name,
      chapterTitle: decision.chapterTitle,
      pageRange: slice.pageRange,
      pdfBase64: slice.buffer.toString('base64'),
      estimatedTokens: pages * TOKENS_PER_PDF_PAGE,
    };
  }

  const extracted = await extractPageRangeText(book.id, startPage, requestedEnd);

  if (extracted.quality === 'none') {
    channel.notice(
      'warn',
      `《${book.name}》第 ${startPage}-${requestedEnd} 页为扫描图片，没有可提取的文字层。` +
        '当前纯文本模型（OpenAI / DeepSeek）无法识别图片内容，本轮将以通识推导作答。' +
        '如需精读该教材原文，请在左侧切换到 Google Gemini（多模态可直读扫描页）。'
    );
    return null;
  }

  if (extracted.quality === 'sparse') {
    channel.notice(
      'info',
      `《${book.name}》第 ${startPage}-${requestedEnd} 页文字层较稀疏，提取到的原文有限，回答可能存在缺漏。`
    );
  }

  const bounded = truncateToTokenBudget(extracted.text, MAX_CONTEXT_TOKENS);
  if (bounded.length < extracted.text.length) {
    console.log(`[answer] slice text truncated to ${MAX_CONTEXT_TOKENS} tokens`);
  }

  return {
    bookName: book.name,
    chapterTitle: decision.chapterTitle,
    pageRange: extracted.pageRange,
    text: bounded,
    estimatedTokens: estimateTokens(bounded),
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
