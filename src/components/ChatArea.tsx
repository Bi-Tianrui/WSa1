import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  Sparkles,
  Copy,
  Check,
  BookMarked,
  GraduationCap,
  Calculator,
  Compass,
  FileSpreadsheet,
  AlertCircle,
  HelpCircle,
  Clock,
  Zap,
  FileCode,
  Info,
  Square
} from 'lucide-react';
import { ChatMessage, MountedBook, GeminiModelType } from '../types';
import { FormattedMathContent } from '../utils/latexParser';

interface ChatAreaProps {
  messages: ChatMessage[];
  mountedBooks: MountedBook[];
  selectedModel: GeminiModelType;
  isStreaming: boolean;
  onSendMessage: (text: string) => void;
  onStopStreaming?: () => void;
  apiKey: string;
  onImportToLatex?: (content: string) => void;
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  mountedBooks,
  selectedModel,
  isStreaming,
  onSendMessage,
  onStopStreaming,
  apiKey,
  onImportToLatex,
}) => {
  const [inputText, setInputText] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim() || isStreaming) return;
    onSendMessage(inputText.trim());
    setInputText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const copyMarkdown = (content: string, id: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  const totalTokens = mountedBooks.reduce((acc, b) => acc + b.tokensEstimate, 0);

  return (
    <main className="flex-1 flex flex-col h-full bg-slate-50 relative overflow-hidden">
      {/* Top Banner Status Bar */}
      <header className="h-14 border-b border-slate-200 bg-white/90 backdrop-blur-xs px-5 flex items-center justify-between shrink-0 z-10 shadow-xs">
        <div className="flex items-center gap-3 overflow-hidden">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="font-semibold text-slate-800 text-sm">
              大学工科教材伴读室
            </span>
          </div>

          <div className="h-4 w-px bg-slate-300"></div>

          <div className="flex items-center gap-2 overflow-hidden text-xs text-slate-600">
            {mountedBooks.length > 0 ? (
              <div className="flex items-center gap-1.5 truncate">
                <BookMarked className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                <span className="truncate">
                  正在研读：
                  <span className="font-medium text-slate-900">
                    {mountedBooks.map((b) => `《${b.name.replace(/\.pdf$/i, '')}》`).join('、')}
                  </span>
                </span>
                <span className="text-slate-400 font-mono text-[11px] bg-slate-100 px-1.5 py-0.5 rounded shrink-0">
                  ~{Math.round(totalTokens / 1000)}k 上下文
                </span>
              </div>
            ) : (
              <span className="text-slate-500 flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
                通识推导模式 (建议在左侧挂载教材 PDF 获得精准页码)
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="hidden sm:inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-medium bg-slate-100 text-slate-700 border border-slate-200 font-mono">
            {selectedModel}
          </span>
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
            打字机流式已开启
          </span>
        </div>
      </header>

      {/* Main Messages Feed */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-5">
        {/* Welcome Empty State */}
        {messages.length === 0 && (
          <div className="max-w-3xl mx-auto my-3">
            <div className="bg-white border border-slate-200/80 rounded-xl p-4 md:p-5 shadow-xs space-y-3.5">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-blue-600/10 text-blue-600 flex items-center justify-center shrink-0 border border-blue-200/50">
                  <GraduationCap className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-sm md:text-base font-bold text-slate-900">
                    大学工科教材伴读室
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    挂载教材即可展开高精度定理推导与学术排版
                  </p>
                </div>
              </div>

              {/* Minimalist Question Pill Buttons */}
              <div className="pt-2.5 border-t border-slate-100 flex flex-wrap gap-2 items-center">
                <button
                  type="button"
                  onClick={() =>
                    onSendMessage('请结合教材，详细推导高斯散度定理证明过程与物理几何直观。')
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-slate-50 hover:bg-blue-50 text-slate-700 hover:text-blue-700 border border-slate-200 hover:border-blue-300 transition-all cursor-pointer whitespace-nowrap"
                >
                  <Calculator className="w-3.5 h-3.5 text-blue-600" />
                  <span>高斯散度定理证明</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    onSendMessage('在教材关于特征值与特征向量部分，相似对角化的充要条件是什么？请注明页码出处。')
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-slate-50 hover:bg-indigo-50 text-slate-700 hover:text-indigo-700 border border-slate-200 hover:border-indigo-300 transition-all cursor-pointer whitespace-nowrap"
                >
                  <Compass className="w-3.5 h-3.5 text-indigo-600" />
                  <span>矩阵相似对角化充要条件</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    onSendMessage('请用 Markdown 表格对比麦克斯韦方程组的微分与积分形式，并标明 SI 量纲。')
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-slate-50 hover:bg-emerald-50 text-slate-700 hover:text-emerald-700 border border-slate-200 hover:border-emerald-300 transition-all cursor-pointer whitespace-nowrap"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
                  <span>麦克斯韦方程组量纲对比表</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    onSendMessage('请梳理教材中热力学第二定律克劳修斯表述与开尔文表述的等价性证明及关键考点。')
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-slate-50 hover:bg-amber-50 text-slate-700 hover:text-amber-700 border border-slate-200 hover:border-amber-300 transition-all cursor-pointer whitespace-nowrap"
                >
                  <HelpCircle className="w-3.5 h-3.5 text-amber-600" />
                  <span>热力学第二定律等价性证明</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Message Items */}
        <div className="max-w-3xl mx-auto space-y-5">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {/* Professor Avatar */}
              {msg.role === 'assistant' && (
                <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center shrink-0 shadow-xs mt-1">
                  <GraduationCap className="w-4 h-4" />
                </div>
              )}

              {/* Message Content Container */}
              <div
                className={`max-w-[88%] md:max-w-[85%] rounded-xl px-4 py-3.5 shadow-xs transition-all ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white rounded-tr-xs'
                    : 'bg-white border border-slate-200 text-slate-800 rounded-tl-xs'
                }`}
              >
                {/* User Message */}
                {msg.role === 'user' ? (
                  <div className="text-sm leading-relaxed whitespace-pre-wrap font-sans">
                    {msg.content}
                  </div>
                ) : (
                  /* Assistant Message with LaTeX & Markdown rendering */
                  <div>
                    {/* Header Badges: Citation & Cache Hit */}
                    <div className="flex flex-wrap items-center gap-1.5 mb-2">
                      {msg.cacheHit && (
                        <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 text-[11px] border border-amber-300/80 font-mono font-medium shadow-2xs">
                          <Zap className="w-3 h-3 fill-amber-500 text-amber-600" />
                          <span>Context Cache 极速</span>
                          {msg.responseTimeMs && (
                            <span className="text-emerald-700 bg-emerald-100/80 px-1 rounded text-[10px] font-sans">
                              {(msg.responseTimeMs / 1000).toFixed(2)}s
                            </span>
                          )}
                        </div>
                      )}

                      {msg.routing && msg.routing.matched && (
                        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-50/90 border border-blue-200 text-blue-900 text-xs font-sans shadow-2xs">
                          <BookMarked className="w-4 h-4 text-blue-600 shrink-0" />
                          <span className="font-semibold">
                            {msg.routing.label ||
                              `📖 智能图书管理员已查阅目录并锁定：《${msg.routing.bookName}》${msg.routing.chapterTitle} (P${msg.routing.startPage} - P${msg.routing.endPage})`}
                          </span>
                          <span className="text-[10px] bg-blue-100/90 text-blue-700 px-1.5 py-0.5 rounded font-mono font-medium shrink-0">
                            毫秒级切片 ~{msg.routing.endPage && msg.routing.startPage ? msg.routing.endPage - msg.routing.startPage + 1 : 20}页
                          </span>
                        </div>
                      )}

                      {!msg.routing && msg.bookCitation && (
                        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-xs border border-blue-200/80 font-medium">
                          <BookMarked className="w-3 h-3" />
                          {msg.bookCitation}
                        </div>
                      )}
                    </div>

                    {/* Backend notices: scanned book, routing miss, degraded extraction */}
                    {msg.notices && msg.notices.length > 0 && (
                      <div className="mb-2.5 space-y-1.5">
                        {msg.notices.map((notice, idx) => (
                          <div
                            key={idx}
                            className={`flex items-start gap-2 px-2.5 py-2 rounded-lg text-[11px] leading-relaxed border ${
                              notice.level === 'warn'
                                ? 'bg-amber-50 border-amber-200 text-amber-900'
                                : 'bg-slate-50 border-slate-200 text-slate-600'
                            }`}
                          >
                            {notice.level === 'warn' ? (
                              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px text-amber-600" />
                            ) : (
                              <Info className="w-3.5 h-3.5 shrink-0 mt-px text-slate-500" />
                            )}
                            <span>{notice.message}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* DeepSeek Reasoning Content if available */}
                    {msg.reasoning && (
                      <details className="mb-2.5 p-2 rounded-lg bg-slate-50/90 border border-indigo-100 text-xs text-slate-600 group" open={isStreaming}>
                        <summary className="font-semibold text-indigo-900 cursor-pointer select-none flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                          <span>思维链推导 (DeepSeek / Reasoning)</span>
                        </summary>
                        <div className="mt-2 text-[11px] font-sans whitespace-pre-wrap text-slate-600 bg-white/90 p-2.5 rounded border border-slate-200 leading-relaxed max-h-60 overflow-y-auto">
                          {msg.reasoning}
                        </div>
                      </details>
                    )}

                    {/* If waiting for first chunk and streaming */}
                    {!msg.content && isStreaming ? (
                      <div className="flex items-center gap-2.5 text-xs text-slate-600 py-1.5">
                        <div className="flex space-x-1 items-center">
                          <div className="w-2 h-2 rounded-full bg-blue-500 animate-bounce"></div>
                          <div className="w-2 h-2 rounded-full bg-blue-500 animate-bounce [animation-delay:0.15s]"></div>
                          <div className="w-2 h-2 rounded-full bg-blue-500 animate-bounce [animation-delay:0.3s]"></div>
                        </div>
                        <span className="text-slate-500 font-medium">
                          {msg.stage || '教授正在检索教材与推演 LaTeX 公式...'}
                        </span>
                      </div>
                    ) : (
                      <div>
                        <FormattedMathContent content={msg.content} />
                        {/* Live streaming cursor */}
                        {isStreaming && msg.id === messages[messages.length - 1]?.id && (
                          <span className="inline-block w-1.5 h-4 bg-blue-600 animate-pulse ml-0.5 align-middle" />
                        )}
                      </div>
                    )}

                    {/* Copy Markdown Note action bar (only show when content exists) */}
                    {msg.content && (
                      <div className="mt-3.5 pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                        <span className="flex items-center gap-1 text-[11px] text-slate-400">
                          <Clock className="w-3 h-3" /> {msg.timestamp}
                        </span>

                        <div className="flex items-center gap-2">
                          {onImportToLatex && (
                            <button
                              onClick={() => onImportToLatex(msg.content)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-medium border border-indigo-200 transition-colors cursor-pointer shadow-2xs"
                              title="将本轮学术回答转换为标准 LaTeX 论文格式，并自动切换至 LaTeX 双联预览室"
                            >
                              <FileCode className="w-3.5 h-3.5 text-indigo-600" />
                              <span>📌 导入至 LaTeX 排版室</span>
                            </button>
                          )}

                          <button
                            onClick={() => copyMarkdown(msg.content, msg.id)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium transition-colors cursor-pointer"
                            title="复制完整的 Markdown 笔记文本"
                          >
                            {copiedId === msg.id ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-600" />
                                <span className="text-emerald-700">已复制笔记</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5 text-slate-600" />
                                <span>复制 Markdown 笔记</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Student Avatar */}
              {msg.role === 'user' && (
                <div className="w-8 h-8 rounded-full bg-slate-800 text-slate-200 flex items-center justify-center shrink-0 shadow-xs mt-1 text-xs font-medium">
                  生
                </div>
              )}
            </div>
          ))}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Bottom Chat Input Bar */}
      <footer className="border-t border-slate-200 bg-white p-3 md:p-4 shrink-0 shadow-xs">
        <div className="max-w-3xl mx-auto">
          {!apiKey && (
            <div className="mb-2 p-2 bg-blue-50 border border-blue-200 rounded-lg flex items-center gap-2 text-xs text-blue-800">
              <Sparkles className="w-4 h-4 text-blue-600 shrink-0" />
              <span>
                系统已连接实时真实 Gemini API 引擎。可直接输入任意理工科问题或在左侧上传 PDF 教材进行实时推导！
              </span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="relative flex items-end gap-2">
            <div className="relative flex-1">
              <textarea
                ref={textareaRef}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="向教授请教教材中的定理、公式推导、概念疑问或课后习题 (Enter 发送，Shift+Enter 换行)..."
                rows={2}
                className="w-full resize-none bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all pr-10"
              />
            </div>

            {isStreaming && onStopStreaming ? (
              <button
                type="button"
                onClick={onStopStreaming}
                className="p-3 rounded-xl flex items-center justify-center bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 transition-all cursor-pointer"
                title="终止本轮生成"
              >
                <Square className="w-4 h-4 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!inputText.trim() || isStreaming}
                className={`p-3 rounded-xl flex items-center justify-center transition-all ${
                  inputText.trim() && !isStreaming
                    ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-xs cursor-pointer'
                    : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                }`}
                title="发送提问"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </form>

          <div className="mt-2 text-center text-[11px] text-slate-400">
            Enter 发送 · Shift+Enter 换行 · 自动渲染 LaTeX ($$)
          </div>
        </div>
      </footer>
    </main>
  );
};
