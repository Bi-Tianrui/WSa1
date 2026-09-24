import React, { useState } from 'react';
import {
  BookOpen,
  KeyRound,
  UploadCloud,
  FileText,
  Trash2,
  RotateCcw,
  Eye,
  EyeOff,
  RefreshCw,
  AlertTriangle,
  Globe,
  Loader2,
  AlertCircle,
  Zap,
  CheckCircle2,
  Server,
  Cpu,
  Check
} from 'lucide-react';
import { MountedBook, GeminiModelType, ApiProviderType } from '../types';

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
        setUploadStatusText(`正在上传《${file.name}》并解析大纲...`);
        const formData = new FormData();
        formData.append('file', file);
        formData.append('clientFileName', file.name);

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

  const URL_PRESETS = [
    { label: 'DeepSeek 官方', url: 'https://api.deepseek.com/v1' },
    { label: 'OpenAI 官方', url: 'https://api.openai.com/v1' },
    { label: 'Moonshot 官方', url: 'https://api.moonshot.cn/v1' },
    { label: '本地 Ollama', url: 'http://localhost:11434/v1' },
  ];

  return (
    <aside className="w-80 md:w-88 flex flex-col bg-slate-900 text-slate-100 border-r border-slate-800 shrink-0 h-full select-none overflow-hidden">
      {/* Brand Header */}
      <div className="p-4 border-b border-slate-800 bg-slate-950/40">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-blue-600/20 text-blue-400 border border-blue-500/30">
              <BookOpen className="w-5 h-5" />
            </div>
            <h1 className="text-sm font-semibold tracking-wide text-white">
              教材伴读助手
            </h1>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 font-mono border border-emerald-500/30 flex items-center gap-1">
            <Zap className="w-2.5 h-2.5" /> 双协议通用
          </span>
        </div>
      </div>

      {/* Scrollable Configuration Sections */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5 text-sm">
        {/* 1. Provider Toggle (服务商模式切换) */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-blue-400" />
              服务商模式切换 (Provider)
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-mono">
              协议解耦
            </span>
          </label>
          <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-950/70 rounded-lg border border-slate-800">
            <button
              type="button"
              onClick={() => onProviderChange('gemini')}
              className={`py-1.5 px-2 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                provider === 'gemini'
                  ? 'bg-blue-600 text-white shadow-xs font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>🌐 Google Gemini</span>
            </button>
            <button
              type="button"
              onClick={() => onProviderChange('openai_compatible')}
              className={`py-1.5 px-2 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                provider === 'openai_compatible'
                  ? 'bg-indigo-600 text-white shadow-xs font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>⚡ OpenAI / DeepSeek</span>
            </button>
          </div>
        </div>

        {/* 2. Dynamic Input Fields based on Provider */}
        {provider === 'gemini' ? (
          /* Google Gemini Mode Inputs */
          <div className="space-y-2 p-3 rounded-xl bg-slate-800/60 border border-slate-750">
            <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-amber-400" />
                Google Gemini API Key
              </span>
              {geminiApiKey ? (
                <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> 自定义Key
                </span>
              ) : (
                <span className="text-[11px] text-slate-400">使用环境变量</span>
              )}
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={geminiApiKey}
                onChange={(e) => onGeminiApiKeyChange(e.target.value)}
                placeholder="默认使用系统 GEMINI_API_KEY (可覆盖)"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono pr-9"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-slate-400 leading-tight">
              直连 Google 官方端点，章节切片以原生 PDF 形式送达。
            </p>
          </div>
        ) : (
          /* OpenAI / DeepSeek Compatible Inputs */
          <div className="space-y-3 p-3 rounded-xl bg-slate-800/60 border border-slate-750">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Server className="w-3.5 h-3.5 text-indigo-400" />
                  API 基础地址 (Base URL)
                </span>
              </label>
              <input
                type="text"
                value={openaiBaseUrl}
                onChange={(e) => onOpenaiBaseUrlChange(e.target.value)}
                placeholder="https://api.deepseek.com/v1"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 font-mono"
              />
              {/* Quick URL Preset Pills */}
              <div className="flex flex-wrap gap-1 pt-1">
                {URL_PRESETS.map((p) => (
                  <button
                    key={p.url}
                    type="button"
                    onClick={() => onOpenaiBaseUrlChange(p.url)}
                    className="text-[10px] px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-750 text-slate-300 border border-slate-700 transition-colors cursor-pointer"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <KeyRound className="w-3.5 h-3.5 text-amber-400" />
                  API Key (Bearer Token)
                </span>
                {openaiApiKey ? (
                  <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> 已填写
                  </span>
                ) : (
                  <span className="text-[11px] text-rose-400">必填</span>
                )}
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={openaiApiKey}
                  onChange={(e) => onOpenaiApiKeyChange(e.target.value)}
                  placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxxx"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 font-mono pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 3. Dynamic Model Discovery & Dropdown Engine (动态模型探测引擎与下拉框) */}
        <div className="p-3 rounded-xl bg-slate-800/80 border border-slate-700/80 space-y-3 shadow-xs">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-white flex items-center gap-1.5">
              <Cpu className="w-4 h-4 text-blue-400" />
              自适应模型下拉引擎
            </label>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-700 text-slate-300 font-mono">
              {discoveredModels.length > 0 ? `${discoveredModels.length} 个可用` : '待探测'}
            </span>
          </div>

          {/* Discovery Action Button */}
          <button
            type="button"
            onClick={onDiscoverModels}
            disabled={isDiscoveringModels}
            className="w-full py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 shadow-xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isDiscoveringModels ? 'animate-spin' : ''}`} />
            <span>
              {isDiscoveringModels ? '正在拉取当前 Key 授权的可用模型...' : '🔄 自动检测可用模型'}
            </span>
          </button>

          {/* Discovery Status Banner if present */}
          {discoveryStatus && (
            <div
              className={`p-2 rounded text-[11px] flex items-start gap-1.5 ${
                discoveryStatus.type === 'success'
                  ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-800/40'
                  : 'bg-rose-950/40 text-rose-300 border border-rose-800/40'
              }`}
            >
              {discoveryStatus.type === 'success' ? (
                <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
              )}
              <span className="leading-snug">{discoveryStatus.message}</span>
            </div>
          )}

          {/* Adaptive Graphical Model Dropdown */}
          <div className="space-y-1.5">
            <span className="text-[11px] text-slate-400 block font-medium">
              当前调用模型 (由真实 API 动态供给):
            </span>
            <select
              value={selectedModel}
              onChange={(e) => onModelChange(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-white focus:outline-hidden focus:ring-2 focus:ring-blue-500 font-mono truncate"
            >
              {discoveredModels.length > 0 ? (
                discoveredModels.map((m) => (
                  <option key={m} value={m} className="bg-slate-900 text-white">
                    {m}
                  </option>
                ))
              ) : (
                <option value={selectedModel}>{selectedModel || '暂无模型，请点击检测'}</option>
              )}
            </select>
          </div>

          <div className="text-[10px] text-slate-400 flex items-center justify-between pt-0.5">
            <span>选定: <strong className="text-blue-300 font-mono">{selectedModel}</strong></span>
            <span className="text-slate-500">自动持久化</span>
          </div>
        </div>

        {/* 3. Textbook Cloud Mount (File Uploader with Resilient Chunking) */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <UploadCloud className="w-3.5 h-3.5 text-cyan-400" />
              教材挂载 (PDF 教科书)
            </label>
            <span className="text-[11px] text-slate-400 font-mono">
              {mountedBooks.length} 本已载入
            </span>
          </div>

          {/* Upload Area */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => {
              if (!isUploading && fileInputRef.current) {
                fileInputRef.current.click();
              }
            }}
            className={`border-2 border-dashed rounded-xl p-3.5 flex flex-col items-center justify-center transition-all cursor-pointer select-none ${
              isDragging
                ? 'border-cyan-400 bg-cyan-950/40 ring-2 ring-cyan-500/30'
                : isUploading
                ? 'border-blue-500/60 bg-blue-950/30 cursor-wait'
                : 'border-slate-700/80 hover:border-blue-500/70 hover:bg-slate-800/40 bg-slate-800/25'
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
              <div className="w-full space-y-2 py-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-blue-300 flex items-center gap-1.5 truncate pr-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400 shrink-0" />
                    <span className="truncate">{uploadStatusText || '传输中...'}</span>
                  </span>
                  <span className="font-mono text-cyan-400 text-xs font-semibold shrink-0">
                    {uploadProgress}%
                  </span>
                </div>

                {/* Progress bar */}
                <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden border border-slate-700/60">
                  <div
                    className="bg-gradient-to-r from-blue-500 to-cyan-400 h-full rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${Math.max(5, uploadProgress)}%` }}
                  />
                </div>

                <div className="text-[10px] text-slate-400 flex items-center justify-between">
                  <span>标准 PDF 教材直接入库</span>
                  <span className="text-slate-400">大纲秒级解析</span>
                </div>
              </div>
            ) : (
              <>
                <UploadCloud
                  className={`w-6 h-6 mb-1 transition-transform ${
                    isDragging ? 'scale-110 text-cyan-400' : 'text-slate-400'
                  }`}
                />
                <span className="text-xs font-medium text-slate-200 text-center">
                  {isDragging ? '松开鼠标立即挂载教材' : '点击或拖拽上传 PDF 教材'}
                </span>
                <span className="text-[10px] text-slate-400 mt-0.5 text-center">
                  支持多本教材，自动索引大纲
                </span>
              </>
            )}
          </div>

          {/* Upload Error Banner */}
          {uploadError && (
            <div className="p-2.5 rounded-lg bg-red-950/50 border border-red-800/80 text-xs text-red-200 flex items-start gap-2 animate-in fade-in duration-200">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-[11px] leading-snug">{uploadError}</p>
                <div className="mt-1 flex items-center gap-2">
                  <button
                    onClick={() => {
                      setUploadError(null);
                      if (fileInputRef.current) fileInputRef.current.click();
                    }}
                    className="text-[11px] text-red-300 hover:text-white underline cursor-pointer"
                  >
                    重试上传
                  </button>
                  <button
                    onClick={() => setUploadError(null)}
                    className="text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    忽略
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Mounted Books List */}
          {mountedBooks.length > 0 && (
            <div className="space-y-2 mt-3">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="font-semibold text-slate-300">已挂载教材库</span>
                <button
                  onClick={onClearAllBooks}
                  className="text-red-400 hover:text-red-300 text-[11px] flex items-center gap-0.5 cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" /> 清空
                </button>
              </div>

              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {mountedBooks.map((book) => (
                  <div
                    key={book.id}
                    className="p-2.5 rounded-md bg-slate-800/80 border border-slate-700/80 flex items-center justify-between group"
                  >
                    <div className="overflow-hidden pr-2">
                      <div className="font-medium text-xs text-slate-200 truncate flex items-center gap-1.5">
                        <FileText className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                        <span className="truncate">{book.name}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 flex items-center gap-2 mt-1">
                        <span>{book.sizeMb} MB</span>
                        {book.pageCount ? (
                          <>
                            <span>•</span>
                            <span>{book.pageCount} 页</span>
                          </>
                        ) : null}
                        <span>•</span>
                        <span className="text-emerald-400 flex items-center gap-0.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block animate-pulse"></span>
                          {book.tocSource === 'bookmarks'
                            ? '书签目录已索引'
                            : book.tocSource === 'text-scan'
                            ? '正文目录已识别'
                            : 'TOC大纲已索引'}
                        </span>
                      </div>
                      {book.textLayer === 'none' && (
                        <div
                          className="mt-1 text-[10px] text-amber-300/90 flex items-start gap-1 leading-snug"
                          title="扫描版教材没有文字层，纯文本模型无法读取页面内容"
                        >
                          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
                          <span>扫描版（无文字层）· 建议用 Gemini 研读</span>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => onRemoveBook(book.id)}
                      className="text-slate-500 hover:text-red-400 p-1 rounded opacity-60 group-hover:opacity-100 transition-opacity cursor-pointer"
                      title="卸载该教材"
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

      {/* Footer Reset Action */}
      <div className="p-3 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between">
        <div className="text-[11px] text-slate-400 flex items-center gap-1">
          <Globe className="w-3.5 h-3.5 text-blue-400" />
          <span>{provider === 'gemini' ? 'Google 官方直连' : 'OpenAI / DeepSeek'}</span>
        </div>
        <button
          onClick={onResetChat}
          className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-2.5 py-1.5 rounded-md flex items-center gap-1 transition-colors cursor-pointer"
          title="重置当前问答对话"
        >
          <RotateCcw className="w-3.5 h-3.5" /> 重置对话
        </button>
      </div>
    </aside>
  );
};
