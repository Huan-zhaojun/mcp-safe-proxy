#!/usr/bin/env node

/**
 * 参数透传验证测试
 *
 * 通过对比三种启动方式下 tools/list 返回的工具数量，
 * 验证 mcp-safe-proxy 是否正确透传 CLI 参数给下游 MCP Server。
 *
 * Phase A: 直连 Playwright MCP（无额外参数）→ 基准工具数 N
 * Phase B: 直连 Playwright MCP + --caps=vision → 工具数 N+M
 * Phase C: 通过代理 + --caps=vision → 工具数应 = N+M（验证透传）
 */

const { spawn } = require('child_process');
const path = require('path');

const proxyPath = path.join(__dirname, '..', 'dist', 'index.js');

// ─── MCP 协议消息 ─────────────────────────────────────────

const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'passthrough-test', version: '1.0.0' },
  },
};

const INITIALIZED_NOTIFICATION = {
  jsonrpc: '2.0',
  method: 'notifications/initialized',
  params: {},
};

const TOOLS_LIST_REQUEST = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
  params: {},
};

// ─── 工具函数 ─────────────────────────────────────────────

/** 启动 MCP 会话并获取 tools/list 响应 */
function getToolsList(label, command, args) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${label}: Timeout (15s)`));
    }, 15000);

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let buffer = '';
    const responses = [];

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { responses.push(JSON.parse(trimmed)); } catch {}
      }

      // 找到 tools/list 响应（id=2 且有 result.tools）
      const toolsResponse = responses.find(
        (r) => r.id === 2 && r.result && r.result.tools
      );
      if (toolsResponse) {
        clearTimeout(timeout);
        child.kill();
        resolve(toolsResponse.result.tools);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`${label}: ${err.message}`));
    });

    // 发送 MCP 握手 + tools/list 请求
    child.stdin.write(JSON.stringify(INITIALIZE_REQUEST) + '\n');
    setTimeout(() => {
      child.stdin.write(JSON.stringify(INITIALIZED_NOTIFICATION) + '\n');
      child.stdin.write(JSON.stringify(TOOLS_LIST_REQUEST) + '\n');
    }, 500);
  });
}

/** 提取工具名列表 */
function getToolNames(tools) {
  return tools.map((t) => t.name).sort();
}

// ─── 主流程 ───────────────────────────────────────────────

async function main() {
  console.log('=== mcp-safe-proxy 参数透传验证测试 ===\n');

  // Phase A: 直连 Playwright MCP（无额外参数）
  console.log('[Phase A] 直连 Playwright MCP（无额外参数）');
  const toolsA = await getToolsList(
    'Phase A',
    'npx', ['@playwright/mcp@latest']
  );
  const namesA = getToolNames(toolsA);
  console.log(`  工具数: ${toolsA.length}`);

  // Phase B: 直连 Playwright MCP + --caps=vision
  console.log('\n[Phase B] 直连 Playwright MCP + --caps=vision');
  const toolsB = await getToolsList(
    'Phase B',
    'npx', ['@playwright/mcp@latest', '--caps=vision']
  );
  const namesB = getToolNames(toolsB);
  console.log(`  工具数: ${toolsB.length}`);

  // 找出 vision 新增的工具
  const visionTools = namesB.filter((name) => !namesA.includes(name));
  console.log(`  vision 新增工具 (${visionTools.length}): ${visionTools.join(', ')}`);

  // Phase C: 通过代理 + --caps=vision
  console.log('\n[Phase C] 通过 mcp-safe-proxy 代理 + --caps=vision');
  const toolsC = await getToolsList(
    'Phase C',
    'node', [proxyPath, '--verbose', '--', 'npx', '@playwright/mcp@latest', '--caps=vision']
  );
  const namesC = getToolNames(toolsC);
  console.log(`  工具数: ${toolsC.length}`);

  // ─── 结果对比 ───────────────────────────────────────────

  console.log('\n=== 对比结果 ===\n');
  console.log(`  Phase A（直连无参数）:       ${toolsA.length} 工具`);
  console.log(`  Phase B（直连 + vision）:    ${toolsB.length} 工具`);
  console.log(`  Phase C（代理 + vision）:    ${toolsC.length} 工具`);

  let passed = 0;
  let failed = 0;

  // 断言 1: vision 参数确实增加了工具
  if (toolsB.length > toolsA.length) {
    console.log(`\n  PASS: --caps=vision 增加了 ${toolsB.length - toolsA.length} 个工具`);
    passed++;
  } else {
    console.log(`\n  FAIL: --caps=vision 未增加工具（B=${toolsB.length} vs A=${toolsA.length}）`);
    failed++;
  }

  // 断言 2: 代理透传后工具数与直连一致
  if (toolsC.length === toolsB.length) {
    console.log(`  PASS: 代理透传参数成功（C=${toolsC.length} == B=${toolsB.length}）`);
    passed++;
  } else {
    console.log(`  FAIL: 代理透传参数失败（C=${toolsC.length} != B=${toolsB.length}）`);
    failed++;
  }

  // 断言 3: 代理返回的工具名完全一致
  const missingInC = namesB.filter((n) => !namesC.includes(n));
  const extraInC = namesC.filter((n) => !namesB.includes(n));
  if (missingInC.length === 0 && extraInC.length === 0) {
    console.log(`  PASS: 工具名列表完全一致`);
    passed++;
  } else {
    console.log(`  FAIL: 工具名不一致 — 缺少: [${missingInC}], 多余: [${extraInC}]`);
    failed++;
  }

  // 断言 4: 代理重写了注解
  const actionTool = toolsC.find((t) => t.name === 'browser_navigate');
  if (actionTool && actionTool.annotations) {
    const a = actionTool.annotations;
    if (a.readOnlyHint === true && a.destructiveHint === false && a.openWorldHint === false) {
      console.log(`  PASS: 注解重写生效（browser_navigate: readOnly=true, destructive=false, openWorld=false）`);
      passed++;
    } else {
      console.log(`  FAIL: 注解未正确重写 — ${JSON.stringify(a)}`);
      failed++;
    }
  } else {
    console.log(`  FAIL: 未找到 browser_navigate 工具或无 annotations`);
    failed++;
  }

  console.log(`\n=== 总计: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
