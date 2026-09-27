// server.ts
import express from "express";
import path3 from "path";
import fs5 from "fs";
import os from "os";
import { spawnSync } from "child_process";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import multer from "multer";

// server/errors.ts
var LlmFailureError = class extends Error {
  constructor(failure) {
    super(failure.message);
    this.name = "LlmFailureError";
    this.failure = failure;
  }
};
var HTTP_FAILURES = {
  400: {
    code: "bad_request",
    message: "\u6A21\u578B\u670D\u52A1\u5224\u5B9A\u8BF7\u6C42\u683C\u5F0F\u4E0D\u5408\u6CD5\uFF08HTTP 400\uFF09\u3002",
    hint: "\u5E38\u89C1\u539F\u56E0\u662F\u6240\u9009\u6A21\u578B\u4E0D\u652F\u6301\u5F53\u524D\u53C2\u6570\uFF0C\u8BF7\u5728\u5DE6\u4FA7\u5207\u6362\u5176\u4ED6\u6A21\u578B\u540E\u91CD\u8BD5\u3002"
  },
  401: {
    code: "auth",
    message: "API Key \u672A\u901A\u8FC7\u6821\u9A8C\uFF08HTTP 401\uFF09\u3002",
    hint: "\u8BF7\u5728\u5DE6\u4FA7\u914D\u7F6E\u9762\u677F\u786E\u8BA4 API Key \u662F\u5426\u586B\u5199\u5B8C\u6574\u3001\u662F\u5426\u5DF2\u8FC7\u671F\u3002"
  },
  403: {
    code: "auth",
    message: "API Key \u65E0\u6743\u8BBF\u95EE\u8BE5\u6A21\u578B\u6216\u8BE5\u5730\u533A\u53D7\u9650\uFF08HTTP 403\uFF09\u3002",
    hint: "\u8BF7\u786E\u8BA4\u5BC6\u94A5\u5DF2\u5F00\u901A\u5BF9\u5E94\u6A21\u578B\u6743\u9650\uFF0C\u6216\u66F4\u6362\u53EF\u7528\u7684 Base URL\u3002"
  },
  404: {
    code: "not_found",
    message: "\u6A21\u578B\u540D\u79F0\u6216 Base URL \u4E0D\u5B58\u5728\uFF08HTTP 404\uFF09\u3002",
    hint: "\u8BF7\u70B9\u51FB\u5DE6\u4FA7\u300C\u5237\u65B0\u63A2\u6D4B\u300D\u91CD\u65B0\u62C9\u53D6\u53EF\u7528\u6A21\u578B\u5217\u8868\u3002"
  },
  429: {
    code: "rate_limit",
    message: "\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\u6216\u4F59\u989D/\u914D\u989D\u5DF2\u8017\u5C3D\uFF08HTTP 429\uFF09\u3002",
    hint: "\u8BF7\u7A0D\u5019\u7247\u523B\u518D\u8BD5\uFF0C\u6216\u68C0\u67E5\u8D26\u6237\u914D\u989D\u4E0E\u8D26\u5355\u72B6\u6001\u3002"
  },
  500: { code: "upstream", message: "\u6A21\u578B\u670D\u52A1\u5185\u90E8\u9519\u8BEF\uFF08HTTP 500\uFF09\u3002", hint: "\u8FD9\u662F\u670D\u52A1\u5546\u4FA7\u7684\u4E34\u65F6\u6545\u969C\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002" },
  502: { code: "upstream", message: "\u6A21\u578B\u670D\u52A1\u7F51\u5173\u5F02\u5E38\uFF08HTTP 502\uFF09\u3002", hint: "\u8FD9\u662F\u670D\u52A1\u5546\u4FA7\u7684\u4E34\u65F6\u6545\u969C\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002" },
  503: { code: "upstream", message: "\u6A21\u578B\u670D\u52A1\u6682\u4E0D\u53EF\u7528\uFF08HTTP 503\uFF09\u3002", hint: "\u670D\u52A1\u5546\u53EF\u80FD\u6B63\u5728\u9650\u6D41\u6216\u7EF4\u62A4\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002" },
  504: { code: "upstream", message: "\u6A21\u578B\u670D\u52A1\u7F51\u5173\u8D85\u65F6\uFF08HTTP 504\uFF09\u3002", hint: "\u957F\u7BC7\u63A8\u5BFC\u5BB9\u6613\u89E6\u53D1\u7F51\u5173\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5\u6216\u6539\u7528\u66F4\u5FEB\u7684\u6A21\u578B\u3002" }
};
var CONTEXT_OVERFLOW_HINTS = [
  "context length",
  "context_length",
  "maximum context",
  "too many tokens",
  "token limit",
  "request too large",
  "exceeds the maximum",
  "input is too long"
];
var CONTEXT_OVERFLOW = {
  code: "context_overflow",
  message: "\u672C\u8F6E\u4E0A\u4E0B\u6587\u8D85\u51FA\u8BE5\u6A21\u578B\u7684\u6700\u5927\u957F\u5EA6\u9650\u5236\u3002",
  hint: "\u8BF7\u7F29\u5C0F\u63D0\u95EE\u8303\u56F4\u3001\u5F00\u542F\u65B0\u5BF9\u8BDD\uFF0C\u6216\u6539\u7528\u4E0A\u4E0B\u6587\u7A97\u53E3\u66F4\u5927\u7684\u6A21\u578B\u3002"
};
function extractProviderMessage(body) {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message || parsed?.message || parsed?.error;
    if (typeof msg === "string") return msg.slice(0, 200);
  } catch {
  }
  return body.slice(0, 200).replace(/\s+/g, " ").trim();
}
function classifyHttpFailure(status, body) {
  const lowered = (body || "").toLowerCase();
  if (CONTEXT_OVERFLOW_HINTS.some((needle) => lowered.includes(needle))) return CONTEXT_OVERFLOW;
  const mapped = HTTP_FAILURES[status];
  if (mapped) {
    const detail = extractProviderMessage(body);
    return detail ? { ...mapped, message: `${mapped.message} \u670D\u52A1\u5546\u63D0\u793A\uFF1A${detail}` } : mapped;
  }
  return {
    code: "upstream",
    message: `\u6A21\u578B\u670D\u52A1\u8FD4\u56DE\u5F02\u5E38\u72B6\u6001\u7801 HTTP ${status}\u3002`,
    hint: extractProviderMessage(body) || "\u8BF7\u7A0D\u540E\u91CD\u8BD5\u6216\u66F4\u6362\u6A21\u578B\u3002"
  };
}
function classifyThrownFailure(err) {
  if (err instanceof LlmFailureError) return err.failure;
  const name = String(err?.name || "");
  const raw = String(err?.message || err || "");
  const lowered = raw.toLowerCase();
  if (name === "AbortError" || lowered.includes("aborted") || lowered.includes("timeout")) {
    return {
      code: "timeout",
      message: "\u7B49\u5F85\u6A21\u578B\u54CD\u5E94\u8D85\u65F6\uFF0C\u8FDE\u63A5\u5DF2\u88AB\u4E3B\u52A8\u4E2D\u65AD\u3002",
      hint: "\u6A21\u578B\u524D\u7F6E\u601D\u8003\u65F6\u95F4\u8FC7\u957F\u6216\u7F51\u7EDC\u4E0D\u7A33\u5B9A\uFF0C\u8BF7\u91CD\u8BD5\uFF0C\u6216\u6539\u7528\u54CD\u5E94\u66F4\u5FEB\u7684\u6A21\u578B\u3002"
    };
  }
  if (CONTEXT_OVERFLOW_HINTS.some((needle) => lowered.includes(needle))) return CONTEXT_OVERFLOW;
  const status = Number(err?.status || err?.code);
  if (!Number.isNaN(status) && HTTP_FAILURES[status]) return HTTP_FAILURES[status];
  if (lowered.includes("fetch failed") || lowered.includes("econnreset") || lowered.includes("econnrefused") || lowered.includes("enotfound") || lowered.includes("etimedout") || lowered.includes("socket hang up") || lowered.includes("network")) {
    return {
      code: "network",
      message: "\u65E0\u6CD5\u8FDE\u63A5\u5230\u6A21\u578B\u670D\u52A1\uFF0C\u7F51\u7EDC\u94FE\u8DEF\u4E2D\u65AD\u3002",
      hint: "\u8BF7\u68C0\u67E5\u672C\u673A\u7F51\u7EDC\u3001\u4EE3\u7406\u8BBE\u7F6E\uFF0C\u4EE5\u53CA Base URL \u662F\u5426\u53EF\u8FBE\u3002"
    };
  }
  if (lowered.includes("api key") || lowered.includes("unauthenticated") || lowered.includes("permission")) {
    return {
      code: "auth",
      message: "API Key \u6821\u9A8C\u5931\u8D25\u6216\u6743\u9650\u4E0D\u8DB3\u3002",
      hint: "\u8BF7\u5728\u5DE6\u4FA7\u914D\u7F6E\u9762\u677F\u91CD\u65B0\u586B\u5199\u6709\u6548\u7684 API Key\u3002"
    };
  }
  return {
    code: "unknown",
    message: `\u8C03\u7528\u6A21\u578B\u670D\u52A1\u65F6\u53D1\u751F\u5F02\u5E38\uFF1A${raw.slice(0, 200) || "\u672A\u77E5\u9519\u8BEF"}`,
    hint: "\u8BF7\u91CD\u8BD5\uFF1B\u82E5\u6301\u7EED\u5931\u8D25\u8BF7\u68C0\u67E5\u6A21\u578B\u9009\u62E9\u4E0E\u7F51\u7EDC\u73AF\u5883\u3002"
  };
}
var RETRYABLE_CODES = ["timeout", "network", "rate_limit", "upstream"];
function isRetryable(failure) {
  return RETRYABLE_CODES.includes(failure.code);
}

// server/sse.ts
var HEARTBEAT_INTERVAL_MS = 15e3;
var SseChannel = class {
  constructor(res) {
    this.heartbeat = null;
    this.closed = false;
    this.aborter = new AbortController();
    this.res = res;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      try {
        this.res.write(": keep-alive\n\n");
      } catch {
      }
    }, HEARTBEAT_INTERVAL_MS);
    res.on("close", () => {
      this.closed = true;
      this.stopHeartbeat();
      this.aborter.abort();
    });
  }
  get isClosed() {
    return this.closed;
  }
  stopHeartbeat() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
  send(payload) {
    if (this.closed) return;
    try {
      this.res.write(`data: ${JSON.stringify(payload)}

`);
    } catch {
    }
  }
  /** Short progress line so the UI can show which pipeline stage is running. */
  stage(message) {
    this.send({ stage: message });
  }
  notice(level, message) {
    this.send({ notice: { level, message } });
  }
  fail(failure) {
    this.send({ error: failure.message, errorCode: failure.code, hint: failure.hint });
    this.end();
  }
  end(payload) {
    if (this.closed) return;
    if (payload) this.send(payload);
    this.stopHeartbeat();
    this.closed = true;
    try {
      this.res.end();
    } catch {
    }
  }
};

