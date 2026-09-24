import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import { GoogleAICacheManager } from '@google/generative-ai/server';
import dotenv from 'dotenv';
import multer from 'multer';
import {
  slicePdf,
  getBookPath,
  getBookTocPath,
  resolvePdfMetadata,
  extractPageRangeText,
  estimateTokens,
  truncateToTokenBudget,
  clampPageRange,
  MAX_SLICE_PAGES,
  MAX_CONTEXT_TOKENS,
  BookMetadata,
} from './server/pdfEngine';
import {
  SseChannel,
  ProviderId,
  supportsNativePdf,
  resilientFetch,
  classifyThrownFailure,
  buildTocCatalog,
  matchChapterLocally,
  expandRange,
} from './server/llmAdapter';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const app = express();

const UPLOADS_DIR = path.join(process.cwd(), 'uploads', 'books');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Lightweight JSON parsing (no need for 50MB base64 anymore!)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Memory storage for uploads (up to 60MB for single files, 6MB per chunk)
const upload = multer({
  limits: { fileSize: 60 * 1024 * 1024 },
  storage: multer.memoryStorage(),
});

const CHUNKS_DIR = path.join(UPLOADS_DIR, 'temp_chunks');
if (!fs.existsSync(CHUNKS_DIR)) {
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
}

const chunkUpload = upload;

// Health check endpoint
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    hasEnvKey: Boolean(process.env.GEMINI_API_KEY),
    architecture: 'Hierarchical TOC Navigation & Surgical Slicing',
  });
});

// ==========================================
// 1. BOOK MANAGEMENT & TOC INDEXING APIS
// ==========================================

// Helper to fix Multer latin1 filename encoding for Chinese/CJK characters
function decodeOriginalFileName(rawName: string): string {
  if (!rawName) return '';
  // If string already contains readable CJK characters, keep as-is!
  if (/[\u4e00-\u9fa5]/.test(rawName)) {
    return rawName;
  }
  try {
    const converted = Buffer.from(rawName, 'latin1').toString('utf8');
    // If conversion resolved latin1-garbled bytes into valid CJK characters
    if (converted && !converted.includes('\uFFFD') && /[\u4e00-\u9fa5]/.test(converted)) {
      return converted;
    }
  } catch {}
  return rawName;
}

// ==========================================
// DYNAMIC MODEL RESOLUTION & JSON CLEANER
// ==========================================

const discoveredModelsCache: {
  gemini: string[];
  openai_compatible: string[];
} = {
  gemini: [],
  openai_compatible: [],
};

// Safe helper to strip markdown code blocks and parse JSON safely
export function cleanAndParseJson<T = any>(raw: string): T | null {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  // Strip code blocks like ```json ... ``` or ``` ... ```
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // 1. Direct parse attempt
  try {
    return JSON.parse(text);
  } catch {}

  // 2. Extract outermost { ... }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  return null;
}

// Dynamically resolve target model without any hardcoded strings
export function resolveDynamicModel(
  requestedModel?: string,
  provider: 'gemini' | 'openai_compatible' = 'gemini'
): string {
  if (requestedModel && typeof requestedModel === 'string' && requestedModel.trim()) {
    return requestedModel.trim();
  }
  const cachedList = discoveredModelsCache[provider] || [];
  if (cachedList.length > 0 && cachedList[0]) {
    return cachedList[0];
  }
  return '';
}

