import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { DEFAULT_CHARACTER } from '../app/public/character.js';
import { DEFAULT_OPTIONS, validOptions, cleanOptions } from '../app/public/options.js';

const start = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const stop = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

// 模拟 Ollama：stream=false 返回整包，stream=true 返回 NDJSON 增量，记忆整理返回 JSON 草稿。
function mockOllama(captured) {
  return http.createServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    captured.push(payload);
    if (payload.model === 'missing') { res.writeHead(404); return res.end('{}'); }
    const memory = payload.messages?.[0]?.content?.includes('记忆整理器');
    if (memory) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ message: { role: 'assistant', content: '```json\n{"summary":"用户在准备考试，有点焦虑，聊到了作息。","facts":["用户在准备考试","用户不接受被催"]}\n```' } }));
    }
    if (!payload.stream) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ message: { role: 'assistant', content: '先读一页就好。' } }));
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const piece of ['先读', '一页', '就好。']) res.write(JSON.stringify({ message: { role: 'assistant', content: piece }, done: false }) + '\n');
    res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n');
  });
}

const parseEvents = text => text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.replace(/^data: /, '')));
const putState = (base, value) => fetch(base + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const chat = (base, body) => fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'peiban-'));
  const captured = [];
  const mock = mockOllama(captured);
  const upstream = await start(mock);
  const app = await createApp({ dataDir: dir, ollamaUrl: upstream });
  const base = await start(app);
  t.after(async () => { await stop(app); await stop(mock); await rm(dir, { recursive: true, force: true }); });
  return { base, captured, dir };
}