// server/pdf/storage.ts
import fs from "fs";
import path from "path";
var UPLOADS_DIR = path.join(process.cwd(), "uploads", "books");
var CHUNKS_DIR = path.join(UPLOADS_DIR, "temp_chunks");
for (const dir of [UPLOADS_DIR, CHUNKS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function getBookPath(bookId) {
  return path.join(UPLOADS_DIR, `${bookId}.pdf`);
}
function getBookTocPath(bookId) {
  return path.join(UPLOADS_DIR, `${bookId}_toc.json`);
}
function saveBookMetadata(meta) {
  fs.writeFileSync(getBookTocPath(meta.id), JSON.stringify(meta, null, 2), "utf-8");
}
function readBookMetadata(bookId) {
  const tocPath = getBookTocPath(bookId);
  if (!fs.existsSync(tocPath)) return null;
  try {
    const stored = JSON.parse(fs.readFileSync(tocPath, "utf-8"));
    return {
      id: stored.id,
      name: stored.name,
      sizeMb: stored.sizeMb,
      pageCount: stored.pageCount,
      toc: Array.isArray(stored.toc) ? stored.toc : [],
      uploadTime: stored.uploadTime,
      tocSource: stored.tocSource,
      visionAttempted: stored.visionAttempted
    };
  } catch {
    return null;
  }
}
function deleteBook(bookId) {
  for (const target of [getBookPath(bookId), getBookTocPath(bookId)]) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
}
function listBookIndexFiles() {
  return fs.readdirSync(UPLOADS_DIR).filter((f) => f.endsWith("_toc.json"));
}

// server/providers/gemini.ts
import { GoogleGenAI } from "@google/genai";
var ROUTING_TIMEOUT_MS = 45e3;
var ANSWER_TIMEOUT_MS = 12e4;
function createClient(apiKey, timeout) {
  return new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { "User-Agent": "aistudio-build" }, timeout }
  });
}
function payloadParts(payload) {
  if (payload.pdfBase64) {
    return [{ inlineData: { mimeType: "application/pdf", data: payload.pdfBase64 } }];
  }
  return (payload.images || []).map((image) => ({
    inlineData: { mimeType: "image/jpeg", data: image.base64 }
  }));
}
var geminiProvider = {
  id: "gemini",
  excerptFormat: "pdf",
  async requestRouting(req) {
    const ai = createClient(req.credentials.apiKey, ROUTING_TIMEOUT_MS);
    const response = await ai.models.generateContent({
      model: req.model,
      contents: req.prompt,
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
        abortSignal: req.signal
      }
    });
    return response.text?.trim() || "";
  },
  async inspectPages(req) {
    const ai = createClient(req.credentials.apiKey, ROUTING_TIMEOUT_MS);
    try {
      const response = await ai.models.generateContent({
        model: req.model,
        contents: [{ role: "user", parts: [...payloadParts(req.payload), { text: req.prompt }] }],
        config: { temperature: 0.1, responseMimeType: "application/json", abortSignal: req.signal }
      });
      return response.text?.trim() || "";
    } catch (err) {
      throw new LlmFailureError(classifyThrownFailure(err));
    }
  },
  async streamAnswer(req) {
    const ai = createClient(req.credentials.apiKey, ANSWER_TIMEOUT_MS);
    const contents = [];
    for (const turn of req.history) {
      contents.push({
        role: turn.role === "user" ? "user" : "model",
        parts: [{ text: turn.content }]
      });
    }
    while (contents.length > 0 && contents[0].role === "model") contents.shift();
    const parts = [];
    if (req.excerpt) {
      parts.push(...payloadParts(req.excerpt));
      parts.push({
        text: `\u3010\u5B66\u672F\u63A8\u6F14\u4EFB\u52A1\u3011\uFF1A
\u4E0A\u8FF0\u6240\u9644 PDF \u4E3A\u300A${req.excerpt.bookName}\u300B\u4E2D\u300C${req.excerpt.chapterTitle}\u300D\u7ECF\u7CBE\u51C6\u5207\u51FA\u7684\u6838\u5FC3\u7AE0\u8282\uFF08\u7B2C ${req.excerpt.pageRange[0]} \u81F3 ${req.excerpt.pageRange[1]} \u9875\uFF09\u3002
\u8BF7\u76F4\u63A5\u7814\u8BFB\u9875\u9762\u4E0A\u7684\u7248\u9762\u3001\u516C\u5F0F\u3001\u63D2\u56FE\u4E0E\u5B9A\u7406\u53D9\u8FF0\uFF0C\u9488\u5BF9\u5B66\u751F\u7684\u4EE5\u4E0B\u63D0\u95EE\u8FDB\u884C\u8BE6\u5C3D\u3001\u6743\u5A01\u3001\u5DE5\u79D1\u7EA7\u7684\u5B66\u672F\u89E3\u7B54\u4E0E LaTeX \u63A8\u5BFC\u6F14\u7ECE\uFF1A

${req.prompt}`
      });
    } else {
      parts.push({ text: req.prompt });
    }
    contents.push({ role: "user", parts });
    let produced = false;
    try {
      const stream = await ai.models.generateContentStream({
        model: req.model,
        contents,
        config: { systemInstruction: req.systemInstruction, abortSignal: req.signal }
      });
      for await (const chunk of stream) {
        if (req.shouldStop()) return;
        if (chunk.text) {
          produced = true;
          req.onText(chunk.text);
        }
      }
    } catch (err) {
      throw new LlmFailureError(classifyThrownFailure(err));
    }
    if (!produced) {
      throw new LlmFailureError({
        code: "upstream",
        message: "\u6A21\u578B\u8FD4\u56DE\u4E86\u7A7A\u54CD\u5E94\uFF0C\u672A\u751F\u6210\u4EFB\u4F55\u5185\u5BB9\u3002",
        hint: "\u5185\u5BB9\u53EF\u80FD\u88AB\u5B89\u5168\u7B56\u7565\u62E6\u622A\uFF0C\u8BF7\u8C03\u6574\u63D0\u95EE\u65B9\u5F0F\u6216\u66F4\u6362\u6A21\u578B\u540E\u91CD\u8BD5\u3002"
      });
    }
  }
};

// server/http.ts
async function resilientFetch(url, init, options) {
  let lastFailure = { code: "unknown", message: "\u8BF7\u6C42\u672A\u80FD\u5B8C\u6210\u3002" };
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (options.signal?.aborted) {
      return { ok: false, failure: { code: "timeout", message: "\u8BF7\u6C42\u5DF2\u88AB\u53D6\u6D88\u3002" } };
    }
    const timer = new AbortController();
    const timeoutHandle = setTimeout(() => timer.abort(), options.timeoutMs);
    const onOuterAbort = () => timer.abort();
    options.signal?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: timer.signal });
      if (response.ok) {
        clearTimeout(timeoutHandle);
        options.signal?.removeEventListener("abort", onOuterAbort);
        return { ok: true, response };
      }
      lastFailure = classifyHttpFailure(response.status, await response.text().catch(() => ""));
    } catch (err) {
      console.warn(`[http] ${url} attempt ${attempt + 1} threw:`, err, err?.cause);
      lastFailure = classifyThrownFailure(err);
    } finally {
      clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onOuterAbort);
    }
    if (attempt >= options.retries || !isRetryable(lastFailure)) break;
    options.onRetry?.(attempt + 1, lastFailure);
    await new Promise((resolve) => setTimeout(resolve, 800 * Math.pow(2, attempt)));
  }
  return { ok: false, failure: lastFailure };
}

