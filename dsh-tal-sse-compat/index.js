// No credentials, request bodies, or response text are logged or persisted.
const TARGET = 'ai-service.tal.com';
const PATH = '/token-plan/v1/messages';
const SLOT = Symbol.for('local.dsh.tal-sse-compat.v1');
const MAX_TAIL = 8192;
export const name = 'tal-sse-compat';

function isTarget(input, init) {
  try {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    return ['http:', 'https:'].includes(url.protocol) && url.hostname === TARGET
      && url.port === '' && url.pathname === PATH && method.toUpperCase() === 'POST';
  } catch { return false; }
}

// Accept only a complete, explicit terminal event missing its SSE delimiter.
// Never synthesize message_stop or repair truncated JSON / transport errors.
function needsDelimiter(tail, total) {
  const normalized = tail.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const boundary = normalized.lastIndexOf('\n\n');
  if (boundary < 0 && total > MAX_TAIL) return false;
  const pending = normalized.slice(boundary < 0 ? 0 : boundary + 2);
  if (!pending.trim()) return false;
  let event;
  const data = [];
  for (const line of pending.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) return false;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field !== 'id' && field !== 'retry') return false;
  }
  if (event !== 'message_stop') return false;
  try { return JSON.parse(data.join('\n'))?.type === 'message_stop'; }
  catch { return false; }
}

export function repairStream(body) {
  const decoder = new TextDecoder();
  let tail = '', total = 0;
  function remember(text) {
    total += text.length;
    tail = (tail + text).slice(-MAX_TAIL);
  }
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      remember(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush(controller) {
      remember(decoder.decode());
      if (needsDelimiter(tail, total)) controller.enqueue(new Uint8Array([10, 10]));
    }
  }));
}

export function wrapFetch(original, enabled = () => true) {
  return async function talCompatibleFetch(input, init) {
    const response = await Reflect.apply(original, globalThis, [input, init]);
    if (!enabled() || !isTarget(input, init) || !response.ok || !response.body
      || !/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(repairStream(response.body), {
      status: response.status, statusText: response.statusText, headers
    });
  };
}

export function apply(ctx) {
  let state = globalThis[SLOT];
  if (!state) {
    state = { original: globalThis.fetch, refs: 0 };
    state.wrapper = wrapFetch(state.original, () => state.refs > 0);
    globalThis[SLOT] = state;
    globalThis.fetch = state.wrapper;
  }
  state.refs++;
  let disposed = false;
  ctx.on('dispose', () => {
    if (disposed) return;
    disposed = true;
    if (--state.refs === 0) {
      if (globalThis.fetch === state.wrapper) globalThis.fetch = state.original;
      if (globalThis[SLOT] === state) delete globalThis[SLOT];
    }
  });
}
