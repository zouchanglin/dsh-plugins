# dsh-tal-sse-compat

给 TAL Messages（Anthropic 风格）SSE 端点补上**流末尾缺失的空行**，避免最后一个事件被 SSE 解析器丢掉。

## 现象

某些 TAL `messages` 端点在结束时会输出：

```
event: message_stop
data: {"type":"message_stop"}
```

但**末尾没有空行**（SSE 的事件分隔符是 `\n\n`）。严格按规范的解析器不会把这段不完整的事件交给上层，于是：

- 上层一直等不到 `message_stop`，该轮回答看起来"卡住"或被判定为截断
- 只有重新触发一次请求才会恢复

## 做法

插件包一层 `globalThis.fetch`，只对目标请求生效：

```
POST https://ai-service.tal.com/token-plan/v1/messages
```

命中后，如果响应的 `content-type` 是 `text/event-stream`，就把响应体接进一个 `TransformStream`：

- 转发所有原始分块，不改写任何内容
- 在流结束时检查尾部：只有在**完整的、明确的** `message_stop` 事件缺少分隔符时才追加 `\n\n`
- 不合成 `message_stop`、不修复截断的 JSON、不掩盖传输错误

实现细节见 [index.js](./index.js)：`needsDelimiter()` 负责严格判定，`repairStream()` 负责流式修复，`apply()` 负责安装/卸载包装（用 `Symbol.for` 防止重复包装，引用计数归零时还原 `fetch`）。

## 接口与配置

```js
const TARGET = 'ai-service.tal.com';
const PATH = '/token-plan/v1/messages';
const MAX_TAIL = 8192;
```

如果你的网关域名或路径不同，改这两行后重启 DSH 即可。

## 安装

见仓库根目录 [README](../README.md#安装)。它只包含 Host 半侧（`index.js`），没有客户端代码，通过 bundle 的 `cordis.patch.yml` 插入一行插件。

## 边界

- 不记录、不持久化请求体、响应体或任何凭据
- 只处理 SSE 末尾分隔符问题，不处理内容层面的协议差异