// server/providers/openaiCompatible.ts
var ROUTING_TIMEOUT_MS2 = 45e3;
var ANSWER_TIMEOUT_MS2 = 18e4;
function endpoint(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}
function authHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": "aistudio-build/1.0"
  };
}
function imageParts(payload) {
  const parts = [];
  for (const image of payload.images || []) {
    parts.push({ type: "text", text: `\u3010\u7B2C ${image.pageNumber} \u9875\u3011` });
    parts.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${image.base64}`, detail: "high" }
    });
  }
  return parts;
}
async function consumeStream(body, req) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let produced = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (req.shouldStop()) {
      try {
        await reader.cancel();
      } catch {
      }
      return produced;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]") continue;
      if (!trimmed.startsWith("data: ")) continue;
      try {
        const delta = JSON.parse(trimmed.slice(6).trim())?.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) {
          produced = true;
          req.onReasoning(delta.reasoning_content);
        }
        if (delta.content) {
          produced = true;
          req.onText(delta.content);
        }
      } catch {
      }
    }
  }
  return produced;
}
var openAiCompatibleProvider = {
  id: "openai_compatible",
  excerptFormat: "image",
  async requestRouting(req) {
    const result = await resilientFetch(
      endpoint(req.credentials.baseUrl),
      {
        method: "POST",
        headers: authHeaders(req.credentials.apiKey),
        body: JSON.stringify({
          model: req.model,
          messages: [{ role: "user", content: req.prompt }],
          temperature: 0.1
        })
      },
      { timeoutMs: ROUTING_TIMEOUT_MS2, retries: 1, signal: req.signal, onRetry: req.onRetry }
    );
    if (!result.ok) throw new LlmFailureError(result.failure);
    const data = await result.response.json();
    return data?.choices?.[0]?.message?.content || "";
  },
  async inspectPages(req) {
    const result = await resilientFetch(
      endpoint(req.credentials.baseUrl),
      {
        method: "POST",
        headers: authHeaders(req.credentials.apiKey),
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: "user", content: [...imageParts(req.payload), { type: "text", text: req.prompt }] }
          ],
          temperature: 0.1
        })
      },
      { timeoutMs: ANSWER_TIMEOUT_MS2, retries: 1, signal: req.signal }
    );
    if (!result.ok) throw new LlmFailureError(result.failure);
    const data = await result.response.json();
    return data?.choices?.[0]?.message?.content || "";
  },
  async streamAnswer(req) {
    const messages = [{ role: "system", content: req.systemInstruction }];
    for (const turn of req.history) messages.push({ role: turn.role, content: turn.content });
    if (req.excerpt) {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `\u3010\u6559\u6750\u539F\u9875\u7CBE\u8BFB\u7D20\u6750 - \u300A${req.excerpt.bookName}\u300B\u300C${req.excerpt.chapterTitle}\u300D\u7B2C ${req.excerpt.pageRange[0]} - ${req.excerpt.pageRange[1]} \u9875\u3011
\u4EE5\u4E0B\u4E3A\u8BE5\u7AE0\u8282\u7684\u6559\u6750\u539F\u59CB\u9875\u9762\u5F71\u50CF\uFF0C\u8BF7\u76F4\u63A5\u9605\u8BFB\u9875\u9762\u4E0A\u7684\u516C\u5F0F\u6392\u7248\u3001\u63D2\u56FE\u4E0E\u5B9A\u7406\u53D9\u8FF0\uFF0C\u5F15\u7528\u65F6\u6807\u6CE8\u5177\u4F53\u9875\u7801\u3002`
          },
          ...imageParts(req.excerpt),
          { type: "text", text: req.prompt }
        ]
      });
    } else {
      messages.push({ role: "user", content: req.prompt });
    }
    const result = await resilientFetch(
      endpoint(req.credentials.baseUrl),
      {
        method: "POST",
        headers: authHeaders(req.credentials.apiKey),
        body: JSON.stringify({ model: req.model, messages, stream: true })
      },
      { timeoutMs: ANSWER_TIMEOUT_MS2, retries: 2, signal: req.signal, onRetry: req.onRetry }
    );
    if (!result.ok) throw new LlmFailureError(result.failure);
    if (!result.response.body) {
      throw new LlmFailureError({
        code: "upstream",
        message: "\u6A21\u578B\u670D\u52A1\u672A\u8FD4\u56DE\u53EF\u8BFB\u7684\u6570\u636E\u6D41\u3002",
        hint: "\u8BF7\u91CD\u8BD5\uFF0C\u6216\u786E\u8BA4\u8BE5\u6A21\u578B\u652F\u6301\u6D41\u5F0F\u8F93\u51FA\u3002"
      });
    }
    const produced = await consumeStream(result.response.body, req);
    if (!produced && !req.shouldStop()) {
      throw new LlmFailureError({
        code: "upstream",
        message: "\u6A21\u578B\u8FD4\u56DE\u4E86\u7A7A\u54CD\u5E94\uFF0C\u672A\u751F\u6210\u4EFB\u4F55\u5185\u5BB9\u3002",
        hint: "\u8BF7\u786E\u8BA4\u6240\u9009\u6A21\u578B\u5177\u5907\u56FE\u50CF\u8BC6\u522B\u80FD\u529B\uFF08\u5982 gpt-4o\u3001claude-3-5-sonnet\uFF09\uFF0C\u6216\u66F4\u6362\u6A21\u578B\u540E\u91CD\u8BD5\u3002"
      });
    }
  }
};

// server/providers/index.ts
function normalizeProviderId(raw) {
  return raw === "openai_compatible" ? "openai_compatible" : "gemini";
}
function getProvider(id) {
  return id === "openai_compatible" ? openAiCompatibleProvider : geminiProvider;
}

// server/pipeline/ingest.ts
import fs4 from "fs";
import { PDFDocument as PDFDocument2 } from "pdf-lib";

// server/pdf/document.ts
import path2 from "path";
import { createRequire } from "module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
var requireFromHere = createRequire(import.meta.url);
var PDFJS_ROOT = path2.dirname(requireFromHere.resolve("pdfjs-dist/package.json"));
var CMAP_URL = path2.join(PDFJS_ROOT, "cmaps") + path2.sep;
var STANDARD_FONT_URL = path2.join(PDFJS_ROOT, "standard_fonts") + path2.sep;
async function withPdfDocument(data, fn) {
  const doc = await pdfjs.getDocument({
    // pdf.js detaches the buffer it is given, so hand it a private copy.
    data: new Uint8Array(data),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_URL,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0
  }).promise;
  try {
    return await fn(doc);
  } finally {
    try {
      await doc.destroy();
    } catch {
    }
  }
}
async function readPageText(doc, pageNumber) {
  const page = await doc.getPage(pageNumber);
  try {
    const content = await page.getTextContent();
    let out = "";
    for (const item of content.items) {
      if (typeof item.str !== "string") continue;
      out += item.str;
      if (item.hasEOL) out += "\n";
    }
    return out;
  } finally {
    try {
      page.cleanup();
    } catch {
    }
  }
}

// server/pdf/raster.ts
import fs2 from "fs";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import { createCanvas, ImageData } from "@napi-rs/canvas";

// server/budget.ts
var MAX_SLICE_PAGES = 30;
var MAX_CONTEXT_TOKENS = 25e3;
var MAX_CATALOG_TOKENS = 1200;
var MAX_HISTORY_TOKENS = 4e3;
var TOKENS_PER_PDF_PAGE = 258;
var TOKENS_PER_IMAGE_PAGE = 1100;
var MAX_INLINE_PDF_KB = 8 * 1024;
var IMAGE_LONG_EDGE_PX = 1400;
var IMAGE_JPEG_QUALITY = 76;
function maxPdfPagesWithinBudget() {
  return Math.max(1, Math.min(MAX_SLICE_PAGES, Math.floor(MAX_CONTEXT_TOKENS / TOKENS_PER_PDF_PAGE)));
}
function maxImagePagesWithinBudget() {
  return Math.max(1, Math.min(MAX_SLICE_PAGES, Math.floor(MAX_CONTEXT_TOKENS / TOKENS_PER_IMAGE_PAGE)));
}
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}
function clampPageRange(startPage, endPage, totalPages) {
  const safeTotal = Math.max(1, totalPages);
  const safeStart = Math.max(1, Math.min(Math.floor(startPage) || 1, safeTotal));
  const hardEnd = Math.min(safeTotal, safeStart + MAX_SLICE_PAGES - 1);
  const safeEnd = Math.max(safeStart, Math.min(Math.floor(endPage) || safeStart, hardEnd));
  return [safeStart, safeEnd];
}

// server/pdf/raster.ts
var libraryPromise = null;
function getLibrary() {
  if (!libraryPromise) {
    libraryPromise = PDFiumLibrary.init().catch((err) => {
      libraryPromise = null;
      throw err;
    });
  }
  return libraryPromise;
}
function bgraToRgba(source) {
  const out = new Uint8ClampedArray(source.length);
  for (let i = 0; i < source.length; i += 4) {
    out[i] = source[i + 2];
    out[i + 1] = source[i + 1];
    out[i + 2] = source[i];
    out[i + 3] = source[i + 3];
  }
  return out;
}
async function renderPageRange(bookId, startPage, endPage) {
  const filePath = getBookPath(bookId);
  if (!fs2.existsSync(filePath)) {
    throw new Error(`\u6559\u6750\u6587\u4EF6\u672A\u627E\u5230: ${bookId}`);
  }
  const library = await getLibrary();
  const doc = await library.loadDocument(fs2.readFileSync(filePath));
  try {
    const [safeStart, safeEnd] = clampPageRange(startPage, endPage, doc.getPageCount());
    const images = [];
    for (let pageNumber = safeStart; pageNumber <= safeEnd; pageNumber++) {
      const page = doc.getPage(pageNumber - 1);
      const { originalWidth, originalHeight } = page.getOriginalSize();
      const longEdge = Math.max(originalWidth, originalHeight) || 1;
      const scale = IMAGE_LONG_EDGE_PX / longEdge;
      const bitmap = await page.render({ scale, render: "bitmap" });
      const canvas = createCanvas(bitmap.width, bitmap.height);
      canvas.getContext("2d").putImageData(new ImageData(bgraToRgba(bitmap.data), bitmap.width, bitmap.height), 0, 0);
      const jpeg = canvas.encodeSync("jpeg", IMAGE_JPEG_QUALITY);
      images.push({
        pageNumber,
        base64: jpeg.toString("base64"),
        width: bitmap.width,
        height: bitmap.height,
        sizeKb: Math.round(jpeg.length / 1024)
      });
    }
    return { images, pageRange: [safeStart, safeEnd] };
  } finally {
    try {
      doc.destroy();
    } catch {
    }
  }
}

// server/pdf/slice.ts
import fs3 from "fs";
import { PDFDocument } from "pdf-lib";
async function slicePdf(bookId, startPage, endPage) {
  const filePath = getBookPath(bookId);
  if (!fs3.existsSync(filePath)) {
    throw new Error(`\u6559\u6750\u6587\u4EF6\u672A\u627E\u5230: ${bookId}`);
  }
  const srcDoc = await PDFDocument.load(fs3.readFileSync(filePath), { ignoreEncryption: true });
  const [safeStart, safeEnd] = clampPageRange(startPage, endPage, srcDoc.getPageCount());
  const subDoc = await PDFDocument.create();
  const pageIndices = [];
  for (let i = safeStart - 1; i < safeEnd; i++) pageIndices.push(i);
  const copied = await subDoc.copyPages(srcDoc, pageIndices);
  copied.forEach((p) => subDoc.addPage(p));
  const buffer = Buffer.from(await subDoc.save());
  return { buffer, pageRange: [safeStart, safeEnd], sizeKb: Math.round(buffer.length / 1024) };
}

// server/pdf/outline.ts
var SYNTHETIC_BLOCK_PAGES = 30;
var TOC_SCAN_PAGES = 30;
var MAX_OUTLINE_ENTRIES = 400;
function sanitizeTitle(raw) {
  return String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}
async function resolveDestinationPage(doc, dest, cache) {
  let resolved = dest;
  if (typeof resolved === "string") {
    resolved = await doc.getDestination(resolved);
  }
  if (!Array.isArray(resolved) || resolved.length === 0) return null;
  const target = resolved[0];
  if (typeof target === "number") return target + 1;
  if (!target || typeof target.num !== "number") return null;
  const key = `${target.num}_${target.gen}`;
  const cached = cache.get(key);
  if (cached !== void 0) return cached;
  const pageNumber = await doc.getPageIndex(target) + 1;
  cache.set(key, pageNumber);
  return pageNumber;
}
function assignEndPages(items, totalPages) {
  const sorted = [...items].sort((a, b) => a.startPage - b.startPage);
  for (let i = 0; i < sorted.length; i++) {
    let end = totalPages;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startPage > sorted[i].startPage) {
        end = sorted[j].startPage - 1;
        break;
      }
    }
    sorted[i].endPage = Math.max(sorted[i].startPage, Math.min(end, totalPages));
  }
  return sorted;
}
async function fromBookmarks(doc, totalPages) {
  const outline = await doc.getOutline();
  if (!Array.isArray(outline) || outline.length === 0) return [];
  const cache = /* @__PURE__ */ new Map();
  const items = [];
  const walk = async (nodes, level) => {
    for (const node of nodes) {
      if (items.length >= MAX_OUTLINE_ENTRIES) return;
      const title = sanitizeTitle(node?.title);
      if (title) {
        let page = null;
        try {
          page = await resolveDestinationPage(doc, node?.dest, cache);
        } catch {
        }
        if (page !== null && page >= 1 && page <= totalPages) {
          items.push({ title, startPage: page, level });
        }
      }
      if (Array.isArray(node?.items) && node.items.length > 0) {
        await walk(node.items, level + 1);
      }
    }
  };
  await walk(outline, 0);
  if (items.length < 2 || new Set(items.map((i) => i.startPage)).size < 2) return [];
  return assignEndPages(items, totalPages);
}
var TOC_LINE_PATTERNS = [
  // 第1章 / 第一章 / 第 3 节 —— 标题 —— 页码 (dot leaders or wide gap)
  /^(第\s*[0-9０-９一二三四五六七八九十百]{1,4}\s*[章节節篇卷部讲講])[\s:：.、·]*(.{0,60}?)[\s.·…—-]{2,}(\d{1,4})$/,
  // 1.2.3 标题 ...... 页码
  /^(\d{1,2}(?:[.．]\d{1,2}){1,2})[\s:：.、]+(.{1,60}?)[\s.·…—-]{2,}(\d{1,4})$/,
  // Chapter 3 / Section II — Title ..... 42
  /^((?:Chapter|Section|Part|Lecture)\s+[0-9IVXLC]{1,5})[\s:.、]*(.{0,60}?)[\s.·…—-]{2,}(\d{1,4})$/i,
  // Looser: a chapter marker line that simply ends in a page number
  /^(第\s*[0-9０-９一二三四五六七八九十百]{1,4}\s*[章节節篇卷部讲講])[\s:：.、·]*(.{0,60}?)\s+(\d{1,4})$/
];
async function buildPrintedPageMap(doc) {
  const map = /* @__PURE__ */ new Map();
  try {
    const labels = await doc.getPageLabels();
    if (!Array.isArray(labels)) return map;
    labels.forEach((label, index) => {
      const printed = parseInt(String(label).trim(), 10);
      if (!Number.isNaN(printed) && !map.has(printed)) map.set(printed, index + 1);
    });
  } catch {
  }
  return map;
}
async function fromPrintedContents(doc, totalPages) {
  const scanLimit = Math.min(TOC_SCAN_PAGES, totalPages);
  const lines = [];
  for (let pageNumber = 1; pageNumber <= scanLimit; pageNumber++) {
    try {
      for (const line of (await readPageText(doc, pageNumber)).split("\n")) {
        const trimmed = line.trim();
        if (trimmed) lines.push(trimmed);
      }
    } catch {
    }
  }
  if (lines.length === 0) return [];
  const printedMap = await buildPrintedPageMap(doc);
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  for (const line of lines) {
    for (const pattern of TOC_LINE_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;
      const marker = sanitizeTitle(match[1]);
      const label = sanitizeTitle(match[2]);
      const printedPage = parseInt(match[3], 10);
      if (!printedPage || Number.isNaN(printedPage)) break;
      const physical = printedMap.get(printedPage) ?? printedPage;
      if (physical < 1 || physical > totalPages) break;
      const title = [marker, label].filter(Boolean).join(" ").trim();
      if (!title || seen.has(title)) break;
      seen.add(title);
      items.push({ title, startPage: physical, level: /^\d/.test(marker) ? 1 : 0 });
      break;
    }
    if (items.length >= 200) break;
  }
  if (items.length < 3 || new Set(items.map((i) => i.startPage)).size < 3) return [];
  return assignEndPages(items, totalPages);
}
async function extractOutline(doc, totalPages) {
  try {
    const bookmarks = await fromBookmarks(doc, totalPages);
    if (bookmarks.length > 0) return { toc: bookmarks, source: "bookmarks" };
  } catch (err) {
    console.warn("[outline] bookmark pass failed:", err);
  }
  try {
    const printed = await fromPrintedContents(doc, totalPages);
    if (printed.length > 0) return { toc: printed, source: "text-scan" };
  } catch (err) {
    console.warn("[outline] printed-contents pass failed:", err);
  }
  return { toc: [], source: "none" };
}
var VISUAL_TOC_PAGES = 15;
var VISUAL_TOC_PROMPT = `\u4F60\u662F\u4E00\u4E2A\u4E25\u8C28\u7684\u6559\u6750\u7F16\u76EE\u5458\u3002\u8BF7\u9605\u8BFB\u63D0\u4F9B\u7684\u6559\u6750\u524D\u7F6E\u9875\u56FE\u7247\uFF0C\u627E\u5230\u5370\u5237\u7684"\u76EE\u5F55"\uFF08Table of Contents\uFF09\uFF0C\u8BC6\u522B\u6240\u6709\u4E00\u7EA7\u7AE0\u8282\u7684\u540D\u79F0\u3001\u8D77\u59CB\u9875\u7801\u4E0E\u7EC8\u6B62\u9875\u7801\u3002
\u8BF7\u76F4\u63A5\u8F93\u51FA\u4E25\u683C\u7684\u5408\u6CD5 JSON \u6570\u7EC4\uFF0C\u683C\u5F0F\u5982\u4E0B\uFF1A
[
  {"title": "\u7B2C\u4E00\u7AE0 ...", "startPage": 1, "endPage": 35},
  {"title": "\u7B2C\u4E8C\u7AE0 ...", "startPage": 36, "endPage": 78}
]
\u4E25\u7981\u8F93\u51FA\u4EFB\u4F55\u591A\u4F59\u5E9F\u8BDD\u6216 Markdown \u6807\u8BB0\uFF0C\u4FDD\u8BC1 JSON \u53EF\u4EE5\u88AB JSON.parse \u76F4\u63A5\u89E3\u6790\u3002`;
function parseVisualOutlineJson(raw) {
  if (!raw || typeof raw !== "string") return [];
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const attempt = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      for (const key of ["entries", "toc", "chapters", "data"]) {
        if (Array.isArray(parsed?.[key])) return parsed[key];
      }
    } catch {
    }
    return null;
  };
  const direct = attempt(text);
  if (direct) return direct;
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if (first !== -1 && last > first) {
    const sliced = attempt(text.slice(first, last + 1));
    if (sliced) return sliced;
  }
  return [];
}
function buildOutlineFromEntries(entries, totalPages) {
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    const title = sanitizeTitle(entry?.title);
    const startPage = Math.floor(Number(entry?.startPage));
    if (!title || seen.has(title)) continue;
    if (!Number.isFinite(startPage) || startPage < 1 || startPage > totalPages) continue;
    const declaredEnd = Math.floor(Number(entry?.endPage));
    const endPage = Number.isFinite(declaredEnd) && declaredEnd >= startPage && declaredEnd <= totalPages ? declaredEnd : void 0;
    seen.add(title);
    items.push({ title, startPage, endPage, level: 0 });
    if (items.length >= MAX_OUTLINE_ENTRIES) break;
  }
  if (items.length < 2 || new Set(items.map((i) => i.startPage)).size < 2) return [];
  const sorted = [...items].sort((a, b) => a.startPage - b.startPage);
  const withEnds = assignEndPages(
    sorted.map(({ endPage, ...rest }) => rest),
    totalPages
  );
  return withEnds.map((item, index) => ({
    ...item,
    endPage: sorted[index].endPage ?? item.endPage
  }));
}
async function extractVisualOutline(ctx) {
  const lastPage = Math.min(VISUAL_TOC_PAGES, ctx.totalPages);
  let payload;
  if (ctx.provider.excerptFormat === "pdf") {
    const slice = await slicePdf(ctx.bookId, 1, lastPage);
    payload = { pdfBase64: slice.buffer.toString("base64") };
  } else {
    const rendered = await renderPageRange(ctx.bookId, 1, lastPage);
    payload = { images: rendered.images };
  }
  const raw = await ctx.provider.inspectPages({
    model: ctx.model,
    credentials: ctx.credentials,
    prompt: VISUAL_TOC_PROMPT,
    payload,
    signal: ctx.signal
  });
  const toc = buildOutlineFromEntries(parseVisualOutlineJson(raw), ctx.totalPages);
  console.log(`[outline] visual pass on ${ctx.bookId} produced ${toc.length} entries`);
  return toc;
}
function synthesizeOutline(totalPages) {
  const items = [];
  for (let start = 1; start <= totalPages; start += SYNTHETIC_BLOCK_PAGES) {
    const end = Math.min(totalPages, start + SYNTHETIC_BLOCK_PAGES - 1);
    items.push({ title: `\u7B2C ${start}-${end} \u9875`, startPage: start, endPage: end, level: 0 });
  }
  return items;
}

// server/pipeline/ingest.ts
async function resolvePageCount(rawBuffer, fileSize) {
  try {
    const count = (await PDFDocument2.load(rawBuffer, { ignoreEncryption: true })).getPageCount();
    if (count > 0) return count;
  } catch (err) {
    console.warn("[ingest] pdf-lib page count failed, trying pdf.js:", err);
  }
  try {
    const count = await withPdfDocument(rawBuffer, async (doc) => doc.numPages);
    if (count > 0) return count;
  } catch (err) {
    console.warn("[ingest] pdf.js page count failed, trying raw scan:", err);
  }
  try {
    const head = rawBuffer.subarray(0, Math.min(rawBuffer.length, 10 * 1024 * 1024)).toString("latin1");
    const countMatch = head.match(/\/Count\s+(\d+)/);
    if (countMatch?.[1]) {
      const count = parseInt(countMatch[1], 10);
      if (count > 0) return count;
    }
    const pageMatches = head.match(/\/Type\s*\/Page\b/g);
    if (pageMatches && pageMatches.length > 0) return pageMatches.length;
  } catch {
  }
  return Math.max(1, Math.round(fileSize / (120 * 1024)));
}
function formatUploadTime() {
  const now = /* @__PURE__ */ new Date();
  return `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
}
async function ingestBook(filePath, safeName, fileSize, bookId, vision) {
  const rawBuffer = fs4.readFileSync(filePath);
  const pageCount = await resolvePageCount(rawBuffer, fileSize);
  let toc = [];
  let tocSource = "none";
  try {
    await withPdfDocument(rawBuffer, async (doc) => {
      const outline = await extractOutline(doc, doc.numPages || pageCount);
      toc = outline.toc;
      tocSource = outline.source;
    });
  } catch (err) {
    console.warn("[ingest] parsing passes failed, falling through to visual reading:", err);
  }
  let visionAttempted = false;
  if (toc.length === 0 && vision) {
    visionAttempted = true;
    try {
      const visual = await extractVisualOutline({
        bookId,
        totalPages: pageCount,
        provider: vision.provider,
        model: vision.model,
        credentials: vision.credentials,
        signal: vision.signal ?? new AbortController().signal
      });
      if (visual.length > 0) {
        toc = visual;
        tocSource = "vision";
      }
    } catch (err) {
      console.warn("[ingest] visual outline read failed, falling back to page blocks:", err);
    }
  }
  if (toc.length === 0) {
    toc = synthesizeOutline(pageCount);
    tocSource = "synthesized";
  }
  return {
    id: bookId,
    name: safeName,
    sizeMb: parseFloat((fileSize / (1024 * 1024)).toFixed(2)) || 0.1,
    pageCount,
    toc,
    uploadTime: formatUploadTime(),
    tocSource,
    visionAttempted
  };
}

// server/pipeline/route.ts
function expandRange(startPage, endPage, totalPages) {
  const span = endPage - startPage + 1;
  const target = span >= 8 ? endPage : startPage + MAX_SLICE_PAGES - 1;
  return clampPageRange(startPage, Math.min(target, totalPages), totalPages);
}
function selectCatalogEntries(toc, limit) {
  if (!Array.isArray(toc) || toc.length === 0) return [];
  if (toc.length <= limit) return toc;
  let selected = [];
  for (const maxLevel of [0, 1, 2, 3]) {
    const candidates = toc.filter((item) => (item.level ?? 0) <= maxLevel);
    if (candidates.length <= limit && candidates.length > selected.length) selected = candidates;
  }
  const remaining = limit - selected.length;
  if (remaining > 0) {
    const chosen = new Set(selected);
    const rest = toc.filter((item) => !chosen.has(item));
    const step = Math.max(1, Math.ceil(rest.length / remaining));
    rest.forEach((item, index) => {
      if (index % step === 0 && selected.length < limit) selected.push(item);
    });
  }
  return selected.sort((a, b) => a.startPage - b.startPage);
}
function renderCatalog(books, entriesPerBook) {
  const lines = [];
  books.forEach((book, index) => {
    lines.push(`\u3010\u6559\u6750 ${index + 1}\u3011\u300A${book.name}\u300B\uFF08ID: ${book.id}\uFF0C\u5171 ${book.pageCount} \u9875\uFF09`);
    for (const item of selectCatalogEntries(book.toc || [], entriesPerBook)) {
      const indent = "  ".repeat(1 + Math.min(2, item.level ?? 0));
      const range = item.endPage && item.endPage !== item.startPage ? `P${item.startPage}-P${item.endPage}` : `P${item.startPage}`;
      lines.push(`${indent}\u2022 ${item.title} (${range})`);
    }
  });
  return lines.join("\n");
}
function buildCatalog(books) {
  let entriesPerBook = Math.max(10, Math.floor(60 / Math.max(1, books.length)));
  let catalog = renderCatalog(books, entriesPerBook);
  while (estimateTokens(catalog) > MAX_CATALOG_TOKENS && entriesPerBook > 6) {
    entriesPerBook = Math.floor(entriesPerBook * 0.7);
    catalog = renderCatalog(books, entriesPerBook);
  }
  return catalog;
}
function tokenizeForMatching(text) {
  const tokens = /* @__PURE__ */ new Set();
  const cleaned = String(text || "").toLowerCase();
  const cjkRun = (cleaned.match(/[\u3400-\u9fff]/g) || []).join("");
  for (let i = 0; i + 1 < cjkRun.length; i++) tokens.add(cjkRun.slice(i, i + 2));
  for (const word of cleaned.match(/[a-z]{3,}/g) || []) tokens.add(word);
  return tokens;
}
function matchChapterLocally(prompt, books) {
  const promptTokens = tokenizeForMatching(prompt);
  if (promptTokens.size === 0) return null;
  let best = null;
  for (const book of books) {
    for (const item of book.toc || []) {
      const titleTokens = tokenizeForMatching(item.title);
      if (titleTokens.size === 0) continue;
      let overlap = 0;
      for (const token of titleTokens) if (promptTokens.has(token)) overlap++;
      if (overlap === 0) continue;
      const score2 = overlap / titleTokens.size;
      if (!best || score2 > best.score) {
        const [startPage, endPage] = expandRange(
          item.startPage,
          item.endPage ?? item.startPage,
          book.pageCount
        );
        best = {
          bookId: book.id,
          bookName: book.name,
          chapterTitle: item.title,
          startPage,
          endPage,
          rationale: "\u6A21\u578B\u8DEF\u7531\u4E0D\u53EF\u7528\uFF0C\u5DF2\u6309\u76EE\u5F55\u5173\u952E\u8BCD\u672C\u5730\u5339\u914D\u5B9A\u4F4D\u3002",
          source: "keyword",
          score: score2
        };
      }
    }
  }
  if (!best || best.score < 0.34) return null;
  const { score, ...decision } = best;
  return decision;
}
var FAST_MODEL_HINTS = ["flash", "mini", "turbo", "lite", "small", "haiku"];
var SLOW_MODEL_HINTS = ["reason", "thinking", "r1", "o1", "o3", "pro", "opus", "max"];
function pickRoutingModel(candidates, answerModel) {
  const usable = (candidates || []).filter(Boolean);
  if (usable.length === 0) return answerModel;
  const fast = usable.find((name) => {
    const lowered = name.toLowerCase();
    return FAST_MODEL_HINTS.some((h) => lowered.includes(h)) && !SLOW_MODEL_HINTS.some((h) => lowered.includes(h));
  });
  if (fast) return fast;
  const answerIsSlow = SLOW_MODEL_HINTS.some((h) => answerModel.toLowerCase().includes(h));
  if (!answerIsSlow) return answerModel;
  const notSlow = usable.find((name) => !SLOW_MODEL_HINTS.some((h) => name.toLowerCase().includes(h)));
  return notSlow || answerModel;
}
function parseRoutingJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(text);
  } catch {
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
    }
  }
  return null;
}
function buildRoutingPrompt(catalog, prompt) {
  return `\u4F60\u662F\u4E00\u4F4D\u9AD8\u6821\u786C\u6838\u5B66\u672F\u56FE\u4E66\u7BA1\u7406\u5458\u3002
\u8BF7\u6839\u636E\u4EE5\u4E0B\u6559\u6750\u5FAE\u578B\u76EE\u5F55\u7D22\u5F15\uFF0C\u5BA1\u9605\u5B66\u751F\u7684\u63D0\u95EE\uFF0C\u7CBE\u786E\u5B9A\u4F4D\u51FA\uFF1A\u8BE5\u95EE\u9898\u5C5E\u4E8E\u54EA\u4E00\u672C\u6559\u6750\u7684\u54EA\u4E00\u5177\u4F53\u7AE0\u8282\uFF0C\u4EE5\u53CA\u6700\u6838\u5FC3\u7684\u7814\u8BFB\u8D77\u6B62\u9875\u7801\u8303\u56F4\u3002

\u3010\u4E25\u683C\u7EA6\u675F\u3011
1. startPage \u4E0E endPage \u7684\u8DE8\u5EA6\u5FC5\u987B\u63A7\u5236\u5728 ${MAX_SLICE_PAGES} \u9875\u4EE5\u5185\u3002
2. \u53EA\u8F93\u51FA\u4E25\u683C\u5408\u6CD5\u7684 JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u591A\u4F59\u6587\u5B57\uFF1A
{
  "matched": true,
  "bookId": "\u6559\u6750\u7684\u771F\u5B9EID",
  "bookName": "\u6559\u6750\u4E66\u540D",
  "chapterTitle": "\u5177\u4F53\u7AE0\u8282\u540D",
  "startPage": 18,
  "endPage": 35,
  "rationale": "\u5B9A\u4F4D\u8BE5\u7AE0\u8282\u7684\u539F\u56E0\u7B80\u8FF0"
}
\u82E5\u95EE\u9898\u4E0E\u6240\u5217\u6559\u6750\u65E0\u5173\uFF0C\u8F93\u51FA: { "matched": false }

\u3010\u5DF2\u6302\u8F7D\u6559\u6750\u5FAE\u578B\u76EE\u5F55\u6811\u3011\uFF1A
${catalog}

\u3010\u5B66\u751F\u63D0\u95EE\u3011\uFF1A
${prompt}`;
}
async function routeQuestion(options) {
  const { prompt, provider, routingModel, credentials, channel } = options;
  const books = options.books.filter((book2) => (book2.toc || []).length > 0);
  if (books.length === 0) return null;
  if (!routingModel || !credentials.apiKey) return matchChapterLocally(prompt, books);
  const catalog = buildCatalog(books);
  console.log(`[route] catalog \u2248 ${estimateTokens(catalog)} tokens via ${routingModel}`);
  let raw = "";
  try {
    raw = await provider.requestRouting({
      model: routingModel,
      credentials,
      prompt: buildRoutingPrompt(catalog, prompt),
      signal: channel.aborter.signal,
      onRetry: () => channel.stage("\u76EE\u5F55\u5B9A\u4F4D\u8BF7\u6C42\u8D85\u65F6\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u8BD5\u2026")
    });
  } catch (err) {
    console.warn("[route] model routing failed, using keyword fallback:", err);
    return matchChapterLocally(prompt, books);
  }
  const parsed = parseRoutingJson(raw);
  if (!parsed?.matched || !parsed.bookId) return matchChapterLocally(prompt, books);
  const book = books.find((b) => b.id === String(parsed.bookId));
  if (!book) return matchChapterLocally(prompt, books);
  const [startPage, endPage] = expandRange(
    Number(parsed.startPage) || 1,
    Number(parsed.endPage) || Number(parsed.startPage) || 1,
    book.pageCount
  );
  return {
    bookId: book.id,
    bookName: book.name,
    chapterTitle: String(parsed.chapterTitle || "\u6838\u5FC3\u7AE0\u8282"),
    startPage,
    endPage,
    rationale: parsed.rationale ? String(parsed.rationale) : void 0,
    source: "model"
  };
}