// Auto discover models on server startup dynamically from API key
async function autoDiscoverModelsOnBoot() {
  const envKey = process.env.GEMINI_API_KEY;
  if (!envKey || !envKey.trim()) return;

  try {
    const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(envKey.trim())}`;
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'aistudio-build/1.0',
        Accept: 'application/json',
      },
    });

    if (response.ok) {
      const data: any = await response.json();
      const rawModels: any[] = data?.models || [];
      const validModels = rawModels
        .filter((m) => {
          const methods = m.supportedGenerationMethods || [];
          return Array.isArray(methods) && methods.includes('generateContent');
        })
        .map((m) => m.name.replace(/^models\//, ''));

      validModels.sort((a, b) => {
        const getScore = (name: string) => {
          const l = name.toLowerCase();
          if (l.includes('flash')) return 100;
          if (l.includes('pro')) return 80;
          return 50;
        };
        return getScore(b) - getScore(a);
      });

      if (validModels.length > 0) {
        discoveredModelsCache.gemini = validModels;
        console.log(`[Boot] Dynamically discovered ${validModels.length} available Gemini models (Primary: ${validModels[0]})`);
      }
    }
  } catch (err) {
    console.warn('[Boot] Dynamic model discovery note:', err);
  }
}

// Unified book upload handler supporting both single-file and chunked uploads
async function handleBookUpload(req: Request, res: Response): Promise<void> {
  if (!req.file || !req.file.buffer) {
    res.status(400).json({ success: false, error: '未接收到上传的 PDF 教材文件数据。' });
    return;
  }

  const { uploadId, chunkIndex, totalChunks, fileName, fileSize, clientFileName } = req.body || {};

  // Mode A: Chunked upload (for large textbooks)
  if (uploadId && chunkIndex !== undefined && totalChunks) {
    const cIdx = parseInt(chunkIndex, 10);
    const tChunks = parseInt(totalChunks, 10);
    const totalBytes = parseInt(fileSize || '0', 10) || req.file.size;
    const rawFileName = fileName || clientFileName || req.file.originalname || 'textbook.pdf';
    const safeName = decodeOriginalFileName(rawFileName);

    const sessionDir = path.join(CHUNKS_DIR, String(uploadId).replace(/[^a-zA-Z0-9_-]/g, ''));
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const chunkPath = path.join(sessionDir, `part_${cIdx}`);
    fs.writeFileSync(chunkPath, req.file.buffer);

    // Intermediate chunk receipt acknowledge
    if (cIdx < tChunks - 1) {
      res.json({
        success: true,
        completed: false,
        chunkIndex: cIdx,
        totalChunks: tChunks,
        uploadId,
      });
      return;
    }

    // Final chunk received: Reassemble all chunks in sequential order
    const bookId = `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const finalBookPath = getBookPath(bookId);

    try {
      const destStream = fs.createWriteStream(finalBookPath);

      for (let i = 0; i < tChunks; i++) {
        const partFile = path.join(sessionDir, `part_${i}`);
        if (!fs.existsSync(partFile)) {
          throw new Error(`分块丢失 (缺少第 ${i + 1} 块)，请重试上传。`);
        }
        const partBuf = fs.readFileSync(partFile);
        destStream.write(partBuf);
      }

      destStream.end();
      await new Promise<void>((resolve, reject) => {
        destStream.on('finish', () => resolve());
        destStream.on('error', (err) => reject(err));
      });

      // Clean up temp chunks
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {}

      // Resilient PDF analysis and TOC extraction
      const actualSize = fs.statSync(finalBookPath).size || totalBytes;
      const metadata = await resolvePdfMetadata(finalBookPath, safeName, actualSize, bookId);

      // Save lightweight ~5KB TOC index to disk
      fs.writeFileSync(getBookTocPath(bookId), JSON.stringify(metadata, null, 2), 'utf-8');

      res.json({
        success: true,
        completed: true,
        book: {
          ...metadata,
          tokensEstimate: Math.round(metadata.pageCount * 800),
          status: 'ready',
        },
        message: `✅ 教材《${safeName}》成功入库并完成大纲索引 (共 ${metadata.pageCount} 页，${metadata.toc.length} 个章节大纲)！`,
      });
      return;
    } catch (err: any) {
      console.error('Failed to assemble and index chunked PDF:', err);
      try {
        if (fs.existsSync(finalBookPath)) fs.unlinkSync(finalBookPath);
      } catch {}
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {}
      res.status(500).json({
        success: false,
        error: `教材组装与大纲解析失败: ${err?.message || String(err)}`,
      });
      return;
    }
  }

  // Mode B: Standard single-file direct upload
  const rawFileName = clientFileName || fileName || req.file.originalname || 'textbook.pdf';
  const safeName = decodeOriginalFileName(rawFileName);
  const bookId = `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const savedPath = getBookPath(bookId);

  try {
    fs.writeFileSync(savedPath, req.file.buffer);
    const metadata = await resolvePdfMetadata(savedPath, safeName, req.file.size, bookId);

    // Save lightweight ~5KB TOC index to disk
    fs.writeFileSync(getBookTocPath(bookId), JSON.stringify(metadata, null, 2), 'utf-8');

    res.json({
      success: true,
      completed: true,
      book: {
        ...metadata,
        tokensEstimate: Math.round(metadata.pageCount * 800),
        status: 'ready',
      },
      message: `✅ 教材《${safeName}》成功入库并完成微型目录索引 (共 ${metadata.pageCount} 页，${metadata.toc.length} 个章节大纲)！`,
    });
  } catch (err: any) {
    console.error('Failed to parse and index PDF:', err);
    try {
      if (fs.existsSync(savedPath)) fs.unlinkSync(savedPath);
    } catch {}
    res.status(500).json({
      success: false,
      error: `PDF 解析与大纲提取失败: ${err?.message || String(err)}`,
    });
  }
}

// Support both /api/books/upload and /api/books/upload-chunk identically
app.post('/api/books/upload', upload.single('file'), handleBookUpload);
app.post('/api/books/upload-chunk', upload.single('file'), handleBookUpload);

// List all indexed textbooks stored on server
app.get('/api/books', async (req: Request, res: Response) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    const tocFiles = files.filter((f) => f.endsWith('_toc.json'));
    const books: BookMetadata[] = [];

    for (const file of tocFiles) {
      const fullPath = path.join(UPLOADS_DIR, file);
      try {
        let parsed = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        const pdfPath = getBookPath(parsed.id);
        // Verify corresponding PDF exists
        if (!fs.existsSync(pdfPath)) continue;

        parsed.name = decodeOriginalFileName(parsed.name);

        // Indexes written before destination-aware outline parsing collapsed every
        // chapter onto page 1; rebuild them once instead of routing against bad pages.
        if (!parsed.tocSource) {
          console.log(`[books] re-indexing legacy TOC for ${parsed.id}`);
          parsed = await resolvePdfMetadata(
            pdfPath,
            parsed.name,
            fs.statSync(pdfPath).size,
            parsed.id
          );
          fs.writeFileSync(fullPath, JSON.stringify(parsed, null, 2), 'utf-8');
        }

        books.push(parsed);
      } catch (err) {
        console.warn(`[books] skipping unreadable index ${file}:`, err);
      }
    }

    res.json({ success: true, books });
  } catch (err: any) {
    res.json({ success: true, books: [] });
  }
});

// Delete a book and its TOC index
app.delete('/api/books/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const pdfP = getBookPath(id);
    const tocP = getBookTocPath(id);
    if (fs.existsSync(pdfP)) fs.unlinkSync(pdfP);
    if (fs.existsSync(tocP)) fs.unlinkSync(tocP);
    res.json({ success: true, deletedId: id });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || '删除失败' });
  }
});

// ==========================================
// 2. LATEX COMPILATION & STATUS APIS
// ==========================================

app.get('/api/latex/status', (req: Request, res: Response) => {
  try {
    const whichRes = spawnSync('which', ['xelatex'], { encoding: 'utf-8' });
    const isInstalled = whichRes.status === 0 && Boolean(whichRes.stdout.trim());
    let version = null;
    if (isInstalled) {
      const vRes = spawnSync('xelatex', ['--version'], { encoding: 'utf-8' });
      version = vRes.stdout.split('\n')[0] || 'XeLaTeX';
    }
    res.json({
      installed: isInstalled,
      engine: 'xelatex',
      version,
      installGuide: 'sudo apt update && sudo apt install -y texlive-xetex texlive-lang-chinese texlive-latex-extra',
    });
  } catch (err: any) {
    res.json({
      installed: false,
      engine: 'xelatex',
      version: null,
      installGuide: 'sudo apt update && sudo apt install -y texlive-xetex texlive-lang-chinese texlive-latex-extra',
    });
  }
});

app.post('/api/latex/compile', (req: Request, res: Response): void => {
  const code = req.body.latexCode || req.body.code;
  if (!code || typeof code !== 'string') {
    res.status(400).json({ success: false, error: '缺少 LaTeX 源码内容。' });
    return;
  }

  const whichRes = spawnSync('which', ['xelatex'], { encoding: 'utf-8' });
  const isInstalled = whichRes.status === 0 && Boolean(whichRes.stdout.trim());

  if (!isInstalled) {
    res.json({
      success: false,
      installed: false,
      error: '系统尚未安装 XeLaTeX 编译引擎。',
      log: '【环境自愈提示】\n未检测到系统 xelatex 可执行程序。\n如需在 Ubuntu 终端启用原生编译，请运行：\nsudo apt update && sudo apt install -y texlive-xetex texlive-lang-chinese texlive-latex-extra\n\n当前工作台已自动启用高保真矢量引擎生成排版预览，您亦可随时下载 .tex 源码或 PDF 文档。',
    });
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-compile-'));
  const texPath = path.join(tempDir, 'document.tex');
  const pdfPath = path.join(tempDir, 'document.pdf');
  const logPath = path.join(tempDir, 'document.log');

  try {
    fs.writeFileSync(texPath, code, 'utf-8');
    const compileResult = spawnSync('xelatex', ['-interaction=nonstopmode', '-halt-on-error', 'document.tex'], {
      cwd: tempDir,
      timeout: 30000,
      encoding: 'utf-8',
    });

    let logContent = '';
    if (fs.existsSync(logPath)) {
      logContent = fs.readFileSync(logPath, 'utf-8');
    } else {
      logContent = (compileResult.stdout || '') + '\n' + (compileResult.stderr || '');
    }

    if (fs.existsSync(pdfPath)) {
      const pdfBuffer = fs.readFileSync(pdfPath);
      const pdfBase64 = pdfBuffer.toString('base64');
      res.json({
        success: true,
        installed: true,
        pdfBase64,
        log: logContent.slice(0, 10000),
        message: '⚡ XeLaTeX 编译成功！',
      });
    } else {
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
    }
  } catch (err: any) {
    res.json({
      success: false,
      installed: true,
      error: err?.message || '编译子进程发生异常',
      log: String(err),
    });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
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
// 3. CONTEXT CACHING & MODELS DISCOVERY APIS
// ==========================================

/** Upper bound on whole-book uploads to Gemini context caching. */
const CACHE_UPLOAD_BUDGET_MB = 20;

app.post('/api/cache/create', async (req: Request, res: Response): Promise<void> => {
  const { displayName = '大学教材知识库', bookIds = [], ttlMinutes = 60, customApiKey } = req.body;

  const apiKey = (customApiKey || req.headers['x-gemini-api-key'] || process.env.GEMINI_API_KEY) as string;
  if (!apiKey || !apiKey.trim()) {
    res.status(400).json({ success: false, error: '缺少 Gemini API Key，无法创建 Context Cache。' });
    return;
  }

  if (!Array.isArray(bookIds) || bookIds.length === 0) {
    res.status(400).json({ success: false, error: '未指定要缓存的教材。' });
    return;
  }

  const cacheParts: any[] = [];
  let totalSizeMb = 0;

  for (const id of bookIds) {
    const bookPdfPath = getBookPath(id);
    if (fs.existsSync(bookPdfPath)) {
      const buffer = fs.readFileSync(bookPdfPath);
      totalSizeMb += buffer.length / (1024 * 1024);

      // Context caching is the only path that uploads whole books. Keep it bounded so a
      // stray call cannot recreate the million-token payload the TOC router exists to avoid.
      if (totalSizeMb > CACHE_UPLOAD_BUDGET_MB) {
        res.status(400).json({
          success: false,
          error:
            `所选教材总体积约 ${totalSizeMb.toFixed(1)} MB，已超过 ${CACHE_UPLOAD_BUDGET_MB} MB 的整本缓存上限。` +
            '厚教材请直接在对话中提问，系统会自动按目录定位并只切取相关章节。',
        });
        return;
      }

      cacheParts.push({
        inlineData: {
          mimeType: 'application/pdf',
          data: buffer.toString('base64'),
        },
      });
    }
  }

  if (cacheParts.length === 0) {
    res.status(400).json({ success: false, error: '教材文件未找到，无法创建缓存。' });
    return;
  }

  cacheParts.push({
    text: '这是大学工科教材完整内容。请将其作为权威学术知识库进行上下文持久化缓存，用于后续的定理推演、概念剖析和课后习题精解。',
  });

  const ttlSec = Math.max(300, Math.min(86400, Number(ttlMinutes || 60) * 60));
  const selectedModel = resolveDynamicModel(req.body.model, 'gemini');
  if (!selectedModel) {
    res.status(400).json({ success: false, error: '未指定模型且未探测到可用 Gemini 模型，无法创建 Context Cache。' });
    return;
  }
  const cacheModel = selectedModel.startsWith('models/') ? selectedModel : `models/${selectedModel}`;

  try {
    const cacheManager = new GoogleAICacheManager(apiKey.trim());
    const createdCache = await cacheManager.create({
      model: cacheModel,
      displayName: displayName.slice(0, 40),
      contents: [
        {
          role: 'user',
          parts: cacheParts,
        },
      ],
      systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
      ttlSeconds: ttlSec,
    });

    const expireTime = createdCache.expireTime || new Date(Date.now() + ttlSec * 1000).toISOString();
    const cacheHandle = createdCache.name;

    const cachePayload = {
      name: cacheHandle,
      displayName: createdCache.displayName || displayName,
      model: selectedModel,
      expireTime: expireTime,
      createTime: createdCache.createTime || new Date().toISOString(),
      ttlSeconds: ttlSec,
      tokenCount: (createdCache as any).usageMetadata?.totalTokenCount || Math.round(totalSizeMb * 35000),
    };

    res.json({
      status: 'success',
      success: true,
      cache: cachePayload,
      meta: cachePayload,
      message: `✅ 成功通过 GoogleAICacheManager 创建官方云端 Context Cache (句柄: ${cacheHandle})！`,
    });
  } catch (err: any) {
    console.error('Official GoogleAICacheManager error:', err);
    res.status(400).json({
      success: false,
      error: `Google 官方 Context Cache 创建失败: ${err?.message || String(err)}`,
    });
  }
});

app.get('/api/cache/list', async (req: Request, res: Response): Promise<void> => {
  const apiKey = (req.query.customApiKey || req.headers['x-gemini-api-key'] || process.env.GEMINI_API_KEY) as string;
  if (!apiKey || !apiKey.trim()) {
    res.json({ caches: [] });
    return;
  }
  try {
    const cacheManager = new GoogleAICacheManager(apiKey.trim());
    const listRes = await cacheManager.list();
    const caches = ((listRes as any).cachedContents || []).map((c: any) => ({
      name: c.name,
      displayName: c.displayName,
      model: (c.model || '').replace(/^models\//, '') || resolveDynamicModel('', 'gemini'),
      expireTime: c.expireTime,
      tokenCount: c.usageMetadata?.totalTokenCount,
    }));
    res.json({ caches });
  } catch (err) {
    res.json({ caches: [] });
  }
});

app.delete('/api/cache', async (req: Request, res: Response): Promise<void> => {
  const { name, customApiKey } = req.body;
  if (!name) {
    res.status(400).json({ success: false, error: 'Cache name is required.' });
    return;
  }
  const apiKey = (customApiKey || req.headers['x-gemini-api-key'] || process.env.GEMINI_API_KEY) as string;
  if (apiKey && apiKey.trim()) {
    try {
      const cacheManager = new GoogleAICacheManager(apiKey.trim());
      await cacheManager.delete(name);
      res.json({ success: true, status: 'ok', deleted: name });
      return;
    } catch (err: any) {
      res.status(400).json({ success: false, error: err?.message || '删除云端缓存失败' });
      return;
    }
  }
  res.json({ success: true, status: 'ok', deleted: name });
});

app.post('/api/models/discover', async (req: Request, res: Response): Promise<void> => {
  const { provider = 'gemini', apiKey: customKey, baseUrl: customBaseUrl } = req.body;

  if (provider === 'gemini') {
    const key = (customKey || req.headers['x-gemini-api-key'] || process.env.GEMINI_API_KEY) as string;
    if (!key || !key.trim()) {
      res.status(400).json({
        success: false,
        provider: 'gemini',
        error: '未提供 Google Gemini API Key，且系统环境变量中未检测到 GEMINI_API_KEY。',
      });
      return;
    }

    try {
      const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key.trim())}`;
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'aistudio-build/1.0',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        let errData: any = {};
        try {
          errData = await response.json();
        } catch {}
        const errorMsg =
          errData?.error?.message || `Google API 返回 HTTP ${response.status} (${response.statusText})。`;
        res.status(response.status).json({ success: false, provider: 'gemini', error: errorMsg });
        return;
      }

      const data: any = await response.json();
      const rawModels: any[] = data?.models || [];

      const validModels = rawModels
        .filter((m) => {
          const methods = m.supportedGenerationMethods || [];
          return Array.isArray(methods) && methods.includes('generateContent');
        })
        .map((m) => m.name.replace(/^models\//, ''));

      validModels.sort((a, b) => {
        const getScore = (name: string) => {
          const l = name.toLowerCase();
          if (l.includes('flash')) return 100;
          if (l.includes('pro')) return 80;
          return 50;
        };
        return getScore(b) - getScore(a);
      });

      if (validModels.length > 0) {
        discoveredModelsCache.gemini = validModels;
      }

      res.json({
        success: true,
        provider: 'gemini',
        models: validModels,
        message: `成功拉取到 ${validModels.length} 个 Google 官方可用模型！`,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        provider: 'gemini',
        error: `连接 Google API 服务失败: ${err?.message || String(err)}`,
      });
    }
  } else {
    const key = (customKey || '').trim();
    let baseUrl = (customBaseUrl || 'https://api.deepseek.com/v1').trim().replace(/\/+$/, '');

    try {
      const targetUrl = `${baseUrl}/models`;
      const headers: Record<string, string> = {
        'User-Agent': 'aistudio-build/1.0',
        Accept: 'application/json',
      };
      if (key) headers['Authorization'] = `Bearer ${key}`;

      const response = await fetch(targetUrl, { method: 'GET', headers });
      if (!response.ok) {
        let errData: any = {};
        try {
          errData = await response.json();
        } catch {}
        res.status(response.status).json({
          success: false,
          provider: 'openai_compatible',
          error: errData?.error?.message || errData?.message || `HTTP ${response.status}`,
        });
        return;
      }

      const data: any = await response.json();
      let modelList: string[] = [];

      if (Array.isArray(data?.data)) {
        modelList = data.data.map((item: any) => (typeof item === 'string' ? item : item.id)).filter(Boolean);
      } else if (Array.isArray(data)) {
        modelList = data.map((item: any) => (typeof item === 'string' ? item : item.id)).filter(Boolean);
      } else if (Array.isArray(data?.models)) {
        modelList = data.models
          .map((item: any) => (typeof item === 'string' ? item : item.id || item.name))
          .filter(Boolean);
      }

      const uniqueModels = Array.from(new Set(modelList));
      uniqueModels.sort((a, b) => {
        const getScore = (name: string) => {
          const l = name.toLowerCase();
          if (l.includes('chat') || l.includes('4o')) return 100;
          if (l.includes('reason') || l.includes('r1') || l.includes('o1')) return 90;
          return 50;
        };
        return getScore(b) - getScore(a);
      });

      if (uniqueModels.length > 0) {
        discoveredModelsCache.openai_compatible = uniqueModels;
      }

      res.json({
        success: true,
        provider: 'openai_compatible',
        models: uniqueModels,
        message: `成功拉取到 ${uniqueModels.length} 个 OpenAI 兼容模型！`,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        provider: 'openai_compatible',
        error: `连接目标 API 失败: ${err?.message || String(err)}`,
      });
    }
  }
});

