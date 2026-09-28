import { geminiProvider } from './gemini';
import { openAiCompatibleProvider } from './openaiCompatible';
import { ChatProvider, ProviderId } from './types';

export * from './types';

export const DEFAULT_QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

export const QWEN_COMPAT_BASE_URLS = [
  DEFAULT_QWEN_BASE_URL,
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  'https://maas.qwencloudapi.com/compatible-mode/v1',
];

export const qwenProvider: ChatProvider = {
  id: 'qwen',
  excerptFormat: 'image',
  requestRouting: (req) => openAiCompatibleProvider.requestRouting(req),
  inspectPages: (req) => openAiCompatibleProvider.inspectPages(req),
  streamAnswer: (req) => openAiCompatibleProvider.streamAnswer(req),
};

export function normalizeProviderId(raw: unknown): ProviderId {
  if (raw === 'openai_compatible') return 'openai_compatible';
  if (raw === 'qwen') return 'qwen';
  return 'gemini';
}

export function getProvider(id: ProviderId): ChatProvider {
  if (id === 'openai_compatible') return openAiCompatibleProvider;
  if (id === 'qwen') return qwenProvider;
  return geminiProvider;
}
