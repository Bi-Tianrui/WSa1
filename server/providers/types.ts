import { LlmFailure } from '../errors';
import { PageImage } from '../pdf/raster';

export type ProviderId = 'gemini' | 'openai_compatible';

/**
 * How a provider wants to receive pages.
 *
 * Both supported channels read pages visually; they differ only in transport. Gemini
 * ingests the sliced PDF directly, while chat-completions endpoints take rendered
 * images. There is no text transport: a provider that cannot see a page is not one this
 * project supports.
 */
export type ExcerptFormat = 'pdf' | 'image';

export interface ProviderCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Pages in whichever visual form the target provider accepts. */
export interface VisualPayload {
  /** Sliced PDF bytes, base64 encoded. Set for `pdf` providers. */
  pdfBase64?: string;
  /** Rendered pages. Set for `image` providers. */
  images?: PageImage[];
}

/**
 * The chapter excerpt handed to a model for one turn.
 *
 * There is deliberately no field that could carry a whole book: the payload is built
 * from a clamped page range and nothing else.
 */
export interface TextbookExcerpt extends VisualPayload {
  bookName: string;
  chapterTitle: string;
  pageRange: [number, number];
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

/** A one-shot visual read of some pages, used to transcribe a printed contents page. */
export interface InspectRequest {
  model: string;
  credentials: ProviderCredentials;
  prompt: string;
  payload: VisualPayload;
  signal: AbortSignal;
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
  /** Which visual transport this provider's pages must be prepared in. */
  readonly excerptFormat: ExcerptFormat;
  /** Stage 2: one cheap non-streaming call returning raw routing JSON. */
  requestRouting(req: RouteRequest): Promise<string>;
  /** Reads pages visually and returns raw text, used for on-demand outline recovery. */
  inspectPages(req: InspectRequest): Promise<string>;
  /** Stage 3+4: stream the answer. Throws LlmFailureError on fatal errors. */
  streamAnswer(req: AnswerRequest): Promise<void>;
}
