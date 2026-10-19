import { DEFAULT_CHARACTER, CHARACTER_PRESETS, CHARACTER_LIMITS, cleanCharacter, importCharacter, exportCharacter } from './character.js?v=0.9.2';
import { DEFAULT_APPEARANCE, THEMES, cleanAppearance, themeProperties } from './appearance.js?v=0.9.2';
import { DEFAULT_OPTIONS, cleanOptions } from './options.js?v=0.9.2';
import { DEFAULT_PET } from './pet-config.js?v=0.9.2';
const $ = id => document.getElementById(id);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const uid = () => crypto.randomUUID();
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
let state, models = [], busy = false, controller, pendingReply = null, selectedMinutes = 25, view = 'chat', timerSaving = false, currentDay = today();
let streamText = null, streamNode = null, utterance = null, memoryBusy = false;
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
async function encodeState(payload) {
  const text = JSON.stringify(payload);
  if (typeof CompressionStream === 'undefined') {
    return { body: text, headers: { 'Content-Type': 'application/json' } };
  }
  const gz = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buffer = await new Response(gz).arrayBuffer();
  return { body: buffer, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } };
}
function mutate(change, { includeAppearance = false } = {}) {
  const action = mutationQueue.then(async () => {
    const draft = structuredClone(state);
    change(draft);
    // 头像是 base64、背景图更大；没有改动外观时不要每次保存都重新上传一遍。
    const payload = includeAppearance ? draft : { ...draft, settings: { ...draft.settings, appearance: undefined } };
    $('save-status').textContent = '正在保存…';
    try {
      const encoded = await encodeState(payload);
      const result = await api('/api/state', { method: 'PUT', headers: encoded.headers, body: encoded.body });
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
  if (view === 'chat') scrollChat(true);
  if (view === 'appearance') { appearanceDraft = structuredClone(state.settings.appearance); appearanceDirty = false; renderAppearanceEditor(); }
}
function greeting() {
  $('date-label').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  $('greeting').textContent = state.settings.nickname ? `${state.settings.nickname}，在呢。` : '在呢，慢慢来。';
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
let stickToBottom = true;
function scrollChat(force = false) {
  const box = $('messages');
  if (!box) return;
  // 用户往上翻的时候不要把他拽回底部
  if (force || stickToBottom) box.scrollTop = box.scrollHeight;
}
function renderMessages() {
  const box = $('messages');
  box.replaceChildren(el('div', 'conversation-date', '一段属于你的安静时间'));
  for (const message of state.messages) box.append(showMessage(message));
  const character = state.settings.character;
  if (!state.messages.some(m => (m.characterId || DEFAULT_CHARACTER.id) === character.id)) box.append(showMessage({ role:'assistant', content:character.greeting }));
  if (busy) {
    const row = showMessage({ role:'assistant', content: streamText === null ? `${character.name}正在想怎么回应你…` : streamText });
    row.classList.add('thinking');
    if (streamText !== null) row.classList.add('streaming');
    box.append(row);
  }
  scrollChat();
}
const ACTIVITIES = ['写代码', '工作', '学习', '打游戏', '看剧', '健身', '发呆', '休息'];
async function setActivity(label) {
  await mutate(s => { s.activity = { label, at: new Date().toISOString() }; });
  if (label) notice(`知道你在${label}。她记下了，不会打扰。`);
}
function renderNow() {
  const box = $('now-chips');
  if (!box) return;
  const current = state.activity?.label || '';
  box.replaceChildren(...ACTIVITIES.map(label => {
    const chip = el('button', `now-chip${label === current ? ' on' : ''}`, label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(label === current));
    chip.addEventListener('click', () => setActivity(label === current ? '' : label).catch(() => {}));
    return chip;
  }));
  $('now-strip')?.classList.toggle('has', !!current);
}
function taskRows(container, tasks) {
  container.replaceChildren();
  if (!tasks.length) { container.append(el('div', 'empty', '还没有安排。\n想到什么就先写下来。')); return; }
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
  $('nav-chat-label').textContent = `和${character.name}待着`;
  $('companion-name').textContent = character.name;
  setAvatar($('header-avatar'),state.settings.appearance.companionAvatar,character.name);
  $('companion-subtitle').textContent = character.identity;
  $('chat-input').placeholder = `想说什么都可以，${character.name}在听…`;
  renderNow();
  const dayTasks = state.tasks.filter(t => t.date === today());
  const complete = dayTasks.filter(t => t.done).length;
  const percent = dayTasks.length ? Math.round(complete / dayTasks.length * 100) : 0;
  $('today-count').textContent = dayTasks.length ? `做了 ${complete} 件 · 还有 ${dayTasks.length - complete} 件` : '还没有安排';
  $('today-percent').textContent = ''; $('today-progress').value = percent;
  taskRows($('today-tasks'), dayTasks);
  taskRows($('plan-tasks'), state.tasks.filter(t => t.date === $('plan-date').value));
  stats('plan-stats', [[dayTasks.length, '今天的小目标'], [complete, '今天已完成'], [state.tasks.filter(t => t.done).length, '累计完成的小事']]);
  const focus = state.records.filter(r => r.type === 'focus');
  stats('record-stats', [[state.records.filter(r => r.type === 'note').length, '写下的片段'], [focus.reduce((n,r) => n + r.minutes, 0) + ' 分钟', '一起待过的时间'], [new Set(state.records.map(r => r.date)).size + ' 天', '有记录的日子']]);
  const records = $('record-list'); records.replaceChildren();
  if (!state.records.length) records.append(el('div', 'empty', '这里还很安静。\n写一句此刻在想什么吧。'));
  state.records.slice().reverse().forEach(r => {
    const row = el('article', 'record'), meta = el('div', 'record-meta');
    meta.append(el('span','record-tag', r.type === 'focus' ? '专注时光' : '日常小记'), el('span', '', r.date));
    row.append(meta, el('p', '', r.text)); records.append(row);
  });
  renderMemory();
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
function paintStream() {
  if (!streamNode || !streamNode.isConnected) {
    renderMessages();
    streamNode = document.querySelector('#messages .message.streaming .bubble');
  }
  if (streamNode) { streamNode.textContent = streamText; scrollChat(); }
}
let voices = [], speakQueue = [], speakTimer = null, speakToken = 0, audioCurrent = null, audioCleanup = null;
function chineseVoices() {
  if (!('speechSynthesis' in window)) return [];
  const list = speechSynthesis.getVoices();
  if (list.length) voices = list;
  return (list.length ? list : voices).filter(v => /^zh/i.test(v.lang));
}
// 神经语音 > 在线 > 普通话 > 其它；本地的 SAPI 语音通常很旧，降权。
function scoreVoice(v) {
  let score = 0;
  if (/natural/i.test(v.name)) score += 6;
  if (/online/i.test(v.name)) score += 2;
  if (/xiaoxiao|晓晓/i.test(v.name)) score += 3;
  if (/^zh-CN$/i.test(v.lang)) score += 2;
  if (/HK|TW|liaoning|shaanxi|Cantonese|Taiwanese|Traditional/i.test(`${v.lang} ${v.name}`)) score -= 4;
  if (v.localService) score -= 1;
  return score;
}
function resolveVoice() {
  const list = chineseVoices();
  if (!list.length) return null;
  return list.find(v => v.name === state.settings.voiceName) || list.slice().sort((a, b) => scoreVoice(b) - scoreVoice(a))[0];
}
function toSpeechChunks(text) {
  const plain = text.replace(/```[\s\S]*?```/g, '').replace(/[*_`#>~]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();
  if (!plain) return [];
  return plain.split(/(?<=[。！？!?…；;])/).map(part => part.trim()).filter(Boolean);
}
function speakNext() {
  const next = speakQueue.shift();
  if (!next) { utterance = null; return; }
  next.onend = () => {
    utterance = null;
    if (speakQueue.length) speakTimer = setTimeout(speakNext, 130);
  };
  next.onerror = () => { speakQueue = []; utterance = null; };
  utterance = next;
  speechSynthesis.speak(next);
}
function speak(text, { force = false } = {}) {
  if (!force && !state.settings.voice) return;
  stopSpeaking();
  const chunks = toSpeechChunks(text);
  if (!chunks.length) return;
  if (state.settings.voiceEngine === 'local') {
    const token = speakToken;
    speakLocal(chunks, token).catch(error => {
      if (token !== speakToken) return;           // 已被停止或换成另一句
      notice(`本地 TTS 没成功（${error.message}），这一句改用系统语音。`);
      speakSystem(chunks);
    });
    return;
  }
  speakSystem(chunks);
}
function speakSystem(chunks) {
  if (!('speechSynthesis' in window)) return;
  const voice = resolveVoice();
  const rate = Number(state.settings.voiceRate) || 1;
  speakQueue = chunks.map(chunk => {
    const line = new SpeechSynthesisUtterance(chunk);
    line.lang = voice?.lang || 'zh-CN';
    if (voice) line.voice = voice;
    line.rate = rate;
    // 逐句合成，句间留一点停顿，比整段一口气念自然得多
    return line;
  });
  speakNext();
}
async function speakLocal(chunks, token) {
  for (const chunk of chunks) {
    if (token !== speakToken) return;
    const response = await fetch('/api/voice/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: chunk }) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `TTS 返回 ${response.status}`);
    }
    const blob = await response.blob();
    if (token !== speakToken) return;
    await playAudio(blob);
  }
}
function playAudio(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const finish = () => { URL.revokeObjectURL(url); if (audioCurrent === audio) { audioCurrent = null; audioCleanup = null; } resolve(); };
    audioCleanup = finish;
    audio.onended = finish;
    audio.onerror = () => { URL.revokeObjectURL(url); audioCurrent = null; audioCleanup = null; reject(new Error('音频播放失败')); };
    audioCurrent = audio;
    audio.play().catch(reject);
  });
}
function stopSpeaking() {
  speakToken++;
  speakQueue = [];
  if (speakTimer) { clearTimeout(speakTimer); speakTimer = null; }
  if (audioCurrent) { audioCurrent.pause(); audioCleanup?.(); audioCurrent = null; audioCleanup = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  utterance = null;
}
function syncVoiceEngine() {
  const local = $('voice-engine').value === 'local';
  const localPanel = document.querySelector('.local-tts'), systemPanel = document.querySelector('.system-tts');
  if (localPanel) localPanel.hidden = !local;
  if (systemPanel) systemPanel.hidden = local;
}
function syncVoiceLabel() {
  $('voice-rate-value').textContent = Number($('voice-rate').value).toFixed(2);
}
function renderVoiceOptions() {
  const select = $('voice-select');
  if (!select) return;
  const list = chineseVoices();
  const current = state.settings.voiceName || '';
  const options = [new Option('自动（优先神经语音）', '')];
  for (const voice of list.slice().sort((a, b) => scoreVoice(b) - scoreVoice(a))) {
    const label = voice.name.replace(/^Microsoft\s*/, '').replace(/\s*-\s*Chinese.*$/, '').trim();
    options.push(new Option(`${label}${voice.localService ? ' · 本地' : ' · 在线'}`, voice.name));
  }
  if (current && !list.some(v => v.name === current)) options.push(new Option(`${current}（系统里已找不到）`, current));
  select.replaceChildren(...options);
  select.value = current;
  const hint = $('voice-hint');
  if (hint) hint.textContent = list.length <= 1
    ? '只检测到本地 SAPI 语音，音质较旧。用 Microsoft Edge 打开这个地址，可以解锁微软神经语音（晓晓、云希等）。'
    : `检测到 ${list.length} 个中文语音。标「在线」的是神经语音，明显更自然。`;
}
async function askModel() {
  if (busy) return;
  chatError(''); setBusy(true);
  try {
    if (pendingReply) {
      const reply = pendingReply;
      await mutate(s => s.messages.push(reply)); pendingReply = null;
    } else {
      controller = new AbortController();
      stopSpeaking();
      const characterId = state.settings.character.id;
      const messages = state.messages.filter(m => (m.characterId || DEFAULT_CHARACTER.id) === characterId).slice(-24).map(({role,content}) => ({role,content}));
      streamText = ''; streamNode = null;
      // 逐字刷新会让读屏软件反复播报，流式期间先关掉实时区域，结束后再打开。
      $('messages').setAttribute('aria-live', 'off');
      const response = await fetch('/api/chat/stream', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ model:state.settings.model, messages, date:today(), characterId }), signal:controller.signal });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || '请求失败，请重试。'); }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '', done = null;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const line = frame.split('\n').find(part => part.startsWith('data: '));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          if (event.error) throw new Error(event.error);
          if (event.delta) { streamText += event.delta; paintStream(); }
          if (event.done) done = event;
        }
      }
      const content = (done?.content ?? streamText).trim();
      if (!content) throw new Error('模型没有返回正文，请换个模型或重新发送。');
      pendingReply = { id:uid(), role:'assistant', content, at:new Date().toISOString(), characterId:done?.characterId || characterId, characterName:done?.characterName || state.settings.character.name };
      await mutate(s => s.messages.push(pendingReply)); pendingReply = null;
      speak(content);
      if (unsummarized(characterId) >= 20) remember({ silent:true }).catch(() => {});
    }
  } catch (e) { chatError(e.name === 'AbortError' ? '已停止生成。可以重试，或发送新的消息。' : e.message); }
  finally { streamText = null; streamNode = null; controller = null; setBusy(false); $('messages').setAttribute('aria-live', 'polite'); $('chat-input').focus(); }
}
function unsummarized(characterId) {
  const cut = state.episodes.at(-1)?.through || '';
  return state.messages.filter(m => (m.characterId || DEFAULT_CHARACTER.id) === characterId && (m.at || '') > cut).length;
}
async function remember({ silent = false } = {}) {
  if (memoryBusy) return;
  memoryBusy = true;
  try {
    const characterId = state.settings.character.id;
    const result = await api('/api/memory/summarize', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ model:state.settings.model, date:today(), characterId }) });
    await mutate(s => {
      if (s.episodes.some(e => e.through === result.through)) return;
      s.episodes.push({ id:uid(), date:result.date, at:new Date().toISOString(), through:result.through, text:result.summary, characterId });
      for (const text of result.facts) if (!s.facts.some(f => f.text === text)) s.facts.push({ id:uid(), text, at:new Date().toISOString() });
      while (s.episodes.length > 120) s.episodes.shift();
      while (s.facts.length > 120) s.facts.shift();
    });
    notice(`记住了这一段：${result.summary}`);
  } catch (e) { if (!silent) notice(e.message); }
  finally { memoryBusy = false; }
}
function renderMemory() {
  const episodes = $('memory-episodes'), facts = $('memory-facts');
  if (!episodes || !facts) return;
  episodes.replaceChildren();
  if (!state.episodes.length) episodes.append(el('div','empty','还没有回忆。聊够了之后，点上面的按钮整理一次。'));
  state.episodes.slice().reverse().forEach(episode => {
    const row = el('article','record'), meta = el('div','record-meta');
    const remove = el('button','task-remove','×'); remove.type = 'button'; remove.setAttribute('aria-label','删除这段回忆');
    remove.addEventListener('click', () => mutate(s => { s.episodes = s.episodes.filter(x => x.id !== episode.id); }).catch(() => {}));
    meta.append(el('span','record-tag','回忆'), el('span','', episode.date), remove);
    row.append(meta, el('p','', episode.text)); episodes.append(row);
  });
  facts.replaceChildren();
  if (!state.facts.length) facts.append(el('div','empty','还没有记住任何事实。'));
  state.facts.slice().reverse().forEach(fact => {
    const chip = el('button','fact-chip', fact.text); chip.type = 'button'; chip.title = '点击删除这条记忆';
    chip.addEventListener('click', () => { if (confirm(`删掉「${fact.text}」这条记忆？`)) mutate(s => { s.facts = s.facts.filter(x => x.id !== fact.id); }).catch(() => {}); });
    facts.append(chip);
  });
  $('memory-count').textContent = `${state.episodes.length} 段回忆 · ${state.facts.length} 条事实`;
}
async function sendMessage(content) {
  content = content.trim();
  if (!content || busy) return;
  if (pendingReply) { chatError('上一条回复尚未保存，请先点击重试保存。'); return; }
  stopSpeaking();
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
    $('model-hint').textContent = models.length ? '模型来自本机 Ollama，可在下面切换。' : '请先在 Ollama 下载一个模型，例如 gemma3:12b。';
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
  $('timer-hint').textContent = timer ? '正在一起待着 · 关闭页面后不会发送通知' : '页面打开时，到点会在这里提醒你';
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
    notice(`一起待了 ${timer.minutes} 分钟，记下来了。`);
  } catch { failedTimerId = timer.id; }
  finally { timerSaving = false; }
}
function syncOptions() {
  $('temperature-value').textContent = Number($('temperature').value).toFixed(2);
  $('numPredict-value').textContent = `${$('numPredict').value} token`;
}
async function init() {
  try { state = await api('/api/state'); }
  catch (e) { notice('无法载入本机记录，请重新启动陪伴后刷新。' + e.message); document.querySelectorAll('button,input,textarea').forEach(n => n.disabled = true); return; }
  state.settings.appearance ||= { ...DEFAULT_APPEARANCE };
  state.settings.options ||= { ...DEFAULT_OPTIONS };
  state.settings.voice = state.settings.voice === true;
  state.episodes ||= []; state.facts ||= [];
  applyAppearance(state.settings.appearance);
  $('plan-date').value = today(); renderData(); renderMessages(); initCharacter(); initAppearance(); $('startup-status').hidden = true; await finishTimer();
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('quick-task-form').addEventListener('submit', e => { e.preventDefault(); addTask($('quick-task'), today()).catch(() => {}); });
  $('plan-form').addEventListener('submit', e => { e.preventDefault(); addTask($('plan-title'), $('plan-date').value).catch(() => {}); });
  $('plan-date').addEventListener('change', renderData);
  $('chat-form').addEventListener('submit', e => { e.preventDefault(); sendMessage($('chat-input').value); });
  $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(e.currentTarget.value); } });
  $('messages').addEventListener('scroll', () => {
    const box = $('messages');
    stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  }, { passive: true });
  document.querySelectorAll('[data-prompt]').forEach(b => b.addEventListener('click', () => sendMessage(b.dataset.prompt)));
  $('stop').addEventListener('click', () => { controller?.abort(); stopSpeaking(); });
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
  $('memory-remember').addEventListener('click', () => { remember().catch(() => {}); });
  $('settings-open').addEventListener('click', () => {
    $('nickname').value = state.settings.nickname; $('model').value = state.settings.model;
    $('voice').checked = !!state.settings.voice;
    const options = state.settings.options || DEFAULT_OPTIONS;
    $('temperature').value = options.temperature; $('numPredict').value = options.numPredict; $('numCtx').value = String(options.numCtx);
    renderVoiceOptions();
    $('voice-rate').value = state.settings.voiceRate || 1;
    $('voice-engine').value = state.settings.voiceEngine || 'system';
    $('tts-adapter').value = state.settings.ttsAdapter || 'openai';
    $('tts-url').value = state.settings.ttsUrl || 'http://127.0.0.1:9880';
    $('tts-voice').value = state.settings.ttsVoice || '';
    $('tts-model').value = state.settings.ttsModel || 'tts-1';
    const pet = state.settings.pet || DEFAULT_PET;
    $('pet-enabled').checked = !!pet.enabled;
    $('pet-interval').value = String(pet.intervalMinutes || 5);
    $('pet-size').value = pet.size || 'medium';
    $('pet-model').value = pet.model || '';
    syncVoiceEngine();
    syncOptions(); syncVoiceLabel();
    $('settings-dialog').showModal();
  });
  $('settings-close').addEventListener('click', () => $('settings-dialog').close());
  $('temperature').addEventListener('input', syncOptions);
  $('numPredict').addEventListener('input', syncOptions);
  $('voice-rate').addEventListener('input', syncVoiceLabel);
  $('voice-engine').addEventListener('change', syncVoiceEngine);
  $('voice-test').addEventListener('click', () => speak('在呢。今天想先聊聊，还是一起开始一件小事？', { force: true }));
  $('pet-open').addEventListener('click', () => window.open('/pet', 'peiban-pet', 'width=320,height=470'));
  if ('speechSynthesis' in window) { speechSynthesis.addEventListener('voiceschanged', renderVoiceOptions); renderVoiceOptions(); }
  $('settings-form').addEventListener('submit', async e => {
    e.preventDefault(); const nickname = $('nickname').value.trim(), model = $('model').value;
    if (!model) { notice('请先连接 Ollama 并选择模型。'); return; }
    let options;
    try { options = cleanOptions({ temperature:Number($('temperature').value), numPredict:Number($('numPredict').value), numCtx:Number($('numCtx').value) }); }
    catch (error) { notice(error.message); return; }
    try { await mutate(s => { s.settings = { ...s.settings, nickname, model, voice:$('voice').checked, voiceName:$('voice-select').value, voiceRate:Number($('voice-rate').value), voiceEngine:$('voice-engine').value, ttsAdapter:$('tts-adapter').value, ttsUrl:$('tts-url').value.trim(), ttsVoice:$('tts-voice').value.trim(), ttsModel:$('tts-model').value.trim(), pet: { enabled:$('pet-enabled').checked, intervalMinutes:Number($('pet-interval').value), size:$('pet-size').value, alwaysOnTop: s.settings.pet?.alwaysOnTop ?? true, model:$('pet-model').value.trim() }, options }; }); $('settings-dialog').close(); renderMessages(); }
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
  if ($('edit-pet-image')) setAvatar($('edit-pet-image'), appearanceDraft.petImage, '伴');
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
      await mutate(s => { s.settings.appearance = appearance; }, { includeAppearance: true });
      appearanceDirty = false; appearanceDraft = structuredClone(appearance); renderAppearanceEditor(); renderMessages(); previewCharacter(false); appearanceError('');
      notice('外观已保存，头像、背景与配色都会在下次打开时保留。');
    } catch(error) { appearanceError(error.message); }
    finally { button.disabled = false; }
  });
  $('appearance-cancel').addEventListener('click',() => { appearanceDraft = structuredClone(state.settings.appearance); appearanceDirty = false; appearanceError(''); renderAppearanceEditor(); });
  $('appearance-reset').addEventListener('click',() => updateAppearance({...DEFAULT_APPEARANCE}));
}
init().catch(error => { notice('页面初始化未完成，请刷新重试。' + error.message); $('startup-status').textContent = '初始化失败，请刷新页面重试。'; });