// ================================================================
// 4. HIERARCHICAL SCHOLAR AGENT ROUTING & SURGICAL SLICING CHAT API
// ================================================================

interface RoutingDecision {
  matched: boolean;
  bookId?: string;
  bookName?: string;
  chapterTitle?: string;
  startPage?: number;
  endPage?: number;
  rationale?: string;
  source?: 'model' | 'keyword';
}

const ROUTING_TIMEOUT_MS = 45_000;
const CHAT_TIMEOUT_MS = 120_000;

/** Upper bound on a single multimodal PDF slice handed to Gemini. */
const NATIVE_PDF_BUDGET_KB = 8 * 1024;

/** Replayed conversation is capped separately so it can never crowd out the textbook. */
const HISTORY_TOKEN_BUDGET = 6_000;

interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Keeps the most recent turns that fit the history budget, oldest dropped first. */
function normalizeHistory(history: any): HistoryTurn[] {
  if (!Array.isArray(history)) return [];

  const usable: HistoryTurn[] = [];
  for (const item of history) {
    if (!item?.content || typeof item.content !== 'string' || !item.content.trim()) continue;
    if (item.id && String(item.id).startsWith('sys-')) continue;
    if (item.isError) continue;
    usable.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content });
  }

  const kept: HistoryTurn[] = [];
  let tokens = 0;
  for (let i = usable.length - 1; i >= 0; i--) {
    const cost = estimateTokens(usable[i].content);
    if (tokens + cost > HISTORY_TOKEN_BUDGET) break;
    tokens += cost;
    kept.unshift(usable[i]);
  }

  return kept;
}

