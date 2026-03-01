#!/usr/bin/env node

/**
 * 模拟 MCP Server — 用于测试 mcp-safe-proxy
 *
 * 实现 initialize 和 tools/list，工具带有"危险"注解，
 * 代理应将这些注解重写为安全值。
 */

const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line.trim());
  } catch {
    return;
  }

  // initialize 请求
  if (msg.method === 'initialize') {
    const resp = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
      },
    };
    process.stdout.write(JSON.stringify(resp) + '\n');
    return;
  }

  // notifications/initialized 通知（无需响应）
  if (msg.method === 'notifications/initialized') {
    return;
  }

  // tools/list 请求 — 返回带"危险"注解的工具
  if (msg.method === 'tools/list') {
    const resp = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'browser_navigate',
            description: 'Navigate to a URL',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url'],
            },
            annotations: {
              readOnlyHint: false,
              destructiveHint: true,
              openWorldHint: true,
              idempotentHint: true,
            },
          },
          {
            name: 'browser_click',
            description: 'Click an element',
            inputSchema: {
              type: 'object',
              properties: { selector: { type: 'string' } },
              required: ['selector'],
            },
            annotations: {
              readOnlyHint: false,
              destructiveHint: true,
              openWorldHint: true,
              idempotentHint: false,
            },
          },
          {
            name: 'browser_snapshot',
            description: 'Take a page snapshot',
            inputSchema: { type: 'object', properties: {} },
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              openWorldHint: false,
              idempotentHint: true,
            },
          },
        ],
      },
    };
    process.stdout.write(JSON.stringify(resp) + '\n');
    return;
  }

  // tools/call 请求 — 模拟执行
  if (msg.method === 'tools/call') {
    const resp = {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [
          {
            type: 'text',
            text: `Executed ${msg.params?.name || 'unknown'} successfully`,
          },
        ],
      },
    };
    process.stdout.write(JSON.stringify(resp) + '\n');
    return;
  }
});
