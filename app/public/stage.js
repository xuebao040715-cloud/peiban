// 舞台层：状态胶囊、角色立绘、按住说话、直说模式开关。
// 独立成模块，避免动 app.js 里的对话主流程。
const $ = id => document.getElementById(id);
let state = null, latency = null, recorder = null, chunks = [], recording = false;

async function loadState() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('读不到本机记录');
  state = await response.json();
  return state;
}

function avatarSource() {
  const appearance = state?.settings?.appearance || {};
  return appearance.petImage || appearance.companionAvatar || '';
}

function setStageAvatar(node, source, fallback) {
  node.replaceChildren();
  if (source) {
    const img = document.createElement('img');
    img.src = source;
    img.alt = '';
    node.append(img);
  } else {
    node.textContent = Array.from(fallback || '伴')[0];
  }
}

const THEME_KEY = 'peiban-stage-theme';
function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}
function applyTheme(theme) {
  document.body.classList.toggle('stage-dark', theme === 'dark');
  const pill = $('pill-theme');
  if (pill) { pill.textContent = theme === 'dark' ? '深色' : '浅色'; pill.classList.toggle('on', theme === 'dark'); }
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* 隐身模式忽略 */ }
  applyTheme(next);
}
function renderStage() {
  if (!state) return;
  const character = state.settings.character;
  $('pill-model').textContent = state.settings.model || '未选模型';
  $('pill-model').title = `本机 Ollama · ${state.settings.options?.numCtx || 8192} 上下文`;
  const direct = state.settings.direct === true;
  const pill = $('pill-direct');
  pill.textContent = direct ? '直说 开' : '直说 关';
  pill.classList.toggle('on', direct);
  pill.setAttribute('aria-pressed', String(direct));
  $('stage-name').textContent = character.name;
  $('stage-state').textContent = character.identity || '在你旁边';
  $('stage-talk').textContent = recording ? '松开发送' : '按住说话';
  setStageAvatar($('stage-avatar'), avatarSource(), character.name);
  setStageAvatar($('header-avatar'), avatarSource(), character.name);
}

function renderLatency() {
  $('pill-latency').textContent = latency === null ? '—' : `${Math.round(latency / 100) / 10}s`;
  $('pill-latency').classList.toggle('warn', latency !== null && latency > 8000);
}

// 给对话请求计时：首个数据帧到达即视为“她开始说话”
function instrumentFetch() {
  const original = window.fetch;
  window.fetch = async function patched(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('/api/chat/stream')) return original.call(this, input, init);
    const started = performance.now();
    const response = await original.call(this, input, init);
    if (response.ok && response.body && typeof response.body.tee === 'function') {
      try {
        const [a, b] = response.body.tee();
        const reader = b.getReader();
        reader.read().then(first => {
          if (!first.done) { latency = performance.now() - started; renderLatency(); }
          reader.cancel().catch(() => {});
        }).catch(() => {});
        return new Response(a, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch {
        return response;   // 计时失败不能影响对话本身
      }
    }
    return response;
  };
}

async function toggleDirect() {
  if (!state) return;
  const next = structuredClone(state);
  next.settings.direct = state.settings.direct !== true;
  const response = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
  if (!response.ok) return;
  await loadState();
  renderStage();
}

function setRecording(value) {
  recording = value;
  const button = $('stage-talk');
  button.classList.toggle('recording', value);
  button.textContent = value ? '松开发送' : '按住说话';
  document.body.classList.toggle('listening', value);
}

async function startRecording() {
  if (recording) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    $('stage-state').textContent = '这个浏览器不支持录音';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      setRecording(false);
      if (!blob.size) return;
      $('stage-state').textContent = '听到了，正在转文字…';
      try {
        const response = await fetch('/api/asr', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '识别失败');
        const input = $('chat-input');
        input.value = data.text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        $('chat-form').requestSubmit();
        $('stage-state').textContent = '在听';
      } catch (error) {
        $('stage-state').textContent = error.message;
      }
    };
    recorder.start();
    setRecording(true);
    $('stage-state').textContent = '在听你说…';
  } catch {
    $('stage-state').textContent = '没有麦克风权限';
  }
}

function stopRecording() {
  if (recorder && recording) recorder.stop();
}

function bind() {
const bar = $('stage-bar');
  if (bar && !$('pill-theme')) {
    const pill = document.createElement('button');
    pill.id = 'pill-theme'; pill.type = 'button'; pill.className = 'stage-pill';
    pill.title = '切换舞台深浅';
    pill.addEventListener('click', toggleTheme);
    bar.append(pill);
  }
  applyTheme(currentTheme());
  $('pill-direct').addEventListener('click', () => toggleDirect().catch(() => {}));
  const talk = $('stage-talk');
  talk.addEventListener('pointerdown', event => { event.preventDefault(); startRecording(); });
  talk.addEventListener('pointerup', event => { event.preventDefault(); stopRecording(); });
  talk.addEventListener('pointerleave', () => { if (recording) stopRecording(); });
  $('stage-avatar').addEventListener('click', startRecording);
  // 角色状态跟随对话与朗读
  const messages = $('messages');
  if (messages) {
    new MutationObserver(() => {
      if (document.querySelector('.message.thinking')) $('stage-state').textContent = '正在想…';
      else if (recording) return;
      else if (state) $('stage-state').textContent = state.settings.character.identity || '在你旁边';
    }).observe(messages, { childList: true, subtree: true });
  }
}

async function init() {
  instrumentFetch();
  bind();
  renderLatency();
  try { await loadState(); } catch { return; }
  renderStage();
  setInterval(async () => {
    try { await loadState(); renderStage(); } catch { /* 服务暂时不可用时忽略 */ }
  }, 15000);
}

init();
