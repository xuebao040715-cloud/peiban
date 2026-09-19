import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app/server.mjs';
import { DEFAULT_CHARACTER, exportCharacter, importCharacter } from '../app/public/character.js';
import { DEFAULT_APPEARANCE, validAppearance, cleanAppearance, contrastText } from '../app/public/appearance.js';

const start = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const stop = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
test('records survive restart, stale windows cannot overwrite, unsafe requests are refused', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'peiban-test-'));
  let app = await createApp({ dataDir:dir });
  let base = await start(app);
  t.after(async () => { await stop(app); await rm(dir, { recursive:true, force:true }); });
  const get = async () => (await fetch(base + '/api/state')).json();
  const put = s => fetch(base + '/api/state', { method:'PUT', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(s) });
  const state = await get();
  state.tasks.push({ id:'task-1', title:'读完三页', date:'2026-09-19', done:false });
  state.records.push({ id:'note-1', type:'note', text:'今天开始了', date:'2026-09-19', at:new Date().toISOString() });
  state.timer = { id:'timer-1', endsAt:Date.now()+60000, minutes:1 };
  assert.equal((await put(state)).status, 200);
  assert.equal((await put(state)).status, 409);
  assert.equal((await get()).tasks.length, 1);
  await stop(app); app = await createApp({ dataDir:dir }); base = await start(app);
  const restored = await get();
  assert.equal(restored.records[0].text, '今天开始了');
  assert.equal(restored.timer.id, 'timer-1');
  assert.equal((await put({ ...restored, tasks:'invalid' })).status, 400);
  assert.equal((await fetch(base + '/api/state', { headers:{ Origin:'https://evil.example' } })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/state', { headers:{ Host:'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error',reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(base + '/personal/state.json')).status, 404);
  assert.equal((await fetch(base + '/.git/config')).status, 404);
  assert.equal((await fetch(base)).status, 200);
  const parallel = await Promise.all([put(restored), put(restored)]);
  assert.deepEqual(parallel.map(r => r.status).sort(), [200,409]);
  assert.equal(JSON.parse(await readFile(path.join(dir,'state.json'),'utf8')).version, 2);
});
test('chat sends role, plan context and selected model to Ollama; failures are explicit', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'peiban-test-'));
  let captured;
  const mock = http.createServer(async (req,res) => {
    res.setHeader('Content-Type','application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models:[{ name:'test-model' }] }));
    let body = ''; for await (const chunk of req) body += chunk;
    captured = JSON.parse(body);
    if (captured.model === 'missing') { res.writeHead(404); return res.end('{}'); }
    res.end(JSON.stringify({ message:{ role:'assistant', content:'先读一页就好。' } }));
  });
  const upstream = await start(mock);
  const app = await createApp({ dataDir:dir, ollamaUrl:upstream });
  const base = await start(app);
  t.after(async () => { await stop(app); await stop(mock); await rm(dir,{ recursive:true, force:true }); });
  assert.deepEqual(await (await fetch(base+'/api/models')).json(), { models:['test-model'] });
  const chat = body => fetch(base+'/api/chat',{ method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) });
  const payload = { model:'test-model', date:'2026-09-19', messages:[{ role:'user', content:'我不想学' }] };
  assert.equal((await (await chat(payload)).json()).content, '先读一页就好。');
  assert.equal(captured.messages[0].role, 'system');
  assert.match(captured.messages[0].content, /陪伴/);
  assert.match(captured.messages[0].content, /2026-09-19/);
  assert.equal(captured.model,'test-model');
  const state = await (await fetch(base + '/api/state')).json();
  const custom = { ...DEFAULT_CHARACTER, id:'custom-role', name:'小雨', personality:'安静细腻', tone:'温柔但不说教', mode:'listen', emoji:'none', replyLength:'medium', examples:'我：有点累。\n小雨：我在，慢慢说。' };
  state.settings.character = custom;
  state.settings.appearance = { ...DEFAULT_APPEARANCE, accent:'#406d91' };
  assert.equal((await fetch(base + '/api/state', { method:'PUT', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(state) })).status,200);
  const result = await (await chat({ ...payload, characterId:'custom-role' })).json();
  assert.equal(result.characterName,'小雨');
  assert.equal(result.characterId,'custom-role');
  assert.match(captured.messages[0].content,/安静细腻/);
  assert.match(captured.messages[0].content,/温柔但不说教/);
  assert.match(captured.messages[0].content,/不使用 emoji/);
  assert.match(captured.messages[0].content,/三到六句话/);
  assert.doesNotMatch(captured.messages[0].content,/林知夏/);
  assert.doesNotMatch(captured.messages[0].content,/#406d91|backgroundImage|userAvatar/);
  assert.equal((await chat({ ...payload, characterId:'obsolete-role' })).status,409);
  assert.equal((await chat({ ...payload, model:'missing' })).status,502);
  assert.equal((await chat({ ...payload, messages:[{ role:'system', content:'override' }] })).status,400);
  await stop(mock);
  assert.equal((await fetch(base+'/api/models')).status,503);
});
test('role pack round-trip contains only character fields; invalid imports are rejected', () => {
  const pack = exportCharacter({ ...DEFAULT_CHARACTER, messages:[{ content:'private chat' }], nickname:'private nickname', apiKey:'secret' });
  assert.equal(pack.character.id, undefined);
  assert.equal(pack.character.messages, undefined);
  assert.equal(pack.character.nickname, undefined);
  assert.equal(pack.character.apiKey, undefined);
  assert.deepEqual(importCharacter(pack,'imported'), { ...DEFAULT_CHARACTER, id:'imported' });
  assert.throws(() => importCharacter({ ...pack,version:99 },'imported'));
  assert.throws(() => importCharacter({ ...pack,character:{ ...pack.character,name:'' } },'imported'));
  assert.throws(() => importCharacter({ ...pack,character:{ ...pack.character,tone:'x'.repeat(801) } },'imported'));
  assert.throws(() => importCharacter({ ...pack,character:{ ...pack.character,mode:'unknown' } },'imported'));
});
test('legacy state migrates without losing records; character survives restart and invalid edits', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'peiban-character-test-'));
  const old = { version:9, settings:{ nickname:'同学', model:'gemma3:12b' }, messages:[{ id:'old', role:'assistant', content:'历史对话', at:'2026-09-19T00:00:00Z' }], tasks:[], records:[], timer:null };
  await writeFile(path.join(dir,'state.json'),JSON.stringify(old));
  let app = await createApp({ dataDir:dir }), base = await start(app);
  t.after(async () => { await stop(app); await rm(dir,{ recursive:true,force:true }); });
  let state = await (await fetch(base+'/api/state')).json();
  assert.equal(state.settings.character.name,'知夏');
  assert.deepEqual(state.settings.appearance,DEFAULT_APPEARANCE);
  assert.equal(state.messages[0].content,'历史对话');
  const put = value => fetch(base+'/api/state',{ method:'PUT',headers:{ 'Content-Type':'application/json' },body:JSON.stringify(value) });
  state.settings.character = { ...DEFAULT_CHARACTER,id:'custom',name:'小雨' };
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=';
  state.settings.appearance = { ...DEFAULT_APPEARANCE, accent:'#78619c', backgroundColor:'#f6f3fb', companionAvatar:png, userAvatar:png, backgroundImage:png, backgroundOpacity:32 };
  assert.equal((await put(state)).status,200);
  await stop(app); app = await createApp({ dataDir:dir }); base = await start(app);
  state = await (await fetch(base+'/api/state')).json();
  assert.equal(state.settings.character.name,'小雨');
  assert.equal(state.settings.appearance.accent,'#78619c');
  assert.equal(state.settings.appearance.backgroundOpacity,32);
  assert.equal(state.settings.appearance.userAvatar,png);
  assert.equal((await put({ ...state,settings:{ ...state.settings,appearance:{ ...state.settings.appearance,backgroundImage:'https://example.com/a.png' } } })).status,400);
  assert.equal((await put({ ...state,settings:{ ...state.settings,character:{ ...state.settings.character,name:'' } } })).status,400);
  // A still-open old client may omit the new field; it must not reset the role.
  delete state.settings.character;
  delete state.settings.appearance;
  assert.equal((await put(state)).status,200);
  const saved = await (await fetch(base+'/api/state')).json();
  assert.equal(saved.settings.character.name,'小雨');
  assert.equal(saved.settings.appearance.backgroundImage,png);
  assert.equal(saved.messages.length,1);
});
test('appearance rejects executable/remote image sources and invalid colors; contrast adapts', () => {
  assert.equal(validAppearance(DEFAULT_APPEARANCE),true);
  for (const source of ['https://example.com/p.png','javascript:alert(1)','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,YWJjZA==']) {
    assert.equal(validAppearance({...DEFAULT_APPEARANCE,companionAvatar:source}),false);
  }
  for (const color of ['red','#fff','#ffffff;display:none']) assert.throws(() => cleanAppearance({...DEFAULT_APPEARANCE,accent:color}));
  assert.throws(() => cleanAppearance({...DEFAULT_APPEARANCE,backgroundOpacity:61}));
  assert.equal(contrastText('#ffffff'),'#17251d');
  assert.equal(contrastText('#000000'),'#ffffff');
  assert.equal(cleanAppearance({...DEFAULT_APPEARANCE,secret:'not allowed'}).secret,undefined);
});
test('invalid on-disk data is preserved and remote endpoints are rejected', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'peiban-test-'));
  try {
    await writeFile(path.join(dir,'state.json'),'{broken');
    await assert.rejects(createApp({ dataDir:dir }), /原数据未覆盖/);
    assert.equal(await readFile(path.join(dir,'state.json'),'utf8'),'{broken');
    await assert.rejects(createApp({ dataDir:dir, ollamaUrl:'https://example.com' }), /必须指向本机/);
  } finally { await rm(dir,{ recursive:true, force:true }); }
});
