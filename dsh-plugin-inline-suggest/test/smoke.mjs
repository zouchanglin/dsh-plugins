// 离线冒烟测试（不依赖真实页面）：
// 用最小 DOM 桩加载 lib/client.js，验证 1) bundle 可物化 2) 上下文提取正确
// 3) 请求发出并画出灰字 4) Tab 接受写入编辑器。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const src = fs.readFileSync(SRC, 'utf8');

/* ---------------- minimal DOM ---------------- */
let idSeq = 0;
function makeEl(tag, attrs = {}, extra = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    attrs,
    className: attrs.class || '',
    innerText: extra.innerText ?? '',
    textContent: extra.innerText ?? '',
    children: [],
    parentNode: null,
    isConnected: true,
    style: {},
    dataset: {},
    id: ++idSeq,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    getClientRects() {
      return this._rect === null ? [] : [{ ...this._rect }];
    },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 300, height: 24, right: 310, bottom: 44 };
    },
    contains() {
      return true;
    },
    appendChild(child) {
      child.parentNode = this;
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((node) => node !== child);
      child.parentNode = null;
      child.isConnected = false;
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    focus() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    querySelector(selector) {
      return queryOne(this.children, selector);
    },
    querySelectorAll(selector) {
      return queryAll(this.children, selector);
    },
    closest() {
      return this;
    },
    _rect: { left: 10, top: 20, width: 300, height: 24 }
  };
  for (const [key, value] of Object.entries(extra)) if (!(key in el)) el[key] = value;
  return el;
}

/* attribute-only selector matcher: [a], [a="b"], [a*="b"], plus :not([b]) suffix */
function matches(el, selector) {
  for (const part of selector.split(',').map((s) => s.trim())) {
    const notMatch = part.match(/:not\(\[([^\]]+)\]\)/);
    const base = part.replace(/:not\(\[[^\]]+\]\)/, '');
    const attr = base.match(/^\[([^=\]*^$]+)(?:([*^$]?)=("([^"]*)")?)?\]$/);
    if (!attr) continue;
    const [, name, op, quoted, value] = attr;
    const have = el.getAttribute(name);
    if (have === null) continue;
    if (op === undefined) {
      if (notMatch) {
        const blocked = el.getAttribute(notMatch[1]);
        if (blocked !== null) continue;
      }
      return true;
    }
    if (value === undefined) continue;
    if (op === '=' && have !== value) continue;
    if (op === '*' && !have.includes(value)) continue;
    if (op === '^' && !have.startsWith(value)) continue;
    if (op === '$' && !have.endsWith(value)) continue;
    return true;
  }
  return false;
}

function walk(nodes, visit) {
  for (const node of nodes) {
    visit(node);
    walk(node.children, visit);
  }
}
function queryOne(nodes, selector) {
  let found = null;
  walk(nodes, (node) => {
    if (!found && matches(node, selector)) found = node;
  });
  return found;
}
function queryAll(nodes, selector) {
  const out = [];
  walk(nodes, (node) => {
    if (matches(node, selector)) out.push(node);
  });
  return out;
}

/* ---------------- fake transcript ---------------- */
let nativeInserts = 0;
let fallbackInserts = 0;
const body = makeEl('body');
const PLACEHOLDER_TEXT = '发消息或创建任务, / 调用指令, @ 文件或对话';
const editor = makeEl('div', { 'data-lexical-editor': 'true', 'data-composer-input': 'true', 'data-placeholder': PLACEHOLDER_TEXT, class: 'GRgSLq_input' }, { innerText: '' });
editor.dispatchEvent = (event) => {
  // Lexical's own beforeinput handler: the fallback path.
  if (event && event.type === 'beforeinput' && event.data) {
    fallbackInserts++;
    editor.innerText = String(editor.innerText || '') + event.data;
    editor.textContent = editor.innerText;
  }
  return true;
};
const placeholder = makeEl('div', { class: 'GRgSLq_placeholder' }, { innerText: PLACEHOLDER_TEXT });
const composerParent = makeEl('div', { class: 'GRgSLq_grow' });
composerParent.appendChild(editor);
composerParent.appendChild(placeholder);

