export type LlmErrorCode =
  | 'timeout'
  | 'network'
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'context_overflow'
  | 'upstream'
  | 'bad_request'
  | 'unknown';

export interface LlmFailure {
  code: LlmErrorCode;
  /** User-facing Chinese description of what went wrong. */
  message: string;
  /** User-facing Chinese suggestion for what to do next. */
  hint?: string;
}

/** Lets providers abort with an already-classified, user-presentable failure. */
export class LlmFailureError extends Error {
  readonly failure: LlmFailure;

  constructor(failure: LlmFailure) {
    super(failure.message);
    this.name = 'LlmFailureError';
    this.failure = failure;
  }
}

const HTTP_FAILURES: Record<number, LlmFailure> = {
  400: {
    code: 'bad_request',
    message: '模型服务判定请求格式不合法（HTTP 400）。',
    hint: '常见原因是所选模型不支持当前参数，请在左侧切换其他模型后重试。',
  },
  401: {
    code: 'auth',
    message: 'API Key 未通过校验（HTTP 401）。',
    hint: '请在左侧配置面板确认 API Key 是否填写完整、是否已过期。',
  },
  403: {
    code: 'auth',
    message: 'API Key 无权访问该模型或该地区受限（HTTP 403）。',
    hint: '请确认密钥已开通对应模型权限，或更换可用的 Base URL。',
  },
  404: {
    code: 'not_found',
    message: '模型名称或 Base URL 不存在（HTTP 404）。',
    hint: '请点击左侧「刷新探测」重新拉取可用模型列表。',
  },
  429: {
    code: 'rate_limit',
    message: '请求过于频繁或余额/配额已耗尽（HTTP 429）。',
    hint: '请稍候片刻再试，或检查账户配额与账单状态。',
  },
  500: { code: 'upstream', message: '模型服务内部错误（HTTP 500）。', hint: '这是服务商侧的临时故障，请稍后重试。' },
  502: { code: 'upstream', message: '模型服务网关异常（HTTP 502）。', hint: '这是服务商侧的临时故障，请稍后重试。' },
  503: { code: 'upstream', message: '模型服务暂不可用（HTTP 503）。', hint: '服务商可能正在限流或维护，请稍后重试。' },
  504: { code: 'upstream', message: '模型服务网关超时（HTTP 504）。', hint: '长篇推导容易触发网关超时，请重试或改用更快的模型。' },
};

const CONTEXT_OVERFLOW_HINTS = [
  'context length',
  'context_length',
  'maximum context',
  'too many tokens',
  'token limit',
  'request too large',
  'exceeds the maximum',
  'input is too long',
];

const CONTEXT_OVERFLOW: LlmFailure = {
  code: 'context_overflow',
  message: '本轮上下文超出该模型的最大长度限制。',
  hint: '请缩小提问范围、开启新对话，或改用上下文窗口更大的模型。',
};

function extractProviderMessage(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message || parsed?.message || parsed?.error;
    if (typeof msg === 'string') return msg.slice(0, 200);
  } catch {}
  return body.slice(0, 200).replace(/\s+/g, ' ').trim();
}

/** Maps an HTTP status plus provider error body onto a Chinese-facing failure. */
export function classifyHttpFailure(status: number, body: string): LlmFailure {
  const lowered = (body || '').toLowerCase();
  if (CONTEXT_OVERFLOW_HINTS.some((needle) => lowered.includes(needle))) return CONTEXT_OVERFLOW;

  const mapped = HTTP_FAILURES[status];
  if (mapped) {
    const detail = extractProviderMessage(body);
    return detail ? { ...mapped, message: `${mapped.message} 服务商提示：${detail}` } : mapped;
  }

  return {
    code: 'upstream',
    message: `模型服务返回异常状态码 HTTP ${status}。`,
    hint: extractProviderMessage(body) || '请稍后重试或更换模型。',
  };
}

/** Maps a thrown exception (network layer, SDK, abort) onto a Chinese-facing failure. */
export function classifyThrownFailure(err: any): LlmFailure {
  if (err instanceof LlmFailureError) return err.failure;

  const name = String(err?.name || '');
  const raw = String(err?.message || err || '');
  const lowered = raw.toLowerCase();

  if (name === 'AbortError' || lowered.includes('aborted') || lowered.includes('timeout')) {
    return {
      code: 'timeout',
      message: '等待模型响应超时，连接已被主动中断。',
      hint: '模型前置思考时间过长或网络不稳定，请重试，或改用响应更快的模型。',
    };
  }

  if (CONTEXT_OVERFLOW_HINTS.some((needle) => lowered.includes(needle))) return CONTEXT_OVERFLOW;

  const status = Number(err?.status || err?.code);
  if (!Number.isNaN(status) && HTTP_FAILURES[status]) return HTTP_FAILURES[status];

  if (
    lowered.includes('fetch failed') ||
    lowered.includes('econnreset') ||
    lowered.includes('econnrefused') ||
    lowered.includes('enotfound') ||
    lowered.includes('etimedout') ||
    lowered.includes('socket hang up') ||
    lowered.includes('network')
  ) {
    return {
      code: 'network',
      message: '无法连接到模型服务，网络链路中断。',
      hint: '请检查本机网络、代理设置，以及 Base URL 是否可达。',
    };
  }

  if (lowered.includes('api key') || lowered.includes('unauthenticated') || lowered.includes('permission')) {
    return {
      code: 'auth',
      message: 'API Key 校验失败或权限不足。',
      hint: '请在左侧配置面板重新填写有效的 API Key。',
    };
  }

  return {
    code: 'unknown',
    message: `调用模型服务时发生异常：${raw.slice(0, 200) || '未知错误'}`,
    hint: '请重试；若持续失败请检查模型选择与网络环境。',
  };
}

const RETRYABLE_CODES: LlmErrorCode[] = ['timeout', 'network', 'rate_limit', 'upstream'];

export function isRetryable(failure: LlmFailure): boolean {
  return RETRYABLE_CODES.includes(failure.code);
}
