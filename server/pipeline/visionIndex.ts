import { extractVisualOutline } from '../pdf/outline';
import { BookMetadata, saveBookMetadata } from '../pdf/storage';
import { ChatProvider, ProviderCredentials } from '../providers';
import { SseChannel } from '../sse';

/**
 * Deferred outline recognition, for books that were uploaded before a usable API key
 * existed.
 *
 * Recognition normally happens once at ingest. A book only reaches this path if the
 * visual pass never ran at all, so `visionAttempted` still guarantees a book is never
 * recognized twice.
 */
export interface DeferredVisionOptions {
  book: BookMetadata;
  provider: ChatProvider;
  model: string;
  credentials: ProviderCredentials;
  channel: SseChannel;
}

export function needsDeferredVision(book: BookMetadata): boolean {
  return book.tocSource === 'synthesized' && !book.visionAttempted;
}

export async function recoverOutlineWithVision(
  options: DeferredVisionOptions
): Promise<BookMetadata> {
  const { book, provider, model, credentials, channel } = options;

  channel.stage(`《${book.name}》上传时尚未配置模型，正在补做印刷目录的视觉识别…`);

  let updated: BookMetadata = { ...book, visionAttempted: true };

  try {
    const toc = await extractVisualOutline({
      bookId: book.id,
      totalPages: book.pageCount,
      provider,
      model,
      credentials,
      signal: channel.aborter.signal,
    });

    if (toc.length > 0) {
      updated = { ...updated, toc, tocSource: 'vision' };
      channel.notice(
        'info',
        `已通过视觉识别为《${book.name}》建立 ${toc.length} 条章节目录，已永久缓存，后续提问不再重复识别。`
      );
    }
  } catch (err) {
    console.warn(`[vision-index] deferred pass failed for ${book.id}:`, err);
  }

  saveBookMetadata(updated);
  return updated;
}
