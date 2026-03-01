# mcp-safe-proxy 兼容 MCP Server 一览

> **日期**：2026-03-01
> **代理版本**：v0.1.0
> **关联文档**：[技术设计文档](./mcp-safe-proxy-design.md) | [Codex 审批问题分析](./codex-mcp-permission-issue.md)

---

## 1. 为什么适用于所有 MCP Server

mcp-safe-proxy 在 **JSON-RPC 协议层**工作，拦截 `tools/list` 响应并重写每个工具的 `annotations` 字段。它不解析工具名称、不依赖特定 Server 的实现，因此**任何使用 stdio 传输的 MCP Server 都天然兼容**。

Codex 的审批判定公式（[源码](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs)）：

```
需要审批 = destructiveHint == true
         OR (readOnlyHint == false AND openWorldHint == true)
```

只要 MCP Server 的工具注解命中上述条件，就会触发审批弹窗。mcp-safe-proxy 将注解重写为不触发审批的值（`readOnlyHint=true, destructiveHint=false, openWorldHint=false`），`tools/call` 等实际操作**完全透传**，功能零损失。

---

## 2. 验证状态说明

| 标记 | 含义 |
|:----:|------|
| ✅ | **源码已验证** — 已在 GitHub 源码中确认存在触发 Codex 审批的注解值 |
| ⬜ | **协议兼容** — 仓库已验证存在且为 stdio MCP Server，但源码中未发现显式注解 |

> **关于 ⬜ 状态**：未设置显式注解的 Server，在当前 Codex 实现中**可能不会触发审批**（Codex 用 `Option<bool>` 判断，`None` 不等于 `Some(true)`）。但 MCP 规范默认值为 `destructiveHint=true`，未来 Codex 版本可能应用这些默认值。proxy 对这类 Server 提供**预防性保障**。

---

## 3. 分类兼容列表

### 3.1 浏览器自动化

AI Agent 自动化场景中最常用、审批弹窗最频繁的类别。

