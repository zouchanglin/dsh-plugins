# dsh-plugin-inline-suggest

给 DSH 输入框加**上下文预测**：一轮回答结束后，空输入框里直接以灰色显示"你下一句最可能说什么"，按 <kbd>Tab</kbd> 接受，灰字变成正常输入。

## 两种模式

| 场景 | 预测来源 | 例子 |
|---|---|---|
| **输入框为空**（主模式） | 模型读对话尾部上下文 | 助手说"你吃饭了吗？" → 灰字 `还没吃，你呢？` |
| **输入框已有内容** | 本地语料前缀补全（零延迟、零请求） | 输入 `帮我` → 灰字 `列出` |

上下文预测只在「最后一条消息是助手的正式回答、且该轮已结束」时触发；助手还在流式输出时不会请求，避免抖动和浪费。同一段上下文只请求一次（按上下文哈希缓存）。

## 交互

- <kbd>Tab</kbd> — 接受建议（灰字变正常文字并进入光标位置）
- <kbd>Esc</kbd> — 忽略当前建议，直到草稿变化
- 继续打字 — 灰字让位给本地补全

空输入框原本会显示 placeholder（"发消息或创建任务…"）。灰字占的就是这块位置，所以**画灰字时会把 placeholder 临时隐藏**，接受/消失后恢复，避免两行灰字叠在一起。

### Tab 只插入一次

输入框是 Lexical：`execCommand('insertText')` 会触发它拦截的 `beforeinput`，真正落地在下一帧。若立刻读草稿判断"没插进去"再补发一次 `beforeinput`，就会插入两遍——这就是之前"按一下 Tab 出现两个重复提示"的原因。现在：

- 只在 Lexical 落地后（约 200ms）仍没变化时才走兜底
- 接受后 300ms 内忽略重复 accept，接受后 700ms 内空输入框不再重新预测（避免灰字叠在被插入的文字上）
- HMR 热重载会留下旧实例的监听器和覆盖层，新实例启动时先 `__DSH_INLINE_SUGGEST_DISPOSE__` 掉旧实例，并清理残留 ghost 节点

### 建议一定是完整句子

早先出现过灰字只有半句（例如"这个组合通常"）。原因有两个：

1. `maxTokens: 96` 太小——推理 token 与正文共享预算，长对话里推理吃掉预算后正文被截断
2. prompt 只要求"短"，没禁止"半句"，模型有时会去续写助手自己没说完的句子

现在的约定：

- `maxTokens` 提到 **512**，给推理留余量
- 读取流式 `finish.reason.kind`：**只有 `max-tokens` 才判定为截断**，回退到最后一个完整句号；找不到完整句就直接不显示灰字（宁可不提示，也不给半句）
- prompt 明确：必须是**完整、可直接发送的一句话**；**绝不续写助手的句子**，即使助手最后一句是半句，用户消息也要完整

## 架构

```
浏览器 (lib/client.js)                       Host (lib/index.js)
──────────────────────                       ───────────────────
读对话行 [data-chat-flow-kind]
  ├ user            → [data-message-bubble]
  └ assistant-step  → [data-chat-group-part="response"]
                      [data-text-interaction-source]
  └─ POST /inline-suggest/predict ─────────► 拼 prompt → ctx.llm.stream()
       { context }                             provider: deepseek-official
                                               model:    deepseek-v4.1-flash
  ◄──────────────── { suggestion } ────────── cleanSuggestion()（剥引号/NONE）
量光标位置 → 画灰色覆盖层（fixed 定位）
按 Tab → execCommand('insertText')
```

**为什么是覆盖层**：输入框是 `ui-conversation` 持有的 Lexical `contenteditable`，文本流内部没有可插入的 slot，所以用折叠 Range 的 `getClientRects()` 定位光标，字体从编辑器 computed style 同步。空输入框取不到光标矩形时退回编辑器的 padding 原点。

