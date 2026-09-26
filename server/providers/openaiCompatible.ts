import { LlmFailureError } from '../errors';
import { resilientFetch } from '../http';
import { AnswerRequest, ChatProvider, InspectRequest, RouteRequest, VisualPayload } from './types';

const ROUTING_TIMEOUT_MS = 45_000;
const ANSWER_TIMEOUT_MS = 180_000;

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'high' } };

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
};

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
 * Renders pages as image parts.
 *
 * `detail: 'high'` is required rather than cosmetic: at low detail the endpoint
 * downsamples to a thumbnail, and textbook body text stops being legible.
 */
function imageParts(payload: VisualPayload): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const image of payload.images || []) {
    parts.push({ type: 'text', text: `【第 ${image.pageNumber} 页】` });
    parts.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${image.base64}`, detail: 'high' },
    });
  }
  return parts;
}

/** Reads one SSE stream of chat-completion deltas. */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  req: AnswerRequest
): Promise<boolean> {
  const reader = body.getReader();
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
      return produced;
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

  return produced;
}

/**
 * Endpoints speaking the OpenAI chat-completions dialect, used here for multimodal
 * models such as GPT-4o and Claude 3.5 Sonnet.
 *
 * Pages are delivered as rendered images, so scanned textbooks, figures and handwritten
 * derivations are read exactly as they appear on the page.
 */
export const openAiCompatibleProvider: ChatProvider = {
  id: 'openai_compatible',
  excerptFormat: 'image',

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

  async inspectPages(req: InspectRequest): Promise<string> {
    const result = await resilientFetch(
      endpoint(req.credentials.baseUrl),
      {
        method: 'POST',
        headers: authHeaders(req.credentials.apiKey),
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: 'user', content: [...imageParts(req.payload), { type: 'text', text: req.prompt }] },
          ],
          temperature: 0.1,
        }),
      },
      { timeoutMs: ANSWER_TIMEOUT_MS, retries: 1, signal: req.signal }
    );

    if (!result.ok) throw new LlmFailureError(result.failure);

    const data: any = await result.response.json();
    return data?.choices?.[0]?.message?.content || '';
  },

  async streamAnswer(req: AnswerRequest): Promise<void> {
    const messages: ChatMessage[] = [{ role: 'system', content: req.systemInstruction }];

    for (const turn of req.history) messages.push({ role: turn.role, content: turn.content });

    if (req.excerpt) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `【教材原页精读素材 - 《${req.excerpt.bookName}》「${req.excerpt.chapterTitle}」第 ${req.excerpt.pageRange[0]} - ${req.excerpt.pageRange[1]} 页】
以下为该章节的教材原始页面影像，请直接阅读页面上的公式排版、插图与定理叙述，引用时标注具体页码。`,
          },
          ...imageParts(req.excerpt),
          { type: 'text', text: req.prompt },
        ],
      });
    } else {
      messages.push({ role: 'user', content: req.prompt });
    }

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

    if (!result.response.body) {
      throw new LlmFailureError({
        code: 'upstream',
        message: '模型服务未返回可读的数据流。',
        hint: '请重试，或确认该模型支持流式输出。',
      });
    }

    const produced = await consumeStream(result.response.body, req);

    if (!produced && !req.shouldStop()) {
      throw new LlmFailureError({
        code: 'upstream',
        message: '模型返回了空响应，未生成任何内容。',
        hint: '请确认所选模型具备图像识别能力（如 gpt-4o、claude-3-5-sonnet），或更换模型后重试。',
      });
    }
  },
};
