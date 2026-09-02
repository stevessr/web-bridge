const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  snapshot: null,
  token: sessionStorage.getItem('mediaWebToken') || '',
  configBaseline: '',
  configDirty: false,
  logs: [],
  lastLogId: 0,
  refreshing: false,
  currentView: 'overview'
};

const titles = {
  overview: ['自动烤肉控制台', 'YouTube → ASR → 翻译 → 字幕 → Bilibili'],
  jobs: ['任务队列', '检查每条视频的处理、重试与投稿状态'],
  config: ['流水线配置', '编辑账号、ASR、翻译、yt-dlp 与投稿选项'],
  diagnostics: ['诊断与日志', '环境检查、访问认证与实时执行日志']
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toast(message, type = '') {
  const item = document.createElement('div');
  item.className = `toast ${type}`.trim();
  item.textContent = message;
  $('#toast-stack').append(item);
  setTimeout(() => item.remove(), 4200);
}

function showBanner(message = '') {
  const banner = $('#banner');
  banner.textContent = message;
  banner.classList.toggle('hidden', !message);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set('authorization', `Bearer ${state.token}`);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  let payload = null;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const error = new Error(payload?.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function switchView(view) {
  if (!titles[view]) return;
  state.currentView = view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $$('.view').forEach((item) => item.classList.toggle('active', item.dataset.viewPanel === view));
  $('#page-title').textContent = titles[view][0];
  $('#page-subtitle').textContent = titles[view][1];
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function relativeDate(value) {
  if (!value) return '—';
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} 秒前`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} 小时前`;
  return `${Math.round(ms / 86_400_000)} 天前`;
}

function statusLabel(status) {
  return ({ discovered: '待处理', running: '处理中', completed: '已完成', failed: '待重试', dead: '停止重试' })[status] || status || '未知';
}

function statusBadge(status) {
  return `<span class="status-badge ${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function renderRuntime(snapshot) {
  const runtime = snapshot.runtime || {};
  const badge = $('#runtime-badge');
  const main = $('#runtime-main');
  const meta = $('#runtime-meta');
  const progress = $('#runtime-progress');
  const side = $('#sidebar-runtime');
  const stop = $('#stop-button');
  const busy = Boolean(runtime.busy);
  const loop = Boolean(runtime.loopRunning);

  badge.className = `badge ${busy ? 'running' : ''}`;
  badge.textContent = loop ? 'LOOP' : busy ? 'RUNNING' : 'IDLE';
  main.textContent = loop ? '自动轮询中' : busy ? '正在处理' : '空闲';
  meta.textContent = loop
    ? `每 ${snapshot.config?.pollIntervalSeconds || '—'} 秒检查一次订阅`
    : runtime.lastRun
      ? `上次执行 ${relativeDate(runtime.lastRun.finishedAt || runtime.lastRun.startedAt)} · ${runtime.lastRun.ok === false ? '失败' : '完成'}`
      : '等待下一次操作';
  progress.style.width = busy ? '72%' : '14%';
  side.className = `runtime-pill ${busy ? 'running' : ''}`;
  side.innerHTML = `<i></i><span>${loop ? '自动轮询' : busy ? '执行中' : '空闲'}</span>`;
  stop.classList.toggle('hidden', !loop);

  $('#run-button').disabled = busy || Boolean(snapshot.configError);
  $('#dry-run-button').disabled = busy || Boolean(snapshot.configError);
  $('#loop-button').disabled = busy || Boolean(snapshot.configError);
  $('#save-config-button').disabled = busy;
  $('#reset-config-button').disabled = busy;
}

function renderStats(snapshot) {
  const stats = snapshot.stats || {};
  $('#stat-total').textContent = stats.total || 0;
  $('#stat-running').textContent = stats.running || 0;
  $('#stat-completed').textContent = stats.completed || 0;
  $('#stat-failed').textContent = (stats.failed || 0) + (stats.dead || 0);
}

function renderAccounts(snapshot) {
  const config = snapshot.config;
  const youtube = config?.youtubeAccounts || [];
  const bilibili = config?.bilibiliAccounts || [];
  $('#youtube-count').textContent = youtube.length;
  $('#bilibili-count').textContent = bilibili.length;
  $('#youtube-accounts').innerHTML = youtube.length ? youtube.map((account) => `
    <div class="account-row">
      <div class="account-avatar">YT</div>
      <div><strong>${escapeHtml(account.id)}</strong><small>${escapeHtml(account.sourceUrls.join(' · '))} → ${escapeHtml(account.bilibiliAccount)}</small></div>
      <i class="account-state ${account.enabled ? 'on' : ''}" title="${account.enabled ? '启用' : '停用'}"></i>
    </div>`).join('') : '<div class="empty-inline">没有 YouTube 账号</div>';
  $('#bilibili-accounts').innerHTML = bilibili.length ? bilibili.map((account) => `
    <div class="account-row">
      <div class="account-avatar">B</div>
      <div><strong>${escapeHtml(account.id)}</strong><small>${account.enabled ? '可用于自动投稿' : '已停用'}</small></div>
      <i class="account-state ${account.enabled ? 'on' : ''}" title="${account.enabled ? '启用' : '停用'}"></i>
    </div>`).join('') : '<div class="empty-inline">没有 Bilibili 账号</div>';
}

function jobsArray() {
  return Object.values(state.snapshot?.state?.jobs || {}).sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
}

function renderRecentJobs() {
  const jobs = jobsArray().slice(0, 6);
  $('#recent-jobs').innerHTML = jobs.length ? jobs.map((job) => `
    <div class="compact-job">
      <div class="compact-job-title"><strong title="${escapeHtml(job.title || job.videoId)}">${escapeHtml(job.title || job.videoId)}</strong><small>${escapeHtml(job.videoId || '')}</small></div>
      <span>${escapeHtml(job.youtubeAccount || '—')}</span>
      <span>${statusBadge(job.status)}</span>
      <span>${escapeHtml(relativeDate(job.updatedAt))}</span>
    </div>`).join('') : '<div class="empty-inline">还没有发现视频</div>';
}

function renderJobs() {
  const query = $('#job-search').value.trim().toLowerCase();
  const status = $('#job-status-filter').value;
  const jobs = jobsArray().filter((job) => {
    if (status !== 'all' && job.status !== status) return false;
    if (!query) return true;
    return [job.title, job.videoId, job.youtubeAccount, job.bilibiliAccount, job.bvid].some((value) => String(value || '').toLowerCase().includes(query));
  });
  $('#jobs-body').innerHTML = jobs.map((job) => {
    const canRequeue = ['failed', 'dead'].includes(job.status);
    const bili = job.bvid ? `<a href="https://www.bilibili.com/video/${encodeURIComponent(job.bvid)}" target="_blank" rel="noreferrer">${escapeHtml(job.bvid)}</a>` : '—';
    return `<tr>
      <td class="video-cell"><a href="${escapeHtml(job.webpageUrl || '#')}" target="_blank" rel="noreferrer" title="${escapeHtml(job.title || job.videoId)}">${escapeHtml(job.title || job.videoId)}</a><small>${escapeHtml(job.videoId || '')}</small></td>
      <td>${escapeHtml(job.youtubeAccount || '—')}</td>
      <td>${statusBadge(job.status)}</td>
      <td>${escapeHtml(job.attempts || 0)} / ${escapeHtml(state.snapshot?.config?.maxAttempts || '—')}</td>
      <td title="${escapeHtml(formatDate(job.updatedAt))}">${escapeHtml(relativeDate(job.updatedAt))}</td>
      <td class="video-cell">${bili}</td>
      <td>${canRequeue ? `<button class="action-small" data-requeue="${escapeHtml(job.key)}">重新入队</button>` : ''}</td>
    </tr>`;
  }).join('');
  $('#jobs-empty').classList.toggle('hidden', jobs.length > 0);
}

function renderConfig(snapshot) {
  const config = snapshot.config;
  $('#config-path').textContent = snapshot.configFile || '—';
  if (!state.configDirty) {
    const text = snapshot.rawConfig ? `${JSON.stringify(snapshot.rawConfig, null, 2)}\n` : '';
    state.configBaseline = text;
    $('#config-editor').value = text;
    $('#editor-status').textContent = snapshot.configError ? snapshot.configError : '配置已同步';
    $('#editor-status').className = `editor-status ${snapshot.configError ? 'error' : ''}`;
  }
  const summary = [
    ['轮询间隔', config ? `${config.pollIntervalSeconds}s` : '—'],
    ['单轮上限', config?.maxItemsPerPoll ?? '—'],
    ['最大重试', config?.maxAttempts ?? '—'],
    ['去重范围', config?.dedupeScope ?? '—'],
    ['ASR', config ? `${config.asr.backend} / ${config.asr.model}` : '—'],
    ['翻译', config ? `${config.translation.backend} / ${config.translation.model}` : '—'],
    ['目标语言', config?.translation?.targetLanguage || '—'],
    ['烧录字幕', config ? (config.burnSubtitles ? '是' : '否') : '—'],
    ['保留产物', config ? (config.keepArtifacts ? '是' : '否') : '—']
  ];
  $('#config-summary').innerHTML = summary.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd>`).join('');
}

function renderStages(snapshot) {
  const config = snapshot.config;
  $('#stage-asr').textContent = config ? `${config.asr.backend} · ${config.asr.model}` : '配置无效';
  $('#stage-translation').textContent = config ? config.translation.backend : '配置无效';
  $('#stage-subtitle').textContent = config ? (config.burnSubtitles ? 'SRT / ASS / 烧录' : 'SRT / ASS') : '—';
}

function appendLogs(entries) {
  if (!entries?.length) return;
  const known = new Set(state.logs.map((item) => item.id));
  for (const entry of entries) {
    if (!known.has(entry.id)) state.logs.push(entry);
    state.lastLogId = Math.max(state.lastLogId, Number(entry.id) || 0);
  }
  if (state.logs.length > 600) state.logs.splice(0, state.logs.length - 600);
  renderLogs();
}

function renderLogs() {
  const terminal = $('#log-output');
  const nearBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 70;
  terminal.innerHTML = state.logs.length ? state.logs.map((entry) => `
    <div class="log-line ${escapeHtml(entry.level)}">
      <span class="time">${escapeHtml(formatDate(entry.at))}</span>
      <span class="level">${escapeHtml(entry.level)}</span>
      <span class="message">${escapeHtml(entry.message)}</span>
    </div>`).join('') : '<div class="empty-inline">暂无日志</div>';
  if (nearBottom) terminal.scrollTop = terminal.scrollHeight;
}

function renderSnapshot(snapshot) {
  state.snapshot = snapshot;
  showBanner(snapshot.configError ? `配置错误：${snapshot.configError}` : '');
  renderRuntime(snapshot);
  renderStats(snapshot);
  renderAccounts(snapshot);
  renderRecentJobs();
  renderJobs();
  renderConfig(snapshot);
  renderStages(snapshot);
  appendLogs(snapshot.logTail || []);
}

async function refreshSnapshot({ quiet = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const snapshot = await api('/api/snapshot');
    renderSnapshot(snapshot);
    if (!quiet) toast('已刷新', 'ok');
  } catch (error) {
    if (error.status === 401) {
      showBanner('管理 API 需要 Bearer token。请在“诊断与日志”中输入 WEB_BRIDGE_MEDIA_WEB_TOKEN。');
      $('#sidebar-runtime').className = 'runtime-pill error';
      $('#sidebar-runtime').innerHTML = '<i></i><span>未认证</span>';
    } else {
      showBanner(`连接管理服务失败：${error.message}`);
    }
    if (!quiet) toast(error.message, 'error');
  } finally {
    state.refreshing = false;
  }
}

async function runAction(dryRun) {
  const button = dryRun ? $('#dry-run-button') : $('#run-button');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = dryRun ? '试运行中…' : '执行中…';
  try {
    const result = await api('/api/run', { method: 'POST', body: JSON.stringify({ dryRun }) });
    toast(dryRun ? `试运行完成：计划 ${result.selected} 个任务` : `执行完成：处理 ${result.selected} 个任务`, 'ok');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.textContent = original;
    await refreshSnapshot({ quiet: true });
  }
}

async function startLoop() {
  try {
    const result = await api('/api/loop/start', { method: 'POST', body: '{}' });
    toast(`自动轮询已启动，每 ${result.intervalSeconds} 秒检查一次`, 'ok');
    await refreshSnapshot({ quiet: true });
  } catch (error) { toast(error.message, 'error'); }
}

async function stopLoop() {
  try {
    const result = await api('/api/loop/stop', { method: 'POST', body: '{}' });
    toast(result.stopped ? '正在停止自动轮询' : result.reason, result.stopped ? 'ok' : '');
    await refreshSnapshot({ quiet: true });
  } catch (error) { toast(error.message, 'error'); }
}

async function runDoctor() {
  const button = $('#doctor-button');
  button.disabled = true;
  button.textContent = '检查中…';
  try {
    const result = await api('/api/doctor', { method: 'POST', body: '{}' });
    $('#doctor-results').innerHTML = result.checks.map((check) => `
      <div class="doctor-row">
        <span class="doctor-icon ${check.ok ? 'ok' : ''}">${check.ok ? '✓' : '!'}</span>
        <strong>${escapeHtml(check.name)}</strong>
        <span>${escapeHtml(check.detail)}</span>
      </div>`).join('');
    toast(result.ok ? '环境检查全部通过' : '部分环境检查未通过', result.ok ? 'ok' : 'error');
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = '运行 Doctor'; }
}

function formatConfig() {
  const editor = $('#config-editor');
  try {
    editor.value = `${JSON.stringify(JSON.parse(editor.value), null, 2)}\n`;
    state.configDirty = editor.value !== state.configBaseline;
    $('#editor-status').textContent = state.configDirty ? '有未保存修改' : '配置已同步';
    $('#editor-status').className = `editor-status ${state.configDirty ? 'changed' : ''}`;
  } catch (error) {
    $('#editor-status').textContent = `JSON 错误：${error.message}`;
    $('#editor-status').className = 'editor-status error';
    toast(error.message, 'error');
  }
}

async function saveConfig() {
  const editor = $('#config-editor');
  let parsed;
  try { parsed = JSON.parse(editor.value); }
  catch (error) {
    $('#editor-status').textContent = `JSON 错误：${error.message}`;
    $('#editor-status').className = 'editor-status error';
    return toast(error.message, 'error');
  }
  const button = $('#save-config-button');
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(parsed) });
    state.configBaseline = `${JSON.stringify(parsed, null, 2)}\n`;
    editor.value = state.configBaseline;
    state.configDirty = false;
    $('#editor-status').textContent = '已保存并通过校验';
    $('#editor-status').className = 'editor-status ok';
    toast('配置已保存', 'ok');
    await refreshSnapshot({ quiet: true });
  } catch (error) {
    $('#editor-status').textContent = `保存失败：${error.message}`;
    $('#editor-status').className = 'editor-status error';
    toast(error.message, 'error');
  } finally {
    button.disabled = Boolean(state.snapshot?.runtime?.busy);
    button.textContent = '保存配置';
  }
}

