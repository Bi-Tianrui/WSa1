/**
 * Converts the assistant's Markdown answer into a compilable ctexart document.
 *
 * Two rules drive the whole design, because breaking either one makes xelatex abort:
 *   1. every \item must sit inside a list environment that is opened and closed;
 *   2. LaTeX special characters in prose must be escaped, but never inside math.
 */

const MATH_PLACEHOLDER_OPEN = '\uE000';
const MATH_PLACEHOLDER_CLOSE = '\uE001';

/** Ordered so longer delimiters win before the single-dollar rule is tried. */
const MATH_SPAN_PATTERNS: RegExp[] = [
  /\$\$[\s\S]+?\$\$/g,
  /\\\[[\s\S]+?\\\]/g,
  /\\\([\s\S]+?\\\)/g,
  /\$[^$\n]+?\$/g,
];

const ESCAPE_SEQUENCE: Array<[RegExp, string]> = [
  // Backslash must be neutralised first or it would corrupt every later replacement.
  [/\\/g, '\\textbackslash{}'],
  [/\{/g, '\\{'],
  [/\}/g, '\\}'],
  [/\$/g, '\\$'],
  [/&/g, '\\&'],
  [/#/g, '\\#'],
  [/%/g, '\\%'],
  [/_/g, '\\_'],
  [/\^/g, '\\textasciicircum{}'],
  [/~/g, '\\textasciitilde{}'],
];

function escapeLatexText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of ESCAPE_SEQUENCE) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function applyEmphasis(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, '\\textbf{\\textit{$1}}')
    .replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}')
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1\\textit{$2}')
    .replace(/`([^`\n]+?)`/g, '\\texttt{$1}');
}

/**
 * Escapes prose while leaving math spans byte-for-byte intact.
 * Math is lifted out behind private-use placeholders, which contain no characters the
 * escaper or the emphasis rules can touch.
 */
export function convertInline(text: string): string {
  const mathSpans: string[] = [];

  let working = text;
  for (const pattern of MATH_SPAN_PATTERNS) {
    working = working.replace(pattern, (match) => {
      mathSpans.push(match);
      return `${MATH_PLACEHOLDER_OPEN}${mathSpans.length - 1}${MATH_PLACEHOLDER_CLOSE}`;
    });
  }

  working = applyEmphasis(escapeLatexText(working));

  return working.replace(
    new RegExp(`${MATH_PLACEHOLDER_OPEN}(\\d+)${MATH_PLACEHOLDER_CLOSE}`, 'g'),
    (_, index) => mathSpans[Number(index)] ?? ''
  );
}

type ListKind = 'itemize' | 'enumerate';

interface OpenList {
  kind: ListKind;
  indent: number;
}

function parseListItem(line: string): { kind: ListKind; indent: number; content: string } | null {
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) return { kind: 'itemize', indent: bullet[1].length, content: bullet[2] };

  const ordered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
  if (ordered) return { kind: 'enumerate', indent: ordered[1].length, content: ordered[2] };

  return null;
}

function renderTable(rows: string[]): string[] {
  const splitRow = (row: string): string[] =>
    row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  const header = splitRow(rows[0]);
  const columns = header.length;
  if (columns === 0) return [];

  const body: string[] = [];
  // Row 1 is the |---|---| alignment separator and carries no content.
  for (let i = 2; i < rows.length; i++) {
    const cells = splitRow(rows[i]);
    while (cells.length < columns) cells.push('');
    body.push(cells.slice(0, columns).map(convertInline).join(' & ') + ' \\\\');
  }

  return [
    '\\begin{table}[htbp]',
    '\\centering',
    '\\small',
    `\\begin{tabular}{${'l'.repeat(columns)}}`,
    '\\toprule',
    header.map(convertInline).join(' & ') + ' \\\\',
    '\\midrule',
    ...body,
    '\\bottomrule',
    '\\end{tabular}',
    '\\end{table}',
  ];
}

/** Converts a Markdown body into LaTeX body markup (no preamble). */
export function markdownToLatexBody(markdown: string): string {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const listStack: OpenList[] = [];

  let tableRows: string[] = [];
  let displayMath: string[] | null = null;
  let codeBlock: string[] | null = null;

  const closeListsTo = (indent: number): void => {
    while (listStack.length > 0 && listStack[listStack.length - 1].indent >= indent) {
      out.push(`\\end{${listStack.pop()!.kind}}`);
    }
  };

  const closeAllLists = (): void => {
    while (listStack.length > 0) out.push(`\\end{${listStack.pop()!.kind}}`);
  };

  const flushTable = (): void => {
    if (tableRows.length >= 2) out.push(...renderTable(tableRows));
    tableRows = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();

    // Fenced code: emit verbatim, never escaped.
    if (codeBlock !== null) {
      if (trimmed.startsWith('```')) {
        out.push('\\begin{verbatim}', ...codeBlock, '\\end{verbatim}');
        codeBlock = null;
      } else {
        codeBlock.push(rawLine);
      }
      continue;
    }

    // Multi-line display math: pass through untouched.
    if (displayMath !== null) {
      displayMath.push(rawLine);
      if (trimmed === '$$' || trimmed.endsWith('\\]')) {
        out.push(...displayMath);
        displayMath = null;
      }
      continue;
    }

    if (trimmed.startsWith('```')) {
      flushTable();
      closeAllLists();
      codeBlock = [];
      continue;
    }

    if (trimmed === '$$' || trimmed === '\\[') {
      flushTable();
      closeAllLists();
      displayMath = [rawLine];
      continue;
    }

    // A complete single-line display equation.
    if (/^\$\$[\s\S]+\$\$$/.test(trimmed) || /^\\\[[\s\S]+\\\]$/.test(trimmed)) {
      flushTable();
      closeAllLists();
      out.push(trimmed);
      continue;
    }

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      closeAllLists();
      tableRows.push(trimmed);
      continue;
    }
    if (tableRows.length > 0) flushTable();

    if (trimmed === '') {
      closeAllLists();
      out.push('');
      continue;
    }

    if (/^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed)) {
      closeAllLists();
      out.push('\\medskip\\hrule\\medskip');
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeAllLists();
      const depth = heading[1].length;
      const title = convertInline(heading[2]);
      const command = depth <= 1 ? 'section*' : depth === 2 ? 'subsection*' : 'subsubsection*';
      out.push(`\\${command}{${title}}`);
      continue;
    }

    const listItem = parseListItem(line);
    if (listItem) {
      const top = listStack[listStack.length - 1];

      if (!top || listItem.indent > top.indent) {
        listStack.push({ kind: listItem.kind, indent: listItem.indent });
        out.push(`\\begin{${listItem.kind}}`);
      } else {
        closeListsTo(listItem.indent + 1);
        const current = listStack[listStack.length - 1];
        if (!current || current.kind !== listItem.kind) {
          if (current && current.indent === listItem.indent) {
            out.push(`\\end{${listStack.pop()!.kind}}`);
          }
          listStack.push({ kind: listItem.kind, indent: listItem.indent });
          out.push(`\\begin{${listItem.kind}}`);
        }
      }

      out.push(`  \\item ${convertInline(listItem.content)}`);
      continue;
    }

    if (trimmed.startsWith('>')) {
      closeAllLists();
      out.push('\\begin{quote}', `\\small ${convertInline(trimmed.replace(/^>\s?/, ''))}`, '\\end{quote}');
      continue;
    }

    closeAllLists();
    out.push(convertInline(trimmed));
  }

  // Close anything the document left dangling.
  if (codeBlock !== null) out.push('\\begin{verbatim}', ...codeBlock, '\\end{verbatim}');
  if (displayMath !== null) out.push(...displayMath);
  flushTable();
  closeAllLists();

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const PREAMBLE = `\\documentclass[11pt,a4paper]{ctexart}
\\usepackage{amsmath,amssymb,amsfonts,amsthm}
\\usepackage{mathtools}
\\usepackage{bm}
\\usepackage{geometry}
\\geometry{left=2.5cm,right=2.5cm,top=2.5cm,bottom=2.5cm}
\\usepackage{booktabs}
\\usepackage{longtable}
\\usepackage{enumitem}
\\usepackage{xcolor}
\\usepackage{hyperref}
\\usepackage{fancyhdr}

% Optional maths packages: a minimal TeX Live install must still compile the note.
\\IfFileExists{esint.sty}{\\usepackage{esint}}{}
\\IfFileExists{mathrsfs.sty}{\\usepackage{mathrsfs}}{}

% Macros models reach for that plain amsmath does not define. \\providecommand is a
% no-op when the package above already supplied them.
\\providecommand{\\oiint}{\\oint}
\\providecommand{\\oiiint}{\\oint}
\\providecommand{\\degree}{^\\circ}
\\providecommand{\\dd}{\\mathrm{d}}
\\providecommand{\\abs}[1]{\\left|#1\\right|}
\\providecommand{\\norm}[1]{\\left\\|#1\\right\\|}
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[L]{\\small\\textcolor{gray}{工科教材智能伴读学术推演笔记}}
\\fancyhead[R]{\\small\\textcolor{gray}{\\thepage}}

\\title{\\textbf{\\LARGE 理工科教材学术定理推演与伴读笔记}}
\\author{\\large 工科教材伴读研学室}
\\date{\\today}`;

/** Wraps the converted body in a complete, compilable ctexart document. */
export function markdownToLatexDocument(markdown: string): string {
  return `${PREAMBLE}

\\begin{document}
\\maketitle

${markdownToLatexBody(markdown)}

\\end{document}`;
}
