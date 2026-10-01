import net from 'node:net';
import { ModelError, cancelled } from './util.js';

const MAX_FRAME = 2 * 1024 * 1024;
export class DesktopBridgeClient {
  constructor(env = process.env) {
    this.socket = env.ZCODE_APPROVAL_BRIDGE_SOCKET;
    this.token = env.ZCODE_APPROVAL_BRIDGE_TOKEN;
    if (env.ZCODE_APPROVAL_BRIDGE_VERSION !== '1' || !this.socket || !this.token) {
      throw new ModelError('This desktop has no compatible approval bridge', { code: 'bridge_unavailable' });
    }
  }
  async rpc(method, params, { signal, deadline = Date.now() + 90000 } = {}) {
    cancelled(signal);
    const time = deadline - Date.now();
    if (time <= 0) throw new ModelError('Desktop review deadline expired', { code: 'timeout' });
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const socket = net.createConnection(this.socket);
      let buffer = '', done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        socket.destroy();
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(signal.reason ?? new Error('Cancelled'));
      const timer = setTimeout(() => finish(new ModelError('Desktop bridge timed out', { code: 'timeout' })), time);
      signal?.addEventListener('abort', abort, { once: true });
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify({ id, token: this.token, method, params }) + '\n'));
      socket.on('error', () => finish(new ModelError('Desktop bridge disconnected', { code: 'bridge_disconnected' })));
      socket.on('close', () => finish(new ModelError('Desktop bridge closed before replying', { code: 'bridge_disconnected' })));
      socket.on('data', data => {
        buffer += data;
        if (Buffer.byteLength(buffer) > MAX_FRAME) return finish(new ModelError('Desktop bridge reply too large', { code: 'input_budget' }));
        if (!buffer.includes('\n')) return;
        try {
          const reply = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
          if (reply.id !== id) throw new Error('Mismatched bridge response');
          if (reply.error) return finish(new ModelError(reply.error.message, { code: reply.error.code, retryable: reply.error.retryable === true }));
          finish(null, reply.result);
        } catch { finish(new ModelError('Invalid desktop bridge reply', { code: 'bridge_protocol' })); }
      });
    });
  }
  context(options) { return this.rpc('context/read', {}, options); }
}

export class DesktopModelClient {
  constructor(bridge, context, budget = { attempts: 0 }) {
    this.bridge = bridge;
    this.context = context;
    this.budget = budget;
    this.config = { model: context.modelSnapshot.modelId };
  }
  complete(messages, { tools, deadline, signal }) {
    if (messages.length === 2 && ++this.budget.attempts > 3) {
      throw new ModelError('Automatic review exhausted its three attempts', { code: 'attempt_budget' });
    }
    return this.bridge.rpc('model/complete', { bindingId: this.context.bindingId, messages, tools }, { deadline, signal });
  }
}