const answerBody = makeEl('div', { 'data-text-interaction-source': '' }, { innerText: '我刚吃完，你呢？' });
const reasoningBody = makeEl('div', { 'data-text-interaction-source': '' }, { innerText: '（思考：用户可能在问吃饭）' });
const askBubble = makeEl('div', { 'data-message-bubble': '' }, { innerText: '你吃饭了吗？' });

const userRow = makeEl('div', { 'data-chat-flow-kind': 'user', 'data-chat-group-part': '' });
userRow.appendChild(askBubble);

const reasoningRow = makeEl('div', { 'data-chat-flow-kind': 'assistant-step', 'data-chat-group-part': 'reasoning' });
reasoningRow.appendChild(reasoningBody);

const answerRow = makeEl('div', { 'data-chat-flow-kind': 'assistant-step', 'data-chat-group-part': 'response' });
answerRow.appendChild(answerBody);

const toolRow = makeEl('div', { 'data-chat-flow-kind': 'tool-call' });
const tailRow = makeEl('div', { 'data-chat-flow-kind': 'turn-tail' });

const transcript = [userRow, reasoningRow, answerRow, toolRow, tailRow];
for (const row of transcript) body.appendChild(row);
body.appendChild(composerParent);

const documentStub = {
  activeElement: null,
  body,
  documentElement: makeEl('html'),
  addEventListener() {},
  removeEventListener() {},
  createElement(tag) {
    return makeEl(tag);
  },
  createRange() {
    return { selectNodeContents() {}, setStart() {}, toString: () => '' };
  },
  execCommand(_cmd, _ui, text) {
    // Lexical applies execCommand insertion through its own model on the next
    // tick: the DOM is still stale synchronously. This mirrors the real editor.
    nativeInserts++;
    const value = String(text ?? '');
    queueMicrotask(() => {
      editor.innerText = String(editor.innerText || '') + value;
      editor.textContent = editor.innerText;
    });
    return true;
  },
  querySelector(selector) {
    return queryOne([body], selector);
  },
  querySelectorAll(selector) {
    return queryAll([body], selector);
  }
};

/* ---------------- controllable timers ---------------- */
let now = 0;
let timerSeq = 0;
const timers = new Map();
function setTimer(fn, delay, repeat) {
  const id = ++timerSeq;
  timers.set(id, { at: now + (delay || 0), fn, repeat: repeat ? Math.max(1, delay || 1) : 0 });
  return id;
}
function clearTimer(id) {
  timers.delete(id);
}
function flush(ms) {
  const target = now + ms;
  for (let guard = 0; guard < 1000; guard++) {
    let next = null;
    for (const [id, timer] of timers) if (timer.at <= target && (next === null || timer.at < next.timer.at)) next = { id, timer };
    if (next === null) break;
    now = next.timer.at;
    if (next.timer.repeat) next.timer.at = now + next.timer.repeat;
    else timers.delete(next.id);
    next.timer.fn();
  }
  now = target;
}

/* ---------------- fake window ---------------- */
const store = new Map();
const fetchCalls = [];
const ghostParents = [];
const windowStub = {
  __ModuleLoader__: { load: (def) => (windowStub.__def = def) },
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value))
  },
  getSelection: () => null,
  getComputedStyle: () => ({
    fontFamily: 'ui-sans-serif',
    fontSize: '14px',
    lineHeight: '20px',
    fontWeight: '400',
    fontStyle: 'normal',
    letterSpacing: '0px',
    paddingLeft: '8px',
    paddingTop: '6px'
  }),
  fetch: (url, init) => {
    fetchCalls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return Promise.resolve({
      status: 200,
      ok: true,
      json: async () => ({ suggestion: '我也刚吃完。' })
    });
  },
  setTimeout: (fn, delay) => setTimer(fn, delay, false),
  setInterval: (fn, delay) => setTimer(fn, delay, true),
  clearTimeout: clearTimer,
  clearInterval: clearTimer
};
windowStub.localStorage = windowStub.localStorage;

/* ---------------- run the bundle ---------------- */
new Function('window', 'document', 'InputEvent', src)(windowStub, documentStub, class InputEventStub {});

const def = windowStub.__def;
if (!def) throw new Error('bundle 没有调用 __ModuleLoader__.load');
if (def.id !== 'dsh-plugin-inline-suggest') throw new Error('bundle id 不符: ' + def.id);

