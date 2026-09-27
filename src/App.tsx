import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { SourceCodeViewer } from './components/SourceCodeViewer';
import { LatexStudio, DEFAULT_ACADEMIC_LATEX_TEMPLATE } from './components/LatexStudio';
import { ChatMessage, MountedBook, ApiProviderType, ModelDiscoveryResponse, StreamNotice } from './types';
import { markdownToLatexDocument } from './utils/markdownToLatex';
import { isRetiredGeminiFlash, isUnusableReadingModel, pickPreferredModel } from '../server/models';
import { Terminal, MessageSquare, FileCode, RefreshCw } from 'lucide-react';

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
    return localStorage.getItem('openai_base_url') || 'https://api.openai.com/v1';
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
  const abortRef = useRef<AbortController | null>(null);

  const handleDiscoverModels = useCallback(
    async (
      targetProvider?: ApiProviderType,
      targetKey?: string,
      targetUrl?: string
    ): Promise<{ ok: boolean; model: string; error?: string }> => {
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

        const preferred = pickPreferredModel(data.models);
        let active = selectedModel;
        if (
          !active ||
          !data.models.includes(active) ||
          isUnusableReadingModel(active) ||
          isRetiredGeminiFlash(active)
        ) {
          active = preferred;
          setSelectedModel(active);
          if (active) localStorage.setItem(`selected_model_${p}`, active);
        }

        setDiscoveryStatus({
          type: 'success',
          message: `已探测到 ${data.models.length} 个可用模型 (首选: ${active})`,
        });
        return { ok: true, model: active };
      } catch (err: any) {
        console.error('Model discovery error:', err);
        const message = err?.message || '探测失败，请检查网络或密钥配置';
        setDiscoveryStatus({ type: 'error', message });
        return { ok: false, model: '', error: message };
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
              status: 'ready' as const,
              uploadTime: b.uploadTime || '刚刚',
              toc: b.toc || [],
              tocSource: b.tocSource,
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


  const handleImportToLatex = (content: string) => {
    const formattedCode = markdownToLatexDocument(content);
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

  // A healthy stream emits a heartbeat every 15s, so silence this long means the
  // connection died somewhere upstream and the UI must stop waiting on it.
  const STREAM_IDLE_TIMEOUT_MS = 90_000;

  const handleStopStreaming = () => {
    abortRef.current?.abort(new DOMException('用户已终止本轮生成', 'AbortError'));
  };

  /** Reads one chunk, rejecting if the stream goes silent past the idle timeout. */
  const readWithIdleTimeout = async (
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('STREAM_IDLE')), STREAM_IDLE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([reader.read(), idle]);
    } finally {
      clearTimeout(timer);
    }
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

    const controller = new AbortController();
    abortRef.current = controller;

    const patchAssistant = (patch: Partial<ChatMessage>) => {
      setMessages((prev) => prev.map((msg) => (msg.id === assistantId ? { ...msg, ...patch } : msg)));
    };

    try {
      const activeKey = provider === 'gemini' ? geminiApiKey : openaiApiKey;
      patchAssistant({ stage: '正在验证 API Key、Base URL 与可用模型…' });
      const preflight = await handleDiscoverModels();
      if (!preflight.ok) {
        throw new Error(preflight.error || '发问前未能验证 API Key 或 Base URL');
      }
      const modelToUse = preflight.model || selectedModel;

      const response = await fetch('/api/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-provider': provider,
          ...(geminiApiKey ? { 'x-gemini-api-key': geminiApiKey } : {}),
        },
        body: JSON.stringify({
          provider: provider,
          baseUrl: openaiBaseUrl || undefined,
          model: modelToUse,
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
      const notices: StreamNotice[] = [];
      let serverError: { message: string; hint?: string } | null = null;

      streaming: while (true) {
        const { done, value } = await readWithIdleTimeout(reader);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          // Lines beginning with ':' are keep-alive comment frames.
          if (!trimmed.startsWith('data: ')) continue;
          const jsonStr = trimmed.slice(6).trim();
          if (!jsonStr) continue;

          let data: any;
          try {
            data = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          if (data.error) {
            serverError = { message: String(data.error), hint: data.hint ? String(data.hint) : undefined };
            break streaming;
          }
          if (data.stage) {
            patchAssistant({ stage: String(data.stage) });
          }
          if (data.notice?.message) {
            notices.push({
              level: data.notice.level === 'warn' ? 'warn' : 'info',
              message: String(data.notice.message),
            });
            patchAssistant({ notices: [...notices] });
          }
          if (data.routing) {
            patchAssistant({
              routing: data.routing,
              contextTokens: data.routing.contextTokens,
              bookCitation:
                data.routing.label ||
                `《${data.routing.bookName}》${data.routing.chapterTitle} (P${data.routing.startPage} - P${data.routing.endPage})`,
            });
          }
          if (typeof data.contextTokens === 'number') {
            patchAssistant({ contextTokens: data.contextTokens });
          }
          if (data.reasoning) {
            accumulatedReasoning += data.reasoning;
            patchAssistant({
              reasoning: accumulatedReasoning,
              stage: undefined,
              responseTimeMs: Math.round(performance.now() - startTime),
            });
          }
          if (data.text) {
            accumulatedContent += data.text;
            patchAssistant({
              content: accumulatedContent,
              reasoning: accumulatedReasoning || undefined,
              stage: undefined,
              responseTimeMs: Math.round(performance.now() - startTime),
            });
          }
        }
      }

      try {
        await reader.cancel();
      } catch {}

      const totalResponseTimeMs = Math.round(performance.now() - startTime);

      if (serverError) {
        patchAssistant({
          content:
            accumulatedContent ||
            `❌ **请求出错**：${serverError.message}${serverError.hint ? `\n\n💡 ${serverError.hint}` : ''}`,
          errorHint: serverError.hint,
          isError: !accumulatedContent,
          stage: undefined,
          responseTimeMs: totalResponseTimeMs,
        });
      } else if (!accumulatedContent && !accumulatedReasoning) {
        patchAssistant({
          content: '❌ **模型未返回任何内容**。\n\n💡 请检查 API Key、Base URL 与所选模型是否可用，然后重试。',
          isError: true,
          stage: undefined,
          responseTimeMs: totalResponseTimeMs,
        });
      } else {
        patchAssistant({
          content: accumulatedContent,
          reasoning: accumulatedReasoning || undefined,
          stage: undefined,
          responseTimeMs: totalResponseTimeMs,
        });
      }
    } catch (err: any) {
      console.error('API Call Error:', err);

      const isUserAbort = err?.name === 'AbortError';
      const isIdleTimeout = err?.message === 'STREAM_IDLE';

      const failureText = isUserAbort
        ? '⏹️ **已终止本轮生成**。'
        : isIdleTimeout
        ? `⌛ **连接已静默超过 ${STREAM_IDLE_TIMEOUT_MS / 1000} 秒，判定为断流并已自动断开**。\n\n💡 模型前置思考过久或网络中断，请重试，或改用响应更快的模型。`
        : `❌ **请求出错**：${err?.message || '调用 API 时发生未知错误'}\n\n💡 请检查左侧的 API Key、Base URL 与网络连接后重试。`;

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: msg.content ? `${msg.content}\n\n---\n${failureText}` : failureText,
                isError: !msg.content,
                stage: undefined,
              }
            : msg
        )
      );
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-zinc-950 font-sans text-zinc-100">
      <nav className="h-11 bg-zinc-950 border-b border-zinc-800 px-4 flex items-center justify-between shrink-0 select-none z-20">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-medium tracking-tight shrink-0 text-zinc-100">WSa1</span>

          <div className="hidden lg:flex items-center gap-2 text-xs text-zinc-500">
            <span className="text-zinc-500">
              {provider === 'gemini' ? 'Gemini' : 'OpenAI'}
            </span>
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="bg-transparent text-xs text-zinc-300 border-none focus:outline-hidden cursor-pointer max-w-[200px] truncate"
              title="当前模型"
            >
              {discoveredModels.length > 0 ? (
                discoveredModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))
              ) : (
                <option value={selectedModel}>{selectedModel || '未选择模型'}</option>
              )}
            </select>
            <button
              type="button"
              onClick={() => handleDiscoverModels()}
              disabled={isDiscoveringModels}
              className="p-0.5 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer disabled:opacity-50"
              title="刷新模型列表"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isDiscoveringModels ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setActiveView('chat')}
            className={`px-2.5 py-1 rounded text-xs transition-colors flex items-center gap-1.5 cursor-pointer ${
              activeView === 'chat'
                ? 'bg-zinc-100 text-zinc-950'
                : 'text-zinc-500 hover:text-zinc-100'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            答疑
          </button>
          <button
            onClick={() => setActiveView('latex')}
            className={`px-2.5 py-1 rounded text-xs transition-colors flex items-center gap-1.5 cursor-pointer ${
              activeView === 'latex'
                ? 'bg-zinc-100 text-zinc-950'
                : hasImportedLatex
                ? 'text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-100'
            }`}
          >
            <FileCode className="w-3.5 h-3.5" />
            LaTeX
          </button>
          <button
            onClick={() => setActiveView('code')}
            className={`px-2.5 py-1 rounded text-xs transition-colors flex items-center gap-1.5 cursor-pointer ${
              activeView === 'code'
                ? 'bg-zinc-100 text-zinc-950'
                : 'text-zinc-500 hover:text-zinc-100'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            源码
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
              onStopStreaming={handleStopStreaming}
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
