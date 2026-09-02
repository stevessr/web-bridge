const QR_POLL_MS = 1500;

let current = null;
let pollTimer = null;
let countdownTimer = null;
let generation = 0;

function token() {
  return sessionStorage.getItem('mediaWebToken') || '';
}

async function qrApi(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const bearer = token();
  if (bearer) headers.set('authorization', `Bearer ${bearer}`);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  let payload = {};
  try { payload = await response.json(); } catch { /* ignore */ }
  if (!response.ok) {
    const error = new Error(payload.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function notify(message, type = '') {
  const stack = document.querySelector('#toast-stack');
  if (!stack) return;
  const item = document.createElement('div');
  item.className = `toast ${type}`.trim();
  item.textContent = message;
  stack.append(item);
  setTimeout(() => item.remove(), 4200);
}

function ensureModal() {
  let modal = document.querySelector('#bili-qr-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'bili-qr-modal';
  modal.className = 'qr-modal hidden';
  modal.innerHTML = `
    <div class="qr-dialog" role="dialog" aria-modal="true" aria-labelledby="bili-qr-title">
      <button class="qr-close" type="button" aria-label="关闭">×</button>
      <div class="qr-kicker">BILIBILI LOGIN</div>
      <h3 id="bili-qr-title">扫码登录</h3>
      <p class="qr-account" id="bili-qr-account">—</p>
      <div class="qr-frame">
        <img id="bili-qr-image" alt="Bilibili 登录二维码">
        <div class="qr-placeholder" id="bili-qr-placeholder">正在生成二维码…</div>
      </div>
      <div class="qr-state waiting" id="bili-qr-state"><i></i><span>正在创建登录会话</span></div>
      <p class="qr-hint" id="bili-qr-hint">使用哔哩哔哩手机客户端扫码并确认登录。登录凭据只保存在服务器端。</p>
      <div class="qr-expiry" id="bili-qr-expiry"></div>
      <div class="qr-actions">
        <button class="button secondary hidden" id="bili-qr-refresh" type="button">刷新二维码</button>
        <button class="button ghost" id="bili-qr-cancel" type="button">取消</button>
      </div>
    </div>`;
  document.body.append(modal);
  modal.querySelector('.qr-close').addEventListener('click', closeModal);
  modal.querySelector('#bili-qr-cancel').addEventListener('click', closeModal);
  modal.querySelector('#bili-qr-refresh').addEventListener('click', () => {
    if (current?.accountId) beginLogin(current.accountId);
  });
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });
  return modal;
}

function setStatus(status, text) {
  const box = document.querySelector('#bili-qr-state');
  if (!box) return;
  box.className = `qr-state ${status}`;
  box.querySelector('span').textContent = text;
}

function stopTimers() {
  clearTimeout(pollTimer);
  clearInterval(countdownTimer);
  pollTimer = null;
  countdownTimer = null;
}

function updateCountdown() {
  const target = document.querySelector('#bili-qr-expiry');
  if (!target || !current?.expiresAt) return;
  const left = Math.max(0, Math.ceil((Date.parse(current.expiresAt) - Date.now()) / 1000));
  target.textContent = left ? `二维码将在 ${left} 秒后过期` : '二维码已过期';
}

async function cancelServerSession(sessionId) {
  if (!sessionId) return;
  try {
    await qrApi('/api/bilibili/qr/cancel', {
      method: 'POST',
      body: JSON.stringify({ sessionId })
    });
  } catch { /* expiry/connection errors do not need another toast */ }
}

async function closeModal() {
  generation += 1;
  stopTimers();
  const sessionId = current?.sessionId;
  current = null;
  document.querySelector('#bili-qr-modal')?.classList.add('hidden');
  await cancelServerSession(sessionId);
}

function showExpired(message = '二维码已过期，请刷新后重试') {
  stopTimers();
  setStatus('expired', message);
  document.querySelector('#bili-qr-refresh')?.classList.remove('hidden');
  const image = document.querySelector('#bili-qr-image');
  if (image) image.classList.add('dimmed');
}

async function pollLogin(myGeneration) {
  if (!current?.sessionId || generation !== myGeneration) return;
  try {
    const result = await qrApi(`/api/bilibili/qr/status?sessionId=${encodeURIComponent(current.sessionId)}`);
    if (generation !== myGeneration) return;
    if (result.status === 'success') {
      stopTimers();
      setStatus('success', '登录成功，投稿凭据已安全保存');
      document.querySelector('#bili-qr-expiry').textContent = result.mid ? `UID ${result.mid}` : '凭据已写入该账号的 cookieFile';
      document.querySelector('#bili-qr-refresh')?.classList.add('hidden');
      current.sessionId = null;
      notify(`Bilibili 账号 ${result.accountId} 登录成功`, 'ok');
      return;
    }
    if (result.status === 'scanned') setStatus('scanned', '已扫码，请在手机端确认登录');
    else if (result.status === 'expired') return showExpired();
    else setStatus('waiting', '等待扫码…');
    pollTimer = setTimeout(() => pollLogin(myGeneration), QR_POLL_MS);
  } catch (error) {
    if (generation !== myGeneration) return;
    if (error.status === 410) return showExpired();
    setStatus('error', `登录检查失败：${error.message}`);
    pollTimer = setTimeout(() => pollLogin(myGeneration), Math.max(QR_POLL_MS, 3000));
  }
}

async function beginLogin(accountId) {
  const modal = ensureModal();
  const oldSession = current?.sessionId;
  generation += 1;
  const myGeneration = generation;
  stopTimers();
  if (oldSession) cancelServerSession(oldSession);
  current = { accountId, sessionId: null, expiresAt: null };
  modal.classList.remove('hidden');
  modal.querySelector('#bili-qr-account').textContent = `投稿账号：${accountId}`;
  const image = modal.querySelector('#bili-qr-image');
  image.removeAttribute('src');
  image.classList.remove('ready', 'dimmed');
  modal.querySelector('#bili-qr-placeholder').classList.remove('hidden');
  modal.querySelector('#bili-qr-refresh').classList.add('hidden');
  modal.querySelector('#bili-qr-expiry').textContent = '';
  setStatus('waiting', '正在生成二维码…');

  try {
    const result = await qrApi('/api/bilibili/qr/start', {
      method: 'POST',
      body: JSON.stringify({ accountId })
    });
    if (generation !== myGeneration) {
      await cancelServerSession(result.sessionId);
      return;
    }
    current = { accountId, sessionId: result.sessionId, expiresAt: result.expiresAt };
    image.src = result.qrDataUrl;
    image.classList.add('ready');
    modal.querySelector('#bili-qr-placeholder').classList.add('hidden');
    setStatus('waiting', '等待扫码…');
    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 1000);
    pollTimer = setTimeout(() => pollLogin(myGeneration), 700);
  } catch (error) {
    if (generation !== myGeneration) return;
    setStatus('error', error.message);
    modal.querySelector('#bili-qr-placeholder').textContent = '无法生成二维码';
    modal.querySelector('#bili-qr-refresh').classList.remove('hidden');
    notify(error.message, 'error');
  }
}

function enhanceAccountRows() {
  const container = document.querySelector('#bilibili-accounts');
  if (!container) return;
  for (const row of container.querySelectorAll('.account-row')) {
    if (row.dataset.qrEnhanced === '1') continue;
    const accountId = row.querySelector('strong')?.textContent?.trim();
    if (!accountId) continue;
    row.dataset.qrEnhanced = '1';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action-small bili-login-button';
    button.textContent = '扫码登录';
    button.title = `使用哔哩哔哩 App 登录 ${accountId}`;
    button.addEventListener('click', () => beginLogin(accountId));
    const stateDot = row.querySelector('.account-state');
    row.insertBefore(button, stateDot || null);
  }
}

const observer = new MutationObserver(enhanceAccountRows);
function boot() {
  ensureModal();
  const container = document.querySelector('#bilibili-accounts');
  if (container) observer.observe(container, { childList: true, subtree: true });
  enhanceAccountRows();
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.querySelector('#bili-qr-modal')?.classList.contains('hidden')) closeModal();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