async function requeueJob(key) {
  try {
    await api('/api/jobs/requeue', { method: 'POST', body: JSON.stringify({ key, resetAttempts: true }) });
    toast(`已重新入队：${key}`, 'ok');
    await refreshSnapshot({ quiet: true });
  } catch (error) { toast(error.message, 'error'); }
}

async function pollLogs() {
  try {
    const payload = await api(`/api/logs?after=${encodeURIComponent(state.lastLogId)}`);
    appendLogs(payload.logs || []);
    if (state.snapshot && payload.runtime) {
      state.snapshot.runtime = payload.runtime;
      renderRuntime(state.snapshot);
    }
  } catch { /* snapshot refresh surfaces connectivity/auth errors */ }
}

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  $$('[data-go]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.go)));
  $('#refresh-button').addEventListener('click', () => refreshSnapshot());
  $('#run-button').addEventListener('click', () => runAction(false));
  $('#dry-run-button').addEventListener('click', () => runAction(true));
  $('#loop-button').addEventListener('click', startLoop);
  $('#stop-button').addEventListener('click', stopLoop);
  $('#doctor-button').addEventListener('click', runDoctor);
  $('#format-config-button').addEventListener('click', formatConfig);
  $('#reset-config-button').addEventListener('click', () => {
    $('#config-editor').value = state.configBaseline;
    state.configDirty = false;
    $('#editor-status').textContent = '已放弃未保存修改';
    $('#editor-status').className = 'editor-status';
  });
  $('#save-config-button').addEventListener('click', saveConfig);
  $('#config-editor').addEventListener('input', () => {
    state.configDirty = $('#config-editor').value !== state.configBaseline;
    $('#editor-status').textContent = state.configDirty ? '有未保存修改' : '配置已同步';
    $('#editor-status').className = `editor-status ${state.configDirty ? 'changed' : ''}`;
  });
  $('#job-search').addEventListener('input', renderJobs);
  $('#job-status-filter').addEventListener('change', renderJobs);
  $('#jobs-body').addEventListener('click', (event) => {
    const button = event.target.closest('[data-requeue]');
    if (button) requeueJob(button.dataset.requeue);
  });
  $('#token-input').value = state.token;
  $('#save-token-button').addEventListener('click', () => {
    state.token = $('#token-input').value.trim();
    if (state.token) sessionStorage.setItem('mediaWebToken', state.token);
    else sessionStorage.removeItem('mediaWebToken');
    toast('访问 Token 已更新', 'ok');
    refreshSnapshot({ quiet: true });
  });
  $('#clear-log-button').addEventListener('click', () => {
    state.logs = [];
    state.lastLogId = 0;
    renderLogs();
  });
  window.addEventListener('beforeunload', (event) => {
    if (!state.configDirty) return;
    event.preventDefault();
  });
}

bindEvents();
renderLogs();
refreshSnapshot({ quiet: true });
setInterval(() => {
  if (document.visibilityState === 'visible') refreshSnapshot({ quiet: true });
}, 3000);
setInterval(() => {
  if (document.visibilityState === 'visible') pollLogs();
}, 1000);
