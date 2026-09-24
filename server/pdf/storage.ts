import fs from 'fs';
import path from 'path';
import { TocItem, TocSource } from './outline';
import { TextLayerQuality } from './document';

export const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'books');
export const CHUNKS_DIR = path.join(UPLOADS_DIR, 'temp_chunks');

for (const dir of [UPLOADS_DIR, CHUNKS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * The entire local index for one textbook. This is all the server keeps in order to
 * answer questions; the PDF body itself is only ever touched one slice at a time.
 */
export interface BookMetadata {
  id: string;
  name: string;
  sizeMb: number;
  pageCount: number;
  toc: TocItem[];
  uploadTime: string;
  tocSource: TocSource;
  textLayer: TextLayerQuality;
}

export function getBookPath(bookId: string): string {
  return path.join(UPLOADS_DIR, `${bookId}.pdf`);
}

export function getBookTocPath(bookId: string): string {
  return path.join(UPLOADS_DIR, `${bookId}_toc.json`);
}

export function saveBookMetadata(meta: BookMetadata): void {
  fs.writeFileSync(getBookTocPath(meta.id), JSON.stringify(meta, null, 2), 'utf-8');
}

export function readBookMetadata(bookId: string): BookMetadata | null {
  const tocPath = getBookTocPath(bookId);
  if (!fs.existsSync(tocPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tocPath, 'utf-8'));
  } catch {
    return null;
  }
}

export function deleteBook(bookId: string): void {
  for (const target of [getBookPath(bookId), getBookTocPath(bookId)]) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
}

export function listBookIndexFiles(): string[] {
  return fs.readdirSync(UPLOADS_DIR).filter((f) => f.endsWith('_toc.json'));
}
