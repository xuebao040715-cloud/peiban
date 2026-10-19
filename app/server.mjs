import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CHARACTER, validCharacter, cleanCharacter, characterPrompt } from './public/character.js';
import { DEFAULT_APPEARANCE, validAppearance, cleanAppearance } from './public/appearance.js';
import { DEFAULT_OPTIONS, validOptions, cleanOptions } from './public/options.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const emptyState = () => ({ version: 0, settings: { nickname: '', model: 'gemma3:12b', character: { ...DEFAULT_CHARACTER }, options: { ...DEFAULT_OPTIONS }, voice: false, voiceName: '', voiceRate: 1, voiceEngine: 'system', ttsAdapter: 'openai', ttsUrl: 'http://127.0.0.1:9880', ttsModel: 'tts-1', ttsVoice: '' }, tasks: [], messages: [], records: [], timer: null, episodes: [], facts: [] });
const VOICE_ENGINES = ['system', 'local'];
const TTS_ADAPTERS = ['openai', 'gpt-sovits', 'custom'];
const isLocalUrl = value => {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  } catch { return false; }
};
const TTS_URL_ERROR = '本地 TTS 地址必须是 http://127.0.0.1:端口 或 http://localhost:端口。';
const isString = (s, max) => typeof s === 'string' && s.length <= max;
const dateKey = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const validMemory = s =>
  (s.episodes === undefined || (Array.isArray(s.episodes) && s.episodes.length <= 200 && s.episodes.every(e =>
    e && isString(e.id, 100) && isString(e.text, 1000) && isString(e.at, 40) && dateKey(e.date) &&
    (e.through === undefined || isString(e.through, 40)) && (e.characterId === undefined || isString(e.characterId, 100))))) &&
  (s.facts === undefined || (Array.isArray(s.facts) && s.facts.length <= 200 && s.facts.every(f =>
    f && isString(f.id, 100) && isString(f.text, 200) && isString(f.at, 40))));
