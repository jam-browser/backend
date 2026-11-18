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
  assert.deepEqual(JSON.parse((await get(relay.port, '/status')).body).limits, { maxMbps: 0, jamMbps: 0, guestMbps: 0, maxGuests: 64, msgRate: 0 });
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

  // ---------- 바이트 한도: 버리지 않고 늦춤 ----------
  async function pair(r, ctl, route, token) {
    const g = new WebSocket(`ws://127.0.0.1:${r.port}/join/${route}`);
    await opened(g);
    const inc = JSON.parse((await nextMsg(ctl)).d);
    const acc = new WebSocket(`ws://127.0.0.1:${r.port}/accept/${route}/${inc.id}?token=${token}`);
    await opened(acc);
    return { g, acc };
  }
  const collect = (ws, count) =>
    new Promise((resolve) => {
      let got = 0;
      let bytes = 0;
      const t0 = Date.now();
      ws.on('message', (d) => {
        bytes += d.length;
        if (++got === count) resolve({ got, bytes, ms: Date.now() - t0 });
      });
    });

  // 손님 연결 하나 8Mbps(초당 1MB, 순간 1MB) — 3MB 를 몰아 보내면 다 오지만 약 2초 걸림
  const r2 = await createRelay({ port: 0, host: '127.0.0.1', guestMbps: 8, jamMbps: 0, msgRate: 200 });
  const c2 = new WebSocket(`ws://127.0.0.1:${r2.port}/host`);
  const rm2 = JSON.parse((await nextMsg(c2)).d);
  const p2 = await pair(r2, c2, rm2.route, rm2.token);
  const chunk = Buffer.alloc(50 * 1024, 7);
  const done = collect(p2.g, 60);
  for (let i = 0; i < 60; i++) p2.acc.send(chunk, { binary: true });
  const res = await done;
  assert.equal(res.got, 60);
  assert.equal(res.bytes, 60 * chunk.length);
  assert.ok(res.ms >= 1500 && res.ms < 6000, `took ${res.ms}ms`);
  assert.ok(JSON.parse((await get(r2.port, '/status')).body).pauses > 0);
  ok(`손님 연결 한도(8Mbps): 3MB 를 하나도 버리지 않고 ${res.ms}ms 에 걸쳐 전달 (보내는 쪽을 잠깐 멈춤)`);

  // 메시지 수 한도(초당 200, 순간 400)도 버리지 않음: 작은 메시지 700개 → 모두 도착, 약 1.5초
  const pausesBefore = JSON.parse((await get(r2.port, '/status')).body).pauses;
  const small = collect(p2.acc, 700);
  for (let i = 0; i < 700; i++) p2.g.send(`m${i}`);
  const rs = await small;
  assert.equal(rs.got, 700);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(JSON.parse((await get(r2.port, '/status')).body).pauses > pausesBefore);
  ok('메시지 수 한도(설정 msgRate 200)를 넘어도 버리지 않음 — 700개 모두 도착, 보내는 쪽은 잠깐 멈춤');
  for (const w of [c2, p2.g, p2.acc]) w.close();
  await r2.close();

  // Jam 하나 합계 8Mbps: 손님 두 명에게 1.5MB 씩 → 합 3MB 가 약 2초
  const r3 = await createRelay({ port: 0, host: '127.0.0.1', guestMbps: 0, jamMbps: 8 });
  const c3 = new WebSocket(`ws://127.0.0.1:${r3.port}/host`);
  const rm3 = JSON.parse((await nextMsg(c3)).d);
  const pa = await pair(r3, c3, rm3.route, rm3.token);
  const pb = await pair(r3, c3, rm3.route, rm3.token);
  const da = collect(pa.g, 30);
  const db = collect(pb.g, 30);
  for (let i = 0; i < 30; i++) {
    pa.acc.send(chunk, { binary: true });
    pb.acc.send(chunk, { binary: true });
  }
  const [ra, rb] = await Promise.all([da, db]);
  assert.equal(ra.got + rb.got, 60);
  assert.ok(Math.max(ra.ms, rb.ms) >= 1500, `took ${ra.ms}/${rb.ms}ms`);
  const st3 = JSON.parse((await get(r3.port, '/status')).body);
  assert.deepEqual(st3.limits, { maxMbps: 0, jamMbps: 8, guestMbps: 0, maxGuests: 64, msgRate: 0 });
  ok(`Jam 하나 합계 한도(8Mbps): 손님 두 명 합 3MB 를 ${Math.max(ra.ms, rb.ms)}ms 에 걸쳐 모두 전달 · /status 에 한도 표시`);
  for (const w of [c3, pa.g, pa.acc, pb.g, pb.acc]) w.close();
  await r3.close();
  console.log(`\n중계 서버 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
