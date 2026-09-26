import { buildOutlineFromEntries } from '../pdf/outline';
import { renderPageRange } from '../pdf/raster';
import { slicePdf } from '../pdf/slice';
import { BookMetadata, saveBookMetadata } from '../pdf/storage';
import { ChatProvider, ProviderCredentials, VisualPayload } from '../providers';
import { SseChannel } from '../sse';
import { parseRoutingJson } from './route';

/**
 * Outline recovery by sight, for books whose contents page exists only as pixels.
 *
 * Scanned textbooks routinely carry no bookmarks and no text layer, so neither file-level
 * pass can index them. Rather than inventing fixed-size chunks and sending the reader to
 * an arbitrary page, the printed contents page is read with the same eyes that will read
 * the chapter. This runs once per book, on the first question, and the result is cached
 * into the book's local index.
 */

/** How many leading pages are shown to the model when hunting for the contents page. */
const CONTENTS_PAGES = 12;

/** Fraction into the book used for the page whose printed number anchors the offset. */
const PROBE_DEPTH = 0.35;

function buildPrompt(probePhysicalPage: number): string {
  return `你正在为一本理工科教材建立章节索引。附图为该教材的前若干页（其中可能包含印刷目录页），以及最后一张单独的正文页。

请完成两件事，并只输出严格合法的 JSON：
1. 从印刷目录中抄录章节条目，printedPage 必须填写目录中该章节右侧印刷的页码数字（不是附图的序号）。
2. 阅读最后一张附图（它是本书的第 ${probePhysicalPage} 张物理页），找出该页面上印刷的页码数字，填入 probePrintedPage。若该页没有印刷页码，填 null。

输出格式：
{
  "entries": [{ "title": "第一章 质点力学", "printedPage": 1 }],
  "probePrintedPage": 17
}

若附图中没有任何印刷目录，输出：{ "entries": [] }`;
}

/** Builds the payload in whichever visual form the provider accepts. */
async function buildPayload(
  book: BookMetadata,
  provider: ChatProvider,
  contentsEnd: number,
  probePage: number
): Promise<VisualPayload> {
  if (provider.excerptFormat === 'pdf') {
    // Gemini reads the PDF directly; the probe page rides along as a second slice.
    const contents = await slicePdf(book.id, 1, contentsEnd);
    return { pdfBase64: contents.buffer.toString('base64') };
  }

  const contents = await renderPageRange(book.id, 1, contentsEnd);
  const probe = await renderPageRange(book.id, probePage, probePage);
  return { images: [...contents.images, ...probe.images] };
}

export interface VisionIndexOptions {
  book: BookMetadata;
  provider: ChatProvider;
  model: string;
  credentials: ProviderCredentials;
  channel: SseChannel;
}

/**
 * Reads the printed contents page and writes the recovered outline into the book index.
 * Returns the updated metadata, or null when no outline could be recovered.
 */
export async function recoverOutlineWithVision(
  options: VisionIndexOptions
): Promise<BookMetadata | null> {
  const { book, provider, model, credentials, channel } = options;

  const contentsEnd = Math.min(CONTENTS_PAGES, book.pageCount);
  const probePage = Math.max(
    contentsEnd + 1,
    Math.min(book.pageCount, Math.round(book.pageCount * PROBE_DEPTH))
  );

  channel.stage(`《${book.name}》尚无可用目录，正在用视觉直读其印刷目录页…`);

  let raw = '';
  try {
    const payload = await buildPayload(book, provider, contentsEnd, probePage);
    raw = await provider.inspectPages({
      model,
      credentials,
      prompt: buildPrompt(probePage),
      payload,
      signal: channel.aborter.signal,
    });
  } catch (err) {
    console.warn(`[vision-index] ${book.id} visual outline read failed:`, err);
    return markAttempted(book);
  }

  const parsed = parseRoutingJson(raw);
  const entries: any[] = Array.isArray(parsed?.entries) ? parsed.entries : [];
  if (entries.length === 0) return markAttempted(book);

  // Printed numbering rarely starts on physical page 1; anchor it with the probe page.
  const probePrinted = Number(parsed?.probePrintedPage);
  const offset =
    Number.isFinite(probePrinted) && probePrinted > 0 ? probePage - probePrinted : 0;

  const toc = buildOutlineFromEntries(
    entries.map((entry) => ({
      title: entry?.title,
      startPage: Math.floor(Number(entry?.printedPage)) + offset,
    })),
    book.pageCount
  );

  if (toc.length === 0) return markAttempted(book);

  const updated: BookMetadata = {
    ...book,
    toc,
    tocSource: 'vision',
    visionIndexAttempted: true,
  };
  saveBookMetadata(updated);
  console.log(`[vision-index] ${book.id} recovered ${toc.length} entries (offset ${offset})`);
  channel.notice('info', `已通过视觉直读为《${book.name}》建立 ${toc.length} 条章节索引，后续提问将直接复用。`);

  return updated;
}

/** Records the attempt so a book without a readable contents page is not retried. */
function markAttempted(book: BookMetadata): null {
  saveBookMetadata({ ...book, visionIndexAttempted: true });
  return null;
}
