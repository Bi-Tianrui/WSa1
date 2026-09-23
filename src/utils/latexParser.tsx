import React from 'react';
import katex from 'katex';

interface MathRendererProps {
  content: string;
}

/**
 * Safely renders LaTeX mathematical formulas and markdown formatting.
 * Supports:
 * - Block formulas: $$ ... $$
 * - Inline formulas: $ ... $
 * - Markdown tables
 * - Headings, bold, lists, blockquotes
 */
export const FormattedMathContent: React.FC<MathRendererProps> = ({ content }) => {
  // Split content by code blocks or lines
  const renderFormattedText = (rawText: string) => {
    // Process markdown tables if present
    const lines = rawText.split('\n');
    const elements: React.ReactNode[] = [];
    let inTable = false;
    let tableRows: string[][] = [];
    let isHeader = true;

    const flushTable = (key: string) => {
      if (tableRows.length > 0) {
        const headerRow = tableRows[0];
        const bodyRows = tableRows.slice(1);
        elements.push(
          <div key={key} className="overflow-x-auto my-3 border border-slate-200 rounded-lg shadow-xs">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-100 font-semibold text-slate-800">
                <tr>
                  {headerRow.map((cell, cIdx) => (
                    <th key={cIdx} className="px-3 py-2 text-left border-r border-slate-200 last:border-r-0">
                      {renderInlineMath(cell.trim())}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {bodyRows.map((row, rIdx) => (
                  <tr key={rIdx} className={rIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                    {row.map((cell, cIdx) => (
                      <td key={cIdx} className="px-3 py-2 text-slate-700 border-r border-slate-200 last:border-r-0">
                        {renderInlineMath(cell.trim())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        tableRows = [];
        inTable = false;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Table line detection: starts and ends with | or contains |
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        const cells = line
          .trim()
          .split('|')
          .slice(1, -1);

        // Check if this is a separator line (|---|---|)
        if (cells.every((c) => c.trim().match(/^:?-+:?$/))) {
          isHeader = false;
          continue;
        }

        if (!inTable) {
          inTable = true;
          tableRows = [];
        }
        tableRows.push(cells);
        continue;
      } else if (inTable) {
        flushTable(`table-${i}`);
      }

      // Block formula: $$ ... $$
      if (line.trim().startsWith('$$') && line.trim().endsWith('$$') && line.trim().length > 4) {
        const math = line.trim().slice(2, -2).trim();
        let mathHtml = '';
        try {
          mathHtml = katex.renderToString(math, { displayMode: true, throwOnError: false });
        } catch {
          mathHtml = `<code>${math}</code>`;
        }
        elements.push(
          <div
            key={`block-math-${i}`}
            className="my-3 py-2 px-3 bg-slate-50 border border-slate-200 rounded-md overflow-x-auto text-center"
            dangerouslySetInnerHTML={{ __html: mathHtml }}
          />
        );
        continue;
      }

      // Headings
      if (line.startsWith('### ')) {
        elements.push(
          <h4 key={`h4-${i}`} className="text-base font-bold text-slate-900 mt-4 mb-1">
            {renderInlineMath(line.replace('### ', ''))}
          </h4>
        );
        continue;
      }
      if (line.startsWith('## ')) {
        elements.push(
          <h3 key={`h3-${i}`} className="text-lg font-bold text-slate-900 mt-5 mb-2 pb-1 border-b border-slate-200">
            {renderInlineMath(line.replace('## ', ''))}
          </h3>
        );
        continue;
      }
      if (line.startsWith('# ')) {
        elements.push(
          <h2 key={`h2-${i}`} className="text-xl font-bold text-slate-900 mt-6 mb-2">
            {renderInlineMath(line.replace('# ', ''))}
          </h2>
        );
        continue;
      }

      // Blockquote
      if (line.startsWith('> ')) {
        elements.push(
          <blockquote key={`bq-${i}`} className="border-l-4 border-blue-500 bg-blue-50/60 py-1.5 px-3 rounded-r my-2 text-slate-700 text-sm">
            {renderInlineMath(line.replace('> ', ''))}
          </blockquote>
        );
        continue;
      }

      // Unordered List
      if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
        elements.push(
          <div key={`li-${i}`} className="flex items-start gap-2 my-1 text-sm text-slate-800 leading-relaxed">
            <span className="text-blue-500 font-bold mt-1">•</span>
            <div className="flex-1">{renderInlineMath(line.trim().replace(/^[-*]\s+/, ''))}</div>
          </div>
        );
        continue;
      }

      // Ordered List
      const olMatch = line.trim().match(/^(\d+)\.\s+(.*)$/);
      if (olMatch) {
        elements.push(
          <div key={`ol-${i}`} className="flex items-start gap-2 my-1 text-sm text-slate-800 leading-relaxed">
            <span className="text-blue-600 font-semibold text-xs mt-0.5 bg-blue-100 px-1.5 py-0.5 rounded">
              {olMatch[1]}
            </span>
            <div className="flex-1">{renderInlineMath(olMatch[2])}</div>
          </div>
        );
        continue;
      }

      // Empty line
      if (!line.trim()) {
        elements.push(<div key={`empty-${i}`} className="h-2" />);
        continue;
      }

      // Regular paragraph
      elements.push(
        <p key={`p-${i}`} className="my-1.5 text-sm text-slate-800 leading-relaxed">
          {renderInlineMath(line)}
        </p>
      );
    }

    if (inTable) {
      flushTable('table-end');
    }

    return elements;
  };

  // Helper to render inline math ($ ... $) and inline bold/italic
  const renderInlineMath = (text: string): React.ReactNode => {
    // Regex for $...$ (avoiding escaped \$ or empty $$)
    const parts: React.ReactNode[] = [];
    const regex = /(\$\$[\s\S]+?\$\$|\$[^\$]+?\$)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      // Text before math
      if (match.index > lastIndex) {
        parts.push(renderTextFormatting(text.slice(lastIndex, match.index), `txt-${lastIndex}`));
      }

      const rawFormula = match[0];
      const isDisplay = rawFormula.startsWith('$$');
      const formula = isDisplay ? rawFormula.slice(2, -2) : rawFormula.slice(1, -1);

      try {
        const rendered = katex.renderToString(formula, {
          displayMode: isDisplay,
          throwOnError: false,
        });
        parts.push(
          <span
            key={`math-${match.index}`}
            className={isDisplay ? 'block my-1 text-center font-serif' : 'inline-block px-1 font-serif text-slate-900'}
            dangerouslySetInnerHTML={{ __html: rendered }}
          />
        );
      } catch {
        parts.push(<code key={`math-err-${match.index}`} className="text-xs bg-slate-100 px-1 py-0.5 rounded">{formula}</code>);
      }

      lastIndex = match.index + rawFormula.length;
    }

    if (lastIndex < text.length) {
      parts.push(renderTextFormatting(text.slice(lastIndex), `txt-${lastIndex}`));
    }

    return parts;
  };

  // Format bold (**...**) and inline code (`...`)
  const renderTextFormatting = (str: string, keyPrefix: string): React.ReactNode => {
    const boldCodeRegex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    const pieces: React.ReactNode[] = [];
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    while ((match = boldCodeRegex.exec(str)) !== null) {
      if (match.index > lastIdx) {
        pieces.push(str.slice(lastIdx, match.index));
      }
      const token = match[0];
      if (token.startsWith('**')) {
        pieces.push(
          <strong key={`${keyPrefix}-b-${match.index}`} className="font-bold text-slate-900">
            {token.slice(2, -2)}
          </strong>
        );
      } else if (token.startsWith('`')) {
        pieces.push(
          <code key={`${keyPrefix}-c-${match.index}`} className="bg-slate-100 text-blue-700 px-1.5 py-0.5 rounded text-xs font-mono font-medium">
            {token.slice(1, -1)}
          </code>
        );
      }
      lastIdx = match.index + token.length;
    }

    if (lastIdx < str.length) {
      pieces.push(str.slice(lastIdx));
    }

    return <React.Fragment key={keyPrefix}>{pieces}</React.Fragment>;
  };

  return <div className="formatted-math-container">{renderFormattedText(content)}</div>;
};
