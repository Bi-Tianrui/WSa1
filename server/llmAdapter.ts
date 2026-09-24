import type { Response } from 'express';
import { BookMetadata, MAX_SLICE_PAGES, TocItem, clampPageRange } from './pdfEngine';

export type ProviderId = 'gemini' | 'openai_compatible';

/** Only Gemini can ingest a raw PDF stream; every other provider needs extracted text. */
export function supportsNativePdf(provider: ProviderId): boolean {
  return provider === 'gemini';
}

// ==========================================
// SSE TRANSPORT WITH HEARTBEAT
// ==========================================

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Wraps an SSE response with a keep-alive heartbeat and write-after-close guards.
 * Long provider "thinking" pauses otherwise leave the socket idle long enough for
 * proxies to drop it, which surfaces in the UI as a cursor that never resolves.
 */
export class SseChannel {
  private readonly res: Response;
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;
  readonly aborter = new AbortController();

  constructor(res: Response) {
    this.res = res;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      try {
        // SSE comment frame: keeps the socket warm without reaching the client parser.
        this.res.write(': keep-alive\n\n');
      } catch {}
    }, HEARTBEAT_INTERVAL_MS);

    res.on('close', () => {
      // Client navigated away or hit stop; cancel any in-flight upstream request.
      this.closed = true;
      this.stopHeartbeat();
      this.aborter.abort();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  send(payload: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {}
  }

  /** Emits a short progress line so the UI can show what the backend is doing. */
  stage(message: string): void {
    this.send({ stage: message });
  }

  notice(level: 'info' | 'warn', message: string): void {
    this.send({ notice: { level, message } });
  }

  fail(error: LlmFailure): void {
    this.send({ error: error.message, errorCode: error.code, hint: error.hint });
    this.end();
  }

  end(payload?: Record<string, unknown>): void {
    if (this.closed) return;
    if (payload) this.send(payload);
    this.stopHeartbeat();
    this.closed = true;
    try {
      this.res.end();
    } catch {}
  }
}

// ==========================================
// ERROR CLASSIFICATION
// ==========================================

export type LlmErrorCode =
  | 'timeout'
  | 'network'
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'context_overflow'
  | 'upstream'
  | 'bad_request'
  | 'unknown';

export interface LlmFailure {
  code: LlmErrorCode;
  message: string;
  hint?: string;
}

const HTTP_FAILURES: Record<number, LlmFailure> = {
  400: {
    code: 'bad_request',
    message: '模型服务判定请求格式不合法（HTTP 400）。',
    hint: '常见原因是所选模型不支持当前参数，请在左侧切换其他模型后重试。',
  },
  401: {
    code: 'auth',
    message: 'API Key 未通过校验（HTTP 401）。',
    hint: '请在左侧配置面板确认 API Key 是否填写完整、是否已过期。',
  },
  403: {
    code: 'auth',
    message: 'API Key 无权访问该模型或该地区受限（HTTP 403）。',
    hint: '请确认密钥已开通对应模型权限，或更换可用的 Base URL。',
  },
  404: {
    code: 'not_found',
    message: '模型名称或 Base URL 不存在（HTTP 404）。',
    hint: '请点击左侧「刷新探测」重新拉取可用模型列表。',
  },
  429: {
    code: 'rate_limit',
    message: '请求过于频繁或余额/配额已耗尽（HTTP 429）。',
    hint: '请稍候片刻再试，或检查账户配额与账单状态。',
  },
  500: { code: 'upstream', message: '模型服务内部错误（HTTP 500）。', hint: '这是服务商侧的临时故障，请稍后重试。' },
  502: { code: 'upstream', message: '模型服务网关异常（HTTP 502）。', hint: '这是服务商侧的临时故障，请稍后重试。' },
  503: { code: 'upstream', message: '模型服务暂不可用（HTTP 503）。', hint: '服务商可能正在限流或维护，请稍后重试。' },
  504: { code: 'upstream', message: '模型服务网关超时（HTTP 504）。', hint: '长篇推导容易触发网关超时，请重试或改用更快的模型。' },
};

const CONTEXT_OVERFLOW_HINTS = [
  'context length',
  'context_length',
  'maximum context',
  'too many tokens',
  'token limit',
  'request too large',
  'exceeds the maximum',
  'input is too long',
];

/** Maps an HTTP status plus provider error body onto a Chinese-facing failure. */
export function classifyHttpFailure(status: number, body: string): LlmFailure {
  const lowered = (body || '').toLowerCase();

  if (CONTEXT_OVERFLOW_HINTS.some((needle) => lowered.includes(needle))) {
    return {
      code: 'context_overflow',
      message: '本轮上下文超出该模型的最大长度限制。',
      hint: '请缩小提问范围、开启新对话，或改用上下文窗口更大的模型。',
    };
  }

  const mapped = HTTP_FAILURES[status];
  if (mapped) {
    const detail = extractProviderMessage(body);
    return detail ? { ...mapped, message: `${mapped.message} 服务商提示：${detail}` } : mapped;
  }

  return {
    code: 'upstream',
    message: `模型服务返回异常状态码 HTTP ${status}。`,
    hint: extractProviderMessage(body) || '请稍后重试或更换模型。',
  };
}

function extractProviderMessage(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message || parsed?.message || parsed?.error;
    if (typeof msg === 'string') return msg.slice(0, 200);
  } catch {}
  return body.slice(0, 200).replace(/\s+/g, ' ').trim();
}

