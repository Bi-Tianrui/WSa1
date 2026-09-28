import React, { useState, useRef, useEffect } from 'react';
import { Send, Square } from 'lucide-react';
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
  apiKey: _apiKey,
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

  // Mounting a book costs nothing: only the slice sent for the latest question does.
  // Showing the whole book's size here would misrepresent the "read like a human" flow.
  const lastContextTokens = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && typeof m.contextTokens === 'number')?.contextTokens;

  return (
    <main className="flex-1 flex flex-col h-full bg-zinc-950 relative overflow-hidden">
      <header className="h-10 border-b border-zinc-800 px-5 flex items-center justify-between shrink-0">
        <div className="min-w-0 text-xs text-zinc-500 truncate">
          {mountedBooks.length > 0 ? (
            <span title={mountedBooks.map((b) => b.name.replace(/\.pdf$/i, '')).join(' · ')}>
              {mountedBooks.length === 1
                ? mountedBooks[0].name.replace(/\.pdf$/i, '')
                : `${mountedBooks.length} 份文件`}
              {lastContextTokens
                ? `  ·  ~${Math.max(1, Math.round(lastContextTokens / 1000))}k`
                : ''}
            </span>
          ) : (
            <span>未挂载文件</span>
          )}
        </div>
        {selectedModel && (
          <span className="text-[11px] text-zinc-400 font-mono shrink-0 ml-3">{selectedModel}</span>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6">
        {messages.length === 0 && (
          <div className="max-w-2xl mx-auto mt-8 space-y-4">
            <p className="text-sm text-zinc-500">左侧选一种方式上传 PDF：教材走章节切片，习题或短文走整份阅读。</p>
            <div className="flex flex-wrap gap-2">
              {[
                {
                  label: '高斯散度定理',
                  text: '请结合教材，详细推导高斯散度定理证明过程与物理几何直观。',
                },
                {
                  label: '相似对角化',
                  text: '在教材关于特征值与特征向量部分，相似对角化的充要条件是什么？请注明页码出处。',
                },
                {
                  label: '麦克斯韦方程组',
                  text: '请用 Markdown 表格对比麦克斯韦方程组的微分与积分形式，并标明 SI 量纲。',
                },
                {
                  label: '热力学第二定律',
                  text: '请梳理教材中热力学第二定律克劳修斯表述与开尔文表述的等价性证明。',
                },
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => onSendMessage(item.text)}
                  className="px-2.5 py-1 rounded text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 cursor-pointer"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="max-w-2xl mx-auto space-y-6">
          {messages.map((msg) => (
            <div key={msg.id} className={msg.role === 'user' ? 'flex justify-end' : ''}>
              <div className={`max-w-[90%] ${msg.role === 'user' ? '' : 'w-full'}`}>
                {msg.role === 'user' ? (
                  <div className="text-sm leading-relaxed whitespace-pre-wrap text-zinc-100 bg-zinc-900 px-3.5 py-2.5 rounded">
                    {msg.content}
                  </div>
                ) : (
                  <div>
                    {msg.routing && msg.routing.matched && (
                      <p className="mb-2 text-[11px] text-zinc-400">
                        {msg.routing.label ||
                          `${msg.routing.bookName} · ${msg.routing.chapterTitle} · P${msg.routing.startPage}–${msg.routing.endPage}`}
                        {msg.routing.endPage && msg.routing.startPage
                          ? ` · ${msg.routing.endPage - msg.routing.startPage + 1} 页`
                          : ''}
                        {msg.contextTokens
                          ? ` · ~${Math.max(1, Math.round(msg.contextTokens / 1000))}k`
                          : ''}
                      </p>
                    )}
                    {!msg.routing && msg.bookCitation && (
                      <p className="mb-2 text-[11px] text-zinc-400">{msg.bookCitation}</p>
                    )}

                    {msg.notices && msg.notices.length > 0 && (
                      <div className="mb-2 space-y-1">
                        {msg.notices.map((notice, idx) => (
                          <p
                            key={idx}
                            className={`text-[11px] leading-relaxed ${
                              notice.level === 'warn' ? 'text-amber-400' : 'text-zinc-500'
                            }`}
                          >
                            {notice.message}
                          </p>
                        ))}
                      </div>
                    )}

                    {msg.reasoning && (
                      <details className="mb-2 text-xs text-zinc-500" open={isStreaming}>
                        <summary className="cursor-pointer select-none">推理过程</summary>
                        <div className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed max-h-60 overflow-y-auto">
                          {msg.reasoning}
                        </div>
                      </details>
                    )}

                    {!msg.content && isStreaming ? (
                      <p className="text-xs text-zinc-400">{msg.stage || '正在阅读教材…'}</p>
                    ) : (
                      <div className="text-zinc-200">
                        <FormattedMathContent content={msg.content} />
                        {isStreaming && msg.id === messages[messages.length - 1]?.id && (
                          <span className="inline-block w-px h-4 bg-zinc-100 ml-0.5 align-middle" />
                        )}
                      </div>
                    )}

                    {msg.content && (
                      <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-400">
                        <span>{msg.timestamp}</span>
                        <div className="flex items-center gap-3">
                          {onImportToLatex && (
                            <button
                              onClick={() => onImportToLatex(msg.content)}
                              className="hover:text-zinc-100 cursor-pointer"
                              title="导入到 LaTeX 编辑器"
                            >
                              导入 LaTeX
                            </button>
                          )}
                          <button
                            onClick={() => copyMarkdown(msg.content, msg.id)}
                            className="hover:text-zinc-100 cursor-pointer"
                          >
                            {copiedId === msg.id ? '已复制' : '复制'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <footer className="border-t border-zinc-800 bg-zinc-950 px-4 py-3 shrink-0">
        <div className="max-w-2xl mx-auto">
          <form onSubmit={handleSubmit} className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="提问教材中的定义、推导或习题…"
              rows={2}
              className="flex-1 resize-none bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-hidden focus:border-zinc-600"
            />

            {isStreaming && onStopStreaming ? (
              <button
                type="button"
                onClick={onStopStreaming}
                className="p-2.5 rounded text-zinc-500 hover:text-zinc-100 cursor-pointer"
                title="停止"
              >
                <Square className="w-4 h-4 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!inputText.trim() || isStreaming}
                className={`p-2.5 rounded ${
                  inputText.trim() && !isStreaming
                    ? 'bg-zinc-100 text-zinc-950 cursor-pointer'
                    : 'text-zinc-700 cursor-not-allowed'
                }`}
                title="发送"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </form>
        </div>
      </footer>
    </main>
  );
};
