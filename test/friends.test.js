'use strict';
// 친구 상태 테스트: node test/friends.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createRelay } = require('../jam-relay');

function call(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {}
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const rid = () => crypto.randomBytes(32).toString('base64url');
const blob = (n = 80) => crypto.randomBytes(n).toString('base64url');

let passed = 0;
async function t(name, fn) {
  await fn();
  passed++;
  console.log('  ✓', name);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-fr-test-'));
  let clock = Date.now();
  const R = await createRelay({ port: 0, host: '127.0.0.1', dataDir: path.join(dir, 'data'), now: () => clock });
  const put = (body, h) => call(R.port, 'POST', '/friends/put', body, h);
  const get = (ids, h) => call(R.port, 'POST', '/friends/get', { ids }, h);

  const [a, b, c] = [rid(), rid(), rid()];
  const [ba, bb] = [blob(), blob()];

  await t('맡기기 → 찾기: 있는 ID 만 돌려줌 · data 폴더를 만들지 않음 · /status 에 수', async () => {
    const r = await put({ items: [{ id: a, blob: ba }, { id: b, blob: bb }] });
    assert.equal(r.status, 200);
    assert.equal(r.body.ttl, 180000);
    const g = await get([a, b, c]);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.found, { [a]: ba, [b]: bb });
    assert.equal(fs.existsSync(path.join(dir, 'data')), false);
    const st = await call(R.port, 'GET', '/status');
    assert.equal(st.body.friendStatus, 2);
  });

  await t('다시 올리면 바뀌고 3분이 늘어남 · 지우기(drop) · 3분 지나면 사라짐 (오프라인)', async () => {
    const nb = blob();
    clock += 120e3;
    await put({ items: [{ id: a, blob: nb }], drop: [b] });
    let g = await get([a, b]);
    assert.deepEqual(g.body.found, { [a]: nb });
    clock += 120e3; // a 는 2분 전에 다시 올려서 아직 있음
    g = await get([a]);
    assert.deepEqual(g.body.found, { [a]: nb });
    clock += 61e3;
    g = await get([a]);
    assert.deepEqual(g.body.found, {});
  });

  await t('형식 확인: 이상한 ID · 큰 암호문 · base64url 아닌 글자 · 너무 많은 항목 · 깨진 JSON → 400, GET → 405', async () => {
    for (const body of [
      { items: [{ id: 'short', blob: blob() }] },
      { items: [{ id: rid(), blob: 'x'.repeat(1025) }] },
      { items: [{ id: rid(), blob: 'a+b/c=' }] },
      { items: Array.from({ length: 257 }, () => ({ id: rid(), blob: 'a' })) },
      { items: 'nope' },
      { drop: ['bad id'] },
    ]) assert.equal((await put(body)).status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal((await put('{nope')).status, 400);
    assert.equal((await get(Array.from({ length: 513 }, rid))).status, 400);
    assert.equal((await get(['x'])).status, 400);
    assert.equal((await call(R.port, 'GET', '/friends/get')).status, 405);
  });

  await t('웹페이지(Origin)에서 오는 요청은 403 · 앱(file:// · null)은 허용', async () => {
    assert.equal((await put({ items: [] }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await get([rid()], { Origin: 'http://localhost:8080' })).status, 403);
    assert.equal((await get([rid()], { Origin: 'file://' })).status, 200);
    assert.equal((await get([rid()], { Origin: 'null' })).status, 200);
  });

  await t('한도: IP 마다 1분에 60번 → 429, 1분 지나면 다시 · IP 하나가 맡길 수 있는 수 1024 → 429', async () => {
    clock += 120e3;
    let last;
    for (let i = 0; i < 61; i++) last = await get([rid()]);
    assert.equal(last.status, 429);
    assert.equal(last.body.error, 'slow-down');
    clock += 61e3;
    assert.equal((await get([rid()])).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await put({ items: Array.from({ length: 256 }, () => ({ id: rid(), blob: 'a' })) })).status, 200);
    const over = await put({ items: [{ id: rid(), blob: 'a' }] });
    assert.equal(over.status, 429);
    clock += 181e3; // 3분 지나 다 사라지면 다시 맡길 수 있음
    assert.equal((await put({ items: [{ id: rid(), blob: 'a' }] })).status, 200);
  });

  await R.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n친구 상태 테스트 통과 (${passed}개)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
