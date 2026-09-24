import { LlmFailureError } from '../errors';
import { resilientFetch } from '../http';
import { AnswerRequest, ChatProvider, RouteRequest } from './types';

const ROUTING_TIMEOUT_MS = 45_000;
const ANSWER_TIMEOUT_MS = 120_000;

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'aistudio-build/1.0',
  };
}

/**
 * OpenAI-compatible endpoints (OpenAI, DeepSeek, Moonshot, Ollama...).
 *
 * These are text-only: they cannot parse a PDF binary, so `acceptsPdf` is false and the
 * pipeline is obliged to hand over extracted prose instead.
 */
export const openAiCompatibleProvider: ChatProvider = {
  id: 'openai_compatible',
  acceptsPdf: false,

  async requestRouting(req: RouteRequest): Promise<string> {
    const result = await resilientFetch(
      endpoint(req.credentials.baseUrl),
      {
        method: 'POST',
        headers: authHeaders(req.credentials.apiKey),
        body: JSON.stringify({
          model: req.model,
          messages: [{ role: 'user', content: req.prompt }],
          temperature: 0.1,
        }),
      },
      { timeoutMs: ROUTING_TIMEOUT_MS, retries: 1, signal: req.signal, onRetry: req.onRetry }
    );

    if (!result.ok) throw new LlmFailureError(result.failure);

    const data: any = await result.response.json();
    return data?.choices?.[0]?.message?.content || '';
  },

  async streamAnswer(req: AnswerRequest): Promise<void> {
    const messages: ChatMessage[] = [{ role: 'system', content: req.systemInstruction }];

    if (req.excerpt?.text) {
      messages.push({
        role: 'system',
        content: `【教材原文精读素材 - 《${req.excerpt.bookName}》「${req.excerpt.chapterTitle}」第 ${req.excerpt.pageRange[0]} - ${req.excerpt.pageRange[1]} 页】
${req.excerpt.text}

以上是从教材 PDF 中切出目标页码后转换得到的纯文本原文。请严格结合该原文作答，引用定理时标注具体页码。`,
      });
    }

    for (const turn of req.history) messages.push({ role: turn.role, content: turn.content });
    messages.push({ role: 'user', content: req.prompt });

    const result = await resilientFetch(
      endpoint(req.credentials.baseUrl),
      {
        method: 'POST',
        headers: authHeaders(req.credentials.apiKey),
        body: JSON.stringify({ model: req.model, messages, stream: true }),
      },
      { timeoutMs: ANSWER_TIMEOUT_MS, retries: 2, signal: req.signal, onRetry: req.onRetry }
    );

    if (!result.ok) throw new LlmFailureError(result.failure);

    const reader = result.response.body?.getReader();
    if (!reader) {
      throw new LlmFailureError({
        code: 'upstream',
        message: '模型服务未返回可读的数据流。',
        hint: '请重试，或确认该模型支持流式输出。',
      });
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let produced = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (req.shouldStop()) {
        try {
          await reader.cancel();
        } catch {}
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        try {
          const delta = JSON.parse(trimmed.slice(6).trim())?.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.reasoning_content) {
            produced = true;
            req.onReasoning(delta.reasoning_content);
          }
          if (delta.content) {
            produced = true;
            req.onText(delta.content);
          }
        } catch {}
      }
    }

    if (!produced) {
      throw new LlmFailureError({
        code: 'upstream',
        message: '模型返回了空响应，未生成任何内容。',
        hint: '请重试，或在左侧更换其他模型。',
      });
    }
  },
};
