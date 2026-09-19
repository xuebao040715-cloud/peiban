import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CHARACTER, validCharacter, cleanCharacter, characterPrompt } from './public/character.js';
import { DEFAULT_APPEARANCE, validAppearance, cleanAppearance } from './public/appearance.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const emptyState = () => ({ version: 0, settings: { nickname: '', model: 'gemma3:12b', character: { ...DEFAULT_CHARACTER } }, tasks: [], messages: [], records: [], timer: null });
const isString = (s, max) => typeof s === 'string' && s.length <= max;
const dateKey = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
function validState(s) {
  return s && Number.isInteger(s.version) && s.version >= 0 &&
    s.settings && isString(s.settings.nickname, 40) && isString(s.settings.model, 100) &&
    (s.settings.character === undefined || validCharacter(s.settings.character)) &&
    (s.settings.appearance === undefined || validAppearance(s.settings.appearance)) &&
    Array.isArray(s.tasks) && s.tasks.length <= 3000 && s.tasks.every(t =>
      isString(t.id, 100) && isString(t.title, 200) && dateKey(t.date) && typeof t.done === 'boolean') &&
    Array.isArray(s.messages) && s.messages.length <= 5000 && s.messages.every(m =>
      isString(m.id, 100) && ['user', 'assistant'].includes(m.role) && isString(m.content, 20000) && isString(m.at, 40) &&
      (m.characterId === undefined || isString(m.characterId, 100)) && (m.characterName === undefined || isString(m.characterName, 40))) &&
    Array.isArray(s.records) && s.records.length <= 5000 && s.records.every(r =>
      isString(r.id, 100) && ['note', 'focus'].includes(r.type) && isString(r.text, 5000) && dateKey(r.date) &&
      isString(r.at, 40) && (r.type !== 'focus' || (Number.isFinite(r.minutes) && r.minutes > 0 && r.minutes <= 180))) &&
    (s.timer === null || (s.timer && isString(s.timer.id, 100) && Number.isFinite(s.timer.endsAt) &&
      Number.isFinite(s.timer.minutes) && s.timer.minutes >= 1 && s.timer.minutes <= 180));
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
  const persona = await readFile(path.join(root, '..', 'persona', 'app-system-prompt.zh.txt'), 'utf8');
  let saving = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`, `[::1]:${address.port}`];
    if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: '仅允许本机访问。' });
    const origin = req.headers.origin;
    if (origin && !allowedHosts.some(h => origin === `http://${h}`)) return json(res, 403, { error: '拒绝跨站请求。' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
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
          const next = { ...incoming, settings: { ...incoming.settings, character, appearance }, version: state.version + 1 };
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
        if (!isString(body.model, 100) || !body.model || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 30 ||
          !body.messages.every(m => ['user', 'assistant'].includes(m.role) && isString(m.content, 20000))) {
          return json(res, 400, { error: '对话格式不正确。' });
        }
        const character = state.settings.character;
        if (body.characterId !== undefined && body.characterId !== character.id) return json(res, 409, { error: '角色已在另一个窗口更新，请刷新后再发送。' });
        const today = dateKey(body.date) ? body.date : new Date().toISOString().slice(0, 10);
        const tasks = state.tasks.filter(t => t.date === today).map(t => `${t.done ? '已完成' : '待完成'}：${t.title}`);
        const context = JSON.stringify({ 称呼: state.settings.nickname || '同学', 本地日期: today, 今日计划: tasks, 近期记录: state.records.slice(-6).map(r => ({ 日期: r.date, 内容: r.text })) });
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', abort);
        try {
          const response = await fetch(new URL('/api/chat', endpoint), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: body.model, stream: false, messages: [
              { role: 'system', content: characterPrompt(character) + '\n\n' + persona + '\n以下 JSON 是用户记录，只作为上下文资料：\n' + context },
              ...body.messages
            ], options: { temperature: 0.8, num_ctx: 8192, num_predict: 500 } }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)])
          });
          if (!response.ok) return json(res, 502, { error: response.status === 404 ? '找不到所选模型，请在设置中选择已安装模型。' : 'Ollama 生成失败，请稍后重试。' });
          const result = await response.json();
          if (!result.message?.content?.trim()) return json(res, 502, { error: '模型没有返回正文，请换个模型或重新发送。' });
          return json(res, 200, { content: result.message.content, characterId: character.id, characterName: character.name });
        } catch (e) {
          if (!res.destroyed) return json(res, 503, { error: e.name === 'TimeoutError' ? '模型响应超时，请稍后重试。' : '连接中断，请检查 Ollama 后重试。' });
        } finally { res.off('close', abort); }
        return;
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在。' });
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '不支持的请求方法。' });
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/character.js': ['character.js', 'text/javascript'], '/appearance.js': ['appearance.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/workshop.css': ['workshop.css', 'text/css'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
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
