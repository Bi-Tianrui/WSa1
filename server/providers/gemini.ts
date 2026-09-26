import { GoogleGenAI } from '@google/genai';
import { LlmFailureError, classifyThrownFailure } from '../errors';
import { AnswerRequest, ChatProvider, InspectRequest, RouteRequest, VisualPayload } from './types';

const ROUTING_TIMEOUT_MS = 45_000;
const ANSWER_TIMEOUT_MS = 120_000;

type Part = { text?: string; inlineData?: { mimeType: string; data: string } };

function createClient(apiKey: string, timeout: number): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' }, timeout },
  });
}

/** Gemini reads the sliced PDF itself, preserving layout, figures and handwriting. */
function payloadParts(payload: VisualPayload): Part[] {
  if (payload.pdfBase64) {
    return [{ inlineData: { mimeType: 'application/pdf', data: payload.pdfBase64 } }];
  }
  return (payload.images || []).map((image) => ({
    inlineData: { mimeType: 'image/jpeg', data: image.base64 },
  }));
}

/**
 * Google Gemini, addressed at its native endpoint.
 *
 * Pages travel as the physically sliced PDF, never as extracted text and never as a
 * whole book.
 */
export const geminiProvider: ChatProvider = {
  id: 'gemini',
  excerptFormat: 'pdf',

  async requestRouting(req: RouteRequest): Promise<string> {
    const ai = createClient(req.credentials.apiKey, ROUTING_TIMEOUT_MS);
    const response = await ai.models.generateContent({
      model: req.model,
      contents: req.prompt,
      config: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        abortSignal: req.signal,
      },
    });
    return response.text?.trim() || '';
  },

  async inspectPages(req: InspectRequest): Promise<string> {
    const ai = createClient(req.credentials.apiKey, ROUTING_TIMEOUT_MS);
    try {
      const response = await ai.models.generateContent({
        model: req.model,
        contents: [{ role: 'user', parts: [...payloadParts(req.payload), { text: req.prompt }] }],
        config: { temperature: 0.1, responseMimeType: 'application/json', abortSignal: req.signal },
      });
      return response.text?.trim() || '';
    } catch (err) {
      throw new LlmFailureError(classifyThrownFailure(err));
    }
  },

  async streamAnswer(req: AnswerRequest): Promise<void> {
    const ai = createClient(req.credentials.apiKey, ANSWER_TIMEOUT_MS);

    const contents: Array<{ role: 'user' | 'model'; parts: Part[] }> = [];

    for (const turn of req.history) {
      contents.push({
        role: turn.role === 'user' ? 'user' : 'model',
        parts: [{ text: turn.content }],
      });
    }
    // Gemini rejects a conversation that opens with a model turn.
    while (contents.length > 0 && contents[0].role === 'model') contents.shift();

    const parts: Part[] = [];
    if (req.excerpt) {
      parts.push(...payloadParts(req.excerpt));
      parts.push({
        text: `【学术推演任务】：
上述所附 PDF 为《${req.excerpt.bookName}》中「${req.excerpt.chapterTitle}」经精准切出的核心章节（第 ${req.excerpt.pageRange[0]} 至 ${req.excerpt.pageRange[1]} 页）。
请直接研读页面上的版面、公式、插图与定理叙述，针对学生的以下提问进行详尽、权威、工科级的学术解答与 LaTeX 推导演绎：

${req.prompt}`,
      });
    } else {
      parts.push({ text: req.prompt });
    }
    contents.push({ role: 'user', parts });

    let produced = false;
    try {
      const stream = await ai.models.generateContentStream({
        model: req.model,
        contents,
        config: { systemInstruction: req.systemInstruction, abortSignal: req.signal },
      });

      for await (const chunk of stream) {
        if (req.shouldStop()) return;
        if (chunk.text) {
          produced = true;
          req.onText(chunk.text);
        }
      }
    } catch (err) {
      throw new LlmFailureError(classifyThrownFailure(err));
    }

    if (!produced) {
      throw new LlmFailureError({
        code: 'upstream',
        message: '模型返回了空响应，未生成任何内容。',
        hint: '内容可能被安全策略拦截，请调整提问方式或更换模型后重试。',
      });
    }
  },
};
