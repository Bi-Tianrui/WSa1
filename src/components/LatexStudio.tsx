import React, { useState, useEffect, useRef } from 'react';
import { LatexCompileResponse } from '../types';
import { jsPDF } from 'jspdf';
import { PdfPreview } from './PdfPreview';

interface LatexStudioProps {
  latexCode: string;
  onLatexCodeChange: (code: string) => void;
  onSwitchToChat: () => void;
}

export const DEFAULT_ACADEMIC_LATEX_TEMPLATE = `\\documentclass[11pt,a4paper]{ctexart}
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

\\title{\\textbf{\\LARGE 高等数学与大学物理核心定理推演笔记}}
\\author{\\large 工科教材伴读研学室}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{核心定理与概念陈述}
设空间有界闭区域 $\\Omega \\subset \\mathbb{R}^3$，其边界 $\\Sigma$ 为分片光滑的闭曲面，取外侧为法向量正向。若向量场 $\\mathbf{F}(x,y,z) = P\\mathbf{i} + Q\\mathbf{j} + R\\mathbf{k}$ 在 $\\Omega$ 上具有一阶连续偏导数，则有高斯公式（散度定理）：
\\begin{equation}
\\iiint_{\\Omega} \\left( \\frac{\\partial P}{\\partial x} + \\frac{\\partial Q}{\\partial y} + \\frac{\\partial R}{\\partial z} \\right) \\mathrm{d}V = \\iint_{\\Sigma} (P \\cos \\alpha + Q \\cos \\beta + R \\cos \\gamma) \\mathrm{d}S = \\iint_{\\Sigma} \\mathbf{F} \\cdot \\mathrm{d}\\mathbf{S}
\\end{equation}

\\section{物理意义与通量解释}
高斯定理揭示了体积分与闭曲面积分之间的深刻对应关系：
\\begin{itemize}
    \\item 散度 $\\mathrm{div}\\,\\mathbf{F} = \\nabla \\cdot \\mathbf{F}$ 反映了场中微元点处的源（Source）或汇（Sink）强度；
    \\item 闭曲面积分代表通过封闭边界向外净穿出的总通量（Flux）。
\\end{itemize}

\\section{麦克斯韦方程组高斯定律对照表}
\\begin{table}[htbp]
\\centering
\\begin{tabular}{ccc}
\\toprule
物理定律 & 微分形式 & 积分形式 \\\\
\\midrule
高斯电场定律 & $\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}$ & $\\oint_S \\mathbf{E} \\cdot \\mathrm{d}\\mathbf{A} = \\frac{Q_{\\text{enc}}}{\\varepsilon_0}$ \\\\
高斯磁场定律 & $\\nabla \\cdot \\mathbf{B} = 0$ & $\\oint_S \\mathbf{B} \\cdot \\mathrm{d}\\mathbf{A} = 0$ \\\\
\\bottomrule
\\end{tabular}
\\end{table}

\\end{document}`;