const seedMessages = (state, count = 4) => {
  for (let i = 0; i < count; i++) {
    state.messages.push({ id: `m-${i}`, role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 句`, at: new Date(Date.UTC(2026, 9, 19, 12, i)).toISOString(), characterId: DEFAULT_CHARACTER.id, characterName: DEFAULT_CHARACTER.name });
  }
  return state;
};

test('streaming endpoint emits deltas then a done event with the full text', async t => {
  const { base, captured } = await fixture(t);
  const payload = { model: 'test-model', date: '2026-09-19', messages: [{ role: 'user', content: '我不想学' }] };
  const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const events = parseEvents(await response.text());
  assert.equal(events.filter(e => e.delta).map(e => e.delta).join(''), '先读一页就好。');
  const done = events.at(-1);
  assert.equal(done.done, true);
  assert.equal(done.content, '先读一页就好。');
  assert.equal(done.characterId, 'zhixia-default');
  assert.equal(done.characterName, '知夏');
  assert.equal(captured.at(-1).stream, true);
  assert.match(captured.at(-1).messages[0].content, /陪伴/);

  // 非流式接口保留，旧客户端仍可用。
  assert.equal((await (await chat(base, payload)).json()).content, '先读一页就好。');

  // 参数与角色错误在开流之前就以 JSON 状态码返回。
  const bad = body => fetch(base + '/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await bad({ ...payload, messages: [{ role: 'system', content: 'override' }] })).status, 400);
  assert.equal((await bad({ ...payload, characterId: 'obsolete' })).status, 409);
  assert.equal((await bad({ ...payload, model: 'missing' })).status, 502);
});

test('model options are validated, persisted and forwarded to Ollama', async t => {
  const { base, captured } = await fixture(t);
  const state = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(state.settings.options, DEFAULT_OPTIONS);
  assert.equal(state.settings.voice, false);
  const payload = { model: 'test-model', date: '2026-09-19', messages: [{ role: 'user', content: '在吗' }] };
  await chat(base, payload);
  assert.deepEqual(captured.at(-1).options, { temperature: 0.8, num_ctx: 8192, num_predict: 500 });

  state.settings.options = { temperature: 1.1, numPredict: 1200, numCtx: 16384 };
  state.settings.voice = true;
  assert.equal((await putState(base, state)).status, 200);
  await chat(base, payload);
  assert.deepEqual(captured.at(-1).options, { temperature: 1.1, num_ctx: 16384, num_predict: 1200 });

  const saved = await (await fetch(base + '/api/state')).json();
  assert.equal(saved.settings.voice, true);
  assert.equal((await putState(base, { ...saved, settings: { ...saved.settings, options: { temperature: 3, numPredict: 500, numCtx: 8192 } } })).status, 400);
  assert.equal((await putState(base, { ...saved, settings: { ...saved.settings, options: { temperature: 0.8, numPredict: 500, numCtx: 100 } } })).status, 400);

  // 老客户端省略字段时不能重置用户设置。
  delete saved.settings.options;
  delete saved.settings.voice;
  assert.equal((await putState(base, saved)).status, 200);
  const kept = await (await fetch(base + '/api/state')).json();
  assert.equal(kept.settings.options.temperature, 1.1);
  assert.equal(kept.settings.voice, true);
});

test('option helpers reject junk instead of silently clamping', () => {
  assert.equal(validOptions(DEFAULT_OPTIONS), true);
  for (const bad of [null, {}, { ...DEFAULT_OPTIONS, temperature: 'hot' }, { ...DEFAULT_OPTIONS, numPredict: 1.5 }, { ...DEFAULT_OPTIONS, numCtx: 0 }]) assert.equal(validOptions(bad), false);
  assert.throws(() => cleanOptions({ ...DEFAULT_OPTIONS, numPredict: 99999 }));
  assert.deepEqual(Object.keys(cleanOptions({ ...DEFAULT_OPTIONS, extra: 'dropped' })).sort(), ['numCtx', 'numPredict', 'temperature']);
});

test('memory summarize returns a draft without writing state, and long-term facts reach the prompt', async t => {
  const { base, captured } = await fixture(t);
  const state = seedMessages(await (await fetch(base + '/api/state')).json());
  assert.equal((await putState(base, state)).status, 200);

  const empty = await fetch(base + '/api/memory/summarize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test-model' }) });
  assert.equal(empty.status, 200);
  const draft = await empty.json();
  assert.match(draft.summary, /准备考试/);
  assert.deepEqual(draft.facts, ['用户在准备考试', '用户不接受被催']);
  assert.equal(draft.covered, 4);
  assert.equal(draft.through, state.messages.at(-1).at);
  assert.equal(draft.date, new Date().toISOString().slice(0, 10));

  // 接口只给草稿，不落盘：state 里仍然没有回忆。
  assert.equal((await (await fetch(base + '/api/state')).json()).episodes.length, 0);

  // 客户端把草稿写回后，事实与回忆要进入系统提示词。
  const withMemory = await (await fetch(base + '/api/state')).json();
  withMemory.episodes.push({ id: 'e-1', date: '2026-10-19', at: new Date().toISOString(), through: draft.through, text: draft.summary, characterId: DEFAULT_CHARACTER.id });
  withMemory.facts.push({ id: 'f-1', text: '用户不接受被催', at: new Date().toISOString() });
  assert.equal((await putState(base, withMemory)).status, 200);
  await chat(base, { model: 'test-model', messages: [{ role: 'user', content: '在吗' }] });
  const system = captured.at(-1).messages[0].content;
  assert.match(system, /用户不接受被催/);
  assert.match(system, /准备考试/);
  assert.match(system, /已知的长期事实/);

  // 已有回忆之后，只整理 through 之后的新消息。
  const next = await (await fetch(base + '/api/state')).json();
  for (let i = 0; i < 4; i++) next.messages.push({ id: 'm-new-' + i, role: i % 2 ? 'assistant' : 'user', content: '新的一句 ' + i, at: new Date(Date.UTC(2026, 9, 20, 1, i)).toISOString(), characterId: DEFAULT_CHARACTER.id });
  assert.equal((await putState(base, next)).status, 200);
  const again = await (await fetch(base + '/api/memory/summarize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test-model' }) })).json();
  assert.equal(again.covered, 4);
});

test('memory rejects too-short transcripts and invalid shapes', async t => {
  const { base } = await fixture(t);
  const one = await (await fetch(base + '/api/state')).json();
  one.messages.push({ id: 'm-1', role: 'user', content: '你好', at: new Date().toISOString() });
  assert.equal((await putState(base, one)).status, 200);
  assert.equal((await fetch(base + '/api/memory/summarize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test-model' }) })).status, 400);
  assert.equal((await fetch(base + '/api/memory/summarize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })).status, 400);
  assert.equal((await putState(base, { ...one, facts: [{ id: 'f', text: 'x'.repeat(201), at: new Date().toISOString() }] })).status, 400);
  assert.equal((await putState(base, { ...one, episodes: 'nope' })).status, 400);
  // 老数据没有 episodes/facts 字段时仍然可用，且 PUT 省略它们不会清空。
  const kept = await (await fetch(base + '/api/state')).json();
  delete kept.episodes; delete kept.facts;
  assert.equal((await putState(base, kept)).status, 200);
  const after = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(after.episodes, []);
  assert.deepEqual(after.facts, []);
});

test('new module is served, and every asset carries the package version', async t => {
  const { base } = await fixture(t);
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const esc = version.replace(/\./g, '\\.');
  const html = await (await fetch(base + '/')).text();
  for (const asset of ['app.js', 'style.css', 'workshop.css']) assert.match(html, new RegExp(`${asset.replace('.', '\\.')}\\?v=${esc}`));
  const module = await fetch(base + '/options.js');
  assert.equal(module.status, 200);
  assert.equal(module.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(await module.text(), /DEFAULT_OPTIONS/);
  const client = await (await fetch(base + '/app.js')).text();
  assert.match(client, new RegExp(`options\\.js\\?v=${esc}`));
  assert.match(client, /\/api\/chat\/stream/);
  assert.match(client, /\/api\/memory\/summarize/);
});

test('voice name and rate are validated and survive partial saves', async t => {
  const { base } = await fixture(t);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.settings.voiceName, '');
  assert.equal(state.settings.voiceRate, 1);

  state.settings.voiceName = 'Microsoft 晓晓 Online (Natural) - Chinese (Mandarin, Simplified)';
  state.settings.voiceRate = 0.9;
  assert.equal((await putState(base, state)).status, 200);
  const saved = await (await fetch(base + '/api/state')).json();
  assert.match(saved.settings.voiceName, /晓晓/);
  assert.equal(saved.settings.voiceRate, 0.9);

  assert.equal((await putState(base, { ...saved, settings: { ...saved.settings, voiceRate: 3 } })).status, 400);
  assert.equal((await putState(base, { ...saved, settings: { ...saved.settings, voiceName: 'x'.repeat(121) } })).status, 400);

  // 老客户端省略这两个字段时不能清空用户选好的音色。
  const legacy = { ...saved, settings: { ...saved.settings } };
  delete legacy.settings.voiceName;
  delete legacy.settings.voiceRate;
  assert.equal((await putState(base, legacy)).status, 200);
  const kept = await (await fetch(base + '/api/state')).json();
  assert.match(kept.settings.voiceName, /晓晓/);
  assert.equal(kept.settings.voiceRate, 0.9);
});

test('the voice picker and pause-friendly rendering ship with the page', async t => {
  const { base } = await fixture(t);
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /id="voice-select"/);
  assert.match(html, /id="voice-rate"/);
  assert.match(html, /id="voice-test"/);
  const client = await (await fetch(base + '/app.js')).text();
  // 逐句合成（带停顿）与神经语音优先，是不再"像机器念稿"的关键。
  assert.match(client, /speakQueue/);
  assert.match(client, /natural\/i|Natural/i);
  assert.match(client, /voiceschanged/);
});
test('local TTS proxy speaks through each adapter and only allows loopback', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'peiban-tts-'));
  const whisper = [];
  const wav = Buffer.from('RIFF....WAVEfmt ');
  const tts = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    whisper.push({ method: req.method, url: req.url, body });
    if (req.url.startsWith('/v1/audio/speech')) { res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(wav); }
    if (req.url.startsWith('/tts')) { res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(wav); }
    if (req.url === '/boom') { res.writeHead(500); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(wav);
  });
  const ttsBase = await start(tts);
  const app = await createApp({ dataDir: dir });
  const base = await start(app);
  t.after(async () => { await stop(app); await stop(tts); await rm(dir, { recursive: true, force: true }); });

  const speak = (text = '你好。') => fetch(base + '/api/voice/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  // 默认是系统语音，本地接口不该工作。
  assert.equal((await speak()).status, 400);

  let state = await (await fetch(base + '/api/state')).json();
  state.settings = { ...state.settings, voiceEngine: 'local', ttsAdapter: 'openai', ttsUrl: ttsBase, ttsModel: 'tts-1', ttsVoice: 'alloy' };
  assert.equal((await putState(base, state)).status, 200);

  let response = await speak();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.ok((await response.arrayBuffer()).byteLength > 0);
  assert.deepEqual(JSON.parse(whisper.at(-1).body), { model: 'tts-1', input: '你好。', voice: 'alloy', response_format: 'wav' });
  assert.equal(whisper.at(-1).url, '/v1/audio/speech');

  state = await (await fetch(base + '/api/state')).json();
  state.settings.ttsAdapter = 'gpt-sovits';
  state.settings.ttsVoice = '/Users/me/ref.wav';
  assert.equal((await putState(base, state)).status, 200);
  response = await speak('第二句。');
  assert.equal(response.status, 200);
  const ttsUrl = new URL('http://x' + whisper.at(-1).url);
  assert.equal(ttsUrl.pathname, '/tts');
  assert.equal(ttsUrl.searchParams.get('text'), '第二句。');
  assert.equal(ttsUrl.searchParams.get('ref_audio_path'), '/Users/me/ref.wav');
  assert.equal(ttsUrl.searchParams.get('text_lang'), 'zh');

  state = await (await fetch(base + '/api/state')).json();
  state.settings.ttsAdapter = 'custom';
  state.settings.ttsVoice = 'xiaoxia';
  assert.equal((await putState(base, state)).status, 200);
  response = await speak('第三句。');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(whisper.at(-1).body), { text: '第三句。', voice: 'xiaoxia' });

  // 上游报错要翻译成人话；远端地址直接拒绝保存。
  state = await (await fetch(base + '/api/state')).json();
  state.settings.ttsUrl = ttsBase + '/boom';
  state.settings.ttsAdapter = 'custom';
  assert.equal((await putState(base, state)).status, 200);
  const broken = await speak();
  assert.equal(broken.status, 502);
  assert.match((await broken.json()).error, /本地 TTS 返回了/);

  const remote = { ...state, settings: { ...state.settings, ttsUrl: 'https://api.example.com' } };
  assert.equal((await putState(base, remote)).status, 400);
  assert.equal((await speak('')).status, 400);
});
test('pet observes the screen through a vision model and rate-limits itself', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'peiban-pet-'));
  const seen = [];
  const ollama = http.createServer(async (req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b' }, { name: 'qwen2.5vl:7b' }] }));
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: { role: 'assistant', content: '{"doing":"在看论文","line":"又在啃论文呀，累了就说。"}' } }));
  });
  const upstream = await start(ollama);
  const shot = Buffer.from('fake-jpeg-bytes');
  const app = await createApp({ dataDir: dir, ollamaUrl: upstream, capture: async () => shot });
  const base = await start(app);
  t.after(async () => { await stop(app); await stop(ollama); await rm(dir, { recursive: true, force: true }); });

  const observe = () => fetch(base + '/api/pet/observe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await observe()).status, 403);

  const state = await (await fetch(base + '/api/state')).json();
  state.settings.pet = { enabled: true, intervalMinutes: 5, size: 'medium', alwaysOnTop: true, model: '' };
  assert.equal((await putState(base, state)).status, 200);

  const first = await observe();
  assert.equal(first.status, 200);
  const data = await first.json();
  assert.equal(data.doing, '在看论文');
  assert.match(data.line, /论文/);
  assert.equal(data.model, 'qwen2.5vl:7b');
  const payload = seen.at(-1);
  assert.equal(payload.stream, false);
  assert.equal(payload.messages[1].images[0], shot.toString('base64'));
  assert.match(payload.messages[0].content, /知夏|扮演/);

  assert.equal((await observe()).status, 429);

  // 指定模型优先于自动挑选
  const next = await (await fetch(base + '/api/state')).json();
  next.settings.pet = { ...next.settings.pet, model: 'llama3.2:3b' };
  assert.equal((await putState(base, next)).status, 200);
});

test('pet surfaces capture and parse failures instead of hanging', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'peiban-pet-fail-'));
  const ollama = http.createServer(async (req, res) => {
    if (req.url === '/api/tags') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ models: [{ name: 'qwen2.5vl:7b' }] })); }
    for await (const _ of req) { /* drain */ }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: { role: 'assistant', content: '我看到你在写代码。' } }));
  });
  const upstream = await start(ollama);
  let mode = 'capture';
  const app = await createApp({
    dataDir: dir, ollamaUrl: upstream,
    capture: async () => { if (mode === 'capture') throw new Error('no desktop session'); return Buffer.from('x'); }
  });
  const base = await start(app);
  t.after(async () => { await stop(app); await stop(ollama); await rm(dir, { recursive: true, force: true }); });

  const state = await (await fetch(base + '/api/state')).json();
  state.settings.pet = { enabled: true, intervalMinutes: 5, size: 'medium', alwaysOnTop: true, model: 'qwen2.5vl:7b' };
  assert.equal((await putState(base, state)).status, 200);

  let response = await fetch(base + '/api/pet/observe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /截屏失败/);

  mode = 'ok';
  response = await fetch(base + '/api/pet/observe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /没有按要求返回/);
});

test('pet page and settings are served with the shared config', async t => {
  const { base } = await fixture(t);
  const page = await (await fetch(base + '/pet')).text();
  assert.match(page, /id="face"/);
  assert.match(page, /id="dress"/);
  const config = await fetch(base + '/pet-config.js');
  assert.equal(config.status, 200);
  assert.match(await config.text(), /DEFAULT_PET/);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.settings.pet.enabled, false);
  assert.equal(state.settings.pet.intervalMinutes, 5);
  const broken = { ...state, settings: { ...state.settings, pet: { enabled: true, intervalMinutes: 0, size: 'medium', alwaysOnTop: true, model: '' } } };
  assert.equal((await putState(base, broken)).status, 400);
});
test('what the user is doing now is injected and validated', async t => {
  const { base, captured } = await fixture(t);
  const state = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(state.activity, { label: '', at: '' });

  state.activity = { label: '写代码', at: new Date().toISOString() };
  assert.equal((await putState(base, state)).status, 200);
  await chat(base, { model: 'test-model', messages: [{ role: 'user', content: '在吗' }] });
  const system = captured.at(-1).messages[0].content;
  assert.match(system, /此刻在做什么/);
  assert.match(system, /写代码/);

  // 没说在做什么时也要有兜底，不能留空让模型瞎猜
  const cleared = await (await fetch(base + '/api/state')).json();
  cleared.activity = { label: '', at: '' };
  assert.equal((await putState(base, cleared)).status, 200);
  await chat(base, { model: 'test-model', messages: [{ role: 'user', content: '在吗' }] });
  assert.match(captured.at(-1).messages[0].content, /没说明/);

  const tooLong = { ...cleared, activity: { label: 'x'.repeat(41), at: new Date().toISOString() } };
  assert.equal((await putState(base, tooLong)).status, 400);

  // 老客户端省略 activity 时保留原值，不清空
  const fresh = await (await fetch(base + '/api/state')).json();
  const legacy = { ...fresh, activity: { label: '看剧', at: new Date().toISOString() } };
  assert.equal((await putState(base, legacy)).status, 200);
  const saved = await (await fetch(base + '/api/state')).json();
  delete saved.activity;
  assert.equal((await putState(base, saved)).status, 200);
  assert.equal((await (await fetch(base + '/api/state')).json()).activity.label, '看剧');
});

test('the companion framing no longer assumes studying', async t => {
  const { base, captured } = await fixture(t);
  await chat(base, { model: 'test-model', messages: [{ role: 'user', content: '在打游戏' }] });
  const system = captured.at(-1).messages[0].content;
  assert.doesNotMatch(system, /学习伙伴|学习教练/);
  const page = await (await fetch(base + '/')).text();
  assert.doesNotMatch(page, /学习计划|今日小复盘|有点不想学/);
  assert.match(page, /今天的事/);
  assert.match(page, /id="now-chips"/);
  const client = await (await fetch(base + '/app.js')).text();
  assert.match(client, /renderNow/);
});

test('direct mode and local ASR proxy behave and validate', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'peiban-stage-'));
  const heard = [];
  const asr = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    heard.push({ url: req.url, size: body.length, type: req.headers['content-type'] });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: '帮我看看这段代码' }));
  });
  const asrBase = await start(asr);
  const chatSeen = [];
  const ollama = http.createServer(async (req, res) => {
    if (req.url === '/api/tags') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ models: [{ name: 'test-model' }] })); }
    let body = '';
    for await (const chunk of req) body += chunk;
    chatSeen.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: { role: 'assistant', content: '嗯。' } }));
  });
  const upstream = await start(ollama);
  const app = await createApp({ dataDir: dir, ollamaUrl: upstream });
  const base = await start(app);
  t.after(async () => { await stop(app); await stop(asr); await stop(ollama); await rm(dir, { recursive: true, force: true }); });

  let state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.settings.direct, false);
  state.settings.direct = true;
  state.settings.asrAdapter = 'openai';
  state.settings.asrUrl = asrBase;
  assert.equal((await putState(base, state)).status, 200);

  await chat(base, { model: 'test-model', messages: [{ role: 'user', content: '在吗' }] });
  assert.match(chatSeen.at(-1).messages[0].content, /直说模式/);

  const audio = Buffer.from('fake-webm-audio');
  let response = await fetch(base + '/api/asr', { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: audio });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, '帮我看看这段代码');
  assert.equal(heard.at(-1).url, '/v1/audio/transcriptions');
  assert.match(heard.at(-1).type, /^multipart\/form-data/);

  // 远端 ASR 地址不允许保存；空录音直接拒绝
  const remote = { ...state, settings: { ...state.settings, asrUrl: 'https://api.example.com' } };
  assert.equal((await putState(base, remote)).status, 400);
  assert.equal((await fetch(base + '/api/asr', { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.alloc(0) })).status, 400);
});

test('the stage layer ships with pills, figure and talk button', async t => {
  const { base } = await fixture(t);
  const page = await (await fetch(base + '/')).text();
  for (const id of ['stage-bar', 'pill-model', 'pill-direct', 'pill-latency', 'stage-figure', 'stage-talk']) assert.match(page, new RegExp(`id="${id}"`));
  const stage = await fetch(base + '/stage.js');
  assert.equal(stage.status, 200);
  const js = await stage.text();
  assert.match(js, /\/api\/asr/);
  assert.match(js, /settings\.direct/);
  assert.match(js, /chat\/stream/);
});
test('chat keeps its scroll position when the user scrolled up', async t => {
  const { base } = await fixture(t);
  const client = await (await fetch(base + '/app.js')).text();
  assert.match(client, /stickToBottom/);
  assert.match(client, /scrollChat\(true\)/);
  assert.match(client, /addEventListener\('scroll'/);
});