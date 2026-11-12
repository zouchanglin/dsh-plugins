# dsh-plugins

[DeepSeek Harness](https://github.com/deepseek-ai "DeepSeek Harness") 的本地插件集合。每个目录都是一个可独立安装的 DSH profile bundle。

## 插件

| 插件 | 作用 |
|---|---|
| [dsh-plugin-inline-suggest](./dsh-plugin-inline-suggest) | 输入框上下文预测：一轮回答结束后，在**空输入框**里用灰色显示"你下一句最可能说什么"，按 <kbd>Tab</kbd> 接受；输入过程中则做本地前缀补全 |
| [dsh-tal-sse-compat](./dsh-tal-sse-compat) | TAL Messages SSE 兼容层：流末尾缺少空行导致终端事件被 SSE 解析器丢弃时，补上分隔符，避免回答被截断/卡住 |

## 安装

它们是 DSH profile bundle。最省事的方式是在 DSH 会话里用内置的 `plugin_manager`：

```powershell
# 把路径换成你本地的绝对路径
plugin_manager action=install_bundle target="C:\path\to\dsh-plugin-inline-suggest"
plugin_manager action=install_bundle target="C:\path\to\dsh-tal-sse-compat"
```

它会写入当前 profile 的 `package.json` 依赖与 `dsh.profile.bundles`，并热应用到运行中的实例。

手动安装也可以：

1. 把插件目录放到 `%USERPROFILE%\.dsh\local-plugins\`
2. 在 `%USERPROFILE%\.dsh\profiles\<profile>\package.json` 的 `dependencies` 里加 `"<包名>": "link:C:/.../插件目录"`
3. 把包名加进同文件的 `dsh.profile.bundles` 数组
4. 重启 DeepSeek Harness

## 说明

- 两个插件只在本机运行，不上报任何数据。
- `dsh-plugin-inline-suggest` 的预测调用走你自己配置的 LLM provider（默认 `deepseek-official/deepseek-v4.1-flash`），会消耗 token。
- 均为个人自用插件，接口随 DSH 版本演进可能变化。