interface RoutingContext {
  prompt: string;
  books: BookMetadata[];
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl: string;
  channel: SseChannel;
}

/**
 * Asks a model to pick the relevant chapter from the compact TOC catalog, and falls
 * back to deterministic keyword matching whenever that call fails or returns junk.
 * Routing never aborts the turn: worst case the answer proceeds without a slice.
 */
async function runRoutingAgent(ctx: RoutingContext): Promise<RoutingDecision | null> {
  const { prompt, books, provider, model, apiKey, baseUrl, channel } = ctx;
  if (books.length === 0) return null;

  const applyLocalFallback = (): RoutingDecision | null => {
    const local = matchChapterLocally(prompt, books);
    if (!local) return null;
    return {
      matched: true,
      bookId: local.bookId,
      bookName: local.bookName,
      chapterTitle: local.chapterTitle,
      startPage: local.startPage,
      endPage: local.endPage,
      rationale: '模型路由不可用，已按目录关键词本地匹配定位。',
      source: 'keyword',
    };
  };

  if (!model || !apiKey) return applyLocalFallback();

  const routingPrompt = `你是一位高校硬核学术图书管理员。
请根据以下教材微型目录索引，审阅学生的提问，快速精确定位出：该问题属于哪一本教材的哪一具体章节，以及最核心的研读起止页码范围 [startPage, endPage]。

【严格约束】
1. startPage 与 endPage 的跨度必须控制在 ${MAX_SLICE_PAGES} 页以内。
2. 必须只输出严格合法的 JSON 对象，不要输出任何多余文字：
{
  "matched": true,
  "bookId": "教材的真实ID",
  "bookName": "教材书名",
  "chapterTitle": "具体章节名",
  "startPage": 18,
  "endPage": 35,
  "rationale": "定位该章节的原因简述"
}
若问题与所列教材无关，输出: { "matched": false }

【已挂载教材微型目录树】：
${buildTocCatalog(books)}

【学生提问】：
${prompt}`;

  let rawRoutingJson = '';

  try {
    if (provider === 'gemini') {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' }, timeout: ROUTING_TIMEOUT_MS },
      });
      const routingResponse = await ai.models.generateContent({
        model,
        contents: routingPrompt,
        config: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          abortSignal: channel.aborter.signal,
        },
      });
      rawRoutingJson = routingResponse.text?.trim() || '';
    } else {
      const result = await resilientFetch(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'User-Agent': 'aistudio-build/1.0',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: routingPrompt }],
            temperature: 0.1,
          }),
        },
        {
          timeoutMs: ROUTING_TIMEOUT_MS,
          retries: 1,
          signal: channel.aborter.signal,
          onRetry: () => channel.stage('目录定位请求超时，正在自动重试…'),
        }
      );

      if (!result.ok) {
        console.warn('[routing] model call failed:', result.failure);
        return applyLocalFallback();
      }
      const data: any = await result.response.json();
      rawRoutingJson = data?.choices?.[0]?.message?.content || '';
    }
  } catch (err) {
    console.warn('[routing] model call threw:', err);
    return applyLocalFallback();
  }

  const parsed = cleanAndParseJson(rawRoutingJson);
  if (!parsed?.matched || !parsed.bookId) return applyLocalFallback();

  const book = books.find((b) => b.id === String(parsed.bookId));
  if (!book) return applyLocalFallback();

  const [startPage, endPage] = expandRange(
    { title: '', startPage: Number(parsed.startPage) || 1, endPage: Number(parsed.endPage) || 1 },
    book.pageCount
  );

  return {
    matched: true,
    bookId: book.id,
    bookName: book.name,
    chapterTitle: String(parsed.chapterTitle || '核心章节'),
    startPage,
    endPage,
    rationale: parsed.rationale ? String(parsed.rationale) : undefined,
    source: 'model',
  };
}

