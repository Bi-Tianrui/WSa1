import fs from 'fs';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { IMAGE_JPEG_QUALITY, IMAGE_LONG_EDGE_PX, clampPageRange } from '../budget';
import { getBookPath } from './storage';

/**
 * Page rasterization for the image channel.
 *
 * Endpoints speaking the OpenAI chat-completions dialect accept images, not PDFs, so a
 * chapter destined for GPT-4o or Claude is rendered here at reading resolution. PDFium
 * runs as WebAssembly, which keeps this free of system packages and native toolchains.
 */

export interface PageImage {
  pageNumber: number;
  /** JPEG bytes, base64 encoded for direct embedding in a data URL. */
  base64: string;
  width: number;
  height: number;
  sizeKb: number;
}

let libraryPromise: Promise<any> | null = null;

/** PDFium initialization is expensive, so the WASM instance is shared process-wide. */
function getLibrary(): Promise<any> {
  if (!libraryPromise) {
    libraryPromise = PDFiumLibrary.init().catch((err) => {
      libraryPromise = null;
      throw err;
    });
  }
  return libraryPromise;
}

/** PDFium writes BGRA; canvas expects RGBA. */
function bgraToRgba(source: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(source.length);
  for (let i = 0; i < source.length; i += 4) {
    out[i] = source[i + 2];
    out[i + 1] = source[i + 1];
    out[i + 2] = source[i];
    out[i + 3] = source[i + 3];
  }
  return out;
}

/**
 * Renders a page range of the stored textbook to JPEG.
 *
 * The range is clamped exactly as slicing is, so this can never walk a whole book.
 */
export async function renderPageRange(
  bookId: string,
  startPage: number,
  endPage: number
): Promise<{ images: PageImage[]; pageRange: [number, number] }> {
  const filePath = getBookPath(bookId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`教材文件未找到: ${bookId}`);
  }

  const library = await getLibrary();
  const doc = await library.loadDocument(fs.readFileSync(filePath));

  try {
    const [safeStart, safeEnd] = clampPageRange(startPage, endPage, doc.getPageCount());
    const images: PageImage[] = [];

    for (let pageNumber = safeStart; pageNumber <= safeEnd; pageNumber++) {
      const page = doc.getPage(pageNumber - 1);
      const { originalWidth, originalHeight } = page.getOriginalSize();
      const longEdge = Math.max(originalWidth, originalHeight) || 1;
      const scale = IMAGE_LONG_EDGE_PX / longEdge;

      const bitmap = await page.render({ scale, render: 'bitmap' });

      const canvas = createCanvas(bitmap.width, bitmap.height);
      canvas
        .getContext('2d')
        .putImageData(new ImageData(bgraToRgba(bitmap.data), bitmap.width, bitmap.height), 0, 0);
      const jpeg = canvas.encodeSync('jpeg', IMAGE_JPEG_QUALITY);

      images.push({
        pageNumber,
        base64: jpeg.toString('base64'),
        width: bitmap.width,
        height: bitmap.height,
        sizeKb: Math.round(jpeg.length / 1024),
      });
    }

    return { images, pageRange: [safeStart, safeEnd] };
  } finally {
    try {
      doc.destroy();
    } catch {}
  }
}
