/**
 * One-shot comprehensive suite: routing, physical slice, both visual channels,
 * LaTeX/PDF, and OpenAI-compatible chat against a local mock.
 */
import http from 'http';
import { createRequire } from 'module';
import { getProvider, normalizeProviderId } from '../server/providers';
import { expandRange, matchChapterLocally, parseRoutingJson, pickRoutingModel } from '../server/pipeline/route';
import { prepareExcerpt } from '../server/pipeline/answer';
import { slicePdf } from '../server/pdf/slice';
import { listBookIndexFiles, readBookMetadata } from '../server/pdf/storage';
import { MAX_SLICE_PAGES } from '../server/budget';
import { markdownToLatexDocument } from '../src/utils/markdownToLatex';

const require = createRequire(import.meta.url);

type Check = { name: string; ok: boolean; detail: string };

const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function loadBooks() {
  return listBookIndexFiles()
    .map((file) => readBookMetadata(file.replace(/_toc\.json$/, '')))
    .filter((b): b is NonNullable<typeof b> => !!b);
}

const CASES: Array<{ prompt: string; expectBook: string; expectTitle: string }> = [
  { prompt: '请证明最小作用量原理如何导出拉格朗日方程。', expectBook: '力学', expectTitle: '最小作用量' },
  { prompt: '开普勒问题的轨道方程和守恒量是什么？', expectBook: '力学', expectTitle: '开普勒' },
  { prompt: '哈密顿方程是怎么从拉格朗日函数得到的？', expectBook: '力学', expectTitle: '哈密顿' },
  { prompt: '刚体运动的欧拉方程怎么写？', expectBook: '力学', expectTitle: '欧拉方程' },
  { prompt: '复分析中共形映射的定义与性质是什么？', expectBook: '复分析', expectTitle: '共形' },
  { prompt: '柯西-黎曼方程是什么，它和解析性有何关系？', expectBook: '复分析', expectTitle: '柯西' },
  { prompt: '柯西-黎曼方程的几何意义是什么？', expectBook: '复分析', expectTitle: '柯西' },
  { prompt: '留数计算的常用公式有哪些？', expectBook: '复分析', expectTitle: '留数' },
  { prompt: 'RISC-V 流水线处理器的数据冒险怎么处理？', expectBook: '数字设计', expectTitle: '流水线' },
  { prompt: '虚拟存储器的地址翻译过程是怎样的？', expectBook: '数字设计', expectTitle: '虚拟存储器' },
];

async function testProvidersAndRouting() {
  record('provider.gemini', normalizeProviderId('gemini') === 'gemini' && getProvider('gemini').excerptFormat === 'pdf', 'excerptFormat=pdf');
  record('provider.openai', normalizeProviderId('openai_compatible') === 'openai_compatible' && getProvider('openai_compatible').excerptFormat === 'image', 'excerptFormat=image');
  record('provider.unknown-defaults-gemini', normalizeProviderId('nope') === 'gemini', '');

  record(
    'pickRoutingModel.prefers-flash',
    pickRoutingModel(['gemini-1.5-pro', 'gemini-1.5-flash'], 'gemini-1.5-pro') === 'gemini-1.5-flash',
    ''
  );
  record(
    'pickRoutingModel.prefers-mini',
    pickRoutingModel(['gpt-4o', 'gpt-4o-mini'], 'gpt-4o') === 'gpt-4o-mini',
    ''
  );
  record(
    'pickRoutingModel.skips-review-bot',
    pickRoutingModel(['codex-auto-review', 'gpt-4o-mini'], 'codex-auto-review') === 'gpt-4o-mini',
    ''
  );
  record(
    'expandRange.caps-at-ten',
    expandRange(15, 16, 192).join('-') === '15-24' && expandRange(295, 306, 491).join('-') === '295-304',
    ''
  );
  record(
    'parseRoutingJson.fenced',
    parseRoutingJson('```json\n{"matched":true,"bookId":"x"}\n```')?.bookId === 'x',
    ''
  );

  const books = loadBooks();
  record('books.mounted', books.length >= 3, books.map((b) => `${b.name.slice(0, 12)}…/${b.toc.length}条`).join(' | '));

  for (const c of CASES) {
    const hit = matchChapterLocally(c.prompt, books);
    const bookOk = !!hit && hit.bookName.includes(c.expectBook);
    const titleOk = !!hit && hit.chapterTitle.includes(c.expectTitle);
    const span = hit ? hit.endPage - hit.startPage + 1 : 0;
    const spanOk = !!hit && span >= 1 && span <= MAX_SLICE_PAGES;
    record(
      `route.keyword: ${c.expectTitle}`,
      bookOk && titleOk && spanOk,
      hit ? `${hit.bookName.slice(0, 18)} / ${hit.chapterTitle} P${hit.startPage}-${hit.endPage}` : '未命中'
    );
  }

  record(
    'route.unrelated-falls-through',
    matchChapterLocally('今天天气怎么样', books) === null,
    ''
  );
}