/** Maps a thrown exception (network layer, SDK, abort) onto a Chinese-facing failure. */
export function classifyThrownFailure(err: any): LlmFailure {
  const name = String(err?.name || '');
  const raw = String(err?.message || err || '');
  const lowered = raw.toLowerCase();

  if (name === 'AbortError' || lowered.includes('aborted') || lowered.includes('timeout')) {
    return {
      code: 'timeout',
      message: '等待模型响应超时，连接已被主动中断。',
      hint: '模型前置思考时间过长或网络不稳定，请重试，或改用响应更快的模型。',
    };
  }

  if (CONTEXT_OVERFLOW_HINTS.some((needle) => lowered.includes(needle))) {
    return {
      code: 'context_overflow',
      message: '本轮上下文超出该模型的最大长度限制。',
      hint: '请缩小提问范围、开启新对话，或改用上下文窗口更大的模型。',
    };
  }

  const status = Number(err?.status || err?.code);
  if (!Number.isNaN(status) && HTTP_FAILURES[status]) {
    return HTTP_FAILURES[status];
  }

  if (
    lowered.includes('fetch failed') ||
    lowered.includes('econnreset') ||
    lowered.includes('econnrefused') ||
    lowered.includes('enotfound') ||
    lowered.includes('etimedout') ||
    lowered.includes('socket hang up') ||
    lowered.includes('network')
  ) {
    return {
      code: 'network',
      message: '无法连接到模型服务，网络链路中断。',
      hint: '请检查本机网络、代理设置，以及 Base URL 是否可达。',
    };
  }

  if (lowered.includes('api key') || lowered.includes('unauthenticated') || lowered.includes('permission')) {
    return {
      code: 'auth',
      message: 'API Key 校验失败或权限不足。',
      hint: '请在左侧配置面板重新填写有效的 API Key。',
    };
  }

  return {
    code: 'unknown',
    message: `调用模型服务时发生异常：${raw.slice(0, 200) || '未知错误'}`,
    hint: '请重试；若持续失败请检查模型选择与网络环境。',
  };
}

const RETRYABLE_CODES: LlmErrorCode[] = ['timeout', 'network', 'rate_limit', 'upstream'];

export function isRetryable(failure: LlmFailure): boolean {
  return RETRYABLE_CODES.includes(failure.code);
}

// ==========================================
// RESILIENT FETCH
// ==========================================

export interface ResilientFetchOptions {
  timeoutMs: number;
  retries: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, failure: LlmFailure) => void;
}

/**
 * Performs a fetch with a hard timeout and bounded retries on transient failures.
 * Resolves with the response as soon as headers arrive so streaming bodies are not
 * buffered; the timeout therefore guards time-to-first-byte, not total stream time.
 */
export async function resilientFetch(
  url: string,
  init: RequestInit,
  options: ResilientFetchOptions
): Promise<{ ok: true; response: globalThis.Response } | { ok: false; failure: LlmFailure }> {
  let lastFailure: LlmFailure = { code: 'unknown', message: '请求未能完成。' };

  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (options.signal?.aborted) {
      return { ok: false, failure: { code: 'timeout', message: '请求已被取消。' } };
    }

    const timer = new AbortController();
    const timeoutHandle = setTimeout(() => timer.abort(), options.timeoutMs);
    const onOuterAbort = () => timer.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const response = await fetch(url, { ...init, signal: timer.signal });

      if (response.ok) {
        // Timeout must not kill the stream once it starts flowing.
        clearTimeout(timeoutHandle);
        options.signal?.removeEventListener('abort', onOuterAbort);
        return { ok: true, response };
      }

      const body = await response.text().catch(() => '');
      lastFailure = classifyHttpFailure(response.status, body);
    } catch (err) {
      lastFailure = classifyThrownFailure(err);
    } finally {
      clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }

    if (attempt >= options.retries || !isRetryable(lastFailure)) break;

    options.onRetry?.(attempt + 1, lastFailure);
    await new Promise((resolve) => setTimeout(resolve, 800 * Math.pow(2, attempt)));
  }

  return { ok: false, failure: lastFailure };
}

// ==========================================
// TOC CATALOG & LOCAL ROUTING FALLBACK
// ==========================================