type PreparedContext =
  | { kind: 'none' }
  | { kind: 'text'; text: string; pageRange: [number, number]; tokens: number }
  | { kind: 'pdf'; base64: string; pageRange: [number, number]; sizeKb: number };

/**
 * Turns a routing decision into provider-appropriate context.
 * Text-only providers get extracted prose; only Gemini receives a raw PDF stream, and
 * either way the payload is bounded by MAX_SLICE_PAGES and MAX_CONTEXT_TOKENS.
 */
async function prepareTextbookContext(
  decision: RoutingDecision,
  book: BookMetadata,
  provider: ProviderId,
  channel: SseChannel
): Promise<PreparedContext> {
  const [startPage, endPage] = clampPageRange(
    decision.startPage || 1,
    decision.endPage || 1,
    book.pageCount
  );

  if (supportsNativePdf(provider)) {
    // Page-count alone does not bound payload size: image-heavy scans can produce a
    // multi-megabyte slice, so shrink the range until the upload budget is respected.
    let rangeEnd = endPage;
    let slice = await slicePdf(book.id, startPage, rangeEnd);

    while (slice.sizeKb > NATIVE_PDF_BUDGET_KB && rangeEnd - startPage + 1 > 4) {
      rangeEnd = startPage + Math.floor((rangeEnd - startPage) / 2);
      console.log(`[context] slice too large (${slice.sizeKb}KB), narrowing to P${startPage}-P${rangeEnd}`);
      slice = await slicePdf(book.id, startPage, rangeEnd);
    }

    return {
      kind: 'pdf',
      base64: slice.buffer.toString('base64'),
      pageRange: slice.pageRange,
      sizeKb: slice.sizeKb,
    };
  }

  const extracted = await extractPageRangeText(book.id, startPage, endPage);

  if (extracted.quality === 'none') {
    channel.notice(
      'warn',
      `《${book.name}》第 ${startPage}-${endPage} 页为扫描图片，没有可提取的文字层。` +
        '当前纯文本模型（OpenAI / DeepSeek）无法识别图片内容，本轮将以通识推导作答。' +
        '如需精读该教材原文，请在左侧切换到 Google Gemini（多模态可直读扫描页）。'
    );
    return { kind: 'none' };
  }

  const bounded = truncateToTokenBudget(extracted.text, MAX_CONTEXT_TOKENS);
  if (bounded.length < extracted.text.length) {
    console.log(`[context] truncated slice text to ${MAX_CONTEXT_TOKENS} tokens`);
  }

  if (extracted.quality === 'sparse') {
    channel.notice(
      'info',
      `《${book.name}》第 ${startPage}-${endPage} 页文字层较稀疏，提取到的原文有限，回答可能存在缺漏。`
    );
  }

  return {
    kind: 'text',
    text: bounded,
    pageRange: extracted.pageRange,
    tokens: estimateTokens(bounded),
  };
}

