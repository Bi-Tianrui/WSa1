import React, { useState } from 'react';
import { Trash2, RotateCcw, Eye, EyeOff, RefreshCw, Loader2 } from 'lucide-react';
import { MountedBook, ApiProviderType } from '../types';

interface SidebarProps {
  provider: ApiProviderType;
  onProviderChange: (provider: ApiProviderType) => void;
  geminiApiKey: string;
  onGeminiApiKeyChange: (key: string) => void;
  openaiBaseUrl: string;
  onOpenaiBaseUrlChange: (url: string) => void;
  openaiApiKey: string;
  onOpenaiApiKeyChange: (key: string) => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  discoveredModels: string[];
  isDiscoveringModels: boolean;
  onDiscoverModels: () => void;
  discoveryStatus?: { type: 'success' | 'error'; message: string } | null;
  mountedBooks: MountedBook[];
  onAddBook: (book: MountedBook) => void;
  onRemoveBook: (id: string) => void;
  onClearAllBooks: () => void;
  onResetChat: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  provider,
  onProviderChange,
  geminiApiKey,
  onGeminiApiKeyChange,
  openaiBaseUrl,
  onOpenaiBaseUrlChange,
  openaiApiKey,
  onOpenaiApiKeyChange,
  selectedModel,
  onModelChange,
  discoveredModels,
  isDiscoveringModels,
  onDiscoverModels,
  discoveryStatus,
  mountedBooks,
  onAddBook,
  onRemoveBook,
  onClearAllBooks,
  onResetChat,
}) => {
  const [showKey, setShowKey] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadStatusText, setUploadStatusText] = useState<string>('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  /**
   * Indexing a scanned textbook may require the vision model to read its printed
   * contents page, so the active provider travels with the upload.
   */
  const appendVisionCredentials = (formData: FormData) => {
    formData.append('provider', provider);
    formData.append('model', selectedModel);
    formData.append('apiKey', provider === 'gemini' ? geminiApiKey : openaiApiKey);
    formData.append('baseUrl', openaiBaseUrl);
  };

  // Resilient PDF upload to /api/books/upload (automatically slices >15MB files into 6MB chunks to stay well under Cloud Run & proxy limits)
  const processPdfFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setUploadError('请选择标准 .pdf 格式的教科书或学术教材！');
      return;
    }

    setIsUploading(true);
    setUploadError(null);
    setUploadProgress(10);
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    setUploadStatusText(`正在准备挂载《${file.name}》(${sizeMb} MB)...`);

    const CHUNK_THRESHOLD = 15 * 1024 * 1024; // 15MB threshold
    const CHUNK_SIZE = 6 * 1024 * 1024; // 6MB slices (guaranteed safe on Cloud Run)

    try {
      let finalBookData: any = null;

      if (file.size <= CHUNK_THRESHOLD) {
        // Direct single-file upload for smaller textbooks
        setUploadProgress(40);
        setUploadStatusText(`正在上传《${file.name}》并解析大纲（扫描版需视觉识别目录，可能稍慢）...`);
        const formData = new FormData();
        formData.append('file', file);
        formData.append('clientFileName', file.name);
        appendVisionCredentials(formData);

        let attempts = 0;
        let success = false;
        let lastError: any = null;

        while (attempts < 3 && !success) {
          attempts++;
          try {
            const res = await fetch('/api/books/upload', {
              method: 'POST',
              body: formData,
            });

            if (!res.ok) {
              const errText = await res.text();
              throw new Error(`服务器响应异常 (${res.status}): ${errText.slice(0, 150)}`);
            }

            const data = await res.json();
            if (!data.success || !data.book) {
              throw new Error(data.error || '教材解析与大纲索引失败');
            }

            finalBookData = data.book;
            success = true;
          } catch (err: any) {
            lastError = err;
            if (attempts < 3) {
              setUploadStatusText(`网络微弱波动，正在自动重试 (${attempts}/3)...`);
              await new Promise((r) => setTimeout(r, 1000 * attempts));
            }
          }
        }

        if (!success) {
          throw lastError || new Error('上传请求异常，请重试');
        }
      } else {
        // Slice-based upload for larger textbooks (>15MB) to avoid proxy disconnects
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        const uploadId = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end = Math.min(file.size, (i + 1) * CHUNK_SIZE);
          const chunkBlob = file.slice(start, end);

          const currentPct = Math.min(92, Math.round(((i + 1) / totalChunks) * 88));
          setUploadProgress(currentPct);
          setUploadStatusText(`正在高速切片传输 (${i + 1}/${totalChunks} 块)...`);

          let attempts = 0;
          let success = false;
          let lastError: any = null;

          while (attempts < 3 && !success) {
            attempts++;
            try {
              const formData = new FormData();
              formData.append('uploadId', uploadId);
              formData.append('chunkIndex', String(i));
              formData.append('totalChunks', String(totalChunks));
              formData.append('fileName', file.name);
              formData.append('fileSize', String(file.size));
              formData.append('file', chunkBlob, file.name);
              appendVisionCredentials(formData);

              const res = await fetch('/api/books/upload', {
                method: 'POST',
                body: formData,
              });

              if (!res.ok) {
                const errText = await res.text();
                throw new Error(`分块传输响应异常 (${res.status}): ${errText.slice(0, 150)}`);
              }

              const data = await res.json();
              if (!data.success) {
                throw new Error(data.error || '分块处理失败');
              }

              success = true;
              if (data.completed && data.book) {
                finalBookData = data.book;
              }
            } catch (err: any) {
              lastError = err;
              if (attempts < 3) {
                setUploadStatusText(`分块 ${i + 1} 重传中 (${attempts}/3)...`);
                await new Promise((r) => setTimeout(r, 1000 * attempts));
              }
            }
          }

          if (!success) {
            throw lastError || new Error(`分块 ${i + 1} 传输失败`);
          }
        }
      }

      if (finalBookData) {
        setUploadProgress(100);
        setUploadStatusText(`✅《${file.name}》成功入库！`);
        onAddBook(finalBookData);

        setTimeout(() => {
          setIsUploading(false);
          setUploadProgress(0);
          setUploadStatusText('');
        }, 1200);
      } else {
        throw new Error('未接收到服务端生成的教材索引元数据。');
      }
    } catch (err: any) {
      console.warn('Upload book issue:', err);
      setUploadError(err?.message || '教材上传遇到网络波动，请检查连接后点击重试');
      setIsUploading(false);
      setUploadProgress(0);
      setUploadStatusText('');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    await processPdfFile(file);
    if (e.target) e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    await processPdfFile(file);
  };

  // Only endpoints that serve vision-capable models belong here.
  const URL_PRESETS = [
    { label: 'OpenAI 官方', url: 'https://api.openai.com/v1' },
    { label: 'XBCL 中转', url: 'https://xbcl.link/v1' },
    { label: 'Anthropic 兼容', url: 'https://api.anthropic.com/v1' },
    { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
    { label: '本地 Ollama', url: 'http://localhost:11434/v1' },
  ];

  const tocLabel = (source?: string) => {
    if (source === 'bookmarks') return '书签';
    if (source === 'text-scan') return '正文目录';
    if (source === 'vision') return '视觉目录';
    if (source === 'synthesized') return '按页分块';
    return '已索引';
  };

  return (
    <aside className="w-72 flex flex-col bg-zinc-950 text-zinc-200 border-r border-zinc-800 shrink-0 h-full select-none overflow-hidden">
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5 text-sm">
        <div className="space-y-2">
          <label className="text-xs text-zinc-500">通道</label>
          <div className="grid grid-cols-2 gap-1">
            <button
              type="button"
              onClick={() => onProviderChange('gemini')}
              className={`py-1.5 rounded text-xs cursor-pointer ${
                provider === 'gemini'
                  ? 'bg-zinc-100 text-zinc-950'
                  : 'text-zinc-500 hover:text-zinc-100 hover:bg-zinc-900'
              }`}
            >
              Gemini
            </button>
            <button
              type="button"
              onClick={() => onProviderChange('openai_compatible')}
              className={`py-1.5 rounded text-xs cursor-pointer ${
                provider === 'openai_compatible'
                  ? 'bg-zinc-100 text-zinc-950'
                  : 'text-zinc-500 hover:text-zinc-100 hover:bg-zinc-900'
              }`}
            >
              OpenAI
            </button>
          </div>
        </div>

        {provider === 'gemini' ? (
          <div className="space-y-2">
            <label className="text-xs text-zinc-500 flex items-center justify-between">
              <span>API Key</span>
              <span className="text-[11px] text-zinc-400">
                {geminiApiKey ? '已填写' : '可用环境变量'}
              </span>
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={geminiApiKey}
                onChange={(e) => onGeminiApiKeyChange(e.target.value)}
                placeholder="GEMINI_API_KEY"
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-hidden focus:border-zinc-600 font-mono pr-9"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 cursor-pointer"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-500">Base URL</label>
              <input
                type="text"
                value={openaiBaseUrl}
                onChange={(e) => onOpenaiBaseUrlChange(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-hidden focus:border-zinc-600 font-mono"
              />
              <div className="flex flex-wrap gap-1">
                {URL_PRESETS.map((p) => (
                  <button
                    key={p.url}
                    type="button"
                    onClick={() => onOpenaiBaseUrlChange(p.url)}
                    className={`text-[11px] px-1.5 py-0.5 rounded cursor-pointer ${
                      openaiBaseUrl === p.url
                        ? 'bg-zinc-100 text-zinc-950'
                        : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-zinc-500 flex items-center justify-between">
                <span>API Key</span>
                <span className="text-[11px] text-zinc-400">{openaiApiKey ? '已填写' : '必填'}</span>
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={openaiApiKey}
                  onChange={(e) => onOpenaiApiKeyChange(e.target.value)}
                  placeholder="sk-..."
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-hidden focus:border-zinc-600 font-mono pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 cursor-pointer"
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-zinc-500">模型</label>
            <span className="text-[11px] text-zinc-400">
              {discoveredModels.length > 0 ? `${discoveredModels.length} 个` : ''}
            </span>
          </div>
          <button
            type="button"
            onClick={onDiscoverModels}
            disabled={isDiscoveringModels}
            className="w-full py-1.5 rounded bg-zinc-100 hover:bg-zinc-200 text-zinc-950 text-xs cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isDiscoveringModels ? 'animate-spin' : ''}`} />
            {isDiscoveringModels ? '检测中…' : '检测可用模型'}
          </button>
          {discoveryStatus && (
            <p
              className={`text-[11px] leading-snug ${
                discoveryStatus.type === 'success' ? 'text-zinc-500' : 'text-red-400'
              }`}
            >
              {discoveryStatus.message}
            </p>
          )}
          <select
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-2 text-xs text-zinc-100 focus:outline-hidden focus:border-zinc-600 font-mono truncate"
          >
            {discoveredModels.length > 0 ? (
              discoveredModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))
            ) : (
              <option value={selectedModel}>{selectedModel || '请先检测模型'}</option>
            )}
          </select>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-zinc-500">教材</label>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-zinc-400">{mountedBooks.length} 本</span>
              {mountedBooks.length > 0 && (
                <button
                  onClick={onClearAllBooks}
                  className="text-[11px] text-zinc-400 hover:text-zinc-100 cursor-pointer"
                >
                  清空
                </button>
              )}
            </div>
          </div>

          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => {
              if (!isUploading && fileInputRef.current) {
                fileInputRef.current.click();
              }
            }}
            className={`border border-dashed rounded p-3 flex flex-col items-center justify-center cursor-pointer ${
              isDragging
                ? 'border-zinc-500 bg-zinc-900'
                : isUploading
                ? 'border-zinc-700 bg-zinc-900 cursor-wait'
                : 'border-zinc-700 hover:border-zinc-500 hover:bg-zinc-900'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              onChange={handleFileUpload}
              className="hidden"
              disabled={isUploading}
            />

            {isUploading ? (
              <div className="w-full space-y-2">
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <span className="flex items-center gap-1.5 truncate pr-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                    <span className="truncate">{uploadStatusText || '上传中…'}</span>
                  </span>
                  <span className="font-mono shrink-0">{uploadProgress}%</span>
                </div>
                <div className="w-full bg-zinc-800 h-1 overflow-hidden">
                  <div
                    className="bg-zinc-100 h-full transition-all duration-300"
                    style={{ width: `${Math.max(5, uploadProgress)}%` }}
                  />
                </div>
              </div>
            ) : (
              <span className="text-xs text-zinc-500">
                {isDragging ? '松开以上传' : '上传 PDF'}
              </span>
            )}
          </div>

          {uploadError && (
            <div className="text-xs text-red-400 space-y-1">
              <p className="leading-snug">{uploadError}</p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    setUploadError(null);
                    if (fileInputRef.current) fileInputRef.current.click();
                  }}
                  className="text-[11px] underline cursor-pointer"
                >
                  重试
                </button>
                <button
                  onClick={() => setUploadError(null)}
                  className="text-[11px] text-zinc-500 hover:text-zinc-200 cursor-pointer"
                >
                  忽略
                </button>
              </div>
            </div>
          )}

          {mountedBooks.length > 0 && (
            <div className="space-y-1">
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {mountedBooks.map((book) => (
                  <div key={book.id} className="py-2 flex items-start justify-between gap-2 group">
                    <div className="min-w-0">
                      <div className="text-xs text-zinc-200 truncate">{book.name}</div>
                      <div className="text-[11px] text-zinc-400 mt-0.5">
                        {book.pageCount ? `${book.pageCount} 页 · ` : ''}
                        {tocLabel(book.tocSource)}
                      </div>
                      {book.tocSource === 'synthesized' && (
                        <div className="mt-0.5 text-[11px] text-zinc-500">未识别目录，按每 30 页分块</div>
                      )}
                    </div>
                    <button
                      onClick={() => onRemoveBook(book.id)}
                      className="text-zinc-600 hover:text-zinc-200 p-0.5 cursor-pointer shrink-0"
                      title="移除"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="px-4 py-3 border-t border-zinc-800 flex items-center justify-between">
        <span className="text-[11px] text-zinc-500">
          {provider === 'gemini' ? 'Gemini · PDF' : 'OpenAI · 图像'}
        </span>
        <button
          onClick={onResetChat}
          className="text-xs text-zinc-500 hover:text-zinc-100 flex items-center gap-1 cursor-pointer"
          title="清空当前对话"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          重置
        </button>
      </div>
    </aside>
  );
};