const MAX_CATALOG_ENTRIES_PER_BOOK = 60;

/**
 * Picks a representative subset of outline entries for the routing prompt.
 * Taking the first N entries would show the router nothing but front matter on books
 * with deep outlines, so shallower levels are preferred and the rest evenly sampled.
 */
export function selectCatalogEntries(toc: TocItem[]): TocItem[] {
  if (!Array.isArray(toc) || toc.length === 0) return [];
  if (toc.length <= MAX_CATALOG_ENTRIES_PER_BOOK) return toc;

  // Take the deepest outline level that still fits the cap, so the router sees whole
  // chapters rather than whichever entries happen to come first in the document.
  let selected: TocItem[] = [];
  for (const maxLevel of [0, 1, 2, 3]) {
    const candidates = toc.filter((item) => (item.level ?? 0) <= maxLevel);
    if (candidates.length <= MAX_CATALOG_ENTRIES_PER_BOOK && candidates.length > selected.length) {
      selected = candidates;
    }
  }

  // Backfill the remaining slots with an even sample of the deeper entries so books
  // with only a handful of top-level parts still expose their sections.
  const remaining = MAX_CATALOG_ENTRIES_PER_BOOK - selected.length;
  if (remaining > 0) {
    const chosen = new Set(selected);
    const rest = toc.filter((item) => !chosen.has(item));
    const step = Math.max(1, Math.ceil(rest.length / remaining));
    rest.forEach((item, index) => {
      if (index % step === 0 && selected.length < MAX_CATALOG_ENTRIES_PER_BOOK) {
        selected.push(item);
      }
    });
  }

  return selected.sort((a, b) => a.startPage - b.startPage);
}

export function buildTocCatalog(books: BookMetadata[]): string {
  const lines: string[] = [];

  books.forEach((book, index) => {
    const readability =
      book.textLayer === 'none' ? '（扫描版，无文字层）' : book.textLayer === 'sparse' ? '（文字层稀疏）' : '';
    lines.push(`【教材 ${index + 1}】《${book.name}》（ID: ${book.id}，共 ${book.pageCount} 页）${readability}`);

    for (const item of selectCatalogEntries(book.toc || [])) {
      const indent = '  '.repeat(1 + Math.min(2, item.level ?? 0));
      const range = item.endPage && item.endPage !== item.startPage ? `P${item.startPage}-P${item.endPage}` : `P${item.startPage}`;
      lines.push(`${indent}• ${item.title} (${range})`);
    }
  });

  return lines.join('\n');
}

function tokenizeForMatching(text: string): Set<string> {
  const tokens = new Set<string>();
  const cleaned = String(text || '').toLowerCase();

  // CJK has no word delimiters, so compare overlapping bigrams.
  const cjk = cleaned.match(/[\u3400-\u9fff]/g) || [];
  const cjkRun = cjk.join('');
  for (let i = 0; i + 1 < cjkRun.length; i++) {
    tokens.add(cjkRun.slice(i, i + 2));
  }

  for (const word of cleaned.match(/[a-z]{3,}/g) || []) {
    tokens.add(word);
  }

  return tokens;
}

export interface LocalMatch {
  bookId: string;
  bookName: string;
  chapterTitle: string;
  startPage: number;
  endPage: number;
  score: number;
}

/**
 * Deterministic keyword routing used when the routing model is unavailable or returns
 * unusable JSON, so a failed router degrades to a narrower slice instead of no context.
 */
export function matchChapterLocally(prompt: string, books: BookMetadata[]): LocalMatch | null {
  const promptTokens = tokenizeForMatching(prompt);
  if (promptTokens.size === 0) return null;

  let best: LocalMatch | null = null;

  for (const book of books) {
    for (const item of book.toc || []) {
      const titleTokens = tokenizeForMatching(item.title);
      if (titleTokens.size === 0) continue;

      let overlap = 0;
      for (const token of titleTokens) {
        if (promptTokens.has(token)) overlap++;
      }
      if (overlap === 0) continue;

      const score = overlap / titleTokens.size;
      if (!best || score > best.score) {
        const [start, end] = expandRange(item, book.pageCount);
        best = {
          bookId: book.id,
          bookName: book.name,
          chapterTitle: item.title,
          startPage: start,
          endPage: end,
          score,
        };
      }
    }
  }

  return best && best.score >= 0.34 ? best : null;
}

/** Widens a thin section entry into a usable reading window, still under the page cap. */
export function expandRange(item: TocItem, totalPages: number): [number, number] {
  const rawEnd = item.endPage ?? item.startPage;
  const span = rawEnd - item.startPage + 1;
  const targetEnd = span >= 8 ? rawEnd : Math.min(totalPages, item.startPage + MAX_SLICE_PAGES - 1);
  return clampPageRange(item.startPage, targetEnd, totalPages);
}