function validState(s) {
  return s && Number.isInteger(s.version) && s.version >= 0 &&
    s.settings && isString(s.settings.nickname, 40) && isString(s.settings.model, 100) &&
    (s.settings.character === undefined || validCharacter(s.settings.character)) &&
    (s.settings.appearance === undefined || validAppearance(s.settings.appearance)) &&
    (s.settings.options === undefined || validOptions(s.settings.options)) &&
    (s.settings.voice === undefined || typeof s.settings.voice === 'boolean') &&
    (s.settings.voiceName === undefined || isString(s.settings.voiceName, 120)) &&
    (s.settings.voiceRate === undefined || (Number.isFinite(s.settings.voiceRate) && s.settings.voiceRate >= 0.6 && s.settings.voiceRate <= 1.4)) &&
    (s.settings.voiceEngine === undefined || VOICE_ENGINES.includes(s.settings.voiceEngine)) &&
    (s.settings.ttsAdapter === undefined || TTS_ADAPTERS.includes(s.settings.ttsAdapter)) &&
    (s.settings.ttsUrl === undefined || (isString(s.settings.ttsUrl, 200) && (!s.settings.ttsUrl || isLocalUrl(s.settings.ttsUrl)))) &&
    (s.settings.ttsModel === undefined || isString(s.settings.ttsModel, 100)) &&
    (s.settings.ttsVoice === undefined || isString(s.settings.ttsVoice, 300)) &&
    Array.isArray(s.tasks) && s.tasks.length <= 3000 && s.tasks.every(t =>
      isString(t.id, 100) && isString(t.title, 200) && dateKey(t.date) && typeof t.done === 'boolean') &&
    Array.isArray(s.messages) && s.messages.length <= 5000 && s.messages.every(m =>
      isString(m.id, 100) && ['user', 'assistant'].includes(m.role) && isString(m.content, 20000) && isString(m.at, 40) &&
      (m.characterId === undefined || isString(m.characterId, 100)) && (m.characterName === undefined || isString(m.characterName, 40))) &&
    Array.isArray(s.records) && s.records.length <= 5000 && s.records.every(r =>
      isString(r.id, 100) && ['note', 'focus'].includes(r.type) && isString(r.text, 5000) && dateKey(r.date) &&
      isString(r.at, 40) && (r.type !== 'focus' || (Number.isFinite(r.minutes) && r.minutes > 0 && r.minutes <= 180))) &&
    (s.timer === null || (s.timer && isString(s.timer.id, 100) && Number.isFinite(s.timer.endsAt) &&
      Number.isFinite(s.timer.minutes) && s.timer.minutes >= 1 && s.timer.minutes <= 180)) &&
    validMemory(s);
}
async function readJson(req) {
  let chunks = [], bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw Object.assign(new Error('数据过大，请先导出备份并整理记录。'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求不是有效的 JSON。'), { status: 400 }); }
}
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
// 从模型输出里提取 {"summary","facts"}，容忍代码块包裹和多余文字。
function parseMemory(text) {
  const raw = String(text).replace(/```[a-zA-Z]*\s*/g, '').trim();
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try { data = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  const summary = typeof data.summary === 'string' ? data.summary.trim().slice(0, 600) : '';
  const facts = Array.isArray(data.facts)
    ? [...new Set(data.facts.filter(f => typeof f === 'string' && f.trim()).map(f => f.trim().slice(0, 120)))].slice(0, 6)
    : [];
  return summary ? { summary, facts } : null;
}

export async function createApp({ dataDir = process.env.PEIBAN_DATA_DIR || path.join(root, '..', 'personal'), ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434' } = {}) {
  const endpoint = new URL(ollamaUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('OLLAMA_URL 必须指向本机 localhost / 127.0.0.1 / [::1]。');
  }
  await mkdir(dataDir, { recursive: true });
  const stateFile = path.join(dataDir, 'state.json');
  let state;
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (!validState(state)) throw new Error('数据结构不符合当前版本');
  } catch (e) {
    if (e.code === 'ENOENT') state = emptyState();
    else throw new Error(`无法读取 ${stateFile}。请备份并检查此文件；原数据未覆盖。${e.message}`);
  }
  state.settings.character = state.settings.character ? cleanCharacter(state.settings.character) : { ...DEFAULT_CHARACTER };
  state.settings.appearance = state.settings.appearance ? cleanAppearance(state.settings.appearance) : { ...DEFAULT_APPEARANCE };
  state.settings.options = state.settings.options ? cleanOptions(state.settings.options) : { ...DEFAULT_OPTIONS };
  state.settings.voice = state.settings.voice === true;
  state.settings.voiceName = typeof state.settings.voiceName === 'string' ? state.settings.voiceName : '';
  state.settings.voiceRate = Number.isFinite(state.settings.voiceRate) ? Math.min(1.4, Math.max(0.6, state.settings.voiceRate)) : 1;
  state.settings.voiceEngine = VOICE_ENGINES.includes(state.settings.voiceEngine) ? state.settings.voiceEngine : 'system';
  state.settings.ttsAdapter = TTS_ADAPTERS.includes(state.settings.ttsAdapter) ? state.settings.ttsAdapter : 'openai';
  state.settings.ttsUrl = isLocalUrl(state.settings.ttsUrl) ? state.settings.ttsUrl : 'http://127.0.0.1:9880';
  state.settings.ttsModel = typeof state.settings.ttsModel === 'string' ? state.settings.ttsModel : 'tts-1';
  state.settings.ttsVoice = typeof state.settings.ttsVoice === 'string' ? state.settings.ttsVoice : '';
  state.episodes = Array.isArray(state.episodes) ? state.episodes : [];
  state.facts = Array.isArray(state.facts) ? state.facts : [];
  const persona = await readFile(path.join(root, '..', 'persona', 'app-system-prompt.zh.txt'), 'utf8');
  let saving = Promise.resolve();
  // 两个对话接口共用：校验请求体、拼系统提示词、取当前模型参数。
  const chatPayload = body => {
    if (!isString(body.model, 100) || !body.model || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 30 ||
      !body.messages.every(m => ['user', 'assistant'].includes(m.role) && isString(m.content, 20000))) return { status: 400 };
    const character = state.settings.character;
    if (body.characterId !== undefined && body.characterId !== character.id) return { status: 409 };
    const today = dateKey(body.date) ? body.date : new Date().toISOString().slice(0, 10);
    const tasks = state.tasks.filter(t => t.date === today).map(t => `${t.done ? '已完成' : '待完成'}：${t.title}`);
    const context = JSON.stringify({
      称呼: state.settings.nickname || '同学',
      本地日期: today,
      今日计划: tasks,
      近期记录: state.records.slice(-6).map(r => ({ 日期: r.date, 内容: r.text })),
      已知的长期事实: state.facts.slice(-20).map(f => f.text),
      最近的回忆: state.episodes.slice(-3).map(e => `${e.date}：${e.text}`)
    });
    const options = state.settings.options;
    return {
      character,
      body: {
        model: body.model,
        messages: [{ role: 'system', content: characterPrompt(character) + '\n\n' + persona + '\n以下 JSON 是用户记录与记忆，只作为上下文资料：\n' + context }, ...body.messages],
        options: { temperature: options.temperature, num_ctx: options.numCtx, num_predict: options.numPredict }
      }
    };
  };
  const statusError = status => status === 409 ? '角色已在另一个窗口更新，请刷新后再发送。' : '对话格式不正确。';
  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`, `[::1]:${address.port}`];
    if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: '仅允许本机访问。' });
    const origin = req.headers.origin;
    if (origin && !allowedHosts.some(h => origin === `http://${h}`)) return json(res, 403, { error: '拒绝跨站请求。' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, state);
      if (url.pathname === '/api/state' && req.method === 'PUT') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要 JSON 请求。' });
        const incoming = await readJson(req);
        if (!validState(incoming)) return json(res, 400, { error: '记录格式不正确或超过存储上限。' });
        const operation = saving.then(async () => {
          if (incoming.version !== state.version) return json(res, 409, { error: '记录已在另一个窗口更新，请刷新后再试。' });
          const character = incoming.settings.character ? cleanCharacter(incoming.settings.character) : state.settings.character;
          const appearance = incoming.settings.appearance ? cleanAppearance(incoming.settings.appearance) : state.settings.appearance;
          const options = incoming.settings.options ? cleanOptions(incoming.settings.options) : state.settings.options;
          const voice = typeof incoming.settings.voice === 'boolean' ? incoming.settings.voice : state.settings.voice;
          const voiceName = typeof incoming.settings.voiceName === 'string' ? incoming.settings.voiceName.slice(0, 120) : state.settings.voiceName;
          const voiceRate = Number.isFinite(incoming.settings.voiceRate) ? Math.min(1.4, Math.max(0.6, incoming.settings.voiceRate)) : state.settings.voiceRate;
          const voiceEngine = VOICE_ENGINES.includes(incoming.settings.voiceEngine) ? incoming.settings.voiceEngine : state.settings.voiceEngine;
          const ttsAdapter = TTS_ADAPTERS.includes(incoming.settings.ttsAdapter) ? incoming.settings.ttsAdapter : state.settings.ttsAdapter;
          const ttsUrl = typeof incoming.settings.ttsUrl === 'string' ? incoming.settings.ttsUrl.slice(0, 200) : state.settings.ttsUrl;
          const ttsModel = typeof incoming.settings.ttsModel === 'string' ? incoming.settings.ttsModel.slice(0, 100) : state.settings.ttsModel;
          const ttsVoice = typeof incoming.settings.ttsVoice === 'string' ? incoming.settings.ttsVoice.slice(0, 300) : state.settings.ttsVoice;
          const next = {
            ...incoming,
            settings: { ...incoming.settings, character, appearance, options, voice, voiceName, voiceRate, voiceEngine, ttsAdapter, ttsUrl, ttsModel, ttsVoice },
            episodes: Array.isArray(incoming.episodes) ? incoming.episodes : state.episodes,
            facts: Array.isArray(incoming.facts) ? incoming.facts : state.facts,
            version: state.version + 1
          };
          await writeFile(`${stateFile}.tmp`, JSON.stringify(next, null, 2), 'utf8');
          await rename(`${stateFile}.tmp`, stateFile);
          state = next;
          json(res, 200, { version: state.version });
        });
        saving = operation.catch(() => {});
        return await operation;
      }
      if (url.pathname === '/api/models' && req.method === 'GET') {
        try {
          const response = await fetch(new URL('/api/tags', endpoint), { signal: AbortSignal.timeout(5000) });
          if (!response.ok) throw new Error('Ollama 返回错误');
          const body = await response.json();
          return json(res, 200, { models: body.models.map(m => m.name) });
        } catch { return json(res, 503, { error: '暂时连不上 Ollama。请先启动本机 Ollama 服务，再点击重新连接。' }); }
      }
      if (url.pathname === '/api/chat' && req.method === 'POST') {
        const body = await readJson(req);
        const prepared = chatPayload(body);
        if (prepared.status) return json(res, prepared.status, { error: statusError(prepared.status) });
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', abort);
        try {
          const response = await fetch(new URL('/api/chat', endpoint), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...prepared.body, stream: false }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)])
          });
          if (!response.ok) return json(res, 502, { error: response.status === 404 ? '找不到所选模型，请在设置中选择已安装模型。' : 'Ollama 生成失败，请稍后重试。' });
          const result = await response.json();
          if (!result.message?.content?.trim()) return json(res, 502, { error: '模型没有返回正文，请换个模型或重新发送。' });
          return json(res, 200, { content: result.message.content, characterId: prepared.character.id, characterName: prepared.character.name });
        } catch (e) {
          if (!res.destroyed) return json(res, 503, { error: e.name === 'TimeoutError' ? '模型响应超时，请稍后重试。' : '连接中断，请检查 Ollama 后重试。' });
        } finally { res.off('close', abort); }
        return;
      }
      if (url.pathname === '/api/chat/stream' && req.method === 'POST') {
        const body = await readJson(req);
        const prepared = chatPayload(body);
        if (prepared.status) return json(res, prepared.status, { error: statusError(prepared.status) });
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', abort);
        try {
          const response = await fetch(new URL('/api/chat', endpoint), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...prepared.body, stream: true }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)])
          });
          if (!response.ok) return json(res, 502, { error: response.status === 404 ? '找不到所选模型，请在设置中选择已安装模型。' : 'Ollama 生成失败，请稍后重试。' });
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          res.flushHeaders();
          const send = event => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
          const decoder = new TextDecoder();
          let buffer = '', content = '', failed = false;
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let index;
            while ((index = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, index).trim();
              buffer = buffer.slice(index + 1);
              if (!line) continue;
              let part;
              try { part = JSON.parse(line); } catch { continue; }
              if (part.error) { send({ error: 'Ollama 生成失败，请稍后重试。' }); failed = true; break; }
              if (part.message?.content) { content += part.message.content; send({ delta: part.message.content }); }
            }
            if (failed) break;
          }
          if (!content.trim()) send({ error: '模型没有返回正文，请换个模型或重新发送。' });
          else send({ done: true, content, characterId: prepared.character.id, characterName: prepared.character.name });
          res.end();
        } catch (e) {
          if (!res.headersSent) { if (!res.destroyed) json(res, 503, { error: e.name === 'TimeoutError' ? '模型响应超时，请稍后重试。' : '连接中断，请检查 Ollama 后重试。' }); }
          else if (!res.writableEnded && !res.destroyed) { res.write(`data: ${JSON.stringify({ error: e.name === 'TimeoutError' ? '模型响应超时，请稍后重试。' : '连接中断，请检查 Ollama 后重试。' })}\n\n`); res.end(); }
        } finally { res.off('close', abort); }
        return;
      }
      // 只生成记忆草稿，不直接落盘；写入仍走 /api/state 的版本检查。
      if (url.pathname === '/api/memory/summarize' && req.method === 'POST') {
        const body = await readJson(req);
        if (!isString(body.model, 100) || !body.model) return json(res, 400, { error: '请先在偏好设置里选择一个本地模型。' });
        const character = state.settings.character;
        if (body.characterId !== undefined && body.characterId !== character.id) return json(res, 409, { error: '角色已在另一个窗口更新，请刷新后再试。' });
        const lastThrough = state.episodes.at(-1)?.through || '';
        const pending = state.messages
          .filter(m => (m.characterId || DEFAULT_CHARACTER.id) === character.id && (m.at || '') > lastThrough)
          .slice(-40);
        if (pending.length < 4) return json(res, 400, { error: '这段新对话还太少，再聊几句就能整理出回忆了。' });
        const transcript = pending.map(m => `${m.role === 'user' ? '我' : character.name}：${m.content}`).join('\n');
        const known = state.facts.slice(-20).map(f => f.text);
        const prompt = [
          '从下面的对话里整理记忆，只输出 JSON，不要解释。',
          '1) summary：一句话摘要，不超过 80 字，用第三人称写用户经历了什么、情绪如何；',
          '2) facts：最多 6 条长期有用的事实，每条不超过 40 字，只写称呼、习惯、偏好、正在推进的事、重要关系；不要写寒暄和一次性细节；没有就给空数组。',
          '输出格式：{"summary":"...","facts":["...","..."]}',
          known.length ? `已经记住的事实（不要重复）：\n${known.join('\n')}` : '',
          `对话：\n${transcript}`
        ].filter(Boolean).join('\n\n');
        try {
          const response = await fetch(new URL('/api/chat', endpoint), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: body.model, stream: false,
              messages: [{ role: 'system', content: '你是记忆整理器，只输出 JSON。' }, { role: 'user', content: prompt }],
              options: { temperature: 0.3, num_ctx: state.settings.options.numCtx, num_predict: 400 }
            }),
            signal: AbortSignal.timeout(120000)
          });
          if (!response.ok) return json(res, 502, { error: response.status === 404 ? '找不到所选模型，请在设置中选择已安装模型。' : 'Ollama 生成失败，请稍后重试。' });
          const result = await response.json();
          const parsed = parseMemory(result.message?.content || '');
          if (!parsed) return json(res, 502, { error: '模型没有按格式返回记忆，换一个模型或再试一次。' });
          return json(res, 200, { ...parsed, through: pending.at(-1).at, covered: pending.length, characterId: character.id, date: dateKey(body.date) ? body.date : new Date().toISOString().slice(0, 10) });
        } catch (e) {
          if (!res.destroyed) return json(res, 503, { error: e.name === 'TimeoutError' ? '整理记忆超时，请稍后重试。' : '连接中断，请检查 Ollama 后重试。' });
        }
        return;
      }
      // 本地 TTS 代理：只允许本机地址，避免把浏览器请求变成任意转发。
      if (url.pathname === '/api/voice/speak' && req.method === 'POST') {
        const body = await readJson(req);
        if (!isString(body.text, 500) || !body.text.trim()) return json(res, 400, { error: '要朗读的文字为空或过长。' });
        const settings = state.settings;
        if (settings.voiceEngine !== 'local') return json(res, 400, { error: '当前用的是系统语音。请在偏好设置里把朗读引擎切到本地 TTS。' });
        if (!isLocalUrl(settings.ttsUrl)) return json(res, 400, { error: TTS_URL_ERROR });
        const base = settings.ttsUrl.replace(/\/+$/, '');
        const text = body.text.trim();
        try {
          let response;
          if (settings.ttsAdapter === 'gpt-sovits') {
            const target = new URL(base + '/tts');
            target.searchParams.set('text', text);
            target.searchParams.set('text_lang', 'zh');
            target.searchParams.set('prompt_lang', 'zh');
            target.searchParams.set('media_type', 'wav');
            target.searchParams.set('streaming_mode', 'false');
            if (settings.ttsVoice) target.searchParams.set('ref_audio_path', settings.ttsVoice);
            response = await fetch(target, { signal: AbortSignal.timeout(30000) });
          } else if (settings.ttsAdapter === 'custom') {
            response = await fetch(base, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text, voice: settings.ttsVoice || undefined }),
              signal: AbortSignal.timeout(30000)
            });
          } else {
            response = await fetch(base + '/v1/audio/speech', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: settings.ttsModel || 'tts-1', input: text, voice: settings.ttsVoice || 'alloy', response_format: 'wav' }),
              signal: AbortSignal.timeout(30000)
            });
          }
          if (!response.ok) return json(res, 502, { error: `本地 TTS 返回了 ${response.status}。检查服务是否在跑，以及音色/模型名是否正确。` });
          const buffer = Buffer.from(await response.arrayBuffer());
          if (!buffer.length) return json(res, 502, { error: '本地 TTS 没有返回音频数据。' });
          if (buffer.length > 8 * 1024 * 1024) return json(res, 502, { error: '本地 TTS 返回的音频超过 8 MB，检查模型是否在复读。' });
          const type = (response.headers.get('content-type') || '').split(';')[0].trim();
          res.writeHead(200, { 'Content-Type': type.startsWith('audio/') ? type : 'audio/wav', 'Content-Length': buffer.length, 'Cache-Control': 'no-store' });
          res.end(buffer);
        } catch (e) {
          if (!res.destroyed) return json(res, 503, { error: e.name === 'TimeoutError' ? '本地 TTS 超时，服务可能卡住了。' : '连不上本地 TTS，检查地址和端口是否正确。' });
        }
        return;
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在。' });
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '不支持的请求方法。' });
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/character.js': ['character.js', 'text/javascript'], '/appearance.js': ['appearance.js', 'text/javascript'], '/options.js': ['options.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/workshop.css': ['workshop.css', 'text/css'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
      const file = files[url.pathname];
      if (!file) return json(res, 404, { error: '页面不存在。' });
      const content = await readFile(path.join(root, 'public', file[0]));
      res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (e) {
      if (!res.headersSent && !res.destroyed) json(res, e.status || 500, { error: e.status ? e.message : '操作未保存，请检查磁盘空间后重试。' });
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3210);
  const server = await createApp();
  server.on('error', e => {
    console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已使用。如果陪伴已启动，请打开 http://127.0.0.1:${port}` : e.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`陪伴已启动：http://127.0.0.1:${port}\n数据仅保存在本机 personal/state.json。关闭此进程即可停止。`));
}
