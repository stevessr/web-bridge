import { access, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';

const execFileAsync = promisify(execFile);

const DEFAULT_NAMES = ['qq', 'linuxqq', 'QQ'];
const FIXED_CANDIDATES = [
  { path: '/opt/QQ/qq', source: 'well-known-direct-host', priority: 5 },
  { path: '/opt/qq/qq', source: 'well-known-direct-host', priority: 5 },
  { path: '/usr/bin/linuxqq', source: 'well-known-launcher', priority: 25 },
  { path: '/usr/bin/qq', source: 'well-known-launcher', priority: 25 },
  { path: '/usr/local/bin/linuxqq', source: 'well-known-launcher', priority: 30 },
  { path: '/usr/local/bin/qq', source: 'well-known-launcher', priority: 30 },
  { path: '/snap/bin/qq', source: 'well-known-launcher', priority: 35 }
];

export function tokenizeDesktopExec(value) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const ch of String(value ?? '')) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += '\\';
  if (current) tokens.push(current);
  return tokens;
}

export function extractExecutableFromDesktopExec(execLine) {
  const tokens = tokenizeDesktopExec(execLine).filter((token) => !/^%[fFuUdDnNickvm]$/.test(token));
  if (!tokens.length) return null;

  let index = 0;
  if (basename(tokens[index]) === 'env') {
    index += 1;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  }

  return tokens[index] || null;
}

export function qqCandidatePriority(path, source = '') {
  const normalized = String(path || '');
  if (/^\/opt\/(?:QQ|qq)\/qq$/.test(normalized)) return 5;
  if (String(source).startsWith('running-process:')) return 10;
  if (String(source).startsWith('PATH:')) return 20;
  if (String(source).startsWith('desktop:')) return 30;
  if (String(source).startsWith('package:')) return 40;
  if (String(source).startsWith('user-app:')) return 50;
  return 60;
}

