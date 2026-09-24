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
  /** Whether routing came from the model or the local keyword fallback. */
  source?: 'model' | 'keyword';
  /** Estimated tokens this slice actually costs. */
  contextTokens?: number;
  /** Which form the excerpt was sent in for this provider. */
  payload?: 'pdf' | 'text';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  reasoning?: string;
  bookCitation?: string;
  routing?: ScholarRouting;
  responseTimeMs?: number;
  /** Textbook context tokens spent on this turn; 0 means none was sent. */
  contextTokens?: number;
  isError?: boolean;
  errorHint?: string;
  notices?: StreamNotice[];
  stage?: string;
}

export interface MountedBook {
  id: string;
  name: string;
  sizeMb: number;
  pageCount: number;
  status: 'ready' | 'processing';
  uploadTime: string;
  toc?: TocItem[];
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

