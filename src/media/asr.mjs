import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { envValue, runCommand } from './utils.mjs';
import { normalizeSegments } from './subtitles.mjs';

async function transcribeOpenAiCompatible(config, audioPath, { signal } = {}) {
  const apiKey = envValue(config.asr.apiKeyEnv, { required: true });
  const bytes = await readFile(audioPath);
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'audio/wav' }), path.basename(audioPath));
  form.set('model', config.asr.model);
  form.set('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  if (config.asr.language && config.asr.language !== 'auto') form.set('language', config.asr.language);
  if (config.asr.prompt) form.set('prompt', config.asr.prompt);

  const response = await fetch(`${config.asr.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ASR API ${response.status}: ${text.slice(0, 2000)}`);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`ASR API returned non-JSON output; verbose_json with segment timestamps is required: ${text.slice(0, 500)}`);
  }
  return { payload, segments: normalizeSegments(payload) };
}

async function transcribeLocalFasterWhisper(config, audioPath, { signal } = {}) {
  const script = path.resolve(process.cwd(), config.asr.localScript);
  const args = [
    script,
    '--model', config.asr.model,
    '--device', config.asr.device,
    '--compute-type', config.asr.computeType
  ];
  if (config.asr.language && config.asr.language !== 'auto') args.push('--language', config.asr.language);
  if (config.asr.prompt) args.push('--prompt', config.asr.prompt);
  args.push(...config.asr.extraArgs, audioPath);
  const { stdout } = await runCommand(config.asr.pythonBinary, args, { signal, maxOutputBytes: 64 * 1024 * 1024 });
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(`Local ASR returned invalid JSON: ${stdout.slice(0, 500)}`);
  }
  return { payload, segments: normalizeSegments(payload) };
}

export async function transcribeAudio(config, audioPath, options = {}) {
  if (config.asr.backend === 'openai-compatible') return transcribeOpenAiCompatible(config, audioPath, options);
  if (config.asr.backend === 'local-faster-whisper') return transcribeLocalFasterWhisper(config, audioPath, options);
  throw new Error(`Unsupported ASR backend: ${config.asr.backend}`);
}
