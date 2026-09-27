/**
 * Live provider eval. Reads keys from the environment only; never prints them.
 */
import dotenv from 'dotenv';
import { pickPreferredModel } from '../server/models';

dotenv.config();

type Event = Record<string, any>;

async function consumeSse(res: Response): Promise<Event[]> {
  const text = await res.text();
  const events: Event[] = [];
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

function summarize(events: Event[]) {
  const routing = events.find((e) => e.routing)?.routing;
  const errEvent = events.find((e) => e.error);
  const text = events.map((e) => e.text || '').join('');
  const done = events.find((e) => e.done);
  const notices = events.filter((e) => e.notice).map((e) => e.notice);
  return {
    routing: routing
      ? {
          source: routing.source,
          book: routing.bookName,
          chapter: routing.chapterTitle,
          pages: `${routing.startPage}-${routing.endPage}`,
          payload: routing.payload,
          tokens: routing.contextTokens,
        }
      : null,
    notices,
    error: errEvent
      ? { code: errEvent.errorCode, message: errEvent.error, hint: errEvent.hint }
      : null,
    chars: text.length,
    excerpt: text.replace(/\s+/g, ' ').slice(0, 280),
    ms: done?.responseTimeMs ?? null,
    hasExamTail: /考点|易错点|考前复习/.test(text),
  };
}

async function discover(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/models/discover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, ok: res.ok, models: json.models || [], error: json.error };
}

async function chat(base: string, body: Record<string, unknown>) {
  const started = Date.now();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const events = await consumeSse(res);
  return { http: res.status, wallMs: Date.now() - started, ...summarize(events) };
}

async function main() {
  const base = process.env.SUITE_BASE || 'http://127.0.0.1:3000';
  const geminiKey = process.env.GEMINI_API_KEY || '';
  const openaiKey = process.env.OPENAI_API_KEY || '';
  const openaiBase = process.env.OPENAI_BASE_URL || 'https://xbcl.link/v1';

  const only = (process.env.ONLY_PROVIDER || '').trim();
  const report: Record<string, unknown> = {
    geminiKeyPresent: Boolean(geminiKey),
    openaiKeyPresent: Boolean(openaiKey),
  };

  const geminiDisc = only === 'openai'
    ? { ok: false, models: [] as string[], error: null }
    : await discover(base, { provider: 'gemini', apiKey: geminiKey });
  if (only !== 'openai') {
    report.geminiDiscover = {
      ok: geminiDisc.ok,
      count: geminiDisc.models.length,
      top: geminiDisc.models.slice(0, 8),
      error: geminiDisc.error || null,
    };
  }

  const openaiDisc = await discover(base, {
    provider: 'openai_compatible',
    apiKey: openaiKey,
    baseUrl: openaiBase,
  });
  report.openaiDiscover = {
    ok: openaiDisc.ok,
    count: openaiDisc.models.length,
    top: openaiDisc.models.slice(0, 8),
    error: openaiDisc.error || null,
  };

  const geminiModel = process.env.LIVE_GEMINI_MODEL || pickPreferredModel(geminiDisc.models);
  const openaiModel = process.env.LIVE_OPENAI_MODEL || pickPreferredModel(openaiDisc.models);

  const cases = [
    {
      id: 'landau-action',
      bookIds: ['book-1790397737839-dozocr'],
      prompt: '请根据教材说明最小作用量原理如何导出拉格朗日方程，并注明页码。',
    },
    {
      id: 'complex-cr',
      bookIds: ['book-1790397724705-7e4lih'],
      prompt: '柯西-黎曼方程是什么，它和解析性有何关系？请结合教材页码说明。',
    },
  ];

  report.chats = [];
  if (geminiModel && only !== 'openai') {
    const one = cases[0];
    (report.chats as any[]).push({
      provider: 'gemini',
      model: geminiModel,
      case: one.id,
      ...(await chat(base, {
        provider: 'gemini',
        customApiKey: geminiKey,
        model: geminiModel,
        prompt: one.prompt,
        bookIds: one.bookIds,
      })),
    });
  }

  if (openaiModel) {
    const one = cases[1];
    (report.chats as any[]).push({
      provider: 'openai_compatible',
      model: openaiModel,
      case: one.id,
      ...(await chat(base, {
        provider: 'openai_compatible',
        customApiKey: openaiKey,
        baseUrl: openaiBase,
        model: openaiModel,
        prompt: one.prompt,
        bookIds: one.bookIds,
      })),
    });
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
