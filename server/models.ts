/**
 * Ranking for the model picker and the cheap routing hop.
 *
 * The lists coming back from Gemini and from OpenAI-compatible relays mix reading
 * models with TTS, image generators and review bots. The first entry is what the
 * UI and the router will use, so unusable names have to sink.
 */

export function rankModels(models: string[], scorer: (lowered: string) => number): string[] {
  return [...models].sort((a, b) => scorer(b.toLowerCase()) - scorer(a.toLowerCase()));
}

const TEXT_ONLY_HINTS = [
  'deepseek-chat',
  'deepseek-reasoner',
  'embedding',
  'rerank',
  'tts',
  'whisper',
  'moderation',
];

const NON_READING_HINTS = [
  ...TEXT_ONLY_HINTS,
  'dall-e',
  'dall_e',
  'imagen',
  'image-preview',
  'robotic',
  'auto-review',
  'codex-spark',
  'codex-auto',
  'wanx',
  'qwen-audio',
  'cosyvoice',
  'paraformer',
];

const VISION_HINTS = [
  '4o',
  '4.1',
  'o4',
  'vision',
  'sonnet',
  'opus',
  'haiku',
  'vl',
  'omni',
  'gpt-5',
  'gpt-4',
  'gemini',
];

export function isUnusableReadingModel(name: string): boolean {
  const lowered = name.toLowerCase();
  if (NON_READING_HINTS.some((hint) => lowered.includes(hint))) return true;
  // Text-only Qwen SKUs cannot see textbook pages. Names with `vl` are vision;
  // Qwen3.7 / 3.8 Plus on QwenCloud are multimodal even without `vl` in the id.
  if (lowered.includes('qwen') && !lowered.includes('vl') && !/qwen3\.[78]/.test(lowered)) return true;
  if (lowered.includes('qwq')) return true;
  return false;
}

/** Retired for new Gemini keys; keep it in the list but never pick it first. */
export function isRetiredGeminiFlash(name: string): boolean {
  return /gemini-2\.5-flash$/.test(name.toLowerCase());
}

export function scoreGeminiModel(lowered: string): number {
  if (/(tts|embed|image|robotic)/.test(lowered)) return 0;
  if (lowered.includes('flash')) {
    if (lowered.includes('3.8') || lowered.includes('latest')) return 130;
    if (lowered.includes('3.')) return 120;
    if (lowered.includes('2.5') || lowered.includes('1.5')) return 70;
    return 100;
  }
  if (lowered.includes('pro')) return 80;
  return 40;
}

/** XBCL currently returns 502 for this SKU even though /models still lists it. */
export function isFragileRelayModel(name: string): boolean {
  return /gpt-5\.4-mini/i.test(name);
}

export function scoreOpenAiCompatibleModel(lowered: string): number {
  if (isUnusableReadingModel(lowered) || isFragileRelayModel(lowered)) return 0;
  const vision = VISION_HINTS.some((hint) => lowered.includes(hint));
  if (!vision) return 25;
  if (lowered.includes('compact')) return 80;
  if (/(mini|flash|lite|haiku)/.test(lowered)) return 70;
  if (/gpt-5\.6|gpt-5\.5|gpt-4o/.test(lowered)) return 130;
  return 100;
}

/** DashScope lists text Qwen next to VL; VL-Max / Qwen3-VL / Qwen3.7 must win. */
export function scoreQwenModel(lowered: string): number {
  if (isUnusableReadingModel(lowered)) return 0;
  if (/qwen3\.[78].*(plus|max)/.test(lowered)) return 145;
  if (!lowered.includes('vl') && !/qwen3\.[78]/.test(lowered)) return 10;
  if (/qwen-vl-max|qwen3-vl-plus|qwen2\.5-vl/.test(lowered)) return 140;
  if (lowered.includes('ocr')) return 90;
  if (/(flash|plus|mini|lite)/.test(lowered)) return 110;
  return 120;
}

export function pickPreferredModel(models: string[]): string {
  return (
    models.find(
      (name) =>
        !isUnusableReadingModel(name) && !isRetiredGeminiFlash(name) && !isFragileRelayModel(name)
    ) ||
    models.find((name) => !isUnusableReadingModel(name)) ||
    models[0] ||
    ''
  );
}