async function testSlices() {
  const books = loadBooks();
  const landau = books.find((b) => b.name.includes('力学'));
  const complex = books.find((b) => b.name.includes('复分析'));
  if (!landau || !complex) {
    record('slice.books', false, '缺少力学或复分析教材');
    return;
  }

  const action = matchChapterLocally('最小作用量原理', [landau])!;
  const pdfExcerpt = await prepareExcerpt(action, landau, getProvider('gemini'));
  record(
    'slice.gemini-pdf',
    !!pdfExcerpt.pdfBase64 && !pdfExcerpt.images && pdfExcerpt.pageRange[1] - pdfExcerpt.pageRange[0] + 1 <= MAX_SLICE_PAGES,
    `P${pdfExcerpt.pageRange[0]}-${pdfExcerpt.pageRange[1]} tokens=${pdfExcerpt.estimatedTokens}`
  );

  const tight = {
    bookId: landau.id,
    bookName: landau.name,
    chapterTitle: '2 最小作用量原理',
    startPage: 15,
    endPage: 16,
    source: 'keyword' as const,
  };
  const imageExcerpt = await prepareExcerpt(tight, landau, getProvider('openai_compatible'));
  record(
    'slice.openai-images',
    !!imageExcerpt.images && imageExcerpt.images.length === 2 && imageExcerpt.images.every((im) => im.base64.length > 1000 && !imageExcerpt.pdfBase64),
    `${imageExcerpt.images?.length} JPEG, ${imageExcerpt.images?.reduce((s, i) => s + i.sizeKb, 0)}KB`
  );

  const residue = matchChapterLocally('留数计算的公式', [complex])!;
  const sliced = await slicePdf(complex.id, residue.startPage, Math.min(residue.startPage + 2, residue.endPage));
  record(
    'slice.physical-copy',
    sliced.pageRange[0] === residue.startPage && sliced.sizeKb > 5,
    `P${sliced.pageRange[0]}-${sliced.pageRange[1]} ${sliced.sizeKb}KB`
  );
}

function startMockOpenAi(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'gpt-4o' },
              { id: 'gpt-4o-mini' },
              { id: 'claude-3-5-sonnet' },
              { id: 'deepseek-chat' },
            ],
          })
        );
        return;
      }

      if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const blob = JSON.stringify(body);
        const isRoute = blob.includes('图书管理员') || blob.includes('matched');
        const hasImages = blob.includes('image_url') && blob.includes('detail":"high"');

        if (!body.stream) {
          const content = isRoute
            ? JSON.stringify({
                matched: true,
                bookId: 'book-1790397737839-dozocr',
                bookName: '朗道理论物理学教程 第一卷 力学',
                chapterTitle: '2 最小作用量原理',
                startPage: 15,
                endPage: 16,
                rationale: 'mock route',
              })
            : 'ok';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content } }] }));
          return;
        }

        const answer = hasImages
          ? '已阅读教材第15-16页。最小作用量原理给出 $\\delta S=0$。'
          : '通识回答（未带图像）。';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function consumeSse(res: Response) {
  const text = await res.text();
  const events: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6).trim();
    if (!raw) continue;
    try {
      events.push(JSON.parse(raw));
    } catch {}
  }
  return events;
}