// server/pipeline/answer.ts
function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const usable = [];
  for (const item of history) {
    if (!item?.content || typeof item.content !== "string" || !item.content.trim()) continue;
    if (item.id && String(item.id).startsWith("sys-")) continue;
    if (item.isError) continue;
    usable.push({ role: item.role === "assistant" ? "assistant" : "user", content: item.content });
  }
  const kept = [];
  let tokens = 0;
  for (let i = usable.length - 1; i >= 0; i--) {
    const cost = estimateTokens(usable[i].content);
    if (tokens + cost > MAX_HISTORY_TOKENS) break;
    tokens += cost;
    kept.unshift(usable[i]);
  }
  return kept;
}
async function prepareExcerpt(decision, book, provider) {
  const [startPage, requestedEnd] = clampPageRange(
    decision.startPage,
    decision.endPage,
    book.pageCount
  );
  const common = { bookName: book.name, chapterTitle: decision.chapterTitle };
  if (provider.excerptFormat === "pdf") {
    const budgetEnd = Math.min(requestedEnd, startPage + maxPdfPagesWithinBudget() - 1);
    let rangeEnd = Math.max(startPage, budgetEnd);
    let slice = await slicePdf(book.id, startPage, rangeEnd);
    while (slice.sizeKb > MAX_INLINE_PDF_KB && rangeEnd - startPage + 1 > 4) {
      rangeEnd = startPage + Math.floor((rangeEnd - startPage) / 2);
      console.log(`[answer] slice ${slice.sizeKb}KB exceeds cap, narrowing to P${startPage}-P${rangeEnd}`);
      slice = await slicePdf(book.id, startPage, rangeEnd);
    }
    const pages = slice.pageRange[1] - slice.pageRange[0] + 1;
    return {
      ...common,
      pageRange: slice.pageRange,
      pdfBase64: slice.buffer.toString("base64"),
      estimatedTokens: pages * TOKENS_PER_PDF_PAGE
    };
  }
  const imageEnd = Math.max(
    startPage,
    Math.min(requestedEnd, startPage + maxImagePagesWithinBudget() - 1)
  );
  const rendered = await renderPageRange(book.id, startPage, imageEnd);
  const totalKb = rendered.images.reduce((sum, image) => sum + image.sizeKb, 0);
  console.log(
    `[answer] rendered P${rendered.pageRange[0]}-P${rendered.pageRange[1]} as ${rendered.images.length} images (${totalKb}KB)`
  );
  return {
    ...common,
    pageRange: rendered.pageRange,
    images: rendered.images,
    estimatedTokens: rendered.images.length * TOKENS_PER_IMAGE_PAGE
  };
}
async function streamAnswer(options) {
  const { provider, model, credentials, systemInstruction, prompt, excerpt, channel } = options;
  await provider.streamAnswer({
    model,
    credentials,
    systemInstruction,
    history: normalizeHistory(options.history),
    prompt,
    excerpt,
    signal: channel.aborter.signal,
    shouldStop: () => channel.isClosed,
    onRetry: (attempt, failure) => channel.stage(`\u8FDE\u63A5\u6A21\u578B\u5931\u8D25\uFF08${failure.message}\uFF09\uFF0C\u6B63\u5728\u7B2C ${attempt} \u6B21\u81EA\u52A8\u91CD\u8BD5\u2026`),
    onText: (chunk) => channel.send({ text: chunk }),
    onReasoning: (chunk) => channel.send({ reasoning: chunk })
  });
}