app.post('/api/chat', async (req: Request, res: Response): Promise<void> => {
  const {
    prompt,
    history = [],
    bookIds = [],
    books = [],
    model,
    provider: rawProvider = 'gemini',
    customApiKey,
    baseUrl = 'https://api.deepseek.com/v1',
    cachedContent,
  } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: '提问内容不能为空。' });
    return;
  }

  const provider: ProviderId = rawProvider === 'openai_compatible' ? 'openai_compatible' : 'gemini';
  const channel = new SseChannel(res);
  const startTime = Date.now();

  try {
    // Consolidate mounted book IDs from either payload shape
    const targetBookIds: string[] = [];
    if (Array.isArray(bookIds)) {
      bookIds.forEach((id: string) => {
        if (typeof id === 'string' && id.trim()) targetBookIds.push(id.trim());
      });
    }
    if (Array.isArray(books)) {
      books.forEach((b: any) => {
        const id = typeof b === 'string' ? b : b?.id;
        if (id && !targetBookIds.includes(id)) targetBookIds.push(id);
      });
    }

    const mountedBookMetas: BookMetadata[] = [];
    for (const id of targetBookIds) {
      const tocPath = getBookTocPath(id);
      if (!fs.existsSync(tocPath)) continue;
      try {
        mountedBookMetas.push(JSON.parse(fs.readFileSync(tocPath, 'utf-8')));
      } catch {}
    }

    const apiKey = String(
      customApiKey || req.headers['x-gemini-api-key'] || process.env.GEMINI_API_KEY || ''
    ).trim();
    const activeModel = resolveDynamicModel(model, provider);
    const cleanBaseUrl = String(baseUrl || 'https://api.deepseek.com/v1').trim().replace(/\/+$/, '');

    if (!apiKey) {
      channel.fail({
        code: 'auth',
        message:
          provider === 'gemini'
            ? '缺少 Google Gemini API Key。'
            : '缺少 OpenAI / DeepSeek 兼容协议 API Key。',
        hint: '请在左侧配置面板填写有效的 API Key 后重试。',
      });
      return;
    }

    if (!activeModel) {
      channel.fail({
        code: 'not_found',
        message: '尚未选择可用的模型。',
        hint: '请点击左侧「刷新探测」拉取模型列表，并在下拉框中选择一个模型。',
      });
      return;
    }

    // -------------------------------------------------------------
    // STAGE 1: TOC routing (model first, deterministic keyword fallback)
    // -------------------------------------------------------------
    let decision: RoutingDecision | null = null;
    if (mountedBookMetas.length > 0) {
      channel.stage('正在查阅教材目录，定位相关章节…');
      decision = await runRoutingAgent({
        prompt,
        books: mountedBookMetas,
        provider,
        model: activeModel,
        apiKey,
        baseUrl: cleanBaseUrl,
        channel,
      });
    }

    // -------------------------------------------------------------
    // STAGE 2: Bounded slicing / text extraction for the chosen provider
    // -------------------------------------------------------------
    let context: PreparedContext = { kind: 'none' };
    const routedBook = decision?.bookId
      ? mountedBookMetas.find((b) => b.id === decision!.bookId)
      : undefined;

    if (decision?.matched && routedBook) {
      channel.stage('正在切取目标章节原文…');
      try {
        context = await prepareTextbookContext(decision, routedBook, provider, channel);
      } catch (sliceErr) {
        console.warn('[slice] failed, continuing without textbook context:', sliceErr);
        channel.notice('warn', '教材切片失败，本轮将以通识推导作答。');
        context = { kind: 'none' };
      }

      if (context.kind !== 'none') {
        const [rangeStart, rangeEnd] = context.pageRange;
        decision.startPage = rangeStart;
        decision.endPage = rangeEnd;
        const prefix = decision.source === 'keyword' ? '📖 已按目录关键词定位' : '📖 智能图书管理员已查阅目录并锁定';
        channel.send({
          routing: {
            ...decision,
            label: `${prefix}：《${decision.bookName}》${decision.chapterTitle} (P${rangeStart} - P${rangeEnd})`,
          },
        });
      }
    } else if (mountedBookMetas.length > 0) {
      channel.notice('info', '未能在已挂载教材中定位到对应章节，本轮以通识推导作答。');
    }

    const normalizedHistory = normalizeHistory(history);
    channel.stage('正在等待模型推演…');

    // -------------------------------------------------------------
    // STAGE 3A: OpenAI-compatible providers (pure text only)
    // -------------------------------------------------------------
    if (provider === 'openai_compatible') {
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: DEFAULT_SYSTEM_INSTRUCTION },
      ];

      if (context.kind === 'text') {
        messages.push({
          role: 'system',
          content: `【教材原文精读素材 - 《${decision?.bookName}》第 ${context.pageRange[0]} - ${context.pageRange[1]} 页】
${context.text}

以上为从教材 PDF 中切出目标页码并转换得到的纯文本原文，请严格结合该原文作答，引用定理时标注具体页码。`,
        });
      }

      for (const turn of normalizedHistory) {
        messages.push({ role: turn.role, content: turn.content });
      }
      messages.push({ role: 'user', content: prompt });

      const result = await resilientFetch(
        `${cleanBaseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'User-Agent': 'aistudio-build/1.0',
          },
          body: JSON.stringify({ model: activeModel, messages, stream: true }),
        },
        {
          timeoutMs: CHAT_TIMEOUT_MS,
          retries: 2,
          signal: channel.aborter.signal,
          onRetry: (attempt, failure) =>
            channel.stage(`连接模型失败（${failure.message}），正在第 ${attempt} 次自动重试…`),
        }
      );

      if (!result.ok) {
        channel.fail(result.failure);
        return;
      }

      const reader = result.response.body?.getReader();
      if (!reader) {
        channel.fail({
          code: 'upstream',
          message: '模型服务未返回可读的数据流。',
          hint: '请重试，或确认该模型支持流式输出。',
        });
        return;
      }

      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let produced = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (channel.isClosed) {
          try {
            await reader.cancel();
          } catch {}
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':') || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;
          try {
            const parsed = JSON.parse(trimmed.slice(6).trim());
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.reasoning_content) {
              produced = true;
              channel.send({ reasoning: delta.reasoning_content });
            }
            if (delta.content) {
              produced = true;
              channel.send({ text: delta.content });
            }
          } catch {}
        }
      }

      if (!produced) {
        channel.fail({
          code: 'upstream',
          message: '模型返回了空响应，未生成任何内容。',
          hint: '请重试，或在左侧更换其他模型。',
        });
        return;
      }

      channel.end({ done: true, responseTimeMs: Date.now() - startTime, routing: decision });
      return;
    }

    // -------------------------------------------------------------
    // STAGE 3B: Google Gemini (native multimodal PDF)
    // -------------------------------------------------------------
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' }, timeout: CHAT_TIMEOUT_MS },
    });

    const formattedContents: Array<{
      role: 'user' | 'model';
      parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
    }> = [];

    for (const turn of normalizedHistory) {
      formattedContents.push({
        role: turn.role === 'user' ? 'user' : 'model',
        parts: [{ text: turn.content }],
      });
    }
    while (formattedContents.length > 0 && formattedContents[0].role === 'model') {
      formattedContents.shift();
    }

    const userParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
    if (context.kind === 'pdf') {
      userParts.push({ inlineData: { mimeType: 'application/pdf', data: context.base64 } });
      userParts.push({
        text: `【学术推演任务】：
上述所附 PDF 为《${decision?.bookName}》中精准切出的核心章节（第 ${context.pageRange[0]} 至 ${context.pageRange[1]} 页）。
请仔细精读切片中的定理叙述与推导步骤，针对学生的以下提问进行详尽、权威、工科级的学术解答与 LaTeX 推导演绎：

${prompt}`,
      });
    } else {
      userParts.push({ text: prompt });
    }
    formattedContents.push({ role: 'user', parts: userParts });

    const useCache =
      typeof cachedContent === 'string' && cachedContent.startsWith('cachedContents/');
    const responseStream = await ai.models.generateContentStream({
      model: activeModel,
      contents: formattedContents,
      config: useCache
        ? { cachedContent: cachedContent.trim(), abortSignal: channel.aborter.signal }
        : { systemInstruction: DEFAULT_SYSTEM_INSTRUCTION, abortSignal: channel.aborter.signal },
    });

    let produced = false;
    for await (const chunk of responseStream) {
      if (channel.isClosed) return;
      if (chunk.text) {
        produced = true;
        channel.send({ text: chunk.text });
      }
    }

    if (!produced) {
      channel.fail({
        code: 'upstream',
        message: '模型返回了空响应，未生成任何内容。',
        hint: '内容可能被安全策略拦截，请调整提问方式或更换模型后重试。',
      });
      return;
    }

    channel.end({ done: true, responseTimeMs: Date.now() - startTime, routing: decision });
  } catch (err: any) {
    console.error('[chat] unhandled failure:', err);
    channel.fail(classifyThrownFailure(err));
  }
});


// Global Express error handler (catches MulterError and avoids connection drops)
app.use((err: any, req: Request, res: Response, next: any) => {
  console.error('[Express Error Handler]:', err);
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

async function startServer() {
  await autoDiscoverModelsOnBoot();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
