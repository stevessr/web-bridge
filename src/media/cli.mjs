#!/usr/bin/env node
import path from 'node:path';
import { loadMediaConfig } from './config.mjs';
import { doctorMedia, runMediaLoop, runMediaOnce } from './pipeline.mjs';
import { readJson } from './utils.mjs';

function usage() {
  console.log(`web-bridge YouTube -> ASR -> fansub -> Bilibili pipeline\n\nUsage:\n  node src/media/cli.mjs once [--config FILE] [--dry-run]\n  node src/media/cli.mjs run [--config FILE]\n  node src/media/cli.mjs doctor [--config FILE]\n  node src/media/cli.mjs state [--config FILE]\n\nEnvironment:\n  WEB_BRIDGE_MEDIA_CONFIG   default config path\n  API keys are read through the env variable names configured in media.json\n`);
}

function parseArgs(argv) {
  const result = { command: 'once', config: process.env.WEB_BRIDGE_MEDIA_CONFIG || 'config/media.json', dryRun: false };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) result.command = args.shift();
  while (args.length) {
    const arg = args.shift();
    if (arg === '--config' || arg === '-c') {
      const value = args.shift();
      if (!value) throw new Error(`${arg} requires a path`);
      result.config = value;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (!['once', 'run', 'doctor', 'state'].includes(args.command)) {
    usage();
    throw new Error(`Unknown command: ${args.command}`);
  }

  const config = await loadMediaConfig(args.config);
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  if (args.command === 'once') {
    const result = await runMediaOnce(config, { signal: controller.signal, dryRun: args.dryRun });
    console.log(JSON.stringify({ ...result, results: result.results.map(({ error, ...item }) => error ? { ...item, error: error.message } : item) }, null, 2));
    if (result.results.some((item) => item.status === 'failed')) process.exitCode = 1;
    return;
  }

  if (args.command === 'run') {
    await runMediaLoop(config, { signal: controller.signal });
    return;
  }

  if (args.command === 'doctor') {
    const checks = await doctorMedia(config);
    for (const check of checks) console.log(`${check.ok ? 'OK ' : 'ERR'}  ${check.name}: ${check.detail}`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }

  const stateFile = path.join(config.workDir, 'state.json');
  const state = await readJson(stateFile, { version: 1, jobs: {} });
  console.log(JSON.stringify(state, null, 2));
}

main().catch((error) => {
  if (error?.message !== 'Interrupted') console.error(error?.stack || error);
  process.exitCode = 1;
});