// server/pipeline/visionIndex.ts
function needsDeferredVision(book) {
  return book.tocSource === "synthesized" && !book.visionAttempted;
}
async function recoverOutlineWithVision(options) {
  const { book, provider, model, credentials, channel } = options;
  channel.stage(`\u300A${book.name}\u300B\u4E0A\u4F20\u65F6\u5C1A\u672A\u914D\u7F6E\u6A21\u578B\uFF0C\u6B63\u5728\u8865\u505A\u5370\u5237\u76EE\u5F55\u7684\u89C6\u89C9\u8BC6\u522B\u2026`);
  let updated = { ...book, visionAttempted: true };
  try {
    const toc = await extractVisualOutline({
      bookId: book.id,
      totalPages: book.pageCount,
      provider,
      model,
      credentials,
      signal: channel.aborter.signal
    });
    if (toc.length > 0) {
      updated = { ...updated, toc, tocSource: "vision" };
      channel.notice(
        "info",
        `\u5DF2\u901A\u8FC7\u89C6\u89C9\u8BC6\u522B\u4E3A\u300A${book.name}\u300B\u5EFA\u7ACB ${toc.length} \u6761\u7AE0\u8282\u76EE\u5F55\uFF0C\u5DF2\u6C38\u4E45\u7F13\u5B58\uFF0C\u540E\u7EED\u63D0\u95EE\u4E0D\u518D\u91CD\u590D\u8BC6\u522B\u3002`
      );
    }
  } catch (err) {
    console.warn(`[vision-index] deferred pass failed for ${book.id}:`, err);
  }
  saveBookMetadata(updated);
  return updated;
}

