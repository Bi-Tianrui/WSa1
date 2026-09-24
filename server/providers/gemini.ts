import { GoogleGenAI } from '@google/genai';
import { LlmFailureError, classifyThrownFailure } from '../errors';
import { AnswerRequest, ChatProvider, RouteRequest } from './types';

const ROUTING_TIMEOUT_MS = 45_000;
const ANSWER_TIMEOUT_MS = 120_000;

function createClient(apiKey: string, timeout: number): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' }, timeout },
  });
}

/**
 * Google Gemini: the only provider allowed to receive a raw PDF stream, and then only
 * the sliced chapter excerpt, never a whole book.
 */
export const geminiProvider: ChatProvider = {
  id: 'gemini',
  acceptsPdf: true,

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

  async streamAnswer(req: AnswerRequest): Promise<void> {
    const ai = createClient(req.credentials.apiKey, ANSWER_TIMEOUT_MS);

    const contents: Array<{
      role: 'user' | 'model';
      parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
    }> = [];

    for (const turn of req.history) {
      contents.push({
        role: turn.role === 'user' ? 'user' : 'model',
        parts: [{ text: turn.content }],
      });
    }
    // Gemini rejects a conversation that opens with a model turn.
    while (contents.length > 0 && contents[0].role === 'model') contents.shift();

    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
    if (req.excerpt?.pdfBase64) {
      parts.push({ inlineData: { mimeType: 'application/pdf', data: req.excerpt.pdfBase64 } });
      parts.push({
        text: `【学术推演任务】：
上述所附 PDF 为《${req.excerpt.bookName}》中「${req.excerpt.chapterTitle}」经精准切出的核心章节（第 ${req.excerpt.pageRange[0]} 至 ${req.excerpt.pageRange[1]} 页）。
请精读切片中的定理叙述与推导步骤，针对学生的以下提问进行详尽、权威、工科级的学术解答与 LaTeX 推导演绎：

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
