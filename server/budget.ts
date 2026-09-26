/**
 * Central hard limits for the "read like a human" pipeline.
 *
 * Every number here exists to guarantee one invariant: a single model request never
 * carries more than one chapter-sized excerpt. Nothing in the codebase may send a
 * whole textbook, at ingest time or at question time.
 */

/** Maximum physical pages that may ever be sliced out for one turn. */
export const MAX_SLICE_PAGES = 30;

/** Maximum textbook context tokens injected into one request. */
export const MAX_CONTEXT_TOKENS = 25_000;

/** Tokens the routing catalog (TOC tree only) is allowed to occupy. */
export const MAX_CATALOG_TOKENS = 1_200;

/** Replayed conversation budget, kept separate so history cannot crowd out the textbook. */
export const MAX_HISTORY_TOKENS = 4_000;

/**
 * Gemini bills an inline PDF page at roughly this many tokens, so page count is the
 * proxy used to keep a multimodal slice inside MAX_CONTEXT_TOKENS.
 */
export const TOKENS_PER_PDF_PAGE = 258;

/**
 * A rendered page costs far more than a PDF page: vision endpoints retile the image and
 * charge per tile, which lands a portrait textbook page near this figure.
 */
export const TOKENS_PER_IMAGE_PAGE = 1_100;

/** Byte ceiling for one inline PDF upload, guarding image-heavy scans. */
export const MAX_INLINE_PDF_KB = 8 * 1024;

/**
 * Long-edge resolution for rendered pages. Vision endpoints downsample to roughly 768px
 * on the short edge anyway, so going much higher inflates the request without adding
 * any detail the model can actually see.
 */
export const IMAGE_LONG_EDGE_PX = 1_400;

export const IMAGE_JPEG_QUALITY = 76;

/** Largest page span that still fits the token budget when sent as a raw PDF. */
export function maxPdfPagesWithinBudget(): number {
  return Math.max(1, Math.min(MAX_SLICE_PAGES, Math.floor(MAX_CONTEXT_TOKENS / TOKENS_PER_PDF_PAGE)));
}

/** Largest page span that still fits the token budget when sent as rendered images. */
export function maxImagePagesWithinBudget(): number {
  return Math.max(1, Math.min(MAX_SLICE_PAGES, Math.floor(MAX_CONTEXT_TOKENS / TOKENS_PER_IMAGE_PAGE)));
}

/**
 * Rough token estimate tuned for mixed Chinese/LaTeX textbook prose.
 * CJK codepoints cost close to one token each; Latin runs about four chars per token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** Clamps a requested range to the document and to MAX_SLICE_PAGES. */
export function clampPageRange(
  startPage: number,
  endPage: number,
  totalPages: number
): [number, number] {
  const safeTotal = Math.max(1, totalPages);
  const safeStart = Math.max(1, Math.min(Math.floor(startPage) || 1, safeTotal));
  const hardEnd = Math.min(safeTotal, safeStart + MAX_SLICE_PAGES - 1);
  const safeEnd = Math.max(safeStart, Math.min(Math.floor(endPage) || safeStart, hardEnd));
  return [safeStart, safeEnd];
}
