import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import multer from 'multer';

import { classifyThrownFailure } from './server/errors';
import { SseChannel } from './server/sse';
import {
  BookMetadata,
  CHUNKS_DIR,
  deleteBook,
  getBookPath,
  listBookIndexFiles,
  readBookMetadata,
  saveBookMetadata,
} from './server/pdf/storage';
import { getProvider, normalizeProviderId, ProviderId } from './server/providers';
import { VisionContext, ingestBook } from './server/pipeline/ingest';
import { pickRoutingModel, routeQuestion } from './server/pipeline/route';
import { prepareExcerpt, streamAnswer } from './server/pipeline/answer';
import { needsDeferredVision, recoverOutlineWithVision } from './server/pipeline/visionIndex';

dotenv.config();

const PORT = 3000;
const app = express();

/** Vision-capable by default; text-only endpoints cannot serve this pipeline. */
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

// The request body only ever carries prompts and TOC-sized JSON; PDFs travel as
// multipart uploads and are read from disk one slice at a time.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const upload = multer({
  limits: { fileSize: 60 * 1024 * 1024 },
  storage: multer.memoryStorage(),
});

const DEFAULT_SYSTEM_INSTRUCTION = `你是一位严谨、权威且富有耐心的大学理工科讲席教授（精通高等数学、线性代数、大学物理、理论力学、电磁学与电动力学、量子力学等硬核学科）。
你的首要任务是结合用户上传或提问的大学教材，开展深度、精准的课业伴读、定理推演、概念剖析与课后习题精解。

【回答核心准则】
1. 【严格忠于学术严谨性】：回答必须清晰准确，定理条件不可遗漏。如有教材出处或章节定位，务必明确指引（如：『📖 出处：第 3 章 向量代数 / 第 85 页 定理 3.4』）。
2. 【工科级详尽推导演绎】：
   - 数学公式必须规范使用标准 LaTeX 语法：行内公式用单个 $ 包裹（如 $E=mc^2$）；独立行间公式使用双 $$ 包裹并单独成行。
   - 推导过程步步清晰，绝不可省略关键步骤，清晰阐明每一步的数学变换依据、物理意义或几何直观。
3. 【结构化表格与对比】：涉及多个物理量对比、公式汇总或判别准则对比时，必须优先整理为工整的 Markdown 表格，并标注物理量符号与 SI 单位。
4. 【考点与易错点】：在末尾主动指出学生常见易错陷阱、边界情况及考前复习精要。`;

// ==========================================
// MODEL DISCOVERY
// ==========================================

const discoveredModelsCache: Record<ProviderId, string[]> = {
  gemini: [],
  openai_compatible: [],
};

/** Resolves the target model without hardcoding any vendor model name. */
function resolveDynamicModel(requestedModel: unknown, provider: ProviderId): string {
  if (typeof requestedModel === 'string' && requestedModel.trim()) return requestedModel.trim();
  return discoveredModelsCache[provider]?.[0] || '';
}

function rankModels(models: string[], scorer: (lowered: string) => number): string[] {
  return [...models].sort((a, b) => scorer(b.toLowerCase()) - scorer(a.toLowerCase()));
}

/** Model families that can read a page image, and families that provably cannot. */
const VISION_MODEL_HINTS = ['4o', '4.1', 'o4', 'vision', 'sonnet', 'opus', 'haiku', 'vl', 'omni'];
const TEXT_ONLY_MODEL_HINTS = ['deepseek-chat', 'deepseek-reasoner', 'embedding', 'rerank', 'tts', 'whisper', 'moderation'];

async function discoverGeminiModels(apiKey: string): Promise<string[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'aistudio-build/1.0', Accept: 'application/json' },
  });

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.json())?.error?.message || '';
    } catch {}
    throw new Error(detail || `Google API 返回 HTTP ${response.status} (${response.statusText})。`);
  }

  const data: any = await response.json();
  const models = (data?.models || [])
    .filter((m: any) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m: any) => m.name.replace(/^models\//, ''));

  return rankModels(models, (l) => (l.includes('flash') ? 100 : l.includes('pro') ? 80 : 50));
}