// server.ts
dotenv.config();
var PORT = 3e3;
var app = express();
var DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
var upload = multer({
  limits: { fileSize: 60 * 1024 * 1024 },
  storage: multer.memoryStorage()
});
var DEFAULT_SYSTEM_INSTRUCTION = `\u4F60\u662F\u4E00\u4F4D\u4E25\u8C28\u3001\u6743\u5A01\u4E14\u5BCC\u6709\u8010\u5FC3\u7684\u5927\u5B66\u7406\u5DE5\u79D1\u8BB2\u5E2D\u6559\u6388\uFF08\u7CBE\u901A\u9AD8\u7B49\u6570\u5B66\u3001\u7EBF\u6027\u4EE3\u6570\u3001\u5927\u5B66\u7269\u7406\u3001\u7406\u8BBA\u529B\u5B66\u3001\u7535\u78C1\u5B66\u4E0E\u7535\u52A8\u529B\u5B66\u3001\u91CF\u5B50\u529B\u5B66\u7B49\u786C\u6838\u5B66\u79D1\uFF09\u3002
\u4F60\u7684\u9996\u8981\u4EFB\u52A1\u662F\u7ED3\u5408\u7528\u6237\u4E0A\u4F20\u6216\u63D0\u95EE\u7684\u5927\u5B66\u6559\u6750\uFF0C\u5F00\u5C55\u6DF1\u5EA6\u3001\u7CBE\u51C6\u7684\u8BFE\u4E1A\u4F34\u8BFB\u3001\u5B9A\u7406\u63A8\u6F14\u3001\u6982\u5FF5\u5256\u6790\u4E0E\u8BFE\u540E\u4E60\u9898\u7CBE\u89E3\u3002

\u3010\u56DE\u7B54\u6838\u5FC3\u51C6\u5219\u3011
1. \u3010\u4E25\u683C\u5FE0\u4E8E\u5B66\u672F\u4E25\u8C28\u6027\u3011\uFF1A\u56DE\u7B54\u5FC5\u987B\u6E05\u6670\u51C6\u786E\uFF0C\u5B9A\u7406\u6761\u4EF6\u4E0D\u53EF\u9057\u6F0F\u3002\u5982\u6709\u6559\u6750\u51FA\u5904\u6216\u7AE0\u8282\u5B9A\u4F4D\uFF0C\u52A1\u5FC5\u660E\u786E\u6307\u5F15\uFF08\u5982\uFF1A\u300E\u{1F4D6} \u51FA\u5904\uFF1A\u7B2C 3 \u7AE0 \u5411\u91CF\u4EE3\u6570 / \u7B2C 85 \u9875 \u5B9A\u7406 3.4\u300F\uFF09\u3002
2. \u3010\u5DE5\u79D1\u7EA7\u8BE6\u5C3D\u63A8\u5BFC\u6F14\u7ECE\u3011\uFF1A
   - \u6570\u5B66\u516C\u5F0F\u5FC5\u987B\u89C4\u8303\u4F7F\u7528\u6807\u51C6 LaTeX \u8BED\u6CD5\uFF1A\u884C\u5185\u516C\u5F0F\u7528\u5355\u4E2A $ \u5305\u88F9\uFF08\u5982 $E=mc^2$\uFF09\uFF1B\u72EC\u7ACB\u884C\u95F4\u516C\u5F0F\u4F7F\u7528\u53CC $$ \u5305\u88F9\u5E76\u5355\u72EC\u6210\u884C\u3002
   - \u63A8\u5BFC\u8FC7\u7A0B\u6B65\u6B65\u6E05\u6670\uFF0C\u7EDD\u4E0D\u53EF\u7701\u7565\u5173\u952E\u6B65\u9AA4\uFF0C\u6E05\u6670\u9610\u660E\u6BCF\u4E00\u6B65\u7684\u6570\u5B66\u53D8\u6362\u4F9D\u636E\u3001\u7269\u7406\u610F\u4E49\u6216\u51E0\u4F55\u76F4\u89C2\u3002
3. \u3010\u7ED3\u6784\u5316\u8868\u683C\u4E0E\u5BF9\u6BD4\u3011\uFF1A\u6D89\u53CA\u591A\u4E2A\u7269\u7406\u91CF\u5BF9\u6BD4\u3001\u516C\u5F0F\u6C47\u603B\u6216\u5224\u522B\u51C6\u5219\u5BF9\u6BD4\u65F6\uFF0C\u5FC5\u987B\u4F18\u5148\u6574\u7406\u4E3A\u5DE5\u6574\u7684 Markdown \u8868\u683C\uFF0C\u5E76\u6807\u6CE8\u7269\u7406\u91CF\u7B26\u53F7\u4E0E SI \u5355\u4F4D\u3002
4. \u3010\u8003\u70B9\u4E0E\u6613\u9519\u70B9\u3011\uFF1A\u5728\u672B\u5C3E\u4E3B\u52A8\u6307\u51FA\u5B66\u751F\u5E38\u89C1\u6613\u9519\u9677\u9631\u3001\u8FB9\u754C\u60C5\u51B5\u53CA\u8003\u524D\u590D\u4E60\u7CBE\u8981\u3002`;
var discoveredModelsCache = {
  gemini: [],
  openai_compatible: []
};
function resolveDynamicModel(requestedModel, provider) {
  if (typeof requestedModel === "string" && requestedModel.trim()) return requestedModel.trim();
  return discoveredModelsCache[provider]?.[0] || "";
}
function rankModels(models, scorer) {
  return [...models].sort((a, b) => scorer(b.toLowerCase()) - scorer(a.toLowerCase()));
}
var VISION_MODEL_HINTS = ["4o", "4.1", "o4", "vision", "sonnet", "opus", "haiku", "vl", "omni"];
var TEXT_ONLY_MODEL_HINTS = ["deepseek-chat", "deepseek-reasoner", "embedding", "rerank", "tts", "whisper", "moderation"];
async function discoverGeminiModels(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "User-Agent": "aistudio-build/1.0", Accept: "application/json" }
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json())?.error?.message || "";
    } catch {
    }
    throw new Error(detail || `Google API \u8FD4\u56DE HTTP ${response.status} (${response.statusText})\u3002`);
  }
  const data = await response.json();
  const models = (data?.models || []).filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
  return rankModels(models, (l) => l.includes("flash") ? 100 : l.includes("pro") ? 80 : 50);
}
async function discoverOpenAiModels(apiKey, baseUrl) {
  const headers = {
    "User-Agent": "aistudio-build/1.0",
    Accept: "application/json"
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { method: "GET", headers });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = body?.error?.message || body?.message || "";
    } catch {
    }
    throw new Error(detail || `HTTP ${response.status}`);
  }
  const data = await response.json();
  const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : data?.models || [];
  const models = Array.from(
    new Set(raw.map((item) => typeof item === "string" ? item : item.id || item.name).filter(Boolean))
  );
  return rankModels(models, (l) => {
    if (TEXT_ONLY_MODEL_HINTS.some((h) => l.includes(h))) return 0;
    if (VISION_MODEL_HINTS.some((h) => l.includes(h))) return 100;
    return 50;
  });
}
async function autoDiscoverModelsOnBoot() {
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (!envKey) return;
  try {
    const models = await discoverGeminiModels(envKey);
    if (models.length > 0) {
      discoveredModelsCache.gemini = models;
      console.log(`[boot] discovered ${models.length} Gemini models (primary: ${models[0]})`);
    }
  } catch (err) {
    console.warn("[boot] model discovery skipped:", err);
  }
}
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    hasEnvKey: Boolean(process.env.GEMINI_API_KEY),
    architecture: "TOC index -> chapter routing -> physical slice -> native PDF or page images -> stream"
  });
});
function decodeOriginalFileName(rawName) {
  if (!rawName) return "";
  if (/[\u4e00-\u9fa5]/.test(rawName)) return rawName;
  try {
    const converted = Buffer.from(rawName, "latin1").toString("utf8");
    if (converted && !converted.includes("\uFFFD") && /[\u4e00-\u9fa5]/.test(converted)) return converted;
  } catch {
  }
  return rawName;
}
function newBookId() {
  return `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function describeIngest(meta) {
  const scale = `\u5171 ${meta.pageCount} \u9875\uFF0C${meta.toc.length} \u6761\u5927\u7EB2`;
  switch (meta.tocSource) {
    case "vision":
      return `\u2705 \u6559\u6750\u300A${meta.name}\u300B\u65E0\u7535\u5B50\u4E66\u7B7E\uFF0C\u5DF2\u7531\u591A\u6A21\u6001\u6A21\u578B\u89C6\u89C9\u8BC6\u522B\u5370\u5237\u76EE\u5F55\u5E76\u6C38\u4E45\u7F13\u5B58\uFF08${scale}\uFF09`;
    case "synthesized":
      return `\u26A0\uFE0F \u6559\u6750\u300A${meta.name}\u300B\u65E2\u65E0\u7535\u5B50\u4E66\u7B7E\uFF0C\u4E5F\u672A\u80FD\u8BC6\u522B\u51FA\u5370\u5237\u76EE\u5F55\uFF0C\u5DF2\u6309\u6BCF 30 \u9875\u5212\u5206\u4E3A\u903B\u8F91\u5757\u4EE5\u4FDD\u8BC1\u53EF\u7528\uFF08${scale}\uFF09`;
    default:
      return `\u2705 \u6559\u6750\u300A${meta.name}\u300B\u5DF2\u5B8C\u6210\u672C\u5730\u76EE\u5F55\u7D22\u5F15\uFF08${scale}\uFF0C\u672A\u6D88\u8017\u4EFB\u4F55 Token\uFF09`;
  }
}
function visionContextFromRequest(body) {
  const providerId = normalizeProviderId(body?.provider);
  const provider = getProvider(providerId);
  const apiKey = String(
    body?.apiKey || (providerId === "gemini" ? process.env.GEMINI_API_KEY : "") || ""
  ).trim();
  if (!apiKey) return null;
  const model = resolveDynamicModel(body?.model, providerId);
  if (!model) return null;
  return {
    provider,
    model,
    credentials: { apiKey, baseUrl: String(body?.baseUrl || DEFAULT_OPENAI_BASE_URL).trim() }
  };
}
async function handleBookUpload(req, res) {
  if (!req.file?.buffer) {
    res.status(400).json({ success: false, error: "\u672A\u63A5\u6536\u5230\u4E0A\u4F20\u7684 PDF \u6559\u6750\u6587\u4EF6\u6570\u636E\u3002" });
    return;
  }
  const { uploadId, chunkIndex, totalChunks, fileName, fileSize, clientFileName } = req.body || {};
  const rawFileName = clientFileName || fileName || req.file.originalname || "textbook.pdf";
  const safeName = decodeOriginalFileName(rawFileName);
  const vision = visionContextFromRequest(req.body);
  if (uploadId && chunkIndex !== void 0 && totalChunks) {
    const index = parseInt(chunkIndex, 10);
    const total = parseInt(totalChunks, 10);
    const sessionDir = path3.join(CHUNKS_DIR, String(uploadId).replace(/[^a-zA-Z0-9_-]/g, ""));
    if (!fs5.existsSync(sessionDir)) fs5.mkdirSync(sessionDir, { recursive: true });
    fs5.writeFileSync(path3.join(sessionDir, `part_${index}`), req.file.buffer);
    if (index < total - 1) {
      res.json({ success: true, completed: false, chunkIndex: index, totalChunks: total, uploadId });
      return;
    }
    const bookId2 = newBookId();
    const finalPath = getBookPath(bookId2);
    try {
      const destStream = fs5.createWriteStream(finalPath);
      for (let i = 0; i < total; i++) {
        const partFile = path3.join(sessionDir, `part_${i}`);
        if (!fs5.existsSync(partFile)) throw new Error(`\u5206\u5757\u4E22\u5931 (\u7F3A\u5C11\u7B2C ${i + 1} \u5757)\uFF0C\u8BF7\u91CD\u8BD5\u4E0A\u4F20\u3002`);
        destStream.write(fs5.readFileSync(partFile));
      }
      destStream.end();
      await new Promise((resolve, reject) => {
        destStream.on("finish", () => resolve());
        destStream.on("error", reject);
      });
      try {
        fs5.rmSync(sessionDir, { recursive: true, force: true });
      } catch {
      }
      const meta = await ingestBook(finalPath, safeName, fs5.statSync(finalPath).size, bookId2, vision);
      saveBookMetadata(meta);
      res.json({ success: true, completed: true, book: { ...meta, status: "ready" }, message: describeIngest(meta) });
    } catch (err) {
      console.error("[upload] chunked assembly failed:", err);
      try {
        if (fs5.existsSync(finalPath)) fs5.unlinkSync(finalPath);
        fs5.rmSync(sessionDir, { recursive: true, force: true });
      } catch {
      }
      res.status(500).json({ success: false, error: `\u6559\u6750\u7EC4\u88C5\u4E0E\u5927\u7EB2\u89E3\u6790\u5931\u8D25: ${err?.message || String(err)}` });
    }
    return;
  }
  const bookId = newBookId();
  const savedPath = getBookPath(bookId);
  try {
    fs5.writeFileSync(savedPath, req.file.buffer);
    const meta = await ingestBook(savedPath, safeName, req.file.size, bookId, vision);
    saveBookMetadata(meta);
    res.json({ success: true, completed: true, book: { ...meta, status: "ready" }, message: describeIngest(meta) });
  } catch (err) {
    console.error("[upload] indexing failed:", err);
    try {
      if (fs5.existsSync(savedPath)) fs5.unlinkSync(savedPath);
    } catch {
    }
    res.status(500).json({ success: false, error: `PDF \u89E3\u6790\u4E0E\u5927\u7EB2\u63D0\u53D6\u5931\u8D25: ${err?.message || String(err)}` });
  }
}
app.post("/api/books/upload", upload.single("file"), handleBookUpload);
app.post("/api/books/upload-chunk", upload.single("file"), handleBookUpload);
app.get("/api/books", async (req, res) => {
  try {
    const books = [];
    for (const file of listBookIndexFiles()) {
      const bookId = file.replace(/_toc\.json$/, "");
      let meta = readBookMetadata(bookId);
      if (!meta) continue;
      const pdfPath = getBookPath(meta.id);
      if (!fs5.existsSync(pdfPath)) continue;
      meta.name = decodeOriginalFileName(meta.name);
      if (!meta.tocSource) {
        console.log(`[books] re-indexing legacy TOC for ${meta.id}`);
        meta = await ingestBook(pdfPath, meta.name, fs5.statSync(pdfPath).size, meta.id);
        saveBookMetadata(meta);
      }
      books.push(meta);
    }
    res.json({ success: true, books });
  } catch (err) {
    console.warn("[books] listing failed:", err);
    res.json({ success: true, books: [] });
  }
});
app.delete("/api/books/:id", (req, res) => {
  try {
    deleteBook(req.params.id);
    res.json({ success: true, deletedId: req.params.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.message || "\u5220\u9664\u5931\u8D25" });
  }
});
app.post("/api/models/discover", async (req, res) => {
  const provider = normalizeProviderId(req.body?.provider);
  const { apiKey: customKey, baseUrl: customBaseUrl } = req.body || {};
  try {
    let models;
    if (provider === "gemini") {
      const key = String(customKey || req.headers["x-gemini-api-key"] || process.env.GEMINI_API_KEY || "").trim();
      if (!key) {
        res.status(400).json({
          success: false,
          provider,
          error: "\u672A\u63D0\u4F9B Google Gemini API Key\uFF0C\u4E14\u7CFB\u7EDF\u73AF\u5883\u53D8\u91CF\u4E2D\u672A\u68C0\u6D4B\u5230 GEMINI_API_KEY\u3002"
        });
        return;
      }
      models = await discoverGeminiModels(key);
    } else {
      models = await discoverOpenAiModels(
        String(customKey || "").trim(),
        String(customBaseUrl || DEFAULT_OPENAI_BASE_URL).trim()
      );
    }
    if (models.length > 0) discoveredModelsCache[provider] = models;
    res.json({
      success: true,
      provider,
      models,
      message: `\u6210\u529F\u62C9\u53D6\u5230 ${models.length} \u4E2A\u53EF\u7528\u6A21\u578B\uFF01`
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      provider,
      error: `\u8FDE\u63A5\u6A21\u578B\u670D\u52A1\u5931\u8D25: ${err?.message || String(err)}`
    });
  }
});
function loadMountedBooks(bookIds, books) {
  const ids = [];
  if (Array.isArray(bookIds)) {
    for (const id of bookIds) if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  if (Array.isArray(books)) {
    for (const entry of books) {
      const id = typeof entry === "string" ? entry : entry?.id;
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids.map((id) => readBookMetadata(id)).filter((m) => m !== null);
}
app.post("/api/chat", async (req, res) => {
  const { prompt, history = [], bookIds = [], books = [], model, customApiKey, baseUrl } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "\u63D0\u95EE\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A\u3002" });
    return;
  }
  const providerId = normalizeProviderId(req.body?.provider);
  const provider = getProvider(providerId);
  const channel = new SseChannel(res);
  const startTime = Date.now();
  try {
    const credentials = {
      apiKey: String(customApiKey || req.headers["x-gemini-api-key"] || process.env.GEMINI_API_KEY || "").trim(),
      baseUrl: String(baseUrl || DEFAULT_OPENAI_BASE_URL).trim()
    };
    if (!credentials.apiKey) {
      channel.fail({
        code: "auth",
        message: providerId === "gemini" ? "\u7F3A\u5C11 Google Gemini API Key\u3002" : "\u7F3A\u5C11 OpenAI / Claude \u591A\u6A21\u6001\u517C\u5BB9\u534F\u8BAE API Key\u3002",
        hint: "\u8BF7\u5728\u5DE6\u4FA7\u914D\u7F6E\u9762\u677F\u586B\u5199\u6709\u6548\u7684 API Key \u540E\u91CD\u8BD5\u3002"
      });
      return;
    }
    const answerModel = resolveDynamicModel(model, providerId);
    if (!answerModel) {
      channel.fail({
        code: "not_found",
        message: "\u5C1A\u672A\u9009\u62E9\u53EF\u7528\u7684\u6A21\u578B\u3002",
        hint: "\u8BF7\u70B9\u51FB\u5DE6\u4FA7\u300C\u5237\u65B0\u63A2\u6D4B\u300D\u62C9\u53D6\u6A21\u578B\u5217\u8868\uFF0C\u5E76\u5728\u4E0B\u62C9\u6846\u4E2D\u9009\u62E9\u4E00\u4E2A\u6A21\u578B\u3002"
      });
      return;
    }
    let mounted = loadMountedBooks(bookIds, books);
    if (mounted.some(needsDeferredVision)) {
      mounted = await Promise.all(
        mounted.map(
          (book) => needsDeferredVision(book) ? recoverOutlineWithVision({ book, provider, model: answerModel, credentials, channel }) : book
        )
      );
    }
    let decision = null;
    if (mounted.length > 0) {
      channel.stage("\u6B63\u5728\u67E5\u9605\u6559\u6750\u76EE\u5F55\uFF0C\u5B9A\u4F4D\u76F8\u5173\u7AE0\u8282\u2026");
      decision = await routeQuestion({
        prompt,
        books: mounted,
        provider,
        routingModel: pickRoutingModel(discoveredModelsCache[providerId], answerModel),
        credentials,
        channel
      });
    }
    let excerpt = null;
    const routedBook = decision ? mounted.find((b) => b.id === decision.bookId) : void 0;
    if (decision && routedBook) {
      channel.stage(
        provider.excerptFormat === "pdf" ? "\u6B63\u5728\u7269\u7406\u5207\u53D6\u76EE\u6807\u7AE0\u8282\u2026" : "\u6B63\u5728\u7269\u7406\u5207\u53D6\u76EE\u6807\u7AE0\u8282\u5E76\u6E32\u67D3\u4E3A\u9AD8\u7CBE\u5EA6\u9875\u9762\u5F71\u50CF\u2026"
      );
      try {
        excerpt = await prepareExcerpt(decision, routedBook, provider);
      } catch (err) {
        console.warn("[chat] slicing failed, answering without textbook context:", err);
        channel.notice("warn", "\u6559\u6750\u5207\u7247\u5931\u8D25\uFF0C\u672C\u8F6E\u5C06\u4EE5\u901A\u8BC6\u63A8\u5BFC\u4F5C\u7B54\u3002");
      }
      if (excerpt) {
        const prefix = decision.source === "keyword" ? "\u{1F4D6} \u5DF2\u6309\u76EE\u5F55\u5173\u952E\u8BCD\u5B9A\u4F4D" : "\u{1F4D6} \u667A\u80FD\u56FE\u4E66\u7BA1\u7406\u5458\u5DF2\u67E5\u9605\u76EE\u5F55\u5E76\u9501\u5B9A";
        channel.send({
          routing: {
            ...decision,
            matched: true,
            startPage: excerpt.pageRange[0],
            endPage: excerpt.pageRange[1],
            contextTokens: excerpt.estimatedTokens,
            payload: provider.excerptFormat,
            label: `${prefix}\uFF1A\u300A${decision.bookName}\u300B${decision.chapterTitle} (P${excerpt.pageRange[0]} - P${excerpt.pageRange[1]})`
          }
        });
      }
    } else if (mounted.length > 0) {
      channel.notice("info", "\u672A\u80FD\u5728\u5DF2\u6302\u8F7D\u6559\u6750\u4E2D\u5B9A\u4F4D\u5230\u5BF9\u5E94\u7AE0\u8282\uFF0C\u672C\u8F6E\u4EE5\u901A\u8BC6\u63A8\u5BFC\u4F5C\u7B54\u3002");
    }
    channel.stage("\u6B63\u5728\u7B49\u5F85\u6A21\u578B\u63A8\u6F14\u2026");
    await streamAnswer({
      provider,
      model: answerModel,
      credentials,
      systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
      prompt,
      history,
      excerpt,
      channel
    });
    channel.end({
      done: true,
      responseTimeMs: Date.now() - startTime,
      contextTokens: excerpt?.estimatedTokens ?? 0,
      pageRange: excerpt?.pageRange ?? null
    });
  } catch (err) {
    console.error("[chat] unhandled failure:", err);
    channel.fail(classifyThrownFailure(err));
  }
});
var LATEX_INSTALL_GUIDE = "sudo apt update && sudo apt install -y texlive-xetex texlive-lang-chinese texlive-latex-extra";
function detectXelatex() {
  try {
    const which = spawnSync("which", ["xelatex"], { encoding: "utf-8" });
    if (which.status !== 0 || !which.stdout.trim()) return { installed: false, version: null };
    const versionRes = spawnSync("xelatex", ["--version"], { encoding: "utf-8" });
    return { installed: true, version: versionRes.stdout.split("\n")[0] || "XeLaTeX" };
  } catch {
    return { installed: false, version: null };
  }
}
app.get("/api/latex/status", (req, res) => {
  const { installed, version } = detectXelatex();
  res.json({ installed, engine: "xelatex", version, installGuide: LATEX_INSTALL_GUIDE });
});
app.post("/api/latex/compile", (req, res) => {
  const code = req.body?.latexCode || req.body?.code;
  if (!code || typeof code !== "string") {
    res.status(400).json({ success: false, error: "\u7F3A\u5C11 LaTeX \u6E90\u7801\u5185\u5BB9\u3002" });
    return;
  }
  if (!detectXelatex().installed) {
    res.json({
      success: false,
      installed: false,
      error: "\u7CFB\u7EDF\u5C1A\u672A\u5B89\u88C5 XeLaTeX \u7F16\u8BD1\u5F15\u64CE\u3002",
      log: `\u3010\u73AF\u5883\u81EA\u6108\u63D0\u793A\u3011
\u672A\u68C0\u6D4B\u5230\u7CFB\u7EDF xelatex \u53EF\u6267\u884C\u7A0B\u5E8F\u3002
\u5982\u9700\u5728 Ubuntu \u7EC8\u7AEF\u542F\u7528\u539F\u751F\u7F16\u8BD1\uFF0C\u8BF7\u8FD0\u884C\uFF1A
${LATEX_INSTALL_GUIDE}

\u5F53\u524D\u5DE5\u4F5C\u53F0\u5DF2\u81EA\u52A8\u542F\u7528\u9AD8\u4FDD\u771F\u77E2\u91CF\u5F15\u64CE\u751F\u6210\u6392\u7248\u9884\u89C8\uFF0C\u60A8\u4EA6\u53EF\u968F\u65F6\u4E0B\u8F7D .tex \u6E90\u7801\u6216 PDF \u6587\u6863\u3002`
    });
    return;
  }
  const tempDir = fs5.mkdtempSync(path3.join(os.tmpdir(), "latex-compile-"));
  const pdfPath = path3.join(tempDir, "document.pdf");
  const logPath = path3.join(tempDir, "document.log");
  try {
    fs5.writeFileSync(path3.join(tempDir, "document.tex"), code, "utf-8");
    const compileResult = spawnSync("xelatex", ["-interaction=nonstopmode", "-halt-on-error", "document.tex"], {
      cwd: tempDir,
      timeout: 3e4,
      encoding: "utf-8"
    });
    const logContent = fs5.existsSync(logPath) ? fs5.readFileSync(logPath, "utf-8") : `${compileResult.stdout || ""}
${compileResult.stderr || ""}`;
    if (fs5.existsSync(pdfPath)) {
      res.json({
        success: true,
        installed: true,
        pdfBase64: fs5.readFileSync(pdfPath).toString("base64"),
        log: logContent.slice(0, 1e4),
        message: "\u26A1 XeLaTeX \u7F16\u8BD1\u6210\u529F\uFF01"
      });
      return;
    }
    const errorLines = logContent.split("\n").filter((line) => line.startsWith("!") || line.includes("Error:")).slice(0, 5);
    res.json({
      success: false,
      installed: true,
      error: errorLines[0] || "LaTeX \u6E90\u7801\u5B58\u5728\u8BED\u6CD5\u9519\u8BEF\uFF0C\u8BF7\u53C2\u8003\u7F16\u8BD1\u65E5\u5FD7\u8C03\u6574\u3002",
      log: logContent.slice(-8e3)
    });
  } catch (err) {
    res.json({ success: false, installed: true, error: err?.message || "\u7F16\u8BD1\u5B50\u8FDB\u7A0B\u53D1\u751F\u5F02\u5E38", log: String(err) });
  } finally {
    try {
      fs5.rmSync(tempDir, { recursive: true, force: true });
    } catch {
    }
  }
});
app.use((err, req, res, next) => {
  console.error("[express]", err);
  if (err instanceof multer.MulterError) {
    res.status(400).json({ success: false, error: `\u6587\u4EF6\u4E0A\u4F20\u9519\u8BEF (${err.code}): ${err.message}` });
    return;
  }
  if (err) {
    res.status(500).json({ success: false, error: err?.message || "\u670D\u52A1\u5668\u5185\u90E8\u5F02\u5E38" });
    return;
  }
  next();
});
async function startServer() {
  await autoDiscoverModelsOnBoot();
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path3.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => res.sendFile(path3.join(distPath, "index.html")));
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}
startServer();
//# sourceMappingURL=server.mjs.map
