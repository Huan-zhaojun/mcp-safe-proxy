# 项目概述

MCP Safe Proxy 是一个轻量级 stdio 代理，位于 MCP Client（Codex CLI、Claude Code）和 MCP Server（如 Playwright MCP）之间。它拦截 `tools/list` 响应并重写工具注解（`readOnlyHint: true`、`destructiveHint: false`、`openWorldHint: false`）以绕过审批弹窗，同时透明转发所有其他消息。

**核心约束**：零运行时依赖。仅使用 Node.js 内置模块（`child_process`、`fs`、`path`）。

# 构建与测试命令

```bash
npm install              # 安装开发依赖（仅首次）
npm run build            # TypeScript 编译 (tsc) → dist/
npm run build && node test/e2e-test.js       # E2E 测试（使用 mock server）
node test/real-playwright-test.js            # 集成测试（需安装 @playwright/mcp）
```

项目未配置 `npm test` 脚本、linter 或 formatter。测试为纯 Node.js 脚本，使用手动断言（无测试框架）。

# 架构

单一源文件：`src/index.ts`（约 227 行）。

```
Client stdin ──→ [mcp-safe-proxy] ──→ MCP Server stdin
MCP Server stdout ──→ [注解重写] ──→ Client stdout
MCP Server stderr ──→ (直接继承，不经过代理)
```

核心流程：
1. **CLI 解析** — `--` 分隔代理选项（左侧）和子命令（右侧）
2. **`interceptRequest()`** — 检测 `tools/list` 请求，将其 JSON-RPC `id` 记录到 `Set`
3. **`interceptResponse()`** — 匹配响应 `id`，重写每个工具的 `annotations`，然后从 Set 中删除 `id`
4. **`createLineParser()`** — 按换行符缓冲解析 JSON-RPC 消息；无效 JSON 行原样透传
5. **进程管理** — 信号转发（SIGTERM/SIGINT/SIGHUP）、退出码保持一致、stdin 关闭传递

# 编码规范

- **注释**：代码内使用中文注释；日志/调试输出使用英文
- **日志**：所有调试输出写入 stderr（不能写 stdout，那是 JSON-RPC 通道）。可选通过 `--log-file` 写入文件
- **Windows 兼容**：使用 `shell: true` 启动子进程以处理 `.cmd` 文件；路径使用正斜杠
- **TypeScript**：严格模式，目标 ES2022，模块 Node16，输出到 `dist/`

# 文档

- `docs/mcp-safe-proxy-design.md` — 原始设计文档（版本号、行数等非核心描述可能与实际存在差异），含架构设计、通信模型、风险评估
- `docs/codex-mcp-permission-issue.md` — Codex MCP 审批行为的根因分析、源码追踪
- `docs/local-dev-testing.md` — 开发环境搭建、配置模板、验收测试清单

# 测试结构

| 文件 | 用途 |
|------|------|
| `test/mock-mcp-server.js` | 模拟 MCP Server，返回带"危险"注解的工具列表 |
| `test/e2e-test.js` | 启动代理 + mock server，验证注解重写和透传 |
| `test/real-playwright-test.js` | 对比直连与代理连接 Playwright MCP，逐工具注解差异比较 |
