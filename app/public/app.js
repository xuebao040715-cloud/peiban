import { DEFAULT_CHARACTER, CHARACTER_PRESETS, CHARACTER_LIMITS, cleanCharacter, importCharacter, exportCharacter } from './character.js?v=0.4.0';
import { DEFAULT_APPEARANCE, THEMES, cleanAppearance, themeProperties } from './appearance.js?v=0.4.0';
const $ = id => document.getElementById(id);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const uid = () => crypto.randomUUID();
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
let state, models = [], busy = false, controller, pendingReply = null, selectedMinutes = 25, view = 'chat', timerSaving = false, currentDay = today();
let mutationQueue = Promise.resolve(), failedTimerId = null;
let appearanceDraft, appearanceDirty = false, uploadTarget = '', imageProcessing = false;
function setAvatar(node, source, fallback) {
  node.replaceChildren();
  if (source) { const img = el('img'); img.src = source; img.alt = ''; node.append(img); }
  else node.textContent = Array.from(fallback || '伴')[0];
}
function applyAppearance(value) {
  const appearance = cleanAppearance(value);
  Object.entries(themeProperties(appearance)).forEach(([key,value]) => document.documentElement.style.setProperty(key,value));
}
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请重试。');
  return data;
}
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function mutate(change) {
  const action = mutationQueue.then(async () => {
    const draft = structuredClone(state);
    change(draft);
    $('save-status').textContent = '正在保存…';
    try {
      const result = await api('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      state = { ...draft, version: result.version };
      $('save-status').textContent = '已保存到本机';
      renderData();
    } catch (e) { $('save-status').textContent = '未保存，请重试'; notice(e.message); throw e; }
  });
  mutationQueue = action.catch(() => {});
  return action;
}
function setView(next) {
  if (view === 'appearance' && next !== 'appearance') { appearanceDraft = structuredClone(state.settings.appearance); appearanceDirty = false; applyAppearance(appearanceDraft); renderData(); renderMessages(); }
  view = next;
  document.querySelectorAll('.view').forEach(n => n.hidden = n.id !== `view-${view}`);
  document.querySelectorAll('nav [data-view]').forEach(n => { n.classList.toggle('active', n.dataset.view === view); n.setAttribute('aria-current', n.dataset.view === view ? 'page' : 'false'); });
  if (view === 'chat') scrollChat();
  if (view === 'appearance') { appearanceDraft = structuredClone(state.settings.appearance); appearanceDirty = false; renderAppearanceEditor(); }
}
function greeting() {
  $('date-label').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  $('greeting').textContent = state.settings.nickname ? `${state.settings.nickname}，今天也一起慢慢来。` : '今天，也一起慢慢来。';
}
function showMessage(m) {
  const row = el('div', `message ${m.role}`);
  const name = m.characterName || (m.id ? DEFAULT_CHARACTER.name : state.settings.character.name);
  const avatar = el('div','companion-avatar');
  const appearance = state.settings.appearance;
  const isCurrentCharacter = !m.id || (m.characterId || DEFAULT_CHARACTER.id) === state.settings.character.id;
  setAvatar(avatar, m.role === 'assistant' ? (isCurrentCharacter ? appearance.companionAvatar : '') : appearance.userAvatar, m.role === 'assistant' ? name : state.settings.nickname || '我');
  if (m.role === 'assistant') row.append(avatar);
  const content = el('div', 'message-content');
  content.append(el('span', 'message-name', m.role === 'assistant' ? name : state.settings.nickname || '我'), el('div', 'bubble', m.content));
  if (m.at) {
    const date = new Date(m.at);
    const time = el('time', '', Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }));
    time.dateTime = m.at;
    content.append(time);
  }
  row.append(content);
  if (m.role === 'user') row.append(avatar);
  return row;
}
function scrollChat() { $('messages').scrollTop = $('messages').scrollHeight; }
function renderMessages() {
  const box = $('messages');
  box.replaceChildren(el('div', 'conversation-date', '一段属于你的安静时间'));
  for (const message of state.messages) box.append(showMessage(message));
  const character = state.settings.character;
  if (!state.messages.some(m => (m.characterId || DEFAULT_CHARACTER.id) === character.id)) box.append(showMessage({ role:'assistant', content:character.greeting }));
  if (busy) {
    const row = showMessage({ role:'assistant', content:`${character.name}正在想怎么回应你…` });
    row.classList.add('thinking'); box.append(row);
  }
  scrollChat();
}
function taskRows(container, tasks) {
  container.replaceChildren();
  if (!tasks.length) { container.append(el('div', 'empty', '还没有小目标。\n从一件五分钟能开始的事做起吧。')); return; }
  tasks.forEach(task => {
    const row = el('div', `task-row${task.done ? ' done' : ''}`);
    const check = el('input'); check.type = 'checkbox'; check.checked = task.done; check.id = `${container.id}-${task.id}`;
    const label = el('label', '', task.title); label.htmlFor = check.id;
    check.addEventListener('change', async () => {
      check.disabled = true;
      try { await mutate(s => { s.tasks.find(t => t.id === task.id).done = check.checked; }); }
      catch { check.checked = task.done; check.disabled = false; }
    });
    const remove = el('button', 'task-remove', '×'); remove.setAttribute('aria-label', `删除任务：${task.title}`);
    remove.addEventListener('click', () => {
      if (confirm(`删除「${task.title}」？`)) mutate(s => { s.tasks = s.tasks.filter(t => t.id !== task.id); }).catch(() => {});
    });
    row.append(check, label, remove); container.append(row);
  });
}
function stats(target, data) {
  $(target).replaceChildren(...data.map(([value, label]) => { const n = el('div', 'stat'); n.append(el('strong', '', String(value)), el('small', '', label)); return n; }));
}
function renderData() {
  greeting();
  const character = state.settings.character;
  $('nav-chat-label').textContent = `和${character.name}聊聊`;
  $('companion-name').textContent = character.name;
  setAvatar($('header-avatar'),state.settings.appearance.companionAvatar,character.name);
  $('companion-subtitle').textContent = character.identity;
  $('chat-input').placeholder = `想说什么都可以，${character.name}在听…`;
  const dayTasks = state.tasks.filter(t => t.date === today());
  const complete = dayTasks.filter(t => t.done).length;
  const percent = dayTasks.length ? Math.round(complete / dayTasks.length * 100) : 0;
  $('today-count').textContent = `已完成 ${complete} / ${dayTasks.length}`;
  $('today-percent').textContent = `${percent}%`; $('today-progress').value = percent;
  taskRows($('today-tasks'), dayTasks);
  taskRows($('plan-tasks'), state.tasks.filter(t => t.date === $('plan-date').value));
  stats('plan-stats', [[dayTasks.length, '今天的小目标'], [complete, '今天已完成'], [state.tasks.filter(t => t.done).length, '累计完成的小事']]);
  const focus = state.records.filter(r => r.type === 'focus');
  stats('record-stats', [[state.records.filter(r => r.type === 'note').length, '留下的心情与复盘'], [focus.reduce((n,r) => n + r.minutes, 0) + ' 分钟', '累计专注时间'], [new Set(state.records.map(r => r.date)).size + ' 天', '有记录的日子']]);
  const records = $('record-list'); records.replaceChildren();
  if (!state.records.length) records.append(el('div', 'empty', '这里还很安静。\n写下第一条记录，或者完成一次专注。'));
  state.records.slice().reverse().forEach(r => {
    const row = el('article', 'record'), meta = el('div', 'record-meta');
    meta.append(el('span','record-tag', r.type === 'focus' ? '专注时光' : '日常小记'), el('span', '', r.date));
    row.append(meta, el('p', '', r.text)); records.append(row);
  });
  renderTimer();
}
async function addTask(input, date) {
  const title = input.value.trim();
  if (!title || input.disabled) return;
  input.disabled = true;
  try { await mutate(s => s.tasks.push({ id:uid(), title, date, done:false })); input.value = ''; }
  finally { input.disabled = false; }
}
function setBusy(value) {
  busy = value; $('send').hidden = value; $('stop').hidden = !value;
  $('chat-input').disabled = value;
  document.querySelectorAll('[data-prompt]').forEach(b => b.disabled = value);
  $('retry-chat').disabled = value;
  $('character-save').disabled = value;
  renderMessages();
}
function chatError(message) { $('chat-error').hidden = !message; $('chat-error').querySelector('span').textContent = message; }
async function askModel() {
  if (busy) return;
  chatError(''); setBusy(true);
  try {
    if (pendingReply) {
      const reply = pendingReply;
      await mutate(s => s.messages.push(reply)); pendingReply = null;
    } else {
      controller = new AbortController();
      const characterId = state.settings.character.id;
      const messages = state.messages.filter(m => (m.characterId || DEFAULT_CHARACTER.id) === characterId).slice(-24).map(({role,content}) => ({role,content}));
      const reply = await api('/api/chat', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ model:state.settings.model, messages, date:today(), characterId }), signal:controller.signal });
      pendingReply = { id:uid(), role:'assistant', content:reply.content, at:new Date().toISOString(), characterId:reply.characterId, characterName:reply.characterName };
      await mutate(s => s.messages.push(pendingReply)); pendingReply = null;
    }
  } catch (e) { chatError(e.name === 'AbortError' ? '已停止生成。可以重试，或发送新的消息。' : e.message); }
  finally { controller = null; setBusy(false); $('chat-input').focus(); }
}
async function sendMessage(content) {
  content = content.trim();
  if (!content || busy) return;
  if (pendingReply) { chatError('上一条回复尚未保存，请先点击重试保存。'); return; }
  setBusy(true);
  try { await mutate(s => s.messages.push({ id:uid(), role:'user', content, at:new Date().toISOString(), characterId:s.settings.character.id })); $('chat-input').value = ''; }
  catch { setBusy(false); return; }
  setBusy(false); await askModel();
}
async function connect() {
  $('connection-label').textContent = '连接中';
  try {
    const result = await api('/api/models'); models = result.models;
    $('connection').classList.toggle('offline', !models.length);
    $('connection-label').textContent = models.length ? '本地模型已连接' : '还没有模型';
    $('model-hint').textContent = models.length ? '模型来自本机 Ollama，默认使用 Gemma 3 12B。' : '请先在 Ollama 下载一个模型，例如 gemma3:12b。';
  } catch (e) {
    models = []; $('connection').classList.add('offline'); $('connection-label').textContent = '重新连接'; $('model-hint').textContent = e.message;
  }
  const current = $('settings-dialog').open ? $('model').value || state.settings.model : state.settings.model;
  $('model').replaceChildren(...[...new Set([current, ...models])].filter(Boolean).map(name => { const option = el('option', '', name + (models.includes(name) ? '' : '（未连接）')); option.value = name; return option; }));
  $('model').value = current;
}
function renderTimer() {
  const timer = state.timer;
  const seconds = timer ? Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000)) : selectedMinutes * 60;
  $('timer-display').textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
  $('timer-toggle').textContent = timer ? (seconds === 0 ? '保存专注记录' : '结束本次专注') : '开始专注 ▷';
  $('timer-hint').textContent = timer ? '正在专注 · 关闭页面后不会发送通知' : '页面打开时，到点会在这里提醒你';
  document.querySelectorAll('[data-minutes]').forEach(b => { b.disabled = !!timer; b.classList.toggle('selected', Number(b.dataset.minutes) === (timer?.minutes || selectedMinutes)); });
}
async function finishTimer() {
  if (!state?.timer || timerSaving || state.timer.endsAt > Date.now()) return;
  timerSaving = true;
  const timer = state.timer;
  const finishedAt = new Date(timer.endsAt);
  const date = `${finishedAt.getFullYear()}-${String(finishedAt.getMonth()+1).padStart(2,'0')}-${String(finishedAt.getDate()).padStart(2,'0')}`;
  try {
    await mutate(s => {
      if (s.timer?.id !== timer.id) return;
      if (!s.records.some(r => r.id === timer.id)) s.records.push({ id:timer.id, type:'focus', minutes:timer.minutes, date, at:finishedAt.toISOString(), text:`完成了 ${timer.minutes} 分钟专注。给认真开始的自己一点肯定。` });
      s.timer = null;
    });
    notice(`这段 ${timer.minutes} 分钟的专注结束了，已经记入陪伴记录。休息一下吧。`);
  } catch { failedTimerId = timer.id; }
  finally { timerSaving = false; }
}
async function init() {
  try { state = await api('/api/state'); }
  catch (e) { notice('无法载入本机记录，请重新启动陪伴后刷新。' + e.message); document.querySelectorAll('button,input,textarea').forEach(n => n.disabled = true); return; }
  state.settings.appearance ||= { ...DEFAULT_APPEARANCE };
  applyAppearance(state.settings.appearance);
  $('plan-date').value = today(); renderData(); renderMessages(); initCharacter(); initAppearance(); $('startup-status').hidden = true; await finishTimer();
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('quick-task-form').addEventListener('submit', e => { e.preventDefault(); addTask($('quick-task'), today()).catch(() => {}); });
  $('plan-form').addEventListener('submit', e => { e.preventDefault(); addTask($('plan-title'), $('plan-date').value).catch(() => {}); });
  $('plan-date').addEventListener('change', renderData);
  $('chat-form').addEventListener('submit', e => { e.preventDefault(); sendMessage($('chat-input').value); });
  $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(e.currentTarget.value); } });
  document.querySelectorAll('[data-prompt]').forEach(b => b.addEventListener('click', () => sendMessage(b.dataset.prompt)));
  $('stop').addEventListener('click', () => controller?.abort());
  $('retry-chat').addEventListener('click', askModel);
  $('note-form').addEventListener('submit', async e => {
    e.preventDefault(); const text = $('note-input').value.trim(); if (!text) return;
    const button = e.currentTarget.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try { await mutate(s => s.records.push({ id:uid(), type:'note', text, date:today(), at:new Date().toISOString() })); $('note-input').value = ''; }
    catch { /* retain draft */ }
    finally { button.disabled = false; }
  });
  document.querySelectorAll('[data-minutes]').forEach(b => b.addEventListener('click', () => { selectedMinutes = Number(b.dataset.minutes); renderTimer(); }));
  $('timer-toggle').addEventListener('click', async () => {
    if (timerSaving) return;
    if (state.timer && state.timer.endsAt <= Date.now()) return finishTimer();
    if (state.timer && !confirm('提前结束这次专注？未完成的时段不会计入专注记录。')) return;
    try { await mutate(s => { s.timer = s.timer ? null : { id:uid(), minutes:selectedMinutes, endsAt:Date.now() + selectedMinutes * 60000 }; }); }
    catch { /* notice shown by mutate */ }
  });
  $('settings-open').addEventListener('click', () => { $('nickname').value = state.settings.nickname; $('model').value = state.settings.model; $('settings-dialog').showModal(); });
  $('settings-close').addEventListener('click', () => $('settings-dialog').close());
  $('settings-form').addEventListener('submit', async e => {
    e.preventDefault(); const nickname = $('nickname').value.trim(), model = $('model').value;
    if (!model) { notice('请先连接 Ollama 并选择模型。'); return; }
    try { await mutate(s => { s.settings = { ...s.settings, nickname, model }; }); $('settings-dialog').close(); renderMessages(); }
    catch { /* keep dialog open */ }
  });
  $('refresh-models').addEventListener('click', connect);
  $('connection').addEventListener('click', async () => { await connect(); if (!models.length) notice($('model-hint').textContent); else notice(''); });
  $('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob), anchor = el('a'); anchor.href = url; anchor.download = `陪伴记录-${today()}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  setInterval(() => {
    if (currentDay !== today()) { currentDay = today(); $('plan-date').value = currentDay; renderData(); }
    renderTimer();
    if (state.timer && state.timer.endsAt <= Date.now() && state.timer.id !== failedTimerId) finishTimer();
  }, 1000);
  await connect();
}
const characterFields = [...Object.keys(CHARACTER_LIMITS), 'mode', 'replyLength', 'emoji'];
function characterDraft() {
  return Object.fromEntries(characterFields.map(k => [k, $('char-' + k).value.trim()]));
}
function previewCharacter(dirty = true) {
  const draft = characterDraft();
  $('preview-name').textContent = draft.name || '角色名字';
  setAvatar($('preview-avatar'),state.settings.appearance.companionAvatar,draft.name || '伴');
  $('preview-identity').textContent = draft.identity;
  $('preview-greeting').textContent = draft.greeting || '写一句你喜欢的开场白…';
  if (dirty) $('character-dirty').textContent = '草稿 · 尚未保存';
}
function fillCharacter(character, dirty = false) {
  characterFields.forEach(k => { $('char-' + k).value = character[k]; });
  $('character-dirty').textContent = dirty ? '草稿 · 尚未保存' : '已保存的角色';
  $('character-error').hidden = true;
  previewCharacter(false);
}
function characterError(message) { $('character-error').textContent = message; $('character-error').hidden = !message; }
function initCharacter() {
  fillCharacter(state.settings.character);
  $('character-presets').replaceChildren(...CHARACTER_PRESETS.map(preset => {
    const button = el('button','character-preset'); button.type = 'button';
    button.append(el('strong','',preset.label),el('small','',preset.description));
    button.addEventListener('click', () => fillCharacter(preset.character, true)); return button;
  }));
  $('character-form').addEventListener('input', () => previewCharacter());
  $('character-form').addEventListener('submit', async e => {
    e.preventDefault(); if (busy) return;
    if (pendingReply) { characterError('上一条回复尚未保存，请先返回聊天重试。'); return; }
    const button = $('character-save'); if (button.disabled) return;
    try {
      const draft = characterDraft();
      const changed = characterFields.some(k => draft[k] !== state.settings.character[k]);
      const character = cleanCharacter({ ...draft, id:changed ? uid() : state.settings.character.id });
      button.disabled = true;
      await mutate(s => { s.settings.character = character; });
      fillCharacter(character); renderMessages(); chatError('');
      notice(`已启用「${character.name}」。下一条消息会使用新角色设定。`);
    } catch (e) { characterError(e.message); }
    finally { button.disabled = busy; }
  });
  $('character-export').addEventListener('click', () => {
    try {
      const pack = exportCharacter({ ...characterDraft(), id:'export' });
      const blob = new Blob([JSON.stringify(pack,null,2)], { type:'application/json' });
      const url = URL.createObjectURL(blob), anchor = el('a'); anchor.href = url; anchor.download = '陪伴角色包.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
      characterError('');
    } catch (e) { characterError(e.message); }
  });
  $('character-import').addEventListener('click', () => $('character-file').click());
  $('character-file').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      if (file.size > 65536) throw new Error('角色包不能超过 64 KiB。');
      let pack; try { pack = JSON.parse(await file.text()); } catch { throw new Error('文件不是有效的 JSON 角色包。'); }
      fillCharacter(importCharacter(pack,uid()),true);
    } catch (e) { characterError(e.message); }
    finally { e.target.value = ''; }
  });
}
function appearanceError(message) { $('appearance-error').textContent = message; $('appearance-error').hidden = !message; }
function renderAppearanceEditor() {
  for (const key of ['accent','backgroundColor']) $('appearance-' + key).value = appearanceDraft[key];
  $('appearance-opacity').value = appearanceDraft.backgroundOpacity;
  $('accent-value').textContent = appearanceDraft.accent;
  $('background-value').textContent = appearanceDraft.backgroundColor;
  $('opacity-value').textContent = appearanceDraft.backgroundOpacity + '%';
  $('appearance-status').textContent = appearanceDirty ? '预览中 · 尚未保存' : '已保存的外观';
  $('appearance-role-name').textContent = state.settings.character.name;
  ['edit-companion-avatar','appearance-companion-preview'].forEach(id => setAvatar($(id),appearanceDraft.companionAvatar,state.settings.character.name));
  ['edit-user-avatar','appearance-user-preview'].forEach(id => setAvatar($(id),appearanceDraft.userAvatar,state.settings.nickname || '我'));
  $('background-upload').classList.toggle('has-image',!!appearanceDraft.backgroundImage);
  $('background-upload').style.backgroundImage = appearanceDraft.backgroundImage ? `linear-gradient(#ffffffb8,#ffffffb8),url("${appearanceDraft.backgroundImage}")` : 'none';
  $('background-upload').setAttribute('aria-label',appearanceDraft.backgroundImage ? '更换背景图片' : '上传背景图片');
  document.querySelectorAll('[data-theme-index]').forEach(button => {
    const theme = THEMES[Number(button.dataset.themeIndex)];
    const selected = theme.accent === appearanceDraft.accent && theme.backgroundColor === appearanceDraft.backgroundColor;
    button.classList.toggle('selected',selected); button.setAttribute('aria-pressed',String(selected));
  });
  applyAppearance(appearanceDraft);
}
function updateAppearance(change) {
  Object.assign(appearanceDraft,change); appearanceDirty = true;
  appearanceError(''); renderAppearanceEditor();
}
async function compressImage(file, target) {
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
  if (file.size > 10 * 1024 * 1024) throw new Error('图片超过 10 MB，请先缩小图片。');
  const source = await new Promise((resolve,reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('无法读取图片。')); reader.readAsDataURL(file);
  });
  const image = new Image();
  image.src = source;
  try { await image.decode(); } catch { throw new Error('图片无法解码，请换一张图片。'); }
  const w = image.naturalWidth, h = image.naturalHeight;
  if (!w || !h || w*h > 40000000) throw new Error('图片尺寸过大，请缩小至 4000 万像素以内。');
  const background = target === 'backgroundImage';
  const canvas = document.createElement('canvas');
  const scale = Math.min(1,1600/Math.max(w,h));
  canvas.width = background ? Math.round(w*scale) : 256;
  canvas.height = background ? Math.round(h*scale) : 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法处理图片。');
  if (background) context.drawImage(image,0,0,canvas.width,canvas.height);
  else { const edge = Math.min(w,h); context.drawImage(image,(w-edge)/2,(h-edge)/2,edge,edge,0,0,256,256); }
  let data = canvas.toDataURL('image/webp',.84);
  const limit = background ? 1600000 : 240000;
  if (data.length > limit) data = canvas.toDataURL('image/jpeg',.65);
  if (data.length > limit) throw new Error('压缩后的图片仍过大，请换一张更小的图片。');
  return data;
}
function initAppearance() {
  appearanceDraft = structuredClone(state.settings.appearance);
  $('theme-presets').replaceChildren(...THEMES.map((theme,index) => {
    const button = el('button','theme-swatch'); button.type = 'button'; button.dataset.themeIndex = String(index);
    const swatch = el('span'); swatch.style.backgroundColor = theme.accent;
    button.append(swatch,el('small','',theme.name));
    button.addEventListener('click',() => updateAppearance({accent:theme.accent,backgroundColor:theme.backgroundColor})); return button;
  }));
  for (const key of ['accent','backgroundColor']) $('appearance-' + key).addEventListener('input',e => updateAppearance({[key]:e.target.value}));
  $('appearance-opacity').addEventListener('input',e => updateAppearance({backgroundOpacity:Number(e.target.value)}));
  document.querySelectorAll('[data-upload]').forEach(button => button.addEventListener('click',() => {
    if (imageProcessing) return;
    uploadTarget = button.dataset.upload; $('appearance-image-file').click();
  }));
  document.querySelectorAll('[data-remove-image]').forEach(button => button.addEventListener('click',() => updateAppearance({[button.dataset.removeImage]:''})));
  $('appearance-image-file').addEventListener('change',async e => {
    const file = e.target.files[0], target = uploadTarget;
    if (!file || imageProcessing) return;
    imageProcessing = true; $('appearance-save').disabled = true;
    $('appearance-status').textContent = '正在处理图片…';
    try { const result = await compressImage(file,target); if (view === 'appearance') updateAppearance({[target]:result}); }
    catch (error) { appearanceError(error.message); }
    finally { imageProcessing = false; $('appearance-save').disabled = false; e.target.value = ''; $('appearance-status').textContent = appearanceDirty ? '预览中 · 尚未保存' : '已保存的外观'; }
  });
  $('appearance-form').addEventListener('submit',async e => {
    e.preventDefault(); const button = $('appearance-save'); if (button.disabled || imageProcessing) return;
    try {
      const appearance = cleanAppearance(appearanceDraft); button.disabled = true;
      await mutate(s => { s.settings.appearance = appearance; });
      appearanceDirty = false; appearanceDraft = structuredClone(appearance); renderAppearanceEditor(); renderMessages(); previewCharacter(false); appearanceError('');
      notice('外观已保存，头像、背景与配色都会在下次打开时保留。');
    } catch(error) { appearanceError(error.message); }
    finally { button.disabled = false; }
  });
  $('appearance-cancel').addEventListener('click',() => { appearanceDraft = structuredClone(state.settings.appearance); appearanceDirty = false; appearanceError(''); renderAppearanceEditor(); });
  $('appearance-reset').addEventListener('click',() => updateAppearance({...DEFAULT_APPEARANCE}));
}
init().catch(error => { notice('页面初始化未完成，请刷新重试。' + error.message); $('startup-status').textContent = '初始化失败，请刷新页面重试。'; });