async function testHttp(base: string, mockUrl: string) {
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  record('http.health', health.status === 'ok', '');

  const listed = await fetch(`${base}/api/books`).then((r) => r.json());
  record('http.books', Array.isArray(listed.books) && listed.books.length >= 3, `${listed.books?.length || 0} books`);

  const geminiDiscover = await fetch(`${base}/api/models/discover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'gemini' }),
  });
  const geminiBody = await geminiDiscover.json();
  record(
    'http.gemini-discover',
    (geminiDiscover.status === 400 && /API Key/.test(geminiBody.error || '')) ||
      (geminiDiscover.ok && Array.isArray(geminiBody.models) && geminiBody.models.length > 0),
    geminiBody.error || `models=${geminiBody.models?.length || 0}`
  );

  const openaiDiscover = await fetch(`${base}/api/models/discover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openai_compatible', apiKey: 'sk-mock', baseUrl: mockUrl }),
  });
  const openaiBody = await openaiDiscover.json();
  const ranked = openaiBody.models || [];
  record(
    'http.openai-discover',
    openaiDiscover.ok &&
      ranked[0] === 'gpt-4o-mini' &&
      ranked.includes('gpt-4o') &&
      ranked.includes('claude-3-5-sonnet') &&
      ranked.at(-1) === 'deepseek-chat',
    JSON.stringify(ranked)
  );

  const latexStatus = await fetch(`${base}/api/latex/status`).then((r) => r.json());
  record('http.latex-status', latexStatus.installed === true, latexStatus.version || '');

  const md = `## 最小作用量原理

作用量 $S=\\int L\\,dt$。驻定条件给出

$$
\\frac{\\mathrm{d}}{\\mathrm{d}t}\\frac{\\partial L}{\\partial \\dot q}=\\frac{\\partial L}{\\partial q}
$$

| 量 | 符号 |
| --- | --- |
| 拉格朗日量 | $L$ |
`;
  const tex = markdownToLatexDocument(md);
  record('latex.markdown-convert', tex.includes('\\begin{document}') && tex.includes('\\begin{tabular}'), `${tex.length} chars`);

  const compiled = await fetch(`${base}/api/latex/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ latexCode: tex }),
  }).then((r) => r.json());
  record('latex.xelatex-compile', compiled.success === true && typeof compiled.pdfBase64 === 'string' && compiled.pdfBase64.length > 1000, compiled.error || `pdf ${compiled.pdfBase64?.length || 0}b64`);

  const geminiChat = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'gemini', prompt: '你好', model: 'not-a-real-model', customApiKey: 'invalid-gemini-key' }),
  });
  const geminiEvents = await consumeSse(geminiChat);
  record(
    'http.gemini-chat-bad-key',
    geminiEvents.some((e) => e.error),
    geminiEvents.find((e) => e.error)?.error || ''
  );

  const openaiChat = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'openai_compatible',
      baseUrl: mockUrl,
      customApiKey: 'sk-mock',
      model: 'gpt-4o-mini',
      prompt: '请根据教材说明最小作用量原理。',
      bookIds: ['book-1790397737839-dozocr'],
    }),
  });
  const openaiEvents = await consumeSse(openaiChat);
  const routing = openaiEvents.find((e) => e.routing)?.routing;
  const text = openaiEvents.map((e) => e.text || '').join('');
  const done = openaiEvents.find((e) => e.done);
  record(
    'http.openai-chat-e2e',
    routing?.matched && routing?.payload === 'image' && /最小作用量/.test(text) && done?.done === true,
    routing ? `${routing.label || routing.chapterTitle} | ${text.slice(0, 40)}` : `events=${openaiEvents.length}`
  );
}

async function main() {
  await testProvidersAndRouting();
  await testSlices();

  const mock = await startMockOpenAi();
  const base = process.env.SUITE_BASE || 'http://127.0.0.1:3000';
  try {
    await testHttp(base, mock.url);
  } finally {
    await mock.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('\n---');
  console.log(`total=${checks.length} pass=${checks.length - failed.length} fail=${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.log('  x', f.name, f.detail);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
