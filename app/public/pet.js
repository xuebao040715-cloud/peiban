import { DEFAULT_APPEARANCE, cleanAppearance } from './appearance.js?v=0.7.0';

const $ = id => document.getElementById(id);
const MAX_IMAGE = 400000;
let state = null, timer = null, pollTimer = null, paused = false, busy = false;
let speakToken = 0, audioCurrent = null, audioCleanup = null, hideTimer = null;

const setStatus = text => { $('status').textContent = text; };

function render() {
  const pet = state.settings.pet;
  const appearance = state.settings.appearance || DEFAULT_APPEARANCE;
  const character = state.settings.character;
  const image = appearance.petImage || appearance.companionAvatar || '';
  const face = $('face');
  if (image) face.src = image; else face.removeAttribute('src');
  $('face-fallback').textContent = Array.from(character.name || '伴')[0];
  $('name').textContent = character.name;
  document.title = `${character.name} · 桌宠`;
  $('pet').className = `pet ${pet.size || 'medium'}`;
  const off = !pet.enabled;
  $('observe').disabled = off || busy;
  $('pause').disabled = off;
  $('pause').classList.toggle('on', paused);
  $('pause').textContent = paused ? '继续' : '暂停';
  if (off) setStatus('未启用 · 到偏好设置里打开「启用桌宠」');
  $('face-button').title = pet.enabled ? '点一下，看看我在做什么' : '桌宠未启用';
}

function showLine(line, doing) {
  $('line').textContent = line;
  $('doing').textContent = doing ? `（${doing}）` : '';
  $('bubble').hidden = false;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { $('bubble').hidden = true; }, 14000);
}

async function loadState() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('读不到本机记录');
  state = await response.json();
  return state;
}

async function observe({ auto = false } = {}) {
  if (busy || paused || !state?.settings.pet.enabled) return;
  busy = true;
  $('observe').disabled = true;
  setStatus(auto ? '看一眼…' : '正在看你的屏幕…');
  try {
    const response = await fetch('/api/pet/observe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    showLine(data.line, data.doing);
    setStatus(`${data.doing || '看过一眼'} · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    speak(data.line);
  } catch (error) {
    setStatus(error.message);
  } finally {
    busy = false;
    $('observe').disabled = !state.settings.pet.enabled;
  }
}

function schedule() {
  clearTimeout(timer);
  if (!state || paused || !state.settings.pet.enabled) return;
  const minutes = Math.min(60, Math.max(1, Number(state.settings.pet.intervalMinutes) || 5));
  timer = setTimeout(async () => { await observe({ auto: true }); schedule(); }, minutes * 60000);
}

function stopSpeaking() {
  speakToken++;
  if (audioCurrent) { audioCurrent.pause(); audioCleanup?.(); audioCurrent = null; audioCleanup = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
function systemSpeak(chunks) {
  if (!('speechSynthesis' in window)) return;
  const voice = speechSynthesis.getVoices().find(v => /^zh/i.test(v.lang) && !v.localService)
    || speechSynthesis.getVoices().find(v => /^zh/i.test(v.lang));
  for (const chunk of chunks) {
    const line = new SpeechSynthesisUtterance(chunk);
    line.lang = voice?.lang || 'zh-CN';
    if (voice) line.voice = voice;
    line.rate = Number(state.settings.voiceRate) || 1;
    speechSynthesis.speak(line);
  }
}
function playAudio(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const finish = () => { URL.revokeObjectURL(url); if (audioCurrent === audio) { audioCurrent = null; audioCleanup = null; } resolve(); };
    audioCleanup = finish;
    audio.onended = finish;
    audio.onerror = () => { URL.revokeObjectURL(url); audioCurrent = null; audioCleanup = null; reject(new Error('播放失败')); };
    audioCurrent = audio;
    audio.play().catch(reject);
  });
}
async function localSpeak(chunks, token) {
  for (const chunk of chunks) {
    if (token !== speakToken) return;
    const response = await fetch('/api/voice/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: chunk }) });
    if (!response.ok) throw new Error('本地 TTS 不可用');
    const blob = await response.blob();
    if (token !== speakToken) return;
    await playAudio(blob);
  }
}
function speak(text) {
  if (!state.settings.voice || !text) return;
  stopSpeaking();
  const chunks = String(text).split(/(?<=[。！？!?…；;])/).map(part => part.trim()).filter(Boolean);
  if (!chunks.length) chunks.push(text);
  if (state.settings.voiceEngine === 'local') {
    const token = speakToken;
    localSpeak(chunks, token).catch(() => { if (token === speakToken) systemSpeak(chunks); });
    return;
  }
  systemSpeak(chunks);
}

async function changeImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG / PNG / WebP 图片。');
  if (file.size > 10 * 1024 * 1024) throw new Error('图片超过 10 MB。');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('图片无法解码。'); });
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法处理图片。');
  const edge = Math.min(bitmap.width, bitmap.height);
  context.drawImage(bitmap, (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge, 0, 0, size, size);
  let data = canvas.toDataURL('image/webp', 0.86);
  if (data.length > MAX_IMAGE) data = canvas.toDataURL('image/jpeg', 0.7);
  if (data.length > MAX_IMAGE) throw new Error('压缩后仍然太大，换一张试试。');
  const draft = structuredClone(state);
  draft.settings.appearance = cleanAppearance({ ...(draft.settings.appearance || DEFAULT_APPEARANCE), petImage: data });
  const response = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || '保存失败');
  }
  await loadState();
  render();
  setStatus('形象已更新');
}

function bind() {
  $('observe').addEventListener('click', () => { observe().then(schedule); });
  $('face-button').addEventListener('click', () => { observe().then(schedule); });
  $('pause').addEventListener('click', () => {
    paused = !paused;
    clearTimeout(timer);
    setStatus(paused ? '已暂停，需要时点「看一眼」' : '继续观察中');
    render();
    if (!paused) schedule();
  });
  $('dress').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatus('正在处理图片…');
    try { await changeImage(file); }
    catch (error) { setStatus(error.message); }
    finally { event.target.value = ''; }
  });
}

async function init() {
  bind();
  try { await loadState(); }
  catch { setStatus('连不上陪伴服务，确认 app/server.mjs 正在运行'); return; }
  render();
  if (state.settings.pet.enabled) {
    schedule();
    setTimeout(() => observe({ auto: true }), 1500);
  }
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
  // 主应用里改了设置，桌宠这边 45 秒内跟上
  pollTimer = setInterval(async () => {
    const previous = state?.settings?.pet;
    try { await loadState(); } catch { return; }
    render();
    if (JSON.stringify(previous) !== JSON.stringify(state.settings.pet)) schedule();
  }, 45000);
}

init();
