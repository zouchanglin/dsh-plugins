/**
 * Host half of the inline-suggest plugin.
 *
 * Exposes loopback-only routes for the browser half:
 *
 *   GET  /inline-suggest/status   -> provider catalogue, resolved target, last error, browser state
 *   POST /inline-suggest/predict  -> { context } -> { suggestion }
 *   POST /inline-suggest/debug    <- the browser half's own state report (why it did or did not paint)
 *
 * The prediction itself is one small LLM call: the browser sends the tail of the
 * visible conversation, the model is asked for the single message the user is
 * most likely to type next, and the answer comes back as plain text that the
 * browser paints as grey ghost text.
 */

export const name = 'inline-suggest';
export const inject = ['webServer', 'llm'];

const SYSTEM_PROMPT = [
  'You are a silent autocomplete engine embedded in a chat input box.',
  'Read the conversation and predict the ONE message the human user is most likely to type next.',
  '',
  'Rules:',
  '- Reply with the message text only. No quotes, no markdown, no labels, no explanation.',
  '- Write as the user, in the first person, in the same language and tone as the conversation.',
  '- The user just read the last assistant message. Predict their natural reaction to it: a follow-up question, a short acknowledgement, a correction, or the next instruction.',
  '- Output MUST be a complete, sendable user message: one full sentence (roughly 4-26 characters), never a sentence fragment, never just a phrase cut in half.',
  '- NEVER continue, complete, or summarize the assistant\'s own sentence. Even when the assistant\'s last message ends mid-sentence, you still write a complete USER message.',
  '- Do not describe technical details, solutions, or explanations; that is the assistant\'s job. You only produce the human\'s next utterance.',
  '- Almost any conversation has a plausible next message, so ALWAYS suggest one. Reply NONE only when the conversation contains no user or assistant text at all.',
  '',
  'Examples:',
  'Assistant: 你吃饭了吗？ -> 还没吃，你呢？',
  'Assistant: 已修复，单元测试全部通过。 -> 好的，谢谢',
  'Assistant: 这个报错是因为端口被占用了。 -> 那怎么解决？',
  'Assistant: 我已经把方案列在下面了。 -> 就按第二个方案来',
  'Assistant: 需要我接着做吗？比如：1. 复查状态 2. 看日志 3. 看截图 -> 三个都做吧',
  'Assistant: 这个组合通常（消息在这里被截断） -> 你刚才说什么？'
].join('\n');

const BODY_LIMIT = 64 * 1024;
const CALL_TIMEOUT_MS = 25000;
const MAX_SUGGESTION_CHARS = 120;

/** Candidate adapter targets, tried in order until one streams. */
const CANDIDATES = [
  { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' },
  { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
  { provider: 'deepseek', model: 'deepseek-v4-flash' }
];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function cleanSuggestion(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  // Strip a single layer of wrapping quotes and common lead-ins.
  text = text.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  text = text.replace(/^(Prediction|Suggestion|Reply|User)\s*[:：]\s*/i, '').trim();
  if (!text) return '';
  if (/^none$/i.test(text)) return '';
  if (/^n\/?a$/i.test(text)) return '';
  text = text.split(/\r?\n/)[0].trim();
  if (text.length > MAX_SUGGESTION_CHARS) text = text.slice(0, MAX_SUGGESTION_CHARS);
  return text;
}

export function apply(ctx) {
  let resolved = null;
  let lastError = null;
  let lastSuggestion = '';
  let calls = 0;
  let inflight = null;
  let lastDebug = null;
  let lastFinish = '';

  function jsonSafe(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  function providers() {
    try {
      return jsonSafe(ctx.llm.listProviders());
    } catch (error) {
      return { error: String((error && error.message) || error) };
    }
  }

  async function streamOnce(target, context) {
    const messages = [
      { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Conversation so far (oldest first):\n\n' +
              context +
              '\n\nNow predict the next message the user is most likely to type.'
          }
        ]
      }
    ];

    let text = '';
    let finish = '';
    const stream = ctx.llm.stream({
      provider: target.provider,
      model: target.model,
      messages,
      temperature: 0.4,
      // Reasoning tokens share this budget; 96 was too small and cut sentences
      // in half once the model thought for a while.
      maxTokens: 512
    });

    for await (const chunk of stream) {
      if (!chunk) continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      if (chunk.type === 'finish') {
        finish = String((chunk.reason && chunk.reason.kind) || '');
        break;
      }
    }
    return { text, finish };
  }

  /** Sentence terminators accepted as a complete suggestion ending. */
  const TERMINALS = ['。', '！', '？', '!', '?', '…', '～', '~', '.'];

  /**
   * A reply that stopped on the token budget is a fragment ("这个组合通常").
   * Cut it back to its last complete sentence, or drop it: a missing hint is
   * far better than half a sentence painted into the composer.
   */
  function completeOnly(text, finish) {
    if (!text) return '';
    if (finish !== 'max-tokens') return text;
    let cut = -1;
    for (const mark of TERMINALS) cut = Math.max(cut, text.lastIndexOf(mark));
    return cut >= 3 ? text.slice(0, cut + 1).trim() : '';
  }

  async function predict(context) {
    const trimmed = String(context || '').trim();
    if (trimmed.length < 8) return '';

    const order = resolved ? [resolved, ...CANDIDATES.filter((c) => c.provider !== resolved.provider || c.model !== resolved.model)] : CANDIDATES;

    let firstError = null;
    for (const target of order) {
      try {
        const { text: raw, finish } = await streamOnce(target, trimmed);
        resolved = target;
        lastFinish = finish;
        lastError = null;
        return completeOnly(cleanSuggestion(raw), finish);
      } catch (error) {
        const message = String((error && error.message) || error);
        if (!firstError) firstError = `${target.provider}/${target.model}: ${message}`;
        if (resolved && resolved.provider === target.provider && resolved.model === target.model) resolved = null;
      }
    }
    lastError = firstError;
    return '';
  }

  async function handlePredict(req, res) {
    let payload = {};
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch (error) {
      sendJson(res, 400, { error: String((error && error.message) || error) });
      return;
    }

    const context = typeof payload.context === 'string' ? payload.context : '';
    if (!context.trim()) {
      sendJson(res, 200, { suggestion: '' });
      return;
    }

    if (inflight) {
      sendJson(res, 200, { suggestion: '', pending: true });
      return;
    }

    inflight = (async () => {
      calls += 1;
      const timeout = new Promise((resolve) => setTimeout(() => resolve(''), CALL_TIMEOUT_MS));
      const result = await Promise.race([predict(context), timeout]);
      lastSuggestion = result;
      return result;
    })();

    try {
      const suggestion = await inflight;
      sendJson(res, 200, { suggestion, error: suggestion ? undefined : lastError || undefined });
    } catch (error) {
      lastError = String((error && error.message) || error);
      sendJson(res, 200, { suggestion: '', error: lastError });
    } finally {
      inflight = null;
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (path === '/inline-suggest/status' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        providers: providers(),
        resolved,
        calls,
        lastError,
        lastSuggestion,
        lastFinish,
        debug: lastDebug
      });
      return;
    }

    if (path === '/inline-suggest/debug' && req.method === 'POST') {
      try {
        const raw = await readBody(req);
        lastDebug = raw ? JSON.parse(raw) : null;
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: String((error && error.message) || error) });
      }
      return;
    }

    if (path === '/inline-suggest/predict' && req.method === 'POST') {
      await handlePredict(req, res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/inline-suggest',
        handler
      }),
    'inline-suggest: prediction routes'
  );
}
