import path from 'node:path';
import { nowIso, readJson, serializeError, writeJsonAtomic } from './utils.mjs';

export class MediaState {
  constructor(config) {
    this.file = path.join(config.workDir, 'state.json');
    this.config = config;
    this.data = { version: 1, jobs: {} };
  }

  async load() {
    const loaded = await readJson(this.file, null);
    if (loaded) {
      if (loaded.version !== 1 || !loaded.jobs || typeof loaded.jobs !== 'object') {
        throw new Error(`Unsupported media state format in ${this.file}`);
      }
      this.data = loaded;
    }
    return this;
  }

  key(accountId, videoId) {
    return this.config.dedupeScope === 'account' ? `${accountId}:${videoId}` : videoId;
  }

  get(accountId, videoId) {
    return this.data.jobs[this.key(accountId, videoId)] || null;
  }

  canRun(accountId, videoId, now = Date.now()) {
    const job = this.get(accountId, videoId);
    if (!job) return true;
    if (job.status === 'completed' || job.status === 'running') return false;
    if ((job.attempts || 0) >= this.config.maxAttempts) return false;
    if (job.nextRetryAt && Date.parse(job.nextRetryAt) > now) return false;
    return true;
  }

  async discovered(accountId, entry) {
    const key = this.key(accountId, entry.id);
    if (!this.data.jobs[key]) {
      this.data.jobs[key] = {
        key,
        videoId: entry.id,
        youtubeAccount: accountId,
        status: 'discovered',
        attempts: 0,
        title: entry.title || '',
        webpageUrl: entry.webpageUrl || entry.url || '',
        discoveredAt: nowIso(),
        updatedAt: nowIso()
      };
      await this.save();
    }
    return this.data.jobs[key];
  }

  async markRunning(accountId, entry) {
    const key = this.key(accountId, entry.id);
    const previous = this.data.jobs[key] || {};
    const job = {
      ...previous,
      key,
      videoId: entry.id,
      youtubeAccount: accountId,
      title: entry.title || previous.title || '',
      webpageUrl: entry.webpageUrl || entry.url || previous.webpageUrl || '',
      status: 'running',
      attempts: (previous.attempts || 0) + 1,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      nextRetryAt: null,
      error: null
    };
    this.data.jobs[key] = job;
    await this.save();
    return job;
  }

  async markCompleted(accountId, videoId, result = {}) {
    const key = this.key(accountId, videoId);
    const previous = this.data.jobs[key] || {};
    this.data.jobs[key] = {
      ...previous,
      ...result,
      status: 'completed',
      completedAt: nowIso(),
      updatedAt: nowIso(),
      nextRetryAt: null,
      error: null
    };
    await this.save();
    return this.data.jobs[key];
  }

  async markFailed(accountId, videoId, error) {
    const key = this.key(accountId, videoId);
    const previous = this.data.jobs[key] || {};
    const attempts = previous.attempts || 1;
    const retryDelayMs = this.config.retryBackoffSeconds * 1000 * Math.min(8, 2 ** Math.max(0, attempts - 1));
    this.data.jobs[key] = {
      ...previous,
      status: attempts >= this.config.maxAttempts ? 'dead' : 'failed',
      error: serializeError(error),
      failedAt: nowIso(),
      updatedAt: nowIso(),
      nextRetryAt: attempts >= this.config.maxAttempts ? null : new Date(Date.now() + retryDelayMs).toISOString()
    };
    await this.save();
    return this.data.jobs[key];
  }

  async requeue(key, { resetAttempts = true } = {}) {
    const previous = this.data.jobs[key];
    if (!previous) throw new Error(`Unknown media job: ${key}`);
    if (previous.status === 'running') throw new Error(`Cannot requeue running media job: ${key}`);
    this.data.jobs[key] = {
      ...previous,
      status: 'discovered',
      attempts: resetAttempts ? 0 : (previous.attempts || 0),
      error: null,
      nextRetryAt: null,
      failedAt: null,
      startedAt: null,
      updatedAt: nowIso()
    };
    await this.save();
    return this.data.jobs[key];
  }

  async save() {
    this.data.updatedAt = nowIso();
    await writeJsonAtomic(this.file, this.data);
  }
}