**为什么按 `data-*` 取文本**：`ui-conversation` 的 class 名是构建哈希，`data-chat-flow-kind` / `data-chat-group-part` / `data-message-bubble` / `data-text-interaction-source` 是稳定契约。注意助手行有 `reasoning` 与 `response` 两种 part，只有 `response` 是用户读到的正文。

**为什么用 HTTP 路由**：`ctx.webServer.register()` 是插件自定义接口的官方方式；桌面端页面在 `dsh-app://app` 下，相对路径的 `fetch` 会被桌面壳转发到 Host 并带上鉴权 Cookie（这一点已实测通过）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/inline-suggest/status` | provider 目录、当前解析到的模型、调用次数、上次错误、浏览器半边的状态回传 |
| `POST` | `/inline-suggest/predict` | 入参 `{ context }`，返回 `{ suggestion, error? }` |
| `POST` | `/inline-suggest/debug` | 浏览器半边把 `branch / ctx / ghost` 等运行状态回传给 Host |

模型候选按顺序尝试：`deepseek-official/deepseek-v4.1-flash` → `deepseek-official/deepseek-v4-flash` → `deepseek/...`，成功后缓存。

## 调试

浏览器控制台：

```js
__DSH_INLINE_SUGGEST__.state               // enabled/visible/text/learned/context
__DSH_INLINE_SUGGEST__.readConversation()  // 实际抓到的上下文与最后一条消息类型
__DSH_INLINE_SUGGEST__.predict('帮我')      // 本地补全
__DSH_INLINE_SUGGEST__.setContextEnabled(false) // 关掉上下文预测，只留本地补全
__DSH_INLINE_SUGGEST__.setEnabled(false)   // 整个插件临时关闭
```

Host 侧自检（端口用当前 GUI 的端口）：

```powershell
irm "http://127.0.0.1:<port>/inline-suggest/status" | ConvertTo-Json -Depth 5
irm "http://127.0.0.1:<port>/inline-suggest/predict" -Method Post `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes('{"context":"User: 你吃饭了吗？\n\nAssistant: 我刚吃完，你呢？"}'))
```

`/status` 里的 `debug.branch` 是更新循环上一轮走到的分支，能直接定位"为什么没有灰字"：
`requesting`（已发请求）→ `showing`（已画出）是正常链路；
`ctx:<kind>`（上下文不可用）、`running`（还在生成）、`focus`（焦点不在输入框）、
`accept-settling`（刚按过 Tab，等编辑器落地）、`fetch-failed:*`（请求失败）则是被拦下的原因。

## 配置点

`lib/index.js` 顶部：`CANDIDATES`（模型候选）、`SYSTEM_PROMPT`（预测规则）、`CALL_TIMEOUT_MS`。
`lib/client.js` 顶部：`MIN_DRAFT`（本地补全最少字符）、`MAX_SUGGEST`。

## 测试

`test/smoke.mjs` 用最小 DOM 桩加载真实的 `lib/client.js`，不需要浏览器或 DSH：

```powershell
node test/smoke.mjs     # 或 npm test
```

覆盖：bundle 可物化、上下文提取（含 reasoning/tool-call 过滤）、预测请求、灰字绘制、placeholder 隐藏/恢复、Tab 单次写入、卸载清理。

Host 半侧改动：在「设置 → 插件」里禁用再启用该插件（或重启应用）。
浏览器半侧改动：正常情况下 HMR 会自动热重载。桌面版注意：窗口刷新复用的是**启动时**注入的启动清单，
可能取不到新版本 bundle，所以改完 `lib/client.js` 后请**完全退出并重开应用**（Host 与页面一起换新）。

## 卸载

```powershell
# 1) 从 profile 的 package.json 删掉依赖和 dsh.profile.bundles 条目
# 2) 删 node_modules\dsh-plugin-inline-suggest 链接
# 3) 重启应用
```