const exported = def.factory(() => ({}));
if (typeof exported.apply !== 'function') throw new Error('缺少 exports.apply');
if (!Array.isArray(exported.inject)) throw new Error('缺少 exports.inject');

let cleanup = null;
exported.apply({
  effect(fn) {
    cleanup = fn();
  }
});

const api = windowStub.__DSH_INLINE_SUGGEST__;
if (!api) throw new Error('apply 后没有暴露 __DSH_INLINE_SUGGEST__');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}  ${detail ?? ''}`);
  }
}

/* 1) 上下文提取：只取 response part，跳过 reasoning/tool-call/turn-tail */
const snapshot = api.readConversation();
check('上下文提取 lastKind=assistant', snapshot.lastKind === 'assistant', JSON.stringify(snapshot.lastKind));
check('上下文含 user 文本', snapshot.context.includes('User: 你吃饭了吗？'), JSON.stringify(snapshot.context));
check('上下文含 assistant 正文', snapshot.context.includes('Assistant: 我刚吃完，你呢？'), JSON.stringify(snapshot.context));
check('排除 reasoning 正文', !snapshot.context.includes('思考'), JSON.stringify(snapshot.context));

/* 2) 空输入框 → 发请求 → 350ms 后返回 → 画灰字 */
flush(20);
flush(400);
await new Promise((resolve) => setTimeout(resolve, 0));
flush(100);
const requested = fetchCalls.find((call) => call.url === '/inline-suggest/predict');
check('向上发预测请求', Boolean(requested), JSON.stringify(fetchCalls));
check('请求带上下文', Boolean(requested) && requested.body.context.includes('你吃饭了吗'), JSON.stringify(requested && requested.body));

await new Promise((resolve) => setTimeout(resolve, 0));
flush(100);
const ghostFind = [];
walk([body], (node) => {
  if (node.getAttribute && node.getAttribute('data-dsh-inline-suggest') === 'ghost') ghostFind.push(node);
});
const ghost = ghostFind[ghostFind.length - 1];
check('创建了灰字覆盖层', Boolean(ghost));
check('灰字内容正确', Boolean(ghost) && ghost.textContent === '我也刚吃完。', ghost && ghost.textContent);
check('灰字已显示', Boolean(ghost) && ghost.style.display === 'block', ghost && ghost.style.display);
check('灰字出现时隐藏 placeholder', placeholder.style.visibility === 'hidden', JSON.stringify(placeholder.style));
check('调试状态 visible', api.state.visible === true, JSON.stringify(api.state));

/* 2b) 输入框一旦有内容，这个插件不再画任何灰字（没有打字前缀补全） */
editor.innerText = '帮我';
editor.textContent = '帮我';
api.refresh();
flush(40);
check('输入框有内容时不画灰字', api.state.visible === false, JSON.stringify(api.state));
check('输入框有内容时恢复 placeholder', placeholder.style.visibility === '', JSON.stringify(placeholder.style));

/* 2c) 清空后又回到上下文的建议 */
editor.innerText = '';
editor.textContent = '';
api.refresh();
flush(40);
check('清空输入框后重新显示上下文建议', api.state.visible === true, JSON.stringify(api.state));

/* 3) Tab 接受：只写入一次（Lexical 的插入是异步落地的） */
const accepted = api.accept();
check('接受建议返回 true', accepted === true);
flush(30);
check('Lexical 尚未落地时不重画灰字', api.state.visible === false, JSON.stringify(api.state));
await Promise.resolve();
flush(250);
await Promise.resolve();
check(
  '建议只写入一次（不重复）',
  editor.innerText === '我也刚吃完。',
  JSON.stringify(editor.innerText) + ` native=${nativeInserts} fallback=${fallbackInserts}`
);
check('未走重复的 beforeinput 兜底', fallbackInserts === 0, String(fallbackInserts));
check('接受后隐藏灰字', api.state.visible === false, JSON.stringify(api.state));
check('接受后恢复 placeholder', placeholder.style.visibility === '', JSON.stringify(placeholder.style));

/* 4) 卸载清理 */
if (typeof cleanup === 'function') cleanup();
check('卸载后移除调试句柄', windowStub.__DSH_INLINE_SUGGEST__ === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
