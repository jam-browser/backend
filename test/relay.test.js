'use strict';
// 중계 서버 단위 테스트: node test/relay.test.js
const assert = require('node:assert/strict');
const http = require('http');
const WebSocket = require('ws');
const { createRelay, VERSION } = require('../jam-relay');

const get = (port, p) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    }).on('error', reject);
  });
const opened = (ws) =>
  new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
const nextMsg = (ws) => new Promise((r) => ws.once('message', (d, isBinary) => r({ d, isBinary })));
const closeCode = (ws) => new Promise((r) => ws.once('close', (c) => r(c)));

(async () => {
  let n = 0;
  const ok = (s) => console.log(`  ✓ ${s}`, ++n && '');
  const relay = await createRelay({ port: 0, host: '127.0.0.1' });
  const base = `ws://127.0.0.1:${relay.port}`;

  assert.equal((await get(relay.port, '/version')).body, VERSION);
  const st = JSON.parse((await get(relay.port, '/status')).body);
  assert.equal(st.routes, 0);
  ok(`/version (${VERSION}) · /status 응답`);

  await assert.rejects(opened(new WebSocket(`${base}/host`, { origin: 'https://evil.example' })), /403/);
  ok('웹페이지 출처 차단');

  const control = new WebSocket(`${base}/host`);
  const routeMsg = JSON.parse((await nextMsg(control)).d);
  assert.equal(routeMsg.type, 'route');
  assert.match(routeMsg.route, /^[a-z0-9]{10}$/);
  ok('호스트가 경로를 받음');

  const guest = new WebSocket(`${base}/join/${routeMsg.route}`);
  await opened(guest);
  const incoming = JSON.parse((await nextMsg(control)).d);
  assert.equal(incoming.type, 'incoming');
  guest.send('before-pair'); // 짝이 맺어지기 전 메시지는 보관됐다가 전달돼야 함

  const bad = new WebSocket(`${base}/accept/${routeMsg.route}/${incoming.id}?token=wrong`);
  assert.equal(await closeCode(bad), 4403);
  ok('토큰이 틀리면 손님 연결을 받을 수 없음');

  const accept = new WebSocket(`${base}/accept/${routeMsg.route}/${incoming.id}?token=${routeMsg.token}`);
  const first = nextMsg(accept);
  await opened(accept);
  const m1 = await first;
  assert.equal(m1.d.toString(), 'before-pair');
  assert.equal(m1.isBinary, false);
  const toGuest = nextMsg(guest);
  accept.send(Buffer.from([1, 2, 3]), { binary: true });
  const m2 = await toGuest;
  assert.equal(m2.isBinary, true);
  assert.deepEqual([...m2.d], [1, 2, 3]);
  ok('짝 맺기 전 메시지 보관 · 텍스트/바이너리 그대로 전달');

  assert.equal(JSON.parse((await get(relay.port, '/status')).body).routes, 1);
  const unknown = new WebSocket(`${base}/join/zzzzzzzzzz`);
  assert.equal(await closeCode(unknown), 4404);
  ok('없는 경로 거절');

  control.close();
  await new Promise((r) => setTimeout(r, 100));
  const again = new WebSocket(`${base}/host?route=${routeMsg.route}&token=${routeMsg.token}`);
  assert.equal(JSON.parse((await nextMsg(again)).d).route, routeMsg.route);
  ok('호스트가 다시 붙으면 같은 경로 유지');

  for (const w of [again, guest, accept]) w.close();
  await relay.close();
  console.log(`\n중계 서버 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
