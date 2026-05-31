import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isPackageInstallationPresent, main } from '../lib/cce/commands.js';

const testRoot = path.resolve('tests/tmp');
fs.rmSync(testRoot, { recursive: true, force: true });
fs.mkdirSync(testRoot, { recursive: true });

const installRoot = path.join(testRoot, 'install-root');
fs.mkdirSync(path.join(installRoot, 'bin'), { recursive: true });
assert.equal(isPackageInstallationPresent(installRoot), false);
fs.writeFileSync(path.join(installRoot, 'package.json'), '{}\n', 'utf8');
assert.equal(isPackageInstallationPresent(installRoot), false);
fs.writeFileSync(path.join(installRoot, 'bin', 'cce.js'), '#!/usr/bin/env node\n', 'utf8');
assert.equal(isPackageInstallationPresent(installRoot), true);
fs.rmSync(path.join(installRoot, 'package.json'));
assert.equal(isPackageInstallationPresent(installRoot), false);

async function captureStdout(callback) {
  const originalLog = console.log;
  const lines = [];
  console.log = (message = '') => {
    lines.push(String(message));
  };
  try {
    const code = await callback();
    return { code, stdout: `${lines.join('\n')}\n` };
  } finally {
    console.log = originalLog;
  }
}

async function captureConsole(callback) {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout = [];
  const stderr = [];
  console.log = (message = '') => {
    stdout.push(String(message));
  };
  console.error = (message = '') => {
    stderr.push(String(message));
  };
  try {
    const code = await callback();
    return {
      code,
      stdout: `${stdout.join('\n')}\n`,
      stderr: `${stderr.join('\n')}\n`,
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const help = await captureStdout(() => main(['--help']));
assert.equal(help.code, 0);
assert.match(help.stdout, /cli-chat-exporter/);
assert.match(help.stdout, /Usage:/);
assert.match(help.stdout, /export/);
assert.match(help.stdout, /service/);
assert.match(help.stdout, /doctor/);
assert.doesNotMatch(help.stdout, /--user/);
assert.doesNotMatch(help.stdout, /sudo/i);

const helpAlias = await captureStdout(() => main(['help']));
assert.equal(helpAlias.code, 0);
assert.equal(helpAlias.stdout, help.stdout);

const version = await captureStdout(() => main(['--version']));
assert.equal(version.code, 0);
assert.match(version.stdout, /@benryoung\/cli-chat-exporter 0\.3\.2/);

const staleConfigPath = path.join(testRoot, 'stale-config.json');
fs.writeFileSync(
  staleConfigPath,
  JSON.stringify({
    user: 'all',
    output: '/tmp/cce-legacy-output',
    schedule: { earliest: '00:00', latest: '01:00', interval: '1h' },
    runtime: {
      log_dir: path.join(testRoot, 'logs'),
      pid_file: path.join(testRoot, 'cce.pid'),
      state_file: path.join(testRoot, 'state.json'),
    },
  }, null, 2),
  'utf8',
);

process.env.CCE_CONFIG = staleConfigPath;
const config = await captureStdout(() => main(['config', 'get']));
assert.equal(config.code, 0);
const parsed = JSON.parse(config.stdout);
assert.equal(Object.hasOwn(parsed, 'user'), false);
assert.equal(parsed.source, 'all');

await assert.rejects(
  () => main(['config', 'set', '--user', 'all']),
  /Unknown option: --user/,
);

await assert.rejects(
  () => main(['config', 'init', '--yes', '--user', 'all']),
  /Unknown option: --user/,
);

await assert.rejects(
  () => main(['export', '--user', 'all']),
  /Unknown option: --user/,
);

await assert.rejects(
  () => main(['export', '--platform', 'ubuntu']),
  /Unknown option: --platform/,
);

await assert.rejects(
  () => main(['export', 'all']),
  /Unknown argument: all/,
);

const setConfig = await captureStdout(() => main(['config', 'set', '--output', '/tmp/cce-next-output']));
assert.equal(setConfig.code, 0);
const setParsed = JSON.parse(setConfig.stdout);
assert.equal(Object.hasOwn(setParsed, 'user'), false);
assert.equal(setParsed.output, '/tmp/cce-next-output');

const initConfigPath = path.join(testRoot, 'init-config.json');
process.env.CCE_CONFIG = initConfigPath;
const initConfig = await captureStdout(() => main(['config', 'init', '--yes']));
assert.equal(initConfig.code, 0);
assert.equal(Object.hasOwn(JSON.parse(initConfig.stdout), 'user'), false);

const serviceConfigPath = path.join(testRoot, 'service-config.json');
const servicePidFile = path.join(testRoot, 'service.pid');
const serviceStateFile = path.join(testRoot, 'service-state.json');
fs.writeFileSync(
  serviceConfigPath,
  JSON.stringify({
    source: 'codex',
    format: 'md',
    output: path.join(testRoot, 'service-output'),
    schedule: { earliest: '00:00', latest: '23:00', interval: '1h' },
    runtime: {
      python: process.execPath,
      log_dir: path.join(testRoot, 'service-logs'),
      pid_file: servicePidFile,
      state_file: serviceStateFile,
    },
  }, null, 2),
  'utf8',
);

process.env.CCE_CONFIG = serviceConfigPath;
let servicePid = null;
try {
  const serviceStart = await captureConsole(() => main(['service', 'start']));
  assert.equal(serviceStart.code, 0, serviceStart.stderr);
  assert.match(serviceStart.stdout, /cce service started; pid=\d+; log=/);
  assert.ok(fs.existsSync(servicePidFile), 'service start should confirm pid file creation');
  servicePid = Number.parseInt(fs.readFileSync(servicePidFile, 'utf8'), 10);
  assert.equal(Number.isInteger(servicePid), true);
  assert.equal(isProcessAlive(servicePid), true);

  const serviceStop = await captureConsole(() => main(['service', 'stop']));
  assert.equal(serviceStop.code, 0, serviceStop.stderr);
  assert.match(serviceStop.stdout, new RegExp(`stopped cce service pid ${servicePid}`));
  assert.equal(fs.existsSync(servicePidFile), false);
} finally {
  if (servicePid && isProcessAlive(servicePid)) {
    process.kill(servicePid, 'SIGTERM');
  }
}

const badLogPath = path.join(testRoot, 'bad-service-log-path');
fs.writeFileSync(badLogPath, 'not a directory\n', 'utf8');
const badServiceConfigPath = path.join(testRoot, 'bad-service-config.json');
fs.writeFileSync(
  badServiceConfigPath,
  JSON.stringify({
    runtime: {
      log_dir: badLogPath,
      pid_file: path.join(testRoot, 'bad-service.pid'),
      state_file: path.join(testRoot, 'bad-service-state.json'),
    },
  }, null, 2),
  'utf8',
);
process.env.CCE_CONFIG = badServiceConfigPath;
const badServiceStart = await captureConsole(() => main(['service', 'start']));
assert.equal(badServiceStart.code, 1);
assert.match(badServiceStart.stderr, /failed to prepare cce service log/);

const commandSource = fs.readFileSync('lib/cce/commands.js', 'utf8');
assert.doesNotMatch(commandSource, /sudo/i);
assert.doesNotMatch(commandSource, /rejectUserScopeFlag/);
assert.doesNotMatch(commandSource, /current local user/);
assert.doesNotMatch(commandSource, /--platform/);
assert.match(commandSource, /windowsHide: true/);

console.log('node cli tests passed');
