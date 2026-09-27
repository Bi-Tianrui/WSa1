import React, { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

interface PdfPreviewProps {
  base64: string;
}

/**
 * Renders a compiled PDF as full-width canvases.
 *
 * The previous iframe handed the file to Chrome's built-in viewer, which draws a
 * floating Pages / thumbnails drawer over the document. Hash flags such as
 * pagemode=none are ignored there, so the only reliable way to keep the pane clear
 * is to paint the pages ourselves.
 */
export const PdfPreview: React.FC<PdfPreviewProps> = ({ base64 }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const host = hostRef.current;
    if (!wrap || !host) return;

    let cancelled = false;
    let resizeTimer: number | undefined;
    let lastWidth = 0;
    let generation = 0;
    let busy = false;
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;

    const paint = async () => {
      if (busy) return;
      busy = true;
      const thisRun = ++generation;
      setStatus((prev) => (prev === 'ready' ? prev : 'loading'));
      setError(null);
      lastWidth = Math.round(wrap.clientWidth);

      try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        // XeLaTeX / ctex CID fonts need packed CMaps; without them pdf.js paints
        // Latin and math but silently drops every CJK glyph.
        loadingTask = pdfjs.getDocument({
          data: bytes,
          verbosity: 0,
          cMapUrl: '/pdfjs-assets/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs-assets/standard_fonts/',
          wasmUrl: '/pdfjs-assets/wasm/',
          iccUrl: '/pdfjs-assets/iccs/',
        });
        const doc = await loadingTask.promise;
        if (cancelled || thisRun !== generation) {
          await doc.destroy();
          return;
        }

        const cssWidth = Math.max(240, wrap.clientWidth - 16);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const fragment = document.createDocumentFragment();

        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
          const page = await doc.getPage(pageNumber);
          const base = page.getViewport({ scale: 1 });
          const scale = cssWidth / base.width;
          const viewport = page.getViewport({ scale: scale * dpr });

          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(base.width * scale)}px`;
          canvas.style.height = `${Math.floor(base.height * scale)}px`;
          canvas.className = 'block mx-auto mb-3 bg-white shadow-lg';
          canvas.setAttribute('aria-label', `第 ${pageNumber} 页`);

          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
          page.cleanup();
          if (cancelled || thisRun !== generation) {
            await doc.destroy();
            return;
          }
          fragment.appendChild(canvas);
        }

        await doc.destroy();
        if (cancelled || thisRun !== generation) return;
        host.replaceChildren(fragment);
        setStatus('ready');
      } finally {
        busy = false;
      }
    };

    paint().catch((err) => {
      if (cancelled) return;
      setStatus('error');
      setError(err instanceof Error ? err.message : 'PDF 预览渲染失败');
    });

    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? 0);
      if (busy || width < 80 || Math.abs(width - lastWidth) < 24) return;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (!cancelled && !busy) void paint().catch(() => {});
      }, 280);
    });
    observer.observe(wrap);

    return () => {
      cancelled = true;
      window.clearTimeout(resizeTimer);
      observer.disconnect();
      void loadingTask?.destroy();
      host.replaceChildren();
    };
  }, [base64]);

  return (
    <div ref={wrapRef} className="relative w-full h-full bg-slate-800/40">
      {status === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-slate-400 pointer-events-none">
          正在渲染预览…
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center px-6 text-center text-xs text-rose-300">
          {error}
        </div>
      )}
      <div ref={hostRef} className="w-full h-full overflow-auto py-3 px-2" />
    </div>
  );
};