export const LatexStudio: React.FC<LatexStudioProps> = ({
  latexCode,
  onLatexCodeChange,
  onSwitchToChat,
}) => {
  const [isCompiling, setIsCompiling] = useState(false);
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const [compileLog, setCompileLog] = useState<string>('');
  const [showLogDrawer, setShowLogDrawer] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [copiedTex, setCopiedTex] = useState(false);
  const [engineStatus, setEngineStatus] = useState<{ installed: boolean; version?: string } | null>(null);
  const [compileSuccessNotice, setCompileSuccessNotice] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Check backend xelatex status on mount
  useEffect(() => {
    fetch('/api/latex/status')
      .then((res) => res.json())
      .then((data) => {
        setEngineStatus({
          installed: Boolean(data.installed),
          version: data.version,
        });
      })
      .catch(() => {
        setEngineStatus({ installed: false });
      });
  }, []);

  // Handle Tab key in editor
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.target as HTMLTextAreaElement;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const newValue = latexCode.substring(0, start) + '  ' + latexCode.substring(end);
      onLatexCodeChange(newValue);
      setTimeout(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      }, 0);
    }
  };

  // Compile LaTeX code via backend xelatex
  const handleCompile = async () => {
    setIsCompiling(true);
    setCompileError(null);
    setCompileSuccessNotice(false);

    try {
      const response = await fetch('/api/latex/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latexCode }),
      });

      const data: LatexCompileResponse = await response.json();
      setCompileLog(data.log || '');

      if (data.success && data.pdfBase64) {
        setPdfBase64(data.pdfBase64);
        setCompileSuccessNotice(true);
        setTimeout(() => setCompileSuccessNotice(false), 4000);
      } else {
        if (!data.installed) {
          // Graceful fallback: generate a beautiful client-side PDF using jsPDF
          generateFallbackPdf(latexCode);
          setCompileError(
            '系统未安装 XeLaTeX 引擎，已为您启用浏览器端高清 PDF 备用引擎生成预览！若需原生 XeLaTeX 宏包支持，请在 Ubuntu 终端运行: sudo apt install -y texlive-xetex texlive-lang-chinese texlive-latex-extra'
          );
        } else {
          setCompileError(data.error || 'LaTeX 编译未能成功生成 PDF，请查看控制台日志');
          setShowLogDrawer(true);
        }
      }
    } catch (err: any) {
      console.warn('Network/compile error:', err);
      // Client-side fallback
      generateFallbackPdf(latexCode);
      setCompileError(`后台编译接口连接异常: ${err?.message || '未知错误'}，已切换为本地备用引擎预览。`);
    } finally {
      setIsCompiling(false);
    }
  };

  // Graceful client-side fallback renderer
  const generateFallbackPdf = (rawTex: string) => {
    try {
      const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
      });

      doc.setFontSize(18);
      doc.setTextColor(30, 41, 59);
      doc.text('LaTeX Academic Notes (Preview)', 20, 20);

      doc.setFontSize(10);
      doc.setTextColor(100, 116, 139);
      doc.text(`Generated at: ${new Date().toLocaleString()} | Engine: Client-Side Fallback`, 20, 28);
      doc.line(20, 31, 190, 31);

      doc.setFontSize(10);
      doc.setTextColor(51, 65, 85);
      const splitLines = doc.splitTextToSize(rawTex, 170);
      let y = 38;
      for (let i = 0; i < Math.min(splitLines.length, 55); i++) {
        if (y > 280) {
          doc.addPage();
          y = 20;
        }
        doc.text(splitLines[i], 20, y);
        y += 5.5;
      }

      const base64Data = doc.output('datauristring').split(',')[1];
      setPdfBase64(base64Data);
    } catch (e) {
      console.error('Failed to generate fallback PDF', e);
    }
  };

  // Download PDF
  const handleDownloadPdf = () => {
    if (!pdfBase64) return;
    const link = document.createElement('a');
    link.href = `data:application/pdf;base64,${pdfBase64}`;
    link.download = 'academic_paper.pdf';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Download .tex source code
  const handleDownloadTex = () => {
    const blob = new Blob([latexCode], { type: 'text/x-tex;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'document.tex';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Copy .tex source
  const handleCopyTex = () => {
    navigator.clipboard.writeText(latexCode).then(() => {
      setCopiedTex(true);
      setTimeout(() => setCopiedTex(false), 2000);
    });
  };

  // Reset to default template
  const handleResetTemplate = () => {
    if (confirm('确认将编辑区重置为标准工科 ctexart 学术模板？当前未保存的代码将被替换。')) {
      onLatexCodeChange(DEFAULT_ACADEMIC_LATEX_TEMPLATE);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-950 text-zinc-100 overflow-hidden font-sans">
      <div className="h-11 border-b border-zinc-800 px-4 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span className="text-zinc-200">LaTeX</span>
          {engineStatus && (
            <span title={engineStatus.installed ? 'XeLaTeX 可用' : '未检测到 xelatex，将使用降级方案'}>
              {engineStatus.installed ? 'XeLaTeX' : '未安装 XeLaTeX'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={handleCompile}
            disabled={isCompiling}
            className="px-2.5 py-1 rounded text-xs bg-zinc-100 hover:bg-zinc-200 disabled:opacity-50 text-zinc-950 cursor-pointer"
            title="编译并刷新预览"
          >
            {isCompiling ? '编译中…' : '编译'}
          </button>
          <button
            onClick={handleDownloadPdf}
            disabled={!pdfBase64}
            className={`px-2.5 py-1 rounded text-xs ${
              pdfBase64
                ? 'text-zinc-300 hover:bg-zinc-900 cursor-pointer'
                : 'text-zinc-700 cursor-not-allowed'
            }`}
            title={pdfBase64 ? '下载 PDF' : '请先编译'}
          >
            PDF
          </button>
          <button
            onClick={handleDownloadTex}
            className="px-2.5 py-1 rounded text-xs text-zinc-300 hover:bg-zinc-900 cursor-pointer"
            title="下载 document.tex"
          >
            .tex
          </button>
          <button
            onClick={() => setShowLogDrawer((prev) => !prev)}
            className={`px-2.5 py-1 rounded text-xs cursor-pointer ${
              showLogDrawer ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900'
            }`}
            title="编译日志"
          >
            日志
          </button>
        </div>
      </div>

      {/* Warning / Notification Banner */}
      {compileError && (
        <div className="border-b border-zinc-800 px-4 py-2 text-xs text-red-400 flex items-center justify-between shrink-0">
          <span>{compileError}</span>
          <button
            onClick={() => setShowLogDrawer(true)}
            className="text-zinc-500 hover:text-zinc-200 text-[11px] shrink-0 cursor-pointer"
          >
            日志
          </button>
        </div>
      )}

      {compileSuccessNotice && (
        <div className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-500 shrink-0">
          编译完成
        </div>
      )}

      {/* Dual Pane Main Area (50% / 50% split) */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        <div className="w-full md:w-1/2 flex flex-col border-r border-zinc-800 bg-zinc-950 h-1/2 md:h-full overflow-hidden">
          <div className="h-8 border-b border-zinc-800 px-3 flex items-center justify-between text-xs text-zinc-500 shrink-0">
            <span className="font-mono text-[11px] text-zinc-400">document.tex</span>
            <div className="flex items-center gap-3">
              <button
                onClick={handleCopyTex}
                className="hover:text-zinc-200 text-[11px] cursor-pointer"
              >
                {copiedTex ? '已复制' : '复制'}
              </button>
              <button
                onClick={handleResetTemplate}
                className="hover:text-zinc-200 text-[11px] cursor-pointer"
                title="恢复默认模板"
              >
                重置
              </button>
            </div>
          </div>

          <div className="flex-1 relative overflow-hidden flex">
            <textarea
              ref={textareaRef}
              value={latexCode}
              onChange={(e) => onLatexCodeChange(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              className="w-full h-full p-4 bg-zinc-950 text-zinc-200 font-mono text-xs md:text-[13px] leading-relaxed resize-none focus:outline-hidden"
              placeholder="% LaTeX"
            />
          </div>
        </div>

        <div className="w-full md:w-1/2 flex flex-col bg-zinc-950 h-1/2 md:h-full overflow-hidden">
          <div className="h-8 border-b border-zinc-800 px-3 flex items-center justify-between text-xs text-zinc-500 shrink-0 bg-zinc-950">
            <span className="text-[11px] text-zinc-400">预览</span>
            {pdfBase64 && (
              <button
                onClick={handleDownloadPdf}
                className="hover:text-zinc-200 text-[11px] cursor-pointer"
              >
                下载
              </button>
            )}
          </div>

          <div className="flex-1 bg-zinc-950 flex items-center justify-center relative overflow-hidden">
            {pdfBase64 ? (
              <PdfPreview base64={pdfBase64} />
            ) : (
              <div className="max-w-sm text-center px-6">
                <p className="text-xs text-zinc-500 mb-4">编译左侧源码，或从答疑导入回答。</p>
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={handleCompile}
                    disabled={isCompiling}
                    className="px-3 py-1.5 rounded bg-zinc-100 text-zinc-950 text-xs cursor-pointer"
                  >
                    编译
                  </button>
                  <button
                    onClick={onSwitchToChat}
                    className="px-3 py-1.5 rounded text-xs text-zinc-400 hover:text-zinc-100 cursor-pointer"
                  >
                    返回答疑
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Collapsible Compilation Log Drawer */}
      {showLogDrawer && (
        <div className="h-44 border-t border-zinc-800 bg-zinc-950 flex flex-col shrink-0">
          <div className="h-7 px-3 flex items-center justify-between text-xs text-zinc-500 border-b border-zinc-800 select-none">
            <span className="text-[11px]">编译日志</span>
            <button
              onClick={() => setShowLogDrawer(false)}
              className="hover:text-zinc-200 text-xs cursor-pointer"
            >
              关闭
            </button>
          </div>
          <div className="flex-1 p-3 font-mono text-xs text-zinc-400 overflow-y-auto whitespace-pre-wrap leading-relaxed">
            {compileLog || '尚无输出。'}
          </div>
        </div>
      )}
    </div>
  );
};
