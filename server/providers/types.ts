import { LlmFailure } from '../errors';

export type ProviderId = 'gemini' | 'openai_compatible';

export interface ProviderCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The chapter excerpt handed to a model for one turn.
 *
 * Exactly one payload field is populated, decided by the provider's `acceptsPdf`
 * capability: multimodal models get the sliced PDF, text-only models get extracted
 * prose. There is deliberately no field that could carry a whole book.
 */
export interface TextbookExcerpt {
  bookName: string;
  chapterTitle: string;
  pageRange: [number, number];
  /** Populated for text-only providers. */
  text?: string;
  /** Populated for multimodal providers. */
  pdfBase64?: string;
  /** Best-effort token cost of whichever payload is set. */
  estimatedTokens: number;
}

export interface RouteRequest {
  model: string;
  credentials: ProviderCredentials;
  /** The compact TOC-only routing prompt. */
  prompt: string;
  signal: AbortSignal;
  onRetry?: (attempt: number, failure: LlmFailure) => void;
}

export interface AnswerRequest {
  model: string;
  credentials: ProviderCredentials;
  systemInstruction: string;
  history: HistoryTurn[];
  prompt: string;
  excerpt: TextbookExcerpt | null;
  signal: AbortSignal;
  onRetry?: (attempt: number, failure: LlmFailure) => void;
  onText: (chunk: string) => void;
  onReasoning: (chunk: string) => void;
  /** Lets the pipeline stop reading when the browser disconnects. */
  shouldStop: () => boolean;
}

export interface ChatProvider {
  readonly id: ProviderId;
  /** True only for providers that can natively ingest a raw PDF stream. */
  readonly acceptsPdf: boolean;
  /** Stage 2: one cheap non-streaming call returning raw routing JSON. */
  requestRouting(req: RouteRequest): Promise<string>;
  /** Stage 3+4: stream the answer. Throws LlmFailureError on fatal errors. */
  streamAnswer(req: AnswerRequest): Promise<void>;
}
