#!/usr/bin/env node

/**
 * 真实 Playwright MCP 对比测试
 *
 * Phase A: 直连 Playwright MCP，获取原始注解
 * Phase B: 通过 mcp-safe-proxy 代理连接，获取重写后注解
 * Phase C: 逐工具对比 before/after，自动断言
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
    clientInfo: { name: 'mcp-safe-proxy-test', version: '1.0.0' },
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

/**
 * 启动 MCP 会话并获取 tools/list 响应
 * @param {string} label - 阶段标签
 * @param {string} command - 启动命令
 * @param {string[]} args - 命令参数
 * @returns {Promise<object[]>} tools 数组
 */
function getToolsList(label, command, args) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${label}: Timeout waiting for tools/list response (15s)`));
    }, 15000);

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let stderrBuf = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => { stderrBuf += chunk; });

    const responses = [];
    let buffer = '';

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          responses.push(JSON.parse(trimmed));
        } catch {
          // 非 JSON 行忽略
        }
      }

      // 检查是否已收到 tools/list 响应 (id=2)
      const toolsResp = responses.find((r) => r.id === 2);
      if (toolsResp) {
        clearTimeout(timeout);
        const tools = toolsResp.result?.tools || [];
        // 关闭子进程
        child.stdin.end();
        setTimeout(() => child.kill(), 500);
        child.on('exit', () => resolve(tools));
        // 如果子进程不退出，强制 resolve
        setTimeout(() => resolve(tools), 2000);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`${label}: Failed to start: ${err.message}`));
    });

    // 发送 MCP 握手序列：initialize → notifications/initialized → tools/list
    child.stdin.write(JSON.stringify(INITIALIZE_REQUEST) + '\n');

    // 等待 initialize 响应后再发后续请求
    const waitForInit = () => {
      const initResp = responses.find((r) => r.id === 1);
      if (initResp) {
        child.stdin.write(JSON.stringify(INITIALIZED_NOTIFICATION) + '\n');
        child.stdin.write(JSON.stringify(TOOLS_LIST_REQUEST) + '\n');
      } else {
        setTimeout(waitForInit, 50);
      }
    };
    waitForInit();
  });
}

// ─── 对比与断言 ───────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    return true;
  } else {
    console.log(`    FAIL: ${message}`);
    failed++;
    return false;
  }
}

// ─── 主流程 ───────────────────────────────────────────────

async function main() {
  console.log('\n========================================');
  console.log('  mcp-safe-proxy Real Playwright Test');
  console.log('========================================\n');

  // --- Phase A: 直连 ---
  console.log('[Phase A] Direct connection to Playwright MCP (no proxy)...');
  let directTools;
  try {
    directTools = await getToolsList(
      'Phase A',
      'npx @playwright/mcp@latest',
      []
    );
    console.log(`  Received ${directTools.length} tools from Playwright MCP\n`);
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    process.exit(1);
  }

  // --- Phase B: 代理模式 ---
  console.log('[Phase B] Connection via mcp-safe-proxy...');
  let proxiedTools;
  try {
    proxiedTools = await getToolsList(
      'Phase B',
      `node ${proxyPath} --verbose -- npx @playwright/mcp@latest`,
      []
    );
    console.log(`  Received ${proxiedTools.length} tools via mcp-safe-proxy\n`);
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    process.exit(1);
  }

  // --- Phase C: 对比 ---
  console.log('[Phase C] Annotation comparison\n');

  // 基本断言
  assert(directTools.length > 0, 'Direct: got at least 1 tool');
  assert(proxiedTools.length > 0, 'Proxied: got at least 1 tool');
  assert(
    directTools.length === proxiedTools.length,
    `Tool count matches: direct=${directTools.length} proxied=${proxiedTools.length}`
  );

  // 表头
  const nameWidth = 30;
  const colWidth = 13;
  const header =
    'Tool'.padEnd(nameWidth) + ' | ' +
    'readOnly'.padEnd(colWidth) + '| ' +
    'destructive'.padEnd(colWidth) + '| ' +
    'openWorld'.padEnd(colWidth) + '| ' +
    'title preserved';
  console.log(header);
  console.log('-'.repeat(header.length + 5));

  // 构建 name → tool 索引
  const proxiedMap = new Map();
  for (const t of proxiedTools) {
    proxiedMap.set(t.name, t);
  }

  let rewriteCount = 0;

  for (const orig of directTools) {
    const prox = proxiedMap.get(orig.name);
    if (!prox) {
      console.log(`  ${orig.name.padEnd(nameWidth)} | MISSING in proxied response!`);
      failed++;
      continue;
    }

    const oa = orig.annotations || {};
    const pa = prox.annotations || {};

    // 判断原始是否为"危险"工具（需要重写的）
    const wasDangerous = oa.readOnlyHint === false || oa.destructiveHint === true || oa.openWorldHint === true;

    // 断言代理后的值
    const readOk = pa.readOnlyHint === true;
    const destOk = pa.destructiveHint === false;
    const openOk = pa.openWorldHint === false;
    const titleOk = !oa.title || pa.title === oa.title;

    const allOk = readOk && destOk && openOk && titleOk;

    if (wasDangerous && allOk) rewriteCount++;

    // 原始行
    const origLine =
      `${orig.name} ORIG`.padEnd(nameWidth) + ' | ' +
      `${oa.readOnlyHint}`.padEnd(colWidth) + '| ' +
      `${oa.destructiveHint}`.padEnd(colWidth) + '| ' +
      `${oa.openWorldHint}`.padEnd(colWidth) + '| ' +
      `${oa.title || '-'}`;

    // 代理行
    const status = allOk ? ' ✓' : ' ✗ FAIL';
    const proxLine =
      `${orig.name} PROXY`.padEnd(nameWidth) + ' | ' +
      `${pa.readOnlyHint}`.padEnd(colWidth) + '| ' +
      `${pa.destructiveHint}`.padEnd(colWidth) + '| ' +
      `${pa.openWorldHint}`.padEnd(colWidth) + '| ' +
      `${pa.title || '-'}` + status;

    console.log(origLine);
    console.log(proxLine);
    console.log('');

    assert(readOk, `${orig.name}: readOnlyHint === true`);
    assert(destOk, `${orig.name}: destructiveHint === false`);
    assert(openOk, `${orig.name}: openWorldHint === false`);
    if (oa.title) {
      assert(titleOk, `${orig.name}: title preserved`);
    }
  }

  console.log('========================================');
  console.log(`  Tools total: ${directTools.length}`);
  console.log(`  Annotations rewritten: ${rewriteCount} dangerous tools fixed`);
  console.log(`  Assertions: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
