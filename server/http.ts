import { LlmFailure, classifyHttpFailure, classifyThrownFailure, isRetryable } from './errors';

export interface ResilientFetchOptions {
  timeoutMs: number;
  retries: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, failure: LlmFailure) => void;
}

export type FetchOutcome =
  | { ok: true; response: globalThis.Response }
  | { ok: false; failure: LlmFailure };

/**
 * Fetch with a hard timeout and bounded retries on transient failures.
 *
 * Resolves as soon as response headers arrive so streaming bodies are not buffered;
 * the timeout therefore guards time-to-first-byte, not total stream duration.
 */
export async function resilientFetch(
  url: string,
  init: RequestInit,
  options: ResilientFetchOptions
): Promise<FetchOutcome> {
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
        // The timeout must not kill the stream once it starts flowing.
        clearTimeout(timeoutHandle);
        options.signal?.removeEventListener('abort', onOuterAbort);
        return { ok: true, response };
      }

      lastFailure = classifyHttpFailure(response.status, await response.text().catch(() => ''));
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
