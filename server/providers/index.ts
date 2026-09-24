import { geminiProvider } from './gemini';
import { openAiCompatibleProvider } from './openaiCompatible';
import { ChatProvider, ProviderId } from './types';

export * from './types';

export function normalizeProviderId(raw: unknown): ProviderId {
  return raw === 'openai_compatible' ? 'openai_compatible' : 'gemini';
}

export function getProvider(id: ProviderId): ChatProvider {
  return id === 'openai_compatible' ? openAiCompatibleProvider : geminiProvider;
}