async function discoverOpenAiModels(apiKey: string, baseUrl: string): Promise<string[]> {
  const headers: Record<string, string> = {
    'User-Agent': 'aistudio-build/1.0',
    Accept: 'application/json',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { method: 'GET', headers });
  if (!response.ok) {
    let detail = '';
    try {
      const body: any = await response.json();
      detail = body?.error?.message || body?.message || '';
    } catch {}
    throw new Error(detail || `HTTP ${response.status}`);
  }

  const data: any = await response.json();
  const raw: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : data?.models || [];
  const models = Array.from(
    new Set(raw.map((item: any) => (typeof item === 'string' ? item : item.id || item.name)).filter(Boolean))
  ) as string[];

  // Pages reach this channel as images, so vision-capable models are ranked to the top
  // and known text-only families are pushed to the bottom.
  return rankModels(models, (l) => {
    if (TEXT_ONLY_MODEL_HINTS.some((h) => l.includes(h))) return 0;
    if (VISION_MODEL_HINTS.some((h) => l.includes(h))) return 100;
    return 50;
  });
}

async function autoDiscoverModelsOnBoot(): Promise<void> {
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (!envKey) return;
  try {
    const models = await discoverGeminiModels(envKey);
    if (models.length > 0) {
      discoveredModelsCache.gemini = models;
      console.log(`[boot] discovered ${models.length} Gemini models (primary: ${models[0]})`);
    }
  } catch (err) {
    console.warn('[boot] model discovery skipped:', err);
  }
}

// ==========================================
// HEALTH
// ==========================================

app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    hasEnvKey: Boolean(process.env.GEMINI_API_KEY),
    architecture: 'TOC index -> chapter routing -> physical slice -> native PDF or page images -> stream',
  });
});

// ==========================================
// STAGE 1 ROUTES: TEXTBOOK LIBRARY
// ==========================================

/** Repairs Multer's latin1 filename decoding for CJK names. */
function decodeOriginalFileName(rawName: string): string {
  if (!rawName) return '';
  if (/[\u4e00-\u9fa5]/.test(rawName)) return rawName;
  try {
    const converted = Buffer.from(rawName, 'latin1').toString('utf8');
    if (converted && !converted.includes('\uFFFD') && /[\u4e00-\u9fa5]/.test(converted)) return converted;
  } catch {}
  return rawName;
}