async function isExecutable(path) {
  if (!path) return false;
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function canonical(path) {
  try { return await realpath(path); } catch { return resolve(path); }
}

function pathEntries(env = process.env) {
  return String(env.PATH || '').split(':').filter(Boolean);
}

async function resolveCommand(command, env = process.env) {
  if (!command) return null;
  if (isAbsolute(command) || command.includes('/')) {
    const absolute = isAbsolute(command) ? command : resolve(command);
    return await isExecutable(absolute) ? absolute : null;
  }
  for (const dir of pathEntries(env)) {
    const candidate = join(dir, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function addCandidate(results, seen, path, source, priority, env = process.env) {
  const resolved = await resolveCommand(path, env);
  if (!resolved) return;
  const normalized = await canonical(resolved);
  if (seen.has(normalized)) return;
  seen.add(normalized);
  results.push({ path: normalized, source, priority: priority ?? qqCandidatePriority(normalized, source) });
}

async function discoverFromPath(results, seen, env) {
  for (const name of DEFAULT_NAMES) {
    const command = await resolveCommand(name, env);
    if (command) await addCandidate(results, seen, command, `PATH:${name}`, undefined, env);
  }
}

async function discoverDesktopEntries(results, seen, env) {
  const home = env.HOME || homedir();
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const dataDirs = String(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  const dirs = [join(dataHome, 'applications'), ...dataDirs.map((dir) => join(dir, 'applications'))];

  for (const dir of [...new Set(dirs)]) {
    let files;
    try { files = await readdir(dir); } catch { continue; }
    const preferred = files.filter((name) => /(?:^|[-_.])(qq|linuxqq|tencent)(?:[-_.]|$)/i.test(name));
    const fallback = files.filter((name) => name.endsWith('.desktop') && !preferred.includes(name));

    for (const name of [...preferred, ...fallback]) {
      if (!name.endsWith('.desktop')) continue;
      let content;
      try { content = await readFile(join(dir, name), 'utf8'); } catch { continue; }
      if (!preferred.includes(name) && !/(^|\n)(Name|GenericName)=.*\bQQ\b/i.test(content)) continue;
      const exec = content.match(/^Exec=(.+)$/m)?.[1];
      const executable = extractExecutableFromDesktopExec(exec);
      if (executable) await addCandidate(results, seen, executable, `desktop:${join(dir, name)}`, undefined, env);
    }
  }
}

async function discoverRunningProcesses(results, seen, env) {
  if (process.platform !== 'linux') return;
  let procEntries;
  try { procEntries = await readdir('/proc'); } catch { return; }

  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const root = join('/proc', entry);
    let cmdline = '';
    let exe = null;
    try {
      cmdline = (await readFile(join(root, 'cmdline'), 'utf8')).replaceAll('\0', ' ');
      exe = await readlink(join(root, 'exe'));
    } catch {
      continue;
    }
    const name = basename(exe).toLowerCase();
    if (name === 'qq' || name === 'linuxqq' || /\/QQ\/qq(?:\s|$)/.test(cmdline)) {
      await addCandidate(results, seen, exe, `running-process:${entry}`, undefined, env);
    }
  }
}

async function discoverUserApplications(results, seen, env) {
  const home = env.HOME || homedir();
  const dirs = [join(home, 'Applications'), join(home, '.local', 'bin')];
  for (const dir of dirs) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!/(?:^|[-_.])(qq|linuxqq)(?:[-_.]|$)/i.test(entry.name) && !/QQ.*\.AppImage$/i.test(entry.name)) continue;
      await addCandidate(results, seen, join(dir, entry.name), `user-app:${dir}`, undefined, env);
    }
  }
}

async function discoverPackageManager(results, seen, env) {
  const probes = [
    ['dpkg-query', ['-L', 'linuxqq']],
    ['dpkg-query', ['-L', 'qq']],
    ['pacman', ['-Qlq', 'linuxqq']],
    ['pacman', ['-Qlq', 'linuxqq-nt']],
    ['rpm', ['-ql', 'linuxqq']],
    ['rpm', ['-ql', 'qq']]
  ];

  for (const [command, args] of probes) {
    if (!(await resolveCommand(command, env))) continue;
    try {
      const { stdout } = await execFileAsync(command, args, { timeout: 1200, maxBuffer: 512 * 1024, env });
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const likely = lines.filter((line) => /(?:\/QQ\/qq|\/linuxqq|\/qq)$/i.test(line));
      for (const line of likely) await addCandidate(results, seen, line, `package:${command} ${args.join(' ')}`, undefined, env);
    } catch {
      // Package is absent or package manager returned non-zero.
    }
  }
}

export async function detectQQBinary({ env = process.env, all = false } = {}) {
  if (env.QQ_BIN) {
    const explicit = await resolveCommand(env.QQ_BIN, env);
    if (!explicit) {
      const error = new Error(`QQ_BIN is set but is not an executable file or PATH command: ${env.QQ_BIN}`);
      error.code = 'QQ_BIN_INVALID';
      throw error;
    }
    const candidate = { path: await canonical(explicit), source: 'env:QQ_BIN', priority: 0 };
    return all ? [candidate] : candidate;
  }

  const results = [];
  const seen = new Set();

  await discoverRunningProcesses(results, seen, env);
  await discoverFromPath(results, seen, env);
  for (const candidate of FIXED_CANDIDATES) {
    await addCandidate(results, seen, candidate.path, candidate.source, candidate.priority, env);
  }
  await discoverDesktopEntries(results, seen, env);
  await discoverPackageManager(results, seen, env);
  await discoverUserApplications(results, seen, env);

  results.sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));
  return all ? results : (results[0] ?? null);
}

function usage() {
  console.log(`Usage: node src/qq-detect.mjs [--print-path] [--json] [--all]\n\n` +
    `  --print-path  print only the best executable path\n` +
    `  --json        print machine-readable JSON\n` +
    `  --all         include every discovered candidate\n`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    usage();
    return;
  }

  const all = args.has('--all');
  let result;
  try {
    result = await detectQQBinary({ all });
  } catch (error) {
    console.error(`[web-bridge] ${error.message}`);
    process.exitCode = 2;
    return;
  }

  if ((all && result.length === 0) || (!all && !result)) {
    console.error('[web-bridge] QQ NT executable was not found automatically.');
    console.error('[web-bridge] Install Linux QQ NT or set QQ_BIN=/path/to/qq explicitly.');
    process.exitCode = 1;
    return;
  }

  if (args.has('--print-path')) {
    const best = all ? result[0] : result;
    process.stdout.write(`${best.path}\n`);
    return;
  }

  if (args.has('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const list = all ? result : [result];
  for (const [index, candidate] of list.entries()) {
    console.log(`${index === 0 ? '*' : '-'} ${candidate.path}`);
    console.log(`  source: ${candidate.source}`);
    console.log(`  priority: ${candidate.priority}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
