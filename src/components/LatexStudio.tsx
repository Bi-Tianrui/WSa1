import React, { useState, useEffect, useRef } from 'react';
import {
  Play,
  Download,
  FileCode,
  Terminal,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Copy,
  Check,
  Maximize2,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  ExternalLink,
  Sparkles
} from 'lucide-react';
import { LatexCompileResponse } from '../types';
import { jsPDF } from 'jspdf';

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
    <div className="flex-1 flex flex-col h-full bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Top Workbench Toolbar (VS Code / Overleaf Style) */}
      <div className="h-12 border-b border-slate-800 bg-slate-900 px-4 flex items-center justify-between shrink-0 select-none z-10">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-pulse"></span>
            <span className="font-semibold text-white text-xs tracking-wide flex items-center gap-1.5">
              <FileCode className="w-4 h-4 text-indigo-400" />
              LaTeX 实时编译与 PDF 双联预览室
            </span>
          </div>

          <div className="h-4 w-px bg-slate-700"></div>

          {/* Engine Status Badge */}
          {engineStatus && (
            <div
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono border ${
                engineStatus.installed
                  ? 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60'
                  : 'bg-amber-950/80 text-amber-300 border-amber-700/60'
              }`}
              title={engineStatus.installed ? 'XeLaTeX 原生引擎正常在线' : '未检测到系统 xelatex，已自动启动自适应优雅降级'}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${engineStatus.installed ? 'bg-emerald-400' : 'bg-amber-400'}`}></span>
              <span>XeLaTeX: {engineStatus.installed ? '已就绪 (原生)' : '未安装 (优雅降级)'}</span>
            </div>
          )}
        </div>

        {/* 4 Core Action Buttons */}
        <div className="flex items-center gap-2">
          {/* Button 1: Compile & Refresh PDF */}
          <button
            onClick={handleCompile}
            disabled={isCompiling}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 text-white text-xs font-semibold shadow-sm transition-all cursor-pointer"
            title="使用后台 XeLaTeX 编译当前代码并刷新右侧高清矢量 PDF"
          >
            {isCompiling ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>正在编译...</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>⚡ 编译并刷新 PDF</span>
              </>
            )}
          </button>

          {/* Button 2: Download PDF */}
          <button
            onClick={handleDownloadPdf}
            disabled={!pdfBase64}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              pdfBase64
                ? 'bg-emerald-700 hover:bg-emerald-600 text-white shadow-xs cursor-pointer'
                : 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700/50'
            }`}
            title={pdfBase64 ? '下载已编译生成的高清矢量 PDF 文件' : '请先点击编译生成 PDF'}
          >
            <Download className="w-3.5 h-3.5" />
            <span>📥 下载高清 PDF</span>
          </button>

          {/* Button 3: Download .tex source */}
          <button
            onClick={handleDownloadTex}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium border border-slate-700 transition-colors cursor-pointer"
            title="将当前编辑区的 LaTeX 源码保存为 document.tex"
          >
            <FileText className="w-3.5 h-3.5 text-blue-400" />
            <span>💾 下载 .tex 源码</span>
          </button>

          {/* Button 4: View Compilation Logs */}
          <button
            onClick={() => setShowLogDrawer((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
              showLogDrawer
                ? 'bg-slate-700 text-white border-slate-600'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
            }`}
            title="展开/折叠显示 XeLaTeX 控制台编译诊断日志"
          >
            <Terminal className="w-3.5 h-3.5 text-amber-400" />
            <span>📜 查看编译日志</span>
            {showLogDrawer ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Warning / Notification Banner */}
      {compileError && (
        <div className="bg-amber-950/90 border-b border-amber-800/80 px-4 py-2 text-xs text-amber-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>{compileError}</span>
          </div>
          <button
            onClick={() => setShowLogDrawer(true)}
            className="text-amber-300 underline hover:text-amber-100 font-mono text-[11px] shrink-0"
          >
            查看详情
          </button>
        </div>
      )}

      {compileSuccessNotice && (
        <div className="bg-emerald-950/90 border-b border-emerald-800/80 px-4 py-2 text-xs text-emerald-200 flex items-center gap-2 shrink-0 animate-fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>⚡ XeLaTeX 编译成功！右侧已刷新高清矢量 PDF 预览视图。</span>
        </div>
      )}

      {/* Dual Pane Main Area (50% / 50% split) */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        {/* Left Half: LaTeX Source Code Editor */}
        <div className="w-full md:w-1/2 flex flex-col border-r border-slate-800 bg-slate-950 h-1/2 md:h-full overflow-hidden">
          {/* Editor Header Sub-bar */}
          <div className="h-8 bg-slate-900/90 border-b border-slate-800 px-3 flex items-center justify-between text-xs text-slate-400 shrink-0">
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <span className="text-slate-200 font-medium">document.tex</span>
              <span className="text-slate-600">|</span>
              <span>UTF-8</span>
              <span className="text-slate-600">|</span>
              <span>ctexart (中文学术模板)</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyTex}
                className="hover:text-slate-200 flex items-center gap-1 text-[11px] transition-colors cursor-pointer"
                title="复制代码到剪贴板"
              >
                {copiedTex ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span className="text-emerald-400">已复制</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>复制代码</span>
                  </>
                )}
              </button>
              <span className="text-slate-600">|</span>
              <button
                onClick={handleResetTemplate}
                className="hover:text-slate-200 text-[11px] transition-colors cursor-pointer"
                title="恢复为初始默认论文模板"
              >
                重置模板
              </button>
            </div>
          </div>

          {/* Textarea Editor */}
          <div className="flex-1 relative overflow-hidden flex bg-slate-950">
            <textarea
              ref={textareaRef}
              value={latexCode}
              onChange={(e) => onLatexCodeChange(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              className="w-full h-full p-4 bg-transparent text-slate-200 font-mono text-xs md:text-[13px] leading-relaxed resize-none focus:outline-hidden selection:bg-indigo-900/60"
              placeholder="% 请在此输入或粘贴标准 LaTeX 源码..."
            />
          </div>
        </div>

        {/* Right Half: Real-time PDF Vector Previewer */}
        <div className="w-full md:w-1/2 flex flex-col bg-slate-900 h-1/2 md:h-full overflow-hidden">
          {/* Previewer Header Sub-bar */}
          <div className="h-8 bg-slate-900/90 border-b border-slate-800 px-3 flex items-center justify-between text-xs text-slate-400 shrink-0">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500"></span>
              <span className="text-slate-200 font-medium text-[11px]">PDF 实时预览视图 (矢量无损)</span>
            </div>

            <div className="flex items-center gap-3 text-[11px]">
              {pdfBase64 && (
                <button
                  onClick={handleDownloadPdf}
                  className="hover:text-slate-200 flex items-center gap-1 transition-colors cursor-pointer text-blue-400"
                >
                  <Download className="w-3 h-3" />
                  <span>导出本地</span>
                </button>
              )}
            </div>
          </div>

          {/* Preview Container */}
          <div className="flex-1 bg-slate-900 flex items-center justify-center p-2 relative overflow-hidden">
            {pdfBase64 ? (
              <iframe
                src={`data:application/pdf;base64,${pdfBase64}#toolbar=1&navpanes=1`}
                className="w-full h-full rounded border border-slate-800 shadow-2xl bg-white"
                title="LaTeX PDF Preview"
              />
            ) : (
              /* Sleek VS Code / Overleaf Style Placeholder */
              <div className="max-w-md text-center p-6 rounded-xl border border-slate-800 bg-slate-950/60 shadow-xl">
                <div className="w-12 h-12 rounded-xl bg-indigo-950 text-indigo-400 flex items-center justify-center mx-auto mb-3 border border-indigo-800/60 shadow-inner">
                  <FileCode className="w-6 h-6" />
                </div>
                <h3 className="text-sm font-semibold text-slate-200 mb-1">
                  VS Code + LaTeX Workshop 风格双联预览
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed mb-4">
                  请在左侧编辑器中修改 LaTeX 代码，或在「💬 教材伴读答疑」中点击{' '}
                  <span className="text-indigo-400 font-mono">📌 导入至 LaTeX 排版室</span>。
                  <br />
                  点击上方 <span className="text-indigo-400 font-semibold">⚡ 编译并刷新 PDF</span>，右侧将无缝呈现原生高清矢量 PDF。
                </p>
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={handleCompile}
                    disabled={isCompiling}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium shadow-sm transition-all cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>立即触发初次编译</span>
                  </button>
                  <button
                    onClick={onSwitchToChat}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700 transition-colors cursor-pointer"
                  >
                    <span>返回伴读答疑</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Collapsible Compilation Log Drawer */}
      {showLogDrawer && (
        <div className="h-52 border-t border-slate-800 bg-slate-950 flex flex-col shrink-0 z-20 shadow-2xl">
          <div className="h-7 bg-slate-900 px-3 flex items-center justify-between text-xs text-slate-400 border-b border-slate-800 select-none">
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <Terminal className="w-3 h-3 text-amber-400" />
              <span>XeLaTeX 终端控制台输出日志</span>
            </div>
            <button
              onClick={() => setShowLogDrawer(false)}
              className="text-slate-400 hover:text-slate-200 text-xs cursor-pointer"
            >
              ✕ 关闭日志
            </button>
          </div>
          <div className="flex-1 p-3 font-mono text-xs text-slate-300 overflow-y-auto bg-black/80 whitespace-pre-wrap leading-relaxed">
            {compileLog || '暂无编译输出日志。点击上方 [⚡ 编译并刷新 PDF] 即可查看实时无头进程输出。'}
          </div>
        </div>
      )}
    </div>
  );
};
