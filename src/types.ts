export interface TocItem {
  title: string;
  startPage: number;
  endPage?: number;
  level?: number;
}

/** How readable a book's text layer is for text-only models. */
export type TextLayerQuality = 'rich' | 'sparse' | 'none';

export type TocSource = 'bookmarks' | 'text-scan' | 'synthesized';

export interface StreamNotice {
  level: 'info' | 'warn';
  message: string;
}

export interface ScholarRouting {
  matched: boolean;
  bookId?: string;
  bookName?: string;
  chapterTitle?: string;
  startPage?: number;
  endPage?: number;
  rationale?: string;
  label?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  reasoning?: string;
  bookCitation?: string;
  routing?: ScholarRouting;
  cacheHit?: boolean;
  cacheHandle?: string;
  responseTimeMs?: number;
  isError?: boolean;
  errorHint?: string;
  notices?: StreamNotice[];
  stage?: string;
}

export interface CachedContentMeta {
  name: string; // e.g. "cachedContents/..."
  displayName: string;
  model: string;
  expireTime: string; // ISO string
  createTime?: string;
  ttlSeconds: number;
  tokenCount?: number;
  sourceBookName?: string;
}

export interface MountedBook {
  id: string;
  name: string;
  sizeMb: number;
  pageCount: number;
  tokensEstimate: number;
  status: 'ready' | 'processing';
  uploadTime: string;
  toc?: TocItem[];
  cachedContentHandle?: string;
  tocSource?: TocSource;
  textLayer?: TextLayerQuality;
}

export type GeminiModelType = string;
export type ApiProviderType = 'gemini' | 'openai_compatible';

export interface ModelDiscoveryResponse {
  success: boolean;
  models: string[];
  provider: ApiProviderType;
  error?: string;
  status?: number;
  message?: string;
}

export interface CodeFileMeta {
  filename: string;
  description: string;
  language: string;
  content: string;
}

export type MainTabType = 'chat' | 'latex' | 'code';

export interface LatexCompileResponse {
  success: boolean;
  installed: boolean;
  pdfBase64?: string;
  log?: string;
  error?: string;
  message?: string;
  elapsedMs?: number;
}

