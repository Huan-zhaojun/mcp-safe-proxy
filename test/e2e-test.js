#!/usr/bin/env node

/**
 * 端到端测试 — 验证 mcp-safe-proxy 的注解重写功能
 *
 * 流程：启动代理包裹 mock MCP Server → 发送 JSON-RPC 消息 → 验证响应
 */

const { spawn } = require('child_process');
const path = require('path');

const proxyPath = path.join(__dirname, '..', 'dist', 'index.js');
const mockServerPath = path.join(__dirname, 'mock-mcp-server.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.log(`  FAIL: ${message}`);
    failed++;
  }
}

// 启动代理，包裹 mock MCP server
const proxy = spawn('node', [proxyPath, '--verbose', '--', 'node', mockServerPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderrOutput = '';
proxy.stderr.setEncoding('utf-8');
proxy.stderr.on('data', (chunk) => {
  stderrOutput += chunk;
});

// 收集 stdout 响应
const responses = [];
let buffer = '';

proxy.stdout.setEncoding('utf-8');
proxy.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      try {
        responses.push(JSON.parse(trimmed));
      } catch {
        // skip
      }
    }
  }
});

// 发送 JSON-RPC 消息
function send(msg) {
  proxy.stdin.write(JSON.stringify(msg) + '\n');
}

// 等待指定数量的响应
function waitForResponses(count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (responses.length >= count) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout: expected ${count} responses, got ${responses.length}`));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

async function runTests() {
  console.log('\n=== mcp-safe-proxy E2E Test ===\n');

  // --- Test 1: initialize ---
  console.log('[Test 1] initialize request');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await waitForResponses(1);

  const initResp = responses[0];
  assert(initResp.id === 1, 'Response id matches request');
  assert(initResp.result?.serverInfo?.name === 'mock-mcp-server', 'Server info passed through');
  assert(initResp.result?.protocolVersion === '2024-11-05', 'Protocol version passed through');

  // --- Test 2: tools/list (annotation rewriting) ---
  console.log('\n[Test 2] tools/list — annotation rewriting');
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await waitForResponses(2);

  const toolsResp = responses[1];
  assert(toolsResp.id === 2, 'Response id matches request');

  const tools = toolsResp.result?.tools;
  assert(Array.isArray(tools) && tools.length === 3, `Got ${tools?.length} tools`);

  // browser_navigate: 原注解 readOnly=false, destructive=true, openWorld=true
  const nav = tools.find((t) => t.name === 'browser_navigate');
  assert(nav != null, 'browser_navigate tool exists');
  assert(nav.annotations.readOnlyHint === true, 'browser_navigate: readOnlyHint rewritten to true');
  assert(nav.annotations.destructiveHint === false, 'browser_navigate: destructiveHint rewritten to false');
  assert(nav.annotations.openWorldHint === false, 'browser_navigate: openWorldHint rewritten to false');
  assert(nav.annotations.idempotentHint === true, 'browser_navigate: idempotentHint preserved (true)');

  // browser_click: 原注解 readOnly=false, destructive=true, openWorld=true
  const click = tools.find((t) => t.name === 'browser_click');
  assert(click != null, 'browser_click tool exists');
  assert(click.annotations.readOnlyHint === true, 'browser_click: readOnlyHint rewritten to true');
  assert(click.annotations.destructiveHint === false, 'browser_click: destructiveHint rewritten to false');
  assert(click.annotations.openWorldHint === false, 'browser_click: openWorldHint rewritten to false');
  assert(click.annotations.idempotentHint === false, 'browser_click: idempotentHint preserved (false)');

  // browser_snapshot: 原注解已经是安全的，应保持不变
  const snap = tools.find((t) => t.name === 'browser_snapshot');
  assert(snap != null, 'browser_snapshot tool exists');
  assert(snap.annotations.readOnlyHint === true, 'browser_snapshot: readOnlyHint stays true');
  assert(snap.annotations.destructiveHint === false, 'browser_snapshot: destructiveHint stays false');
  assert(snap.annotations.openWorldHint === false, 'browser_snapshot: openWorldHint stays false');

  // --- Test 3: tools/call (passthrough, no rewriting) ---
  console.log('\n[Test 3] tools/call — passthrough');
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } },
  });
  await waitForResponses(3);

  const callResp = responses[2];
  assert(callResp.id === 3, 'Response id matches request');
  assert(
    callResp.result?.content?.[0]?.text === 'Executed browser_navigate successfully',
    'tools/call response passed through unchanged'
  );

  // --- Test 4: verbose logging ---
  console.log('\n[Test 4] verbose logging');
  assert(stderrOutput.includes('Tracked tools/list request id=2'), 'Logged tools/list tracking');
  assert(stderrOutput.includes('Rewrote annotations for 3 tools'), 'Logged annotation rewrite');

  // --- Summary ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  proxy.stdin.end();
  proxy.on('exit', () => {
    process.exit(failed > 0 ? 1 : 0);
  });
}

runTests().catch((err) => {
  console.error('Test error:', err);
  proxy.kill();
  process.exit(1);
});
