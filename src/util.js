import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : canonical(value)).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function clip(text, limit = 16000) {
  text = String(text);
  return text.length <= limit ? text : `${text.slice(0, limit)}\n<truncated omitted_chars="${text.length - limit}" />`;
}
export class Paused extends Error {
  constructor(message, status = 'waiting_approval') { super(message); this.status = status; }
}
export class ModelError extends Error {
  constructor(message, { retryable = false, retryAfterMs = 0, code = 'model_error', businessCode, httpStatus, requestId } = {}) {
    super(message); Object.assign(this, { retryable, retryAfterMs, code, businessCode, httpStatus, requestId });
  }
}
export function cancelled(signal) { signal?.throwIfAborted(); }
export async function underSignal(operation, signal) {
  cancelled(signal);
  if (!signal) return operation();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    return await Promise.race([aborted, Promise.resolve().then(operation)]);
  } finally { signal.removeEventListener('abort', abort); }
}
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    cancelled(signal);
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { done(); reject(signal.reason); };
    const timer = setTimeout(() => { done(); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function reviewFailure(error) {
  const redact = value => String(value)
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|authorization|token|password|secret)[\s"']*[:=][\s"']*)[^\s"',;}]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[endpoint]').split('\n')[0];
  const message = redact(error?.message ?? 'Automatic review unavailable').slice(0,2000);
  return { code: redact(error?.code ?? 'review_error').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80), message,
    ...(error?.businessCode ? { businessCode: redact(error.businessCode).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0,80) } : {}),
    ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}),
    ...(error?.requestId ? { requestId: redact(error.requestId).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0,160) } : {}),
    ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: Math.min(90000,Math.max(0,Math.floor(error.retryAfterMs))) } : {}),
    retryable: error?.retryable === true }; 
}