function newBookId(): string {
  return `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function describeIngest(meta: BookMetadata): string {
  const scale = `共 ${meta.pageCount} 页，${meta.toc.length} 条大纲`;

  switch (meta.tocSource) {
    case 'vision':
      return `✅ 教材《${meta.name}》无电子书签，已由多模态模型视觉识别印刷目录并永久缓存（${scale}）`;
    case 'synthesized':
      return `⚠️ 教材《${meta.name}》既无电子书签，也未能识别出印刷目录，已按每 30 页划分为逻辑块以保证可用（${scale}）`;
    default:
      return `✅ 教材《${meta.name}》已完成本地目录索引（${scale}，未消耗任何 Token）`;
  }
}

/**
 * Builds the vision context for ingest from whatever the client sent alongside the file.
 *
 * Returns null when no usable credentials arrived, in which case ingest stays offline
 * and a scanned book falls back to page blocks until the first question.
 */
function visionContextFromRequest(body: any): VisionContext | null {
  const providerId = normalizeProviderId(body?.provider);
  const provider = getProvider(providerId);

  const apiKey = String(
    body?.apiKey || (providerId === 'gemini' ? process.env.GEMINI_API_KEY : '') || ''
  ).trim();
  if (!apiKey) return null;

  const model = resolveDynamicModel(body?.model, providerId);
  if (!model) return null;

  return {
    provider,
    model,
    credentials: { apiKey, baseUrl: String(body?.baseUrl || DEFAULT_OPENAI_BASE_URL).trim() },
  };
}

/** Handles both single-shot and chunked uploads, then indexes the book locally. */
async function handleBookUpload(req: Request, res: Response): Promise<void> {
  if (!req.file?.buffer) {
    res.status(400).json({ success: false, error: '未接收到上传的 PDF 教材文件数据。' });
    return;
  }

  const { uploadId, chunkIndex, totalChunks, fileName, fileSize, clientFileName } = req.body || {};
  const rawFileName = clientFileName || fileName || req.file.originalname || 'textbook.pdf';
  const safeName = decodeOriginalFileName(rawFileName);
  const vision = visionContextFromRequest(req.body);

  // Mode A: chunked upload for large textbooks
  if (uploadId && chunkIndex !== undefined && totalChunks) {
    const index = parseInt(chunkIndex, 10);
    const total = parseInt(totalChunks, 10);
    const sessionDir = path.join(CHUNKS_DIR, String(uploadId).replace(/[^a-zA-Z0-9_-]/g, ''));
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    fs.writeFileSync(path.join(sessionDir, `part_${index}`), req.file.buffer);

    if (index < total - 1) {
      res.json({ success: true, completed: false, chunkIndex: index, totalChunks: total, uploadId });
      return;
    }

    const bookId = newBookId();
    const finalPath = getBookPath(bookId);

    try {
      const destStream = fs.createWriteStream(finalPath);
      for (let i = 0; i < total; i++) {
        const partFile = path.join(sessionDir, `part_${i}`);
        if (!fs.existsSync(partFile)) throw new Error(`分块丢失 (缺少第 ${i + 1} 块)，请重试上传。`);
        destStream.write(fs.readFileSync(partFile));
      }
      destStream.end();
      await new Promise<void>((resolve, reject) => {
        destStream.on('finish', () => resolve());
        destStream.on('error', reject);
      });

      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {}

      const meta = await ingestBook(finalPath, safeName, fs.statSync(finalPath).size, bookId, vision);
      saveBookMetadata(meta);
      res.json({ success: true, completed: true, book: { ...meta, status: 'ready' }, message: describeIngest(meta) });
    } catch (err: any) {
      console.error('[upload] chunked assembly failed:', err);
      try {
        if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {}
      res.status(500).json({ success: false, error: `教材组装与大纲解析失败: ${err?.message || String(err)}` });
    }
    return;
  }

  // Mode B: direct single-file upload
  const bookId = newBookId();
  const savedPath = getBookPath(bookId);

  try {
    fs.writeFileSync(savedPath, req.file.buffer);
    const meta = await ingestBook(savedPath, safeName, req.file.size, bookId, vision);
    saveBookMetadata(meta);
    res.json({ success: true, completed: true, book: { ...meta, status: 'ready' }, message: describeIngest(meta) });
  } catch (err: any) {
    console.error('[upload] indexing failed:', err);
    try {
      if (fs.existsSync(savedPath)) fs.unlinkSync(savedPath);
    } catch {}
    res.status(500).json({ success: false, error: `PDF 解析与大纲提取失败: ${err?.message || String(err)}` });
  }
}

app.post('/api/books/upload', upload.single('file'), handleBookUpload);
app.post('/api/books/upload-chunk', upload.single('file'), handleBookUpload);

app.get('/api/books', async (req: Request, res: Response) => {
  try {
    const books: BookMetadata[] = [];

    for (const file of listBookIndexFiles()) {
      const bookId = file.replace(/_toc\.json$/, '');
      let meta = readBookMetadata(bookId);
      if (!meta) continue;

      const pdfPath = getBookPath(meta.id);
      if (!fs.existsSync(pdfPath)) continue;

      meta.name = decodeOriginalFileName(meta.name);

      // Indexes written before destination-aware outline parsing point every chapter at
      // page 1. Rebuild those once; every other index, including a synthesized one, is a
      // settled result and must not be recomputed on each listing.
      if (!meta.tocSource) {
        console.log(`[books] re-indexing legacy TOC for ${meta.id}`);
        meta = await ingestBook(pdfPath, meta.name, fs.statSync(pdfPath).size, meta.id);
        saveBookMetadata(meta);
      }

      books.push(meta);
    }

    res.json({ success: true, books });
  } catch (err) {
    console.warn('[books] listing failed:', err);
    res.json({ success: true, books: [] });
  }
});

app.delete('/api/books/:id', (req: Request, res: Response) => {
  try {
    deleteBook(req.params.id);
    res.json({ success: true, deletedId: req.params.id });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || '删除失败' });
  }
});

// ==========================================
// MODEL DISCOVERY ROUTE
// ==========================================

app.post('/api/models/discover', async (req: Request, res: Response): Promise<void> => {
  const provider = normalizeProviderId(req.body?.provider);
  const { apiKey: customKey, baseUrl: customBaseUrl } = req.body || {};

  try {
    let models: string[];

    if (provider === 'gemini') {
      const key = String(customKey || req.headers['x-gemini-api-key'] || process.env.GEMINI_API_KEY || '').trim();
      if (!key) {
        res.status(400).json({
          success: false,
          provider,
          error: '未提供 Google Gemini API Key，且系统环境变量中未检测到 GEMINI_API_KEY。',
        });
        return;
      }
      models = await discoverGeminiModels(key);
    } else {
      models = await discoverOpenAiModels(
        String(customKey || '').trim(),
        String(customBaseUrl || DEFAULT_OPENAI_BASE_URL).trim()
      );
    }

    if (models.length > 0) discoveredModelsCache[provider] = models;

    res.json({
      success: true,
      provider,
      models,
      message: `成功拉取到 ${models.length} 个可用模型！`,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      provider,
      error: `连接模型服务失败: ${err?.message || String(err)}`,
    });
  }
});

// ==========================================
// STAGES 2-4: QUESTION -> ROUTE -> SLICE -> STREAM
// ==========================================

/** Collects the locally indexed metadata for every mounted book. */
function loadMountedBooks(bookIds: unknown, books: unknown): BookMetadata[] {
  const ids: string[] = [];

  if (Array.isArray(bookIds)) {
    for (const id of bookIds) if (typeof id === 'string' && id.trim()) ids.push(id.trim());
  }
  if (Array.isArray(books)) {
    for (const entry of books) {
      const id = typeof entry === 'string' ? entry : (entry as any)?.id;
      if (id && !ids.includes(id)) ids.push(id);
    }
  }

  return ids.map((id) => readBookMetadata(id)).filter((m): m is BookMetadata => m !== null);
}

app.post('/api/chat', async (req: Request, res: Response): Promise<void> => {
  const { prompt, history = [], bookIds = [], books = [], model, customApiKey, baseUrl } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: '提问内容不能为空。' });
    return;
  }

  const providerId = normalizeProviderId(req.body?.provider);
  const provider = getProvider(providerId);
  const channel = new SseChannel(res);
  const startTime = Date.now();

  try {
    const credentials = {
      apiKey: String(customApiKey || req.headers['x-gemini-api-key'] || process.env.GEMINI_API_KEY || '').trim(),
      baseUrl: String(baseUrl || DEFAULT_OPENAI_BASE_URL).trim(),
    };

    if (!credentials.apiKey) {
      channel.fail({
        code: 'auth',
        message:
          providerId === 'gemini'
            ? '缺少 Google Gemini API Key。'
            : '缺少 OpenAI / Claude 多模态兼容协议 API Key。',
        hint: '请在左侧配置面板填写有效的 API Key 后重试。',
      });
      return;
    }

    const answerModel = resolveDynamicModel(model, providerId);
    if (!answerModel) {
      channel.fail({
        code: 'not_found',
        message: '尚未选择可用的模型。',
        hint: '请点击左侧「刷新探测」拉取模型列表，并在下拉框中选择一个模型。',
      });
      return;
    }

    let mounted = loadMountedBooks(bookIds, books);

    // ---- STAGE 1b: catch up on books uploaded before any key was configured ----
    if (mounted.some(needsDeferredVision)) {
      mounted = await Promise.all(
        mounted.map((book) =>
          needsDeferredVision(book)
            ? recoverOutlineWithVision({ book, provider, model: answerModel, credentials, channel })
            : book
        )
      );
    }

    // ---- STAGE 2: route the question against the TOC tree only ----
    let decision = null;
    if (mounted.length > 0) {
      channel.stage('正在查阅教材目录，定位相关章节…');
      decision = await routeQuestion({
        prompt,
        books: mounted,
        provider,
        routingModel: pickRoutingModel(discoveredModelsCache[providerId], answerModel),
        credentials,
        channel,
      });
    }

    // ---- STAGE 3: physically slice, then render into the provider's visual format ----
    let excerpt = null;
    const routedBook = decision ? mounted.find((b) => b.id === decision!.bookId) : undefined;

    if (decision && routedBook) {
      channel.stage(
        provider.excerptFormat === 'pdf'
          ? '正在物理切取目标章节…'
          : '正在物理切取目标章节并渲染为高精度页面影像…'
      );
      try {
        excerpt = await prepareExcerpt(decision, routedBook, provider);
      } catch (err) {
        console.warn('[chat] slicing failed, answering without textbook context:', err);
        channel.notice('warn', '教材切片失败，本轮将以通识推导作答。');
      }

      if (excerpt) {
        const prefix = decision.source === 'keyword' ? '📖 已按目录关键词定位' : '📖 智能图书管理员已查阅目录并锁定';
        channel.send({
          routing: {
            ...decision,
            matched: true,
            startPage: excerpt.pageRange[0],
            endPage: excerpt.pageRange[1],
            contextTokens: excerpt.estimatedTokens,
            payload: provider.excerptFormat,
            label: `${prefix}：《${decision.bookName}》${decision.chapterTitle} (P${excerpt.pageRange[0]} - P${excerpt.pageRange[1]})`,
          },
        });
      }
    } else if (mounted.length > 0) {
      channel.notice('info', '未能在已挂载教材中定位到对应章节，本轮以通识推导作答。');
    }

    // ---- STAGE 4: stream the answer ----
    channel.stage('正在等待模型推演…');
    await streamAnswer({
      provider,
      model: answerModel,
      credentials,
      systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
      prompt,
      history,
      excerpt,
      channel,
    });

    channel.end({
      done: true,
      responseTimeMs: Date.now() - startTime,
      contextTokens: excerpt?.estimatedTokens ?? 0,
      pageRange: excerpt?.pageRange ?? null,
    });
  } catch (err: any) {
    console.error('[chat] unhandled failure:', err);
    channel.fail(classifyThrownFailure(err));
  }
});

// ==========================================
// LATEX TOOLCHAIN
// ==========================================

const LATEX_INSTALL_GUIDE =
  'sudo apt update && sudo apt install -y texlive-xetex texlive-lang-chinese texlive-latex-extra';

function detectXelatex(): { installed: boolean; version: string | null } {
  try {
    const which = spawnSync('which', ['xelatex'], { encoding: 'utf-8' });
    if (which.status !== 0 || !which.stdout.trim()) return { installed: false, version: null };
    const versionRes = spawnSync('xelatex', ['--version'], { encoding: 'utf-8' });
    return { installed: true, version: versionRes.stdout.split('\n')[0] || 'XeLaTeX' };
  } catch {
    return { installed: false, version: null };
  }
}

app.get('/api/latex/status', (req: Request, res: Response) => {
  const { installed, version } = detectXelatex();
  res.json({ installed, engine: 'xelatex', version, installGuide: LATEX_INSTALL_GUIDE });
});

app.post('/api/latex/compile', (req: Request, res: Response): void => {
  const code = req.body?.latexCode || req.body?.code;
  if (!code || typeof code !== 'string') {
    res.status(400).json({ success: false, error: '缺少 LaTeX 源码内容。' });
    return;
  }

  if (!detectXelatex().installed) {
    res.json({
      success: false,
      installed: false,
      error: '系统尚未安装 XeLaTeX 编译引擎。',
      log: `【环境自愈提示】\n未检测到系统 xelatex 可执行程序。\n如需在 Ubuntu 终端启用原生编译，请运行：\n${LATEX_INSTALL_GUIDE}\n\n当前工作台已自动启用高保真矢量引擎生成排版预览，您亦可随时下载 .tex 源码或 PDF 文档。`,
    });
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-compile-'));
  const pdfPath = path.join(tempDir, 'document.pdf');
  const logPath = path.join(tempDir, 'document.log');

  try {
    fs.writeFileSync(path.join(tempDir, 'document.tex'), code, 'utf-8');
    const compileResult = spawnSync('xelatex', ['-interaction=nonstopmode', '-halt-on-error', 'document.tex'], {
      cwd: tempDir,
      timeout: 30000,
      encoding: 'utf-8',
    });

    const logContent = fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf-8')
      : `${compileResult.stdout || ''}\n${compileResult.stderr || ''}`;

    if (fs.existsSync(pdfPath)) {
      res.json({
        success: true,
        installed: true,
        pdfBase64: fs.readFileSync(pdfPath).toString('base64'),
        log: logContent.slice(0, 10000),
        message: '⚡ XeLaTeX 编译成功！',
      });
      return;
    }

    const errorLines = logContent
      .split('\n')
      .filter((line) => line.startsWith('!') || line.includes('Error:'))
      .slice(0, 5);

    res.json({
      success: false,
      installed: true,
      error: errorLines[0] || 'LaTeX 源码存在语法错误，请参考编译日志调整。',
      log: logContent.slice(-8000),
    });
  } catch (err: any) {
    res.json({ success: false, installed: true, error: err?.message || '编译子进程发生异常', log: String(err) });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

// ==========================================
// BOOTSTRAP
// ==========================================

app.use((err: any, req: Request, res: Response, next: any) => {
  console.error('[express]', err);
  if (err instanceof multer.MulterError) {
    res.status(400).json({ success: false, error: `文件上传错误 (${err.code}): ${err.message}` });
    return;
  }
  if (err) {
    res.status(500).json({ success: false, error: err?.message || '服务器内部异常' });
    return;
  }
  next();
});

async function startServer(): Promise<void> {
  await autoDiscoverModelsOnBoot();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
