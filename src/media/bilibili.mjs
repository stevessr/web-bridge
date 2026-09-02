import path from 'node:path';
import { clampText, runCommand } from './utils.mjs';

function configPath(config, value) {
  return value ? path.resolve(config.configDir || process.cwd(), value) : '';
}

export function findBilibiliAccount(config, id) {
  const account = config.bilibili.accounts.find((item) => item.id === id && item.enabled);
  if (!account) throw new Error(`Bilibili account is not configured or disabled: ${id}`);
  return account;
}

export async function uploadToBilibili(config, account, videoPath, metadata, { signal } = {}) {
  const args = [];
  if (account.proxy) args.push('--proxy', account.proxy);
  if (account.cookieFile) args.push('--user-cookie', configPath(config, account.cookieFile));
  args.push('upload', videoPath);
  if (account.submit) args.push('--submit', account.submit);
  if (account.line) args.push('--line', account.line);
  args.push('--copyright', String(account.copyright));
  if (account.copyright === 2 && metadata.source) args.push('--source', metadata.source);
  args.push('--tid', String(account.tid));
  args.push('--title', clampText(metadata.title, 80));
  if (metadata.description) args.push('--desc', clampText(metadata.description, 2000));
  if (metadata.tags?.length) args.push('--tag', metadata.tags.join(','));
  args.push(...account.extraArgs);

  const { stdout, stderr } = await runCommand(config.bilibili.binary, args, {
    signal,
    logOutput: true,
    maxOutputBytes: 32 * 1024 * 1024
  });
  const output = `${stdout}\n${stderr}`;
  const bvid = output.match(/\bBV[0-9A-Za-z]{8,}\b/)?.[0] || '';
  const aid = output.match(/\bav(\d+)\b/i)?.[1] || '';
  return { bvid, aid, output: output.trim().slice(-8000) };
}
