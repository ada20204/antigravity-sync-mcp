import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createExecutableKillMatcher, createRestartPrimitive } = require('../src/services/launcher.js');

function createSpawnRecorder() {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      const child = {
        command,
        args,
        options,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        },
      };
      calls.push({ type: 'spawn', command, args, options, child });
      return child;
    },
  };
}

test('buildKillMatcher narrows matching to executable path when provided', () => {
  const matcher = createExecutableKillMatcher('/Applications/Antigravity.app/Contents/MacOS/Electron');

  assert.deepEqual(matcher, {
    pgrepArgs: ['-f', '/Applications/Antigravity.app/Contents/MacOS/Electron'],
    pkillArgs: ['-f', '/Applications/Antigravity.app/Contents/MacOS/Electron'],
    forceKillArgs: ['-9', '-f', '/Applications/Antigravity.app/Contents/MacOS/Electron'],
  });
});

test('restart uses provided executable and args', () => {
  const recorder = createSpawnRecorder();
  const restart = createRestartPrimitive({
    platform: 'darwin',
    spawn: recorder.spawn,
  });

  restart({
    executable: '/Applications/Antigravity.app/Contents/MacOS/Electron',
    args: ['/tmp/workspace', '--new-window', '--flag=value'],
    restart: false,
  });

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].command, 'bash');
  assert.deepEqual(recorder.calls[0].args, [
    '-c',
    'exec \'/Applications/Antigravity.app/Contents/MacOS/Electron\' \'/tmp/workspace\' \'--new-window\' \'--flag=value\'',
  ]);
  assert.equal(recorder.calls[0].child.unrefCalled, true);
});

test('restart quoting handles single quotes in executable and args', () => {
  const recorder = createSpawnRecorder();
  const restart = createRestartPrimitive({
    platform: 'darwin',
    spawn: recorder.spawn,
  });

  restart({
    executable: "/Applications/O'Brien/Antigravity",
    args: ["/tmp/it's workspace", "--label=O'Brien"],
    restart: false,
  });

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].command, 'bash');
  assert.deepEqual(recorder.calls[0].args, [
    '-c',
    `exec '/Applications/O'"'"'Brien/Antigravity' '/tmp/it'"'"'s workspace' '--label=O'"'"'Brien'`,
  ]);
});

test('windows launch spawns the executable directly', () => {
  const recorder = createSpawnRecorder();
  const restart = createRestartPrimitive({
    platform: 'win32',
    spawn: recorder.spawn,
  });

  restart({
    executable: 'C:\\Program Files\\Antigravity\\Antigravity.exe',
    args: ['C:\\workspace', '--new-window', '--remote-debugging-port=9002'],
    restart: false,
  });

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].command, 'C:\\Program Files\\Antigravity\\Antigravity.exe');
  assert.deepEqual(recorder.calls[0].args, ['C:\\workspace', '--new-window', '--remote-debugging-port=9002']);
  assert.deepEqual(recorder.calls[0].options, {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  });
  assert.equal(recorder.calls[0].child.unrefCalled, true);
});

test('restart path invokes process-kill flow before relaunch', () => {
  const recorder = createSpawnRecorder();
  const probeOutputs = ['1234\n', '1234\n', '1234\n', '1234\n', '1234\n', '1234\n', '1234\n', '1234\n', '1234\n', ''];
  const syncCalls = [];
  let nowValue = 0;

  const restart = createRestartPrimitive({
    platform: 'darwin',
    spawn: recorder.spawn,
    spawnSync(command, args, options) {
      syncCalls.push({ command, args, options });
      return { stdout: probeOutputs.shift() ?? '' };
    },
    now() {
      return nowValue;
    },
    wait(ms) {
      nowValue += ms;
    },
  });

  restart({
    executable: '/Applications/Antigravity.app/Contents/MacOS/Electron',
    args: [],
    restart: true,
    killMatcher: {
      pgrepArgs: ['-f', 'Antigravity --profile task3'],
      pkillArgs: ['-f', 'Antigravity --profile task3'],
      forceKillArgs: ['-9', '-f', 'Antigravity --profile task3'],
    },
  });

  assert.equal(recorder.calls[0].command, 'pkill');
  assert.deepEqual(recorder.calls[0].args, ['-f', 'Antigravity --profile task3']);
  assert.equal(recorder.calls[1].command, 'pkill');
  assert.deepEqual(recorder.calls[1].args, ['-9', '-f', 'Antigravity --profile task3']);
  assert.equal(recorder.calls[2].command, 'bash');
  assert.ok(syncCalls.length >= 4);
  for (const call of syncCalls) {
    assert.deepEqual(call.args, ['-f', 'Antigravity --profile task3']);
  }
});

test('caller can opt into waiting/probing hooks without UI dependencies', () => {
  const recorder = createSpawnRecorder();
  let nowValue = 0;
  const events = [];

  const restart = createRestartPrimitive({
    platform: 'darwin',
    spawn: recorder.spawn,
    spawnSync() {
      return { stdout: '' };
    },
    now() {
      return nowValue;
    },
    wait(ms) {
      events.push(`wait:${ms}`);
      nowValue += ms;
    },
  });

  restart({
    executable: '/Applications/Antigravity.app/Contents/MacOS/Electron',
    args: ['--new-window'],
    restart: true,
    observer: {
      onKillStart() {
        events.push('kill-start');
      },
      onProbe({ phase }) {
        events.push(`probe:${phase}`);
      },
      onKillComplete({ forced }) {
        events.push(`kill-complete:${forced}`);
      },
      onBeforeLaunch({ executable, args, restart }) {
        events.push(`before-launch:${restart}:${executable}:${args.join(' ')}`);
      },
      onAfterLaunch({ restart }) {
        events.push(`after-launch:${restart}`);
      },
    },
  });

  assert.deepEqual(events, [
    'kill-start',
    'probe:term-check',
    'kill-complete:false',
    'before-launch:true:/Applications/Antigravity.app/Contents/MacOS/Electron:--new-window',
    'after-launch:true',
  ]);
  assert.equal(recorder.calls.at(-1).command, 'bash');
});
