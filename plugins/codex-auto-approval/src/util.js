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
  constructor(message, { retryable = false, retryAfterMs = 0, code = 'model_error' } = {}) {
    super(message); Object.assign(this, { retryable, retryAfterMs, code });
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
