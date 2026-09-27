import React, { useState } from 'react';
import { Copy, Download } from 'lucide-react';
import {
  REQUIREMENTS_CONTENT,
  APP_PY_CONTENT,
  RUN_SH_CONTENT,
} from '../data/sourceCode';

export const SourceCodeViewer: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'app.py' | 'requirements.txt' | 'run.sh'>('app.py');
  const [copied, setCopied] = useState(false);

  const files = {
    'app.py': APP_PY_CONTENT,
    'requirements.txt': REQUIREMENTS_CONTENT,
    'run.sh': RUN_SH_CONTENT,
  } as const;

  const content = files[activeTab];

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleDownload = () => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = activeTab;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-950 text-zinc-200 overflow-hidden">
      <div className="h-11 border-b border-zinc-800 px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1">
          {(Object.keys(files) as Array<keyof typeof files>).map((name) => (
            <button
              key={name}
              onClick={() => setActiveTab(name)}
              className={`px-2.5 py-1 rounded text-xs font-mono cursor-pointer ${
                activeTab === name ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-500 hover:text-zinc-100'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <button onClick={handleCopy} className="hover:text-zinc-100 cursor-pointer flex items-center gap-1">
            <Copy className="w-3.5 h-3.5" />
            {copied ? '已复制' : '复制'}
          </button>
          <button onClick={handleDownload} className="hover:text-zinc-100 cursor-pointer flex items-center gap-1">
            <Download className="w-3.5 h-3.5" />
            下载
          </button>
        </div>
      </div>

      <p className="px-4 py-2 text-[11px] text-zinc-500 border-b border-zinc-800">
        早期 Streamlit 试验文件，当前服务由 Express + React 启动。
      </p>

      <div className="flex-1 overflow-auto">
        <pre className="p-4 text-xs font-mono text-zinc-300 leading-relaxed">
          <code>{content}</code>
        </pre>
      </div>
    </div>
  );
};
