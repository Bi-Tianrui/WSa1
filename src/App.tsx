import React, { useState, useEffect, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { SourceCodeViewer } from './components/SourceCodeViewer';
import { LatexStudio, DEFAULT_ACADEMIC_LATEX_TEMPLATE } from './components/LatexStudio';
import { ChatMessage, MountedBook, ApiProviderType, ModelDiscoveryResponse } from './types';
import { Terminal, MessageSquare, FileCode, Sparkles, Cpu, RefreshCw, Globe, Zap, Check } from 'lucide-react';

export default function App() {
  const [activeView, setActiveView] = useState<'chat' | 'latex' | 'code'>('chat');

  // Multi-Provider Authentication State
  const [provider, setProvider] = useState<ApiProviderType>(() => {
    return (localStorage.getItem('api_provider') as ApiProviderType) || 'gemini';
  });
  const [geminiApiKey, setGeminiApiKey] = useState<string>(() => {
    return localStorage.getItem('gemini_api_key') || '';
  });
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState<string>(() => {
    return localStorage.getItem('openai_base_url') || 'https://api.deepseek.com/v1';
  });
  const [openaiApiKey, setOpenaiApiKey] = useState<string>(() => {
    return localStorage.getItem('openai_api_key') || '';
  });

  // Dynamic Models State
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    const currP = (localStorage.getItem('api_provider') as ApiProviderType) || 'gemini';
    const saved = localStorage.getItem(`selected_model_${currP}`);
    if (saved) return saved;
    const cached = localStorage.getItem(`discovered_models_${currP}`);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed[0]) return parsed[0];
      } catch {}
    }
    return '';
  });
  const [discoveredModels, setDiscoveredModels] = useState<string[]>(() => {
    const currP = (localStorage.getItem('api_provider') as ApiProviderType) || 'gemini';
    const cached = localStorage.getItem(`discovered_models_${currP}`);
    if (cached) {
      try { return JSON.parse(cached); } catch {}
    }
    return [];
  });
  const [isDiscoveringModels, setIsDiscoveringModels] = useState(false);
  const [discoveryStatus, setDiscoveryStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [mountedBooks, setMountedBooks] = useState<MountedBook[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [latexCode, setLatexCode] = useState<string>(DEFAULT_ACADEMIC_LATEX_TEMPLATE);
  const [hasImportedLatex, setHasImportedLatex] = useState(false);

  // Dynamic Model Discovery Execution
  const handleDiscoverModels = useCallback(
    async (targetProvider?: ApiProviderType, targetKey?: string, targetUrl?: string) => {
      const p = targetProvider ?? provider;
      const k = targetKey ?? (p === 'gemini' ? geminiApiKey : openaiApiKey);
      const u = targetUrl ?? openaiBaseUrl;

      setIsDiscoveringModels(true);
      setDiscoveryStatus(null);

      try {
        const res = await fetch('/api/models/discover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: p,
            apiKey: k || undefined,
            baseUrl: u || undefined,
          }),
        });

        const data: ModelDiscoveryResponse = await res.json();
        if (!res.ok || !data.success || !data.models || data.models.length === 0) {
          throw new Error(data.error || '未检索到可用模型或端点无法访问');
        }

        setDiscoveredModels(data.models);
        localStorage.setItem(`discovered_models_${p}`, JSON.stringify(data.models));

        // Auto-select dynamically discovered top model if current selection isn't valid
        let active = selectedModel;
        if (!active || !data.models.includes(active)) {
          active = data.models[0] || '';
          setSelectedModel(active);
          if (active) {
            localStorage.setItem(`selected_model_${p}`, active);
          }
        }

        setDiscoveryStatus({
          type: 'success',
          message: `已探测到 ${data.models.length} 个可用模型 (首选: ${active})`,
        });
      } catch (err: any) {
        console.error('Model discovery error:', err);
        setDiscoveryStatus({
          type: 'error',
          message: err?.message || '探测失败，请检查网络或密钥配置',
        });
      } finally {
        setIsDiscoveringModels(false);
      }
    },
    [provider, geminiApiKey, openaiApiKey, openaiBaseUrl, selectedModel]
  );

  // Auto trigger model discovery and fetch indexed books on first mount
  useEffect(() => {
    if (discoveredModels.length === 0 || !selectedModel) {
      handleDiscoverModels();
    }
    // Fetch server-persisted books
    fetch('/api/books')
      .then((res) => res.json())
      .then((data) => {
        if (data?.success && Array.isArray(data?.books)) {
          setMountedBooks(
            data.books.map((b: any) => ({
              id: b.id,
              name: b.name,
              sizeMb: b.sizeMb,
              pageCount: b.pageCount || 100,
              tokensEstimate: Math.round((b.pageCount || 100) * 800),
              status: 'ready' as const,
              uploadTime: b.uploadTime || '刚刚',
              toc: b.toc || [],
            }))
          );
        }
      })
      .catch((err) => console.warn('Fetch books error:', err));
  }, []);

  const handleProviderChange = (newProvider: ApiProviderType) => {
    setProvider(newProvider);
    localStorage.setItem('api_provider', newProvider);
    setDiscoveryStatus(null);

    const cached = localStorage.getItem(`discovered_models_${newProvider}`);
    let list: string[] = [];
    if (cached) {
      try { list = JSON.parse(cached); } catch {}
    }
    setDiscoveredModels(list);

    const savedModel = localStorage.getItem(`selected_model_${newProvider}`);
    const modelToSet = savedModel || (list.length > 0 ? list[0] : '');
    setSelectedModel(modelToSet);
    if (modelToSet) {
      localStorage.setItem(`selected_model_${newProvider}`, modelToSet);
    }

    const key = newProvider === 'gemini' ? geminiApiKey : openaiApiKey;
    handleDiscoverModels(newProvider, key, openaiBaseUrl);
  };

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    localStorage.setItem(`selected_model_${provider}`, model);
  };

  const handleGeminiApiKeyChange = (key: string) => {
    setGeminiApiKey(key);
    localStorage.setItem('gemini_api_key', key);
  };

  const handleOpenaiBaseUrlChange = (url: string) => {
    setOpenaiBaseUrl(url);
    localStorage.setItem('openai_base_url', url);
  };

  const handleOpenaiApiKeyChange = (key: string) => {
    setOpenaiApiKey(key);
    localStorage.setItem('openai_api_key', key);
  };

  // Convert assistant markdown reply to standard academic ctexart format
  const convertMarkdownToAcademicLatex = (markdownText: string): string => {
    const lines = markdownText.trim().split('\n');
    const texBody: string[] = [];
    let inTable = false;
    let tableLines: string[] = [];

    const flushTable = (tbl: string[]) => {
      if (!tbl || tbl.length < 2) return '';
      const header = tbl[0]
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim());
      const cols = header.length;
      const colAlign = 'c'.repeat(cols);
      const res: string[] = [
        '\\begin{table}[htbp]',
        '\\centering',
        `\\begin{tabular}{${colAlign}}`,
        '\\toprule',
        header.join(' & ') + ' \\\\',
        '\\midrule',
      ];
      for (let r = 2; r < tbl.length; r++) {
        const cells = tbl[r]
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
        if (cells.length === cols) {
          res.push(cells.join(' & ') + ' \\\\');
        }
      }
      res.push('\\bottomrule', '\\end{tabular}', '\\end{table}');
      return res.join('\n');
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('|') && line.endsWith('|')) {
        inTable = true;
        tableLines.push(line);
        continue;
      } else if (inTable) {
        inTable = false;
        texBody.push(flushTable(tableLines));
        tableLines = [];
      }

      if (line.startsWith('### ')) {
        texBody.push(`\\subsubsection*{${line.slice(4)}}`);
      } else if (line.startsWith('## ')) {
        texBody.push(`\\subsection*{${line.slice(3)}}`);
      } else if (line.startsWith('# ')) {
        texBody.push(`\\section*{${line.slice(2)}}`);
      } else if (line.startsWith('- ') || line.startsWith('* ')) {
        texBody.push(`\\item ${line.slice(2)}`);
      } else if (line.startsWith('> ')) {
        texBody.push(`\\begin{quote}\n\\small ${line.slice(2)}\n\\end{quote}`);
      } else {
        texBody.push(line);
      }
    }

    if (inTable && tableLines.length > 0) {
      texBody.push(flushTable(tableLines));
    }

    let raw = texBody.join('\n');
    raw = raw.replace(/\*\*(.*?)\*\*/g, '\\textbf{$1}');
    raw = raw.replace(/📖 出处：(.*?)(?=\n|$)/g, '\\textcolor{blue}{\\small \\textbf{出处：}$1}');

    return `\\documentclass[11pt,a4paper]{ctexart}
\\usepackage{amsmath,amssymb,amsfonts,amsthm}
\\usepackage{geometry}
\\geometry{left=2.5cm,right=2.5cm,top=2.5cm,bottom=2.5cm}
\\usepackage{booktabs}
\\usepackage{hyperref}
\\usepackage{xcolor}
\\usepackage{fancyhdr}
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[L]{\\small\\textcolor{gray}{工科教材智能伴读学术推演笔记}}
\\fancyhead[R]{\\small\\textcolor{gray}{\\thepage}}

\\title{\\textbf{\\LARGE 理工科教材学术定理推演与伴读笔记}}
\\author{\\large 工科教材伴读研学室}
\\date{\\today}

\\begin{document}
\\maketitle

${raw}

\\end{document}`;
  };

  const handleImportToLatex = (content: string) => {
    const formattedCode = convertMarkdownToAcademicLatex(content);
    setLatexCode(formattedCode);
    setActiveView('latex');
    setHasImportedLatex(true);
    setTimeout(() => setHasImportedLatex(false), 5000);
  };

  const handleAddBook = (book: MountedBook) => {
    setMountedBooks((prev) => [...prev.filter((b) => b.name !== book.name), book]);
  };

  const handleRemoveBook = async (id: string) => {
    setMountedBooks((prev) => prev.filter((b) => b.id !== id));
    try {
      await fetch(`/api/books/${id}`, { method: 'DELETE' });
    } catch {}
  };

  const handleClearAllBooks = async () => {
    const current = [...mountedBooks];
    setMountedBooks([]);
    for (const b of current) {
      try {
        await fetch(`/api/books/${b.id}`, { method: 'DELETE' });
      } catch {}
    }
  };

  const handleResetChat = () => {
    setMessages([]);
  };

  // Real Multi-Provider Unified SSE Streaming Chat
  const handleSendMessage = async (text: string) => {
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    const currentHistory = [...messages, userMsg];
    setMessages(currentHistory);
    setIsStreaming(true);

    const startTime = performance.now();
    const assistantId = `assistant-${Date.now()}`;
    const initialAssistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, initialAssistantMsg]);

    try {
      const activeKey = provider === 'gemini' ? geminiApiKey : openaiApiKey;
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-provider': provider,
          ...(geminiApiKey ? { 'x-gemini-api-key': geminiApiKey } : {}),
        },
        body: JSON.stringify({
          provider: provider,
          baseUrl: openaiBaseUrl || undefined,
          model: selectedModel,
          prompt: text,
          history: messages
            .filter((m) => !m.id.startsWith('sys-') && !m.isError && m.content && m.content.trim())
            .map((m) => ({ role: m.role, content: m.content })),
          bookIds: mountedBooks.map((b) => b.id),
          books: mountedBooks.map((b) => ({ id: b.id, name: b.name })),
          customApiKey: activeKey || undefined,
        }),
      });

      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        throw new Error(errorJson.error || `服务请求失败 (HTTP ${response.status})`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('浏览器未返回可读数据流');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedContent = '';
      let accumulatedReasoning = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const jsonStr = trimmed.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const data = JSON.parse(jsonStr);
            if (data.error) {
              throw new Error(data.error);
            }
            if (data.routing) {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantId
                    ? {
                        ...msg,
                        routing: data.routing,
                        bookCitation:
                          data.routing.label ||
                          `《${data.routing.bookName}》${data.routing.chapterTitle} (P${data.routing.startPage} - P${data.routing.endPage})`,
                      }
                    : msg
                )
              );
            }
            if (data.cacheHit) {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantId
                    ? {
                        ...msg,
                        cacheHit: true,
                        cacheHandle: data.cacheHandle || msg.cacheHandle,
                      }
                    : msg
                )
              );
            }
            if (data.reasoning) {
              accumulatedReasoning += data.reasoning;
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantId
                    ? {
                        ...msg,
                        reasoning: accumulatedReasoning,
                        responseTimeMs: Math.round(performance.now() - startTime),
                      }
                    : msg
                )
              );
            }
            if (data.text) {
              accumulatedContent += data.text;
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantId
                    ? {
                        ...msg,
                        content: accumulatedContent,
                        reasoning: accumulatedReasoning || undefined,
                        responseTimeMs: Math.round(performance.now() - startTime),
                      }
                    : msg
                )
              );
            }
          } catch (jsonErr: any) {
            if (jsonErr?.message && !jsonErr.message.includes('Unexpected end of JSON')) {
              throw jsonErr;
            }
          }
        }
      }

      const totalResponseTimeMs = Math.round(performance.now() - startTime);

      if (!accumulatedContent && !accumulatedReasoning) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: '（模型暂未返回文本，请检查 API Key、Base URL 或网络连接后重试）',
                  responseTimeMs: totalResponseTimeMs,
                }
              : msg
          )
        );
      } else {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: accumulatedContent,
                  reasoning: accumulatedReasoning || undefined,
                  responseTimeMs: totalResponseTimeMs,
                }
              : msg
          )
        );
      }
    } catch (err: any) {
      console.error('API Call Error:', err);
      const errText = err?.message || '调用 API 时发生未知错误';
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: `❌ **请求出错**: ${errText}\n\n*请检查左侧边栏的 API Key、Base URL 是否有效，或检查网络连接。*`,
              }
            : msg
        )
      );
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-slate-100 font-sans">
      {/* Top Application Bar */}
      <nav className="h-11 bg-slate-950 border-b border-slate-800 px-3 md:px-4 flex items-center justify-between shrink-0 select-none z-20">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-white text-xs font-bold tracking-wide">
              理工科教材伴读助手
            </span>
          </div>

          {/* Dynamic Model Dropdown Control in Navigation Bar */}
          <div className="hidden lg:flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-0.5 text-xs">
            <span className="flex items-center gap-1 text-[11px] font-medium text-slate-300">
              {provider === 'gemini' ? (
                <Globe className="w-3.5 h-3.5 text-blue-400" />
              ) : (
                <Zap className="w-3.5 h-3.5 text-indigo-400" />
              )}
              <span className="font-mono">
                {provider === 'gemini' ? 'Google 官方' : 'OpenAI/DeepSeek'}
              </span>
            </span>
            <div className="h-3 w-px bg-slate-700"></div>
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="bg-transparent text-xs text-white font-mono border-none focus:outline-hidden cursor-pointer max-w-[180px] truncate"
              title="当前调用的模型"
            >
              {discoveredModels.length > 0 ? (
                discoveredModels.map((m) => (
                  <option key={m} value={m} className="bg-slate-900 text-white font-mono">
                    {m}
                  </option>
                ))
              ) : (
                <option value={selectedModel} className="bg-slate-900 text-white font-mono">
                  {selectedModel}
                </option>
              )}
            </select>
            <button
              type="button"
              onClick={() => handleDiscoverModels()}
              disabled={isDiscoveringModels}
              className="p-0.5 text-slate-400 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
              title="刷新检测可用模型"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isDiscoveringModels ? 'animate-spin text-blue-400' : ''}`} />
            </button>
          </div>
        </div>

        {/* View Switcher Tabs */}
        <div className="flex items-center gap-1 bg-slate-900 p-0.5 rounded-lg border border-slate-800">
          <button
            onClick={() => setActiveView('chat')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
              activeView === 'chat'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>💬 教材伴读答疑</span>
          </button>

          <button
            onClick={() => setActiveView('latex')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer relative ${
              activeView === 'latex'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileCode className="w-3.5 h-3.5" />
            <span>📐 LaTeX 编译与 PDF 双联预览室</span>
            {hasImportedLatex && (
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping absolute -top-0.5 -right-0.5"></span>
            )}
          </button>

          <button
            onClick={() => setActiveView('code')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer ${
              activeView === 'code'
                ? 'bg-emerald-700 text-white shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>💻 Ubuntu 源码与脚本 (3个文件)</span>
          </button>
        </div>
      </nav>

      {/* Main Workspace */}
      <div className="flex-1 flex overflow-hidden">
        {activeView === 'chat' && (
          <div className="flex w-full h-full overflow-hidden">
            {/* Left Sidebar (Settings, Dynamic Discovery & Library) */}
            <Sidebar
              provider={provider}
              onProviderChange={handleProviderChange}
              geminiApiKey={geminiApiKey}
              onGeminiApiKeyChange={handleGeminiApiKeyChange}
              openaiBaseUrl={openaiBaseUrl}
              onOpenaiBaseUrlChange={handleOpenaiBaseUrlChange}
              openaiApiKey={openaiApiKey}
              onOpenaiApiKeyChange={handleOpenaiApiKeyChange}
              selectedModel={selectedModel}
              onModelChange={handleModelChange}
              discoveredModels={discoveredModels}
              isDiscoveringModels={isDiscoveringModels}
              onDiscoverModels={() => handleDiscoverModels()}
              discoveryStatus={discoveryStatus}
              mountedBooks={mountedBooks}
              onAddBook={handleAddBook}
              onRemoveBook={handleRemoveBook}
              onClearAllBooks={handleClearAllBooks}
              onResetChat={handleResetChat}
            />

            {/* Right Chat Area (LaTeX, Tables, Streaming, Notes) */}
            <ChatArea
              messages={messages}
              mountedBooks={mountedBooks}
              selectedModel={selectedModel}
              isStreaming={isStreaming}
              onSendMessage={handleSendMessage}
              apiKey={geminiApiKey}
              onImportToLatex={handleImportToLatex}
            />
          </div>
        )}

        {activeView === 'latex' && (
          <LatexStudio
            latexCode={latexCode}
            onLatexCodeChange={setLatexCode}
            onSwitchToChat={() => setActiveView('chat')}
          />
        )}

        {activeView === 'code' && (
          /* Ubuntu Source Code Viewer & Export */
          <SourceCodeViewer />
        )}
      </div>
    </div>
  );
}
