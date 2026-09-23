import React, { useState } from 'react';
import {
  FileCode,
  Terminal,
  Download,
  Copy,
  Check,
  ExternalLink,
  ShieldCheck,
  PlayCircle,
  FileText
} from 'lucide-react';
import {
  REQUIREMENTS_CONTENT,
  APP_PY_CONTENT,
  RUN_SH_CONTENT,
} from '../data/sourceCode';

interface SourceCodeViewerProps {
  onClose?: () => void;
}

export const SourceCodeViewer: React.FC<SourceCodeViewerProps> = () => {
  const [activeTab, setActiveTab] = useState<'app.py' | 'requirements.txt' | 'run.sh'>('app.py');
  const [copied, setCopied] = useState(false);

  const getFileContent = () => {
    switch (activeTab) {
      case 'app.py':
        return { name: 'app.py', content: APP_PY_CONTENT, lang: 'python' };
      case 'requirements.txt':
        return { name: 'requirements.txt', content: REQUIREMENTS_CONTENT, lang: 'plaintext' };
      case 'run.sh':
        return { name: 'run.sh', content: RUN_SH_CONTENT, lang: 'bash' };
    }
  };

  const current = getFileContent();

  const handleCopy = () => {
    navigator.clipboard.writeText(current.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleDownload = (filename: string, text: string) => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-900 text-slate-100 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-slate-800 bg-slate-950 flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div>
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Terminal className="w-5 h-5 text-emerald-400" />
            Ubuntu 本地项目源码与一键启动脚本
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            单文件架构、免配环境，自动管理 .venv 与浏览器一键启动
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center gap-1.5 bg-slate-800 p-1 rounded-lg border border-slate-700">
          <button
            onClick={() => setActiveTab('app.py')}
            className={`px-3 py-1.5 rounded text-xs font-mono font-medium transition-colors flex items-center gap-1.5 ${
              activeTab === 'app.py'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileCode className="w-3.5 h-3.5" />
            app.py (业务主代码)
          </button>
          <button
            onClick={() => setActiveTab('requirements.txt')}
            className={`px-3 py-1.5 rounded text-xs font-mono font-medium transition-colors flex items-center gap-1.5 ${
              activeTab === 'requirements.txt'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            requirements.txt (依赖清单)
          </button>
          <button
            onClick={() => setActiveTab('run.sh')}
            className={`px-3 py-1.5 rounded text-xs font-mono font-medium transition-colors flex items-center gap-1.5 ${
              activeTab === 'run.sh'
                ? 'bg-emerald-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            run.sh (Ubuntu 一键启动)
          </button>
        </div>

        {/* Actions: Copy & Download */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-200 font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-400">已复制到剪贴板</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5 text-slate-400" />
                <span>复制本文件代码</span>
              </>
            )}
          </button>

          <button
            onClick={() => handleDownload(current.name, current.content)}
            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs"
          >
            <Download className="w-3.5 h-3.5" />
            <span>下载 {current.name}</span>
          </button>
        </div>
      </div>

      {/* Ubuntu Quick Start Terminal Guide */}
      <div className="px-5 py-3 bg-slate-950/80 border-b border-slate-800 text-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-emerald-400">
            <PlayCircle className="w-4 h-4" />
            Ubuntu 终端 30 秒一键执行指令：
          </div>
          <span className="text-slate-400 text-[11px]">
            已验证 Ubuntu 20.04 / 22.04 / 24.04 LTS
          </span>
        </div>
        <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 font-mono text-[11px]">
          <div className="p-2 rounded bg-slate-900 border border-slate-800 flex items-center justify-between">
            <span className="text-slate-300">1. 给脚本执行权限:</span>
            <code className="text-emerald-300 font-semibold bg-slate-950 px-1.5 py-0.5 rounded">chmod +x run.sh</code>
          </div>
          <div className="p-2 rounded bg-slate-900 border border-slate-800 flex items-center justify-between">
            <span className="text-slate-300">2. 一键启动应用:</span>
            <code className="text-emerald-300 font-semibold bg-slate-950 px-1.5 py-0.5 rounded">./run.sh</code>
          </div>
          <div className="p-2 rounded bg-slate-900 border border-slate-800 flex items-center justify-between">
            <span className="text-slate-300">3. 自动就绪访问:</span>
            <span className="text-blue-400 font-semibold">自动调用 xdg-open 启动浏览器</span>
          </div>
        </div>
      </div>

      {/* Code Editor Body */}
      <div className="flex-1 overflow-auto p-4 bg-slate-950">
        <div className="rounded-lg border border-slate-800 bg-slate-900 overflow-hidden shadow-inner">
          <div className="px-4 py-2 bg-slate-850 border-b border-slate-800 text-xs text-slate-400 flex items-center justify-between">
            <span className="font-mono text-slate-300">{current.name}</span>
            <span>{current.content.split('\n').length} 行代码</span>
          </div>
          <pre className="p-4 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed selection:bg-blue-600 selection:text-white">
            <code>{current.content}</code>
          </pre>
        </div>
      </div>
    </div>
  );
};
