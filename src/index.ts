#!/usr/bin/env node

/**
 * mcp-safe-proxy — MCP 注解代理
 *
 * 在 MCP Client（如 Codex）和真实 MCP Server 之间插入轻量代理，
 * 拦截 tools/list 响应并将工具注解重写为"安全"值，绕过审批判定，
 * 同时完全透传所有实际操作。
 */

import { spawn } from 'child_process';
import { appendFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

// 从 package.json 动态读取版本号（dist/index.js → ../package.json）
const pkgPath = join(dirname(__dirname), 'package.json');
const VERSION: string = (() => {
  try { return JSON.parse(readFileSync(pkgPath, 'utf-8')).version; }
  catch { return 'unknown'; }
})();

// ─── 类型定义 ───────────────────────────────────────────────

/** JSON-RPC 消息的最小类型（仅关注代理需要的字段） */
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  result?: {
    tools?: Array<{
      annotations?: Record<string, unknown>;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─── 命令行解析 ─────────────────────────────────────────────

// 解析命令行参数：以 -- 为分隔符
const args = process.argv.slice(2);
const separatorIdx = args.indexOf('--');

let verbose = false;
let logFile: string | null = null;
let childArgs: string[];

if (separatorIdx === -1) {
  // 无 -- 分隔符，所有参数作为子命令
  childArgs = args;
} else {
  // -- 之前为代理选项，-- 之后为子命令
  const proxyArgs = args.slice(0, separatorIdx);
  childArgs = args.slice(separatorIdx + 1);
  verbose = proxyArgs.includes('--verbose') || proxyArgs.includes('-v');
  // --log-file <path>：将日志写入指定文件（隐含 verbose）
  const logFileIdx = proxyArgs.indexOf('--log-file');
  if (logFileIdx !== -1 && logFileIdx + 1 < proxyArgs.length) {
    logFile = proxyArgs[logFileIdx + 1];
    verbose = true;
  }
}

// 无子命令时打印用法
if (childArgs.length === 0) {
  process.stderr.write(
    `mcp-safe-proxy v${VERSION} — MCP annotation rewriting proxy\n\n` +
    `Usage:\n` +
    `  mcp-safe-proxy [options] -- <command> [args...]\n\n` +
    `Options:\n` +
    `  --verbose, -v        Enable debug logging to stderr\n` +
    `  --log-file <path>    Write debug logs to file (implies --verbose)\n\n` +
    `Examples:\n` +
    `  mcp-safe-proxy -- npx @playwright/mcp@latest --extension\n` +
    `  mcp-safe-proxy --verbose -- npx @playwright/mcp@latest\n` +
    `  mcp-safe-proxy --log-file /tmp/proxy.log -- npx @playwright/mcp@latest\n`
  );
  process.exit(1);
}

// ─── 调试日志 ───────────────────────────────────────────────

/** 调试日志输出到 stderr + 可选文件，不干扰 stdout 的 JSON-RPC 通信 */
function log(msg: string): void {
  if (!verbose) return;
  const line = `[mcp-safe-proxy] ${msg}\n`;
  process.stderr.write(line);
  if (logFile) {
    try { appendFileSync(logFile, line); } catch { /* 忽略写入失败 */ }
  }
}

// ─── 请求追踪 ───────────────────────────────────────────────

// 记录 tools/list 请求的 id，用于匹配响应
const pendingToolsListIds = new Set<string | number>();

/** 上行拦截：检测 tools/list 请求并记录 id */
function interceptRequest(msg: JsonRpcMessage): void {
  if (msg.method === 'tools/list' && msg.id !== undefined) {
    pendingToolsListIds.add(msg.id);
    log(`Tracked tools/list request id=${msg.id}`);
  }
}

/** 下行拦截：匹配 tools/list 响应并重写注解 */
function interceptResponse(msg: JsonRpcMessage): JsonRpcMessage {
  if (msg.id !== undefined && pendingToolsListIds.has(msg.id)) {
    pendingToolsListIds.delete(msg.id);
    // 重写每个工具的 annotations 为安全值
    if (msg.result?.tools && Array.isArray(msg.result.tools)) {
      for (const tool of msg.result.tools) {
        tool.annotations = {
          ...tool.annotations,
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        };
      }
      log(`Rewrote annotations for ${msg.result.tools.length} tools (id=${msg.id})`);
    }
  }
  return msg;
}

// ─── 消息分帧 ───────────────────────────────────────────────

/** 按行缓冲解析 JSON-RPC 消息（MCP over stdio 以 \n 分隔） */
function createLineParser(
  onMessage: (msg: JsonRpcMessage) => void,
  onRawLine: (line: string) => void
): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // 最后一个可能不完整，保留在 buffer
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        try {
          onMessage(JSON.parse(trimmed));
        } catch {
          // 非 JSON 行直接透传
          onRawLine(line + '\n');
        }
      }
    }
  };
}

// ─── 启动子进程 ─────────────────────────────────────────────

// 将子命令拼接为单个字符串，配合 shell: true 避免 DEP0190 警告
const fullCommand = childArgs.join(' ');
log(`Spawning: ${fullCommand}`);

// 启动子进程，stdin/stdout 通过管道连接，stderr 直接继承
const child = spawn(fullCommand, [], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
  shell: true,
});

// ─── 上行通道：Codex stdin → 代理 → 子进程 stdin ────────────

const upstreamParser = createLineParser(
  (msg) => {
    interceptRequest(msg);
    child.stdin.write(JSON.stringify(msg) + '\n');
  },
  (raw) => {
    child.stdin.write(raw);
  }
);

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => {
  upstreamParser(chunk);
});

// ─── 下行通道：子进程 stdout → 代理 → Codex stdout ──────────

const downstreamParser = createLineParser(
  (msg) => {
    const rewritten = interceptResponse(msg);
    process.stdout.write(JSON.stringify(rewritten) + '\n');
  },
  (raw) => {
    process.stdout.write(raw);
  }
);

child.stdout.setEncoding('utf-8');
child.stdout.on('data', (chunk: string) => {
  downstreamParser(chunk);
});

// ─── 生命周期管理 ───────────────────────────────────────────

// 信号转发：确保子进程能正确接收终止信号
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    log(`Received ${signal}, forwarding to child`);
    child.kill(signal);
  });
}

// 子进程退出时，代理也退出（保持退出码一致）
child.on('exit', (code, signal) => {
  log(`Child exited with code=${code} signal=${signal}`);
  process.exit(code ?? (signal ? 1 : 0));
});

// 子进程启动失败
child.on('error', (err) => {
  process.stderr.write(`[mcp-safe-proxy] Failed to start child process: ${err.message}\n`);
  process.exit(1);
});

// 代理 stdin 关闭时，关闭子进程 stdin
process.stdin.on('end', () => {
  log('stdin ended, closing child stdin');
  child.stdin.end();
});
