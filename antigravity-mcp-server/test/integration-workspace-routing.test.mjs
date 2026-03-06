#!/usr/bin/env node
/**
 * integration-workspace-routing.test.mjs
 *
 * Smart Workspace Routing 集成测试
 * 直接测试 cdp.js 和 index.js 的导出函数，绕过 MCP 协议层
 * 使用模拟的 registry 文件和 fetch 函数验证核心逻辑
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 配置 - 使用相对路径，从 test/ 目录解析到 build/dist/
const SERVER_BUILD_DIR = join(__dirname, '..', 'build', 'dist');
const TEST_REGISTRY_DIR = join(os.tmpdir(), `ag-mcp-integration-test-${process.pid}`);

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function log(level, message) {
  const color = {
    INFO: colors.blue,
    PASS: colors.green,
    FAIL: colors.red,
    WARN: colors.yellow,
  }[level] || colors.reset;

  console.log(`${color}[${level}]${colors.reset} ${message}`);
}

// 测试统计
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const testResults = [];

// 创建 registry 文件
function createRegistry(filename, content) {
  const filepath = join(TEST_REGISTRY_DIR, filename);
  fs.mkdirSync(TEST_REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(content, null, 2));
  return filepath;
}

// 断言函数
function assert(condition, testName, details = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    log('PASS', testName);
    testResults.push(`✓ ${testName}`);
    return true;
  } else {
    failedTests++;
    log('FAIL', testName + (details ? ` - ${details}` : ''));
    testResults.push(`✗ ${testName}`);
    return false;
  }
}

// ============================================================================
// 测试套件
// ============================================================================

async function testCDPDiscovery() {
  console.log('\n========================================');
  console.log('Test Suite: CDP Discovery');
  console.log('========================================\n');

  // 动态导入模块
  const cdpModule = await import(pathToFileURL(join(SERVER_BUILD_DIR, 'cdp.js')).href);
  const { discoverCDPDetailed, computeWorkspaceId } = cdpModule;

  // Test 1: 空 registry 返回 no_workspace_ever_opened
  log('INFO', 'Test 1: Empty registry returns no_workspace_ever_opened');
  const emptyRegistry = createRegistry('empty.json', {});
  process.env.ANTIGRAVITY_REGISTRY_FILE = emptyRegistry;

  try {
    const result = await discoverCDPDetailed('/tmp/any-path');
    assert(
      result.ok === false && result.error?.code === 'no_workspace_ever_opened',
      'Empty registry error code',
      `got: ${result.error?.code}`
    );
  } catch (err) {
    assert(false, 'Empty registry test', err.message);
  }

  // Test 2: 只有 __control__ 的 registry
  log('INFO', 'Test 2: Registry with only __control__ key');
  const controlOnlyRegistry = createRegistry('control-only.json', {
    __control__: { ping: true },
  });
  process.env.ANTIGRAVITY_REGISTRY_FILE = controlOnlyRegistry;

  try {
    const result = await discoverCDPDetailed('/tmp/any-path');
    assert(
      result.ok === false && result.error?.code === 'no_workspace_ever_opened',
      'Control-only registry error code'
    );
  } catch (err) {
    assert(false, 'Control-only registry test', err.message);
  }

  // Test 3: 单个 ready workspace - 无 targetDir (auto_fallback)
  log('INFO', 'Test 3: Single ready workspace without targetDir');
  const workspacePath = '/tmp/test-workspace';
  const workspaceId = computeWorkspaceId(workspacePath);

  const singleRegistry = createRegistry('single-ready.json', {
    [workspacePath]: {
      schema_version: 2,
      workspace_id: workspaceId,
      workspace_paths: { raw: workspacePath },
      role: 'host',
      state: 'ready',
      verified_at: Date.now(),
      ttl_ms: 30000,
      local_endpoint: { host: '127.0.0.1', port: 9222, mode: 'direct' },
    },
  });
  process.env.ANTIGRAVITY_REGISTRY_FILE = singleRegistry;

  try {
    // Mock fetch for CDP list endpoint
    global.fetch = async () => ({
      json: async () => [
        {
          id: 'target-1',
          title: 'Antigravity',
          url: 'file:///workbench.html',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
          type: 'page',
        },
      ],
    });

    const result = await discoverCDPDetailed(undefined); // 无 targetDir
    assert(result.ok === true, 'Discovery succeeded');
    assert(
      result.discovered?.matchMode === 'auto_fallback',
      'Match mode is auto_fallback',
      `got: ${result.discovered?.matchMode}`
    );
    assert(
      result.discovered?.workspaceKey === workspaceId,
      'Workspace key matches',
      `got: ${result.discovered?.workspaceKey}`
    );
  } catch (err) {
    assert(false, 'Single workspace auto-fallback test', err.message);
  } finally {
    delete global.fetch;
  }

  // Test 4: 精确匹配 (exact)
  log('INFO', 'Test 4: Exact match with targetDir');
  process.env.ANTIGRAVITY_REGISTRY_FILE = singleRegistry;

  try {
    global.fetch = async () => ({
      json: async () => [
        {
          id: 'target-1',
          title: 'Antigravity',
          url: 'file:///workbench.html',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
          type: 'page',
        },
      ],
    });

    const result = await discoverCDPDetailed(workspacePath); // 精确路径
    assert(result.ok === true, 'Discovery succeeded');
    assert(
      result.discovered?.matchMode === 'exact',
      'Match mode is exact',
      `got: ${result.discovered?.matchMode}`
    );
  } catch (err) {
    assert(false, 'Exact match test', err.message);
  } finally {
    delete global.fetch;
  }

  // Test 5: targetDir 不匹配，回退到 ready 条目
  log('INFO', 'Test 5: targetDir mismatch, fallback to ready entry');
  process.env.ANTIGRAVITY_REGISTRY_FILE = singleRegistry;

  try {
    global.fetch = async () => ({
      json: async () => [
        {
          id: 'target-1',
          title: 'Antigravity',
          url: 'file:///workbench.html',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
          type: 'page',
        },
      ],
    });

    const result = await discoverCDPDetailed('/tmp/wrong-path'); // 不匹配的路径
    assert(result.ok === true, 'Discovery succeeded with fallback');
    assert(
      result.discovered?.matchMode === 'auto_fallback',
      'Match mode is auto_fallback for mismatch',
      `got: ${result.discovered?.matchMode}`
    );
  } catch (err) {
    assert(false, 'Fallback test', err.message);
  } finally {
    delete global.fetch;
  }

  // Test 6: 多个 workspace，选择高优先级
  log('INFO', 'Test 6: Multiple workspaces, select high priority');
  const multiRegistry = createRegistry('multi-priority.json', {
    '/tmp/workspace-low': {
      schema_version: 2,
      workspace_id: 'ws-low',
      workspace_paths: { raw: '/tmp/workspace-low' },
      role: 'host',
      state: 'ready',
      verified_at: Date.now(),
      ttl_ms: 30000,
      priority: 5,
      local_endpoint: { host: '127.0.0.1', port: 9222, mode: 'direct' },
    },
    '/tmp/workspace-high': {
      schema_version: 2,
      workspace_id: 'ws-high',
      workspace_paths: { raw: '/tmp/workspace-high' },
      role: 'host',
      state: 'ready',
      verified_at: Date.now(),
      ttl_ms: 30000,
      priority: 10,
      local_endpoint: { host: '127.0.0.1', port: 9223, mode: 'direct' },
    },
  });
  process.env.ANTIGRAVITY_REGISTRY_FILE = multiRegistry;

  try {
    global.fetch = async (url) => {
      // 根据端口返回不同的 CDP target
      const port = url.includes('9223') ? 9223 : 9222;
      return {
        json: async () => [
          {
            id: `target-${port}`,
            title: 'Antigravity',
            url: 'file:///workbench.html',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1`,
            type: 'page',
          },
        ],
      };
    };

    const result = await discoverCDPDetailed(undefined); // 无 targetDir
    assert(result.ok === true, 'Discovery succeeded');
    assert(
      result.discovered?.workspaceKey === 'ws-high',
      'Selected high priority workspace',
      `got: ${result.discovered?.workspaceKey}`
    );
  } catch (err) {
    assert(false, 'Priority selection test', err.message);
  } finally {
    delete global.fetch;
  }

  // Test 7: entry_not_ready 状态
  log('INFO', 'Test 7: entry_not_ready state');
  const notReadyRegistry = createRegistry('not-ready.json', {
    '/tmp/not-ready': {
      schema_version: 2,
      workspace_id: 'not-ready-id',
      workspace_paths: { raw: '/tmp/not-ready' },
      role: 'host',
      state: 'app_down',
      verified_at: Date.now(),
      ttl_ms: 30000,
      local_endpoint: { host: '127.0.0.1', port: 9222, mode: 'direct' },
    },
  });
  process.env.ANTIGRAVITY_REGISTRY_FILE = notReadyRegistry;

  try {
    const result = await discoverCDPDetailed('/tmp/not-ready');
    assert(
      result.ok === false && result.error?.code === 'entry_not_ready',
      'Not ready error code',
      `got: ${result.error?.code}`
    );
    assert(
      result.error?.state === 'app_down',
      'State is app_down',
      `got: ${result.error?.state}`
    );
  } catch (err) {
    assert(false, 'Not ready test', err.message);
  }

  // Test 8: entry_stale 状态
  log('INFO', 'Test 8: entry_stale state');
  const staleRegistry = createRegistry('stale.json', {
    '/tmp/stale': {
      schema_version: 2,
      workspace_id: 'stale-id',
      workspace_paths: { raw: '/tmp/stale' },
      role: 'host',
      state: 'ready',
      verified_at: Date.now() - 120000, // 2 分钟前
      ttl_ms: 10000, // 10 秒 TTL
      local_endpoint: { host: '127.0.0.1', port: 9222, mode: 'direct' },
    },
  });
  process.env.ANTIGRAVITY_REGISTRY_FILE = staleRegistry;

  try {
    const result = await discoverCDPDetailed('/tmp/stale');
    assert(
      result.ok === false && result.error?.code === 'entry_stale',
      'Stale error code',
      `got: ${result.error?.code}`
    );
  } catch (err) {
    assert(false, 'Stale test', err.message);
  }
}

async function testWorkspaceRouting() {
  console.log('\n========================================');
  console.log('Test Suite: Workspace Routing');
  console.log('========================================\n');

  // 动态导入模块
  const indexModule = await import(pathToFileURL(join(SERVER_BUILD_DIR, 'index.js')).href);
  const { __testExports } = indexModule;

  if (!__testExports) {
    log('WARN', 'Test exports not available, skipping workspace routing tests');
    return;
  }

  const {
    activeAskTasks,
    claimWorkspaceTask,
    handleStop,
    handleListWorkspaces,
    NO_WORKSPACE_GUIDANCE,
  } = __testExports;

  // 清理状态
  activeAskTasks.clear();

  // Test 1: 并发任务声明
  log('INFO', 'Test 1: Concurrent workspace task claims');
  const { createAskTask } = await import(pathToFileURL(join(SERVER_BUILD_DIR, 'task-runtime.js')).href);

  try {
    const taskA = createAskTask('test-a');
    const taskB = createAskTask('test-b');

    claimWorkspaceTask('workspace-a', taskA);
    claimWorkspaceTask('workspace-b', taskB);

    assert(activeAskTasks.size === 2, 'Two tasks claimed');
    assert(activeAskTasks.get('workspace-a')?.id === taskA.id, 'Task A claimed');
    assert(activeAskTasks.get('workspace-b')?.id === taskB.id, 'Task B claimed');
  } catch (err) {
    assert(false, 'Concurrent claims test', err.message);
  }

  // Test 2: 同一 workspace 不能重复声明
  log('INFO', 'Test 2: Same workspace cannot be claimed twice');
  try {
    const task1 = createAskTask('test-1');
    const task2 = createAskTask('test-2');

    claimWorkspaceTask('workspace-x', task1);

    let errorThrown = false;
    try {
      claimWorkspaceTask('workspace-x', task2);
    } catch (err) {
      errorThrown = true;
    }

    assert(errorThrown, 'Second claim throws error');
  } catch (err) {
    assert(false, 'Duplicate claim test', err.message);
  }

  // 清理
  activeAskTasks.clear();

  // Test 3: handleStop 多任务时需要 targetDir
  log('INFO', 'Test 3: handleStop with multiple tasks requires targetDir');
  try {
    const taskA = createAskTask('stop-a');
    const taskB = createAskTask('stop-b');

    claimWorkspaceTask('workspace-alpha', taskA);
    claimWorkspaceTask('workspace-beta', taskB);

    let errorThrown = false;
    try {
      await handleStop(undefined);
    } catch (err) {
      errorThrown = err.message.includes('Multiple workspaces');
    }

    assert(errorThrown, 'Stop without targetDir throws error');
  } catch (err) {
    assert(false, 'Stop multi-task test', err.message);
  }

  // 清理
  activeAskTasks.clear();

  // Test 4: list-workspaces 不建立 CDP 连接
  log('INFO', 'Test 4: list-workspaces does not open CDP connection');
  const listRegistry = createRegistry('list-test.json', {
    '/tmp/list-test': {
      schema_version: 2,
      workspace_id: 'list-test-id',
      workspace_paths: { raw: '/tmp/list-test' },
      role: 'host',
      state: 'ready',
      verified_at: Date.now(),
      ttl_ms: 30000,
      local_endpoint: { host: '127.0.0.1', port: 9222, mode: 'direct' },
      quota: {
        promptCredits: { remainingPercentage: 75 },
        models: [{ modelId: 'test-model' }],
      },
    },
  });
  process.env.ANTIGRAVITY_REGISTRY_FILE = listRegistry;

  try {
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called');
    };

    const result = await handleListWorkspaces();
    const data = JSON.parse(result);

    assert(!fetchCalled, 'Fetch not called');
    assert(data.workspaces.length === 1, 'One workspace listed');
    assert(data.workspaces[0].workspacePath === '/tmp/list-test', 'Correct path');
  } catch (err) {
    assert(false, 'List workspaces test', err.message);
  } finally {
    delete global.fetch;
  }

  // Test 5: NO_WORKSPACE_GUIDANCE 不包含 auto-launch
  log('INFO', 'Test 5: NO_WORKSPACE_GUIDANCE does not suggest auto-launch');
  assert(
    NO_WORKSPACE_GUIDANCE.includes('Open Antigravity'),
    'Guidance mentions opening Antigravity'
  );
  assert(
    NO_WORKSPACE_GUIDANCE.includes('authorization'),
    'Guidance mentions authorization'
  );
  assert(
    !NO_WORKSPACE_GUIDANCE.match(/auto-launch|launch antigravity/i),
    'Guidance does not suggest auto-launch'
  );
}

// ============================================================================
// 主函数
// ============================================================================

async function main() {
  console.log('========================================');
  console.log('Smart Workspace Routing - Direct Test');
  console.log('========================================\n');

  // 检查构建产物
  if (!fs.existsSync(join(SERVER_BUILD_DIR, 'cdp.js'))) {
    log('FAIL', `Build not found at: ${SERVER_BUILD_DIR}`);
    log('INFO', 'Run: cd ~/antigravity-sync-mcp/antigravity-mcp-server && npm run build');
    process.exit(1);
  }

  // 创建测试目录
  fs.mkdirSync(TEST_REGISTRY_DIR, { recursive: true });

  try {
    // 运行测试套件
    await testCDPDiscovery();
    await testWorkspaceRouting();

    // 生成报告
    console.log('\n========================================');
    console.log('Test Report');
    console.log('========================================\n');
    console.log(`Total Tests: ${totalTests}`);
    console.log(`Passed: ${passedTests}`);
    console.log(`Failed: ${failedTests}`);
    console.log('');

    if (failedTests === 0) {
      log('PASS', 'All tests passed! ✨');
      console.log('\nSummary:');
      testResults.forEach(result => console.log(`  ${result}`));
      process.exit(0);
    } else {
      log('FAIL', 'Some tests failed');
      console.log('\nSummary:');
      testResults.forEach(result => console.log(`  ${result}`));
      process.exit(1);
    }
  } finally {
    // 清理测试目录
    if (fs.existsSync(TEST_REGISTRY_DIR)) {
      fs.rmSync(TEST_REGISTRY_DIR, { recursive: true, force: true });
    }
    delete process.env.ANTIGRAVITY_REGISTRY_FILE;
  }
}

main().catch(err => {
  log('FAIL', `Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
