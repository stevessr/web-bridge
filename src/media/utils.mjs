import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export function stringArray(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

export function renderTemplate(template, values) {
  return String(template ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    const value = key.split('.').reduce((cursor, part) => cursor?.[part], values);
    return value == null ? '' : String(value);
  });
}

export function clampText(value, max) {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function envValue(name, { required = false } = {}) {
  const value = name ? process.env[name] : undefined;
  if (required && !value) throw new Error(`Missing required environment variable: ${name}`);
  return value || '';
}

export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Aborted'));
    }, { once: true });
  });
}

export async function runCommand(command, args = [], options = {}) {
  if (!command || typeof command !== 'string') throw new Error('command must be a non-empty string');
  stringArray(args, 'command args');
  const {
    cwd,
    env = process.env,
    input,
    signal,
    logOutput = false,
    maxOutputBytes = 16 * 1024 * 1024
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      signal,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let total = 0;
    const append = (kind, chunk) => {
      const text = chunk.toString('utf8');
      total += Buffer.byteLength(text);
      if (total > maxOutputBytes) {
        child.kill('SIGTERM');
        reject(new Error(`${command} produced more than ${maxOutputBytes} bytes of output`));
        return;
      }
      if (kind === 'stdout') stdout += text;
      else stderr += text;
      if (logOutput) process[kind].write(text);
    };

    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.on('error', reject);
    child.on('close', (code, childSignal) => {
      if (code === 0) return resolve({ stdout, stderr, code });
      const detail = stderr.trim() || stdout.trim() || `signal ${childSignal || 'unknown'}`;
      const error = new Error(`${command} exited with code ${code}: ${detail}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });

    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function parseJsonLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function nowIso() {
  return new Date().toISOString();
}

export function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || ''
  };
}