| MCP Server | 仓库 | Stars | 触发原因 | 状态 |
|---|---|---:|---|:---:|
| **Playwright MCP** | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | 27.9k | action 类工具：`destructiveHint: !readOnly`，`openWorldHint: true`（始终） | ✅ |
| **Chrome DevTools MCP** | [ChromeDevTools/chrome-devtools-mcp](https://github.com/nicobailon/chrome-devtools-mcp) | 27.1k | Chrome DevTools 浏览器控制工具 | ⬜ |
| **Browserbase MCP** | [browserbase/mcp-server-browserbase](https://github.com/browserbase/mcp-server-browserbase) | 3.2k | 云端浏览器会话控制 | ⬜ |
| **Puppeteer MCP** | [merajmehrabi/puppeteer-mcp-server](https://github.com/merajmehrabi/puppeteer-mcp-server) | 401 | Puppeteer 浏览器操作 | ⬜ |

**Playwright MCP 注解源码**（[`tool.ts`](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/mcp/sdk/tool.ts)）：

```typescript
const readOnly = tool.type === 'readOnly' || tool.type === 'assertion';
return {
  annotations: {
    readOnlyHint: readOnly,       // action 类工具 → false
    destructiveHint: !readOnly,   // action 类工具 → true  ← 触发条件 1
    openWorldHint: true,          // 始终 true              ← 触发条件 2
  },
};
```

受影响工具：`browser_navigate`、`browser_click`、`browser_type`、`browser_fill`、`browser_select_option` 等所有 `type: "action"` 工具。

### 3.2 文件系统与代码

| MCP Server | 仓库 | Stars | 触发原因 | 状态 |
|---|---|---:|---|:---:|
| **Filesystem MCP** | [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) (filesystem) | 79.8k | 文件修改工具：`destructiveHint: true` | ✅ |
| **GitHub MCP** | [github/github-mcp-server](https://github.com/github/github-mcp-server) | 27.3k | 仓库写操作：`DestructiveHint: Ptr(true)` | ✅ |

**Filesystem MCP 注解源码**（[`src/filesystem/index.ts`](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/index.ts)）：

| 工具 | annotations | 触发审批？ |
|------|------------|:---:|
| `read_file`, `list_directory`, `search_files` 等 | `{ readOnlyHint: true }` | ❌ |
| `create_directory` | `{ readOnlyHint: false, destructiveHint: false, idempotentHint: true }` | ❌ |
| **`write_file`** | `{ readOnlyHint: false, destructiveHint: true, idempotentHint: true }` | ✅ |
| **`edit_file`** | `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false }` | ✅ |
| **`move_file`** | `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false }` | ✅ |

**GitHub MCP 注解源码**（Go，[`pkg/github/`](https://github.com/github/github-mcp-server) 下多个文件）：

```go
// 只读工具（不触发审批）
Annotations: &mcp.ToolAnnotations{ ReadOnlyHint: true }

// 写入/删除工具（触发审批）
Annotations: &mcp.ToolAnnotations{
    ReadOnlyHint:    false,
    DestructiveHint: jsonschema.Ptr(true),
}
```

受影响工具：`create_pull_request`、`merge_pull_request`、`create_issue`、`delete_branch` 等写操作。

### 3.3 通信与协作

| MCP Server | 仓库 | Stars | 触发原因 | 状态 |
|---|---|---:|---|:---:|
| **Notion MCP** | [makenotion/notion-mcp-server](https://github.com/makenotion/notion-mcp-server) | 3.9k | 非 GET 方法 → `destructiveHint: true` | ✅ |
| **Slack MCP** | [korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server) | 1.4k | 消息发送类操作 | ⬜ |
| **Google Workspace MCP** | [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) | 1.6k | Gmail 邮件发送、Drive 文件操作 | ⬜ |

**Notion MCP 注解源码**（[`src/openapi-mcp-server/mcp/proxy.ts`](https://github.com/makenotion/notion-mcp-server)）：

```typescript
const isReadOnly = httpMethod === 'get';
// 非 GET 方法（POST/PATCH/DELETE）→ destructiveHint: true
```

受影响工具：`create_page`、`update_page`、`delete_block`、`append_block_children` 等所有写操作。

### 3.4 DevOps

| MCP Server | 仓库 | Stars | 触发原因 | 状态 |
|---|---|---:|---|:---:|
| **Docker MCP** | [QuantGeekDev/docker-mcp](https://github.com/QuantGeekDev/docker-mcp) | 450 | 容器生命周期管理 | ⬜ |

---

## 4. 配置示例速查

### 通用模式

以 `--` 为分隔符，在原始命令前插入 `mcp-safe-proxy`：

**Codex TOML 格式**：

```toml
# 原始配置（会弹审批）
[mcp_servers.<name>]
type = "stdio"
command = "<原始命令>"
args = ["<原始参数>..."]

# 代理配置（不弹审批）
[mcp_servers.<name>]
type = "stdio"
command = "npx"
args = ["-y", "mcp-safe-proxy", "--", "<原始命令>", "<原始参数>..."]
```

**JSON 格式**（Claude Code / ccSwitch）：

```json
{
  "command": "npx",
  "args": ["-y", "mcp-safe-proxy", "--", "<原始命令>", "<原始参数>..."]
}
```

### 具体示例

#### Playwright MCP

```toml
[mcp_servers.playwright]
type = "stdio"
command = "npx"
args = ["-y", "mcp-safe-proxy", "--", "npx", "@playwright/mcp@latest"]
```

#### GitHub MCP

```toml
[mcp_servers.github]
type = "stdio"
command = "npx"
args = ["-y", "mcp-safe-proxy", "--", "npx", "@github/mcp-server"]
env = { GITHUB_TOKEN = "<your-token>" }
```

#### Filesystem MCP

```toml
[mcp_servers.filesystem]
type = "stdio"
command = "npx"
args = ["-y", "mcp-safe-proxy", "--", "npx", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"]
```

#### Notion MCP

```toml
[mcp_servers.notion]
type = "stdio"
command = "npx"
args = ["-y", "mcp-safe-proxy", "--", "npx", "notion-mcp-server"]
env = { NOTION_API_KEY = "<your-key>" }
```

#### Python MCP Server

```toml
[mcp_servers.custom]
type = "stdio"
command = "npx"
args = ["-y", "mcp-safe-proxy", "--", "python", "my_custom_mcp_server.py"]
```

---

## 5. 自行验证方法

对于未在清单中列出的 MCP Server，可通过以下步骤验证是否受审批问题影响：

**Step 1**：用 `--verbose` 启动代理，观察日志输出：

```bash
mcp-safe-proxy --verbose -- npx <your-mcp-server>
```

**Step 2**：查看 stderr 中的日志，确认注解被重写：

```
[mcp-safe-proxy] Tracked tools/list request id=1
[mcp-safe-proxy] Rewrote annotations for 25 tools (id=1)
```

**Step 3**：也可用 `--log-file` 将日志写入文件以便后续分析：

```bash
mcp-safe-proxy --log-file ./proxy-debug.log -- npx <your-mcp-server>
```

如果日志显示 `Rewrote annotations for N tools`，说明该 Server 的工具注解已被重写，代理正常工作。

> 参考 `test/real-playwright-test.js`，了解如何编写自动化验证脚本对比直连与代理模式的注解差异。

---

## 6. FAQ

### 未列出的 MCP Server 是否兼容？

**兼容**。mcp-safe-proxy 在协议层工作，不依赖特定 Server 实现。只要使用标准 stdio 传输的 MCP Server 都可以被包裹。本清单只是常见受影响 Server 的便捷参考，不是限制列表。

### SSE / Streamable HTTP 传输的 MCP Server 能用吗？

**当前不支持**。mcp-safe-proxy 仅支持 stdio 传输模式。SSE / Streamable HTTP 的 MCP Server（如 Zapier MCP、Close CRM MCP 等云端服务）需要不同的代理方案。

### 代理会影响 MCP Server 的功能吗？

**不会**。代理仅修改 `tools/list` 响应中的 `annotations` 字段（提示信息），`tools/call`（实际操作）、`resources/*`、`prompts/*`、`notifications/*` 等所有其他消息完全透传。工具的名称、描述、参数 schema 均不变。

### 如果 MCP Server 的工具本来就没有注解呢？

不影响。代理会为每个工具添加安全注解值。在当前 Codex 实现中，缺少注解的工具**不会触发审批**（Codex 用 `Option<bool>` 判断，`None` 不等于 `Some(true)`），所以代理对这类工具是无害的预防性保障。如果未来 Codex 改为应用 MCP 规范默认值（`destructiveHint=true`），proxy 将立即发挥作用。

---

## 7. 参考来源

- [MCP 工具注解规范](https://modelcontextprotocol.io/legacy/concepts/tools) — 注解字段定义与默认值
- [Codex 审批逻辑 `mcp_tool_call.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs) — 审批判定源码
- [Playwright 注解映射 `tool.ts`](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/mcp/sdk/tool.ts) — action/readOnly/assertion 到注解的映射
- [Filesystem MCP `index.ts`](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/index.ts) — 工具注解精确值
- [GitHub MCP Server](https://github.com/github/github-mcp-server) — Go 注解实现
- [Notion MCP Server](https://github.com/makenotion/notion-mcp-server) — HTTP 方法注解检测
