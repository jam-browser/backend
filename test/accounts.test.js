'use strict';
// 브라우저 계정 테스트: node test/accounts.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createRelay, createInvite, listInvites } = require('../jam-relay');

const ROOT = path.join(__dirname, '..');
const tmpDirs = [];
const tmpData = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-acc-test-'));
  tmpDirs.push(d);
  return path.join(d, 'data');
};

// 응답: { status, headers, body(JSON 이면 객체), raw }
function call(port, method, p, body, headers = {}) {
  const { chunked, ...extra } = headers; // chunked: 길이를 미리 알리지 않고 나눠 보내기
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    let done = false;
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'Content-Type': 'application/json', ...(chunked ? {} : { 'Content-Length': data.length }) } : {}), ...extra } },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          done = true;
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
        });
      },
    );
    // 서버가 본문을 다 받기 전에 413 으로 답하고 끊을 수 있음 → 응답을 받았으면 쓰기 오류는 무시
    req.on('error', (e) => !done && setTimeout(() => !done && reject(e), 200));
    if (data && chunked) for (let i = 0; i < data.length; i += 256 * 1024) req.write(data.subarray(i, i + 256 * 1024));
    else if (data) req.write(data);
    req.end();
  });
}
const b64 = (n) => crypto.randomBytes(n).toString('base64');
const newAuth = () => b64(32);
const vaultOf = (tag = 'x', kdf) => ({
  format: 'jam-vault',
  v: 1,
  kdf: kdf || { alg: 'scrypt', N: 131072, r: 8, p: 1, salt: b64(32) },
  dek: b64(93),
  data: Buffer.from(`secret-${tag}`).toString('base64'),
});
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

(async () => {
  let n = 0;
  const ok = (s) => console.log(`  ✓ ${s}`, ++n && '');

  // ================= 기본 흐름 (가입 정책 open) =================
  const dataA = tmpData();
  const A = await createRelay({ port: 0, host: '127.0.0.1', dataDir: dataA, signup: 'open' });
  const P = A.port;
  const post = (p, body, h) => call(P, 'POST', p, body, h);

  let st = JSON.parse((await call(P, 'GET', '/status')).raw);
  assert.equal(st.accounts, 0);
  assert.equal(st.signup, 'open');
  assert.equal(fs.existsSync(dataA), false, '켜기만 해서는 data 폴더를 만들지 않음');
  ok('/status 에 accounts · signup · 켜기만 해서는 data 폴더를 안 만듦');

  // prelogin: 없는 아이디는 가짜지만 늘 같은 kdf
  const f1 = await post('/account/prelogin', { id: 'nobody' });
  const f2 = await post('/account/prelogin', { id: ' NoBody ' });
  const f3 = await post('/account/prelogin', { id: 'someone-else' });
  assert.equal(f1.status, 200);
  assert.equal(f1.headers['cache-control'], 'no-store');
  assert.deepEqual(f1.body, f2.body);
  assert.notEqual(f1.body.kdf.salt, f3.body.kdf.salt);
  assert.equal(Buffer.from(f1.body.kdf.salt, 'base64').length, 32);
  assert.deepEqual({ ...f1.body.kdf, salt: 0 }, { alg: 'scrypt', N: 131072, r: 8, p: 1, salt: 0 });

  const authA = newAuth();
  const v1 = vaultOf('1');
  const reg = await post('/account/register', { id: '  Alice.Kim ', auth: authA, vault: v1 });
  assert.equal(reg.status, 201, reg.raw);
  assert.equal(reg.body.rev, 1);
  assert.match(reg.body.token, /^[A-Za-z0-9_-]{43}$/);
  const tA = reg.body.token;
  const real = await post('/account/prelogin', { id: 'alice.kim' });
  assert.deepEqual(real.body, { kdf: v1.kdf });
  assert.deepEqual(Object.keys(real.body.kdf).sort(), Object.keys(f1.body.kdf).sort());
  ok('prelogin: 있는 아이디는 저장된 kdf, 없는 아이디는 같은 모양의 가짜 kdf (매번 같음, 아이디마다 다름)');

  assert.equal((await post('/account/register', { id: 'alice.kim', auth: newAuth(), vault: vaultOf() })).body.error, 'id-taken');
  assert.equal((await post('/account/register', { id: 'ab', auth: newAuth(), vault: vaultOf() })).body.error, 'bad-id');
  assert.equal((await post('/account/register', { id: '-abc', auth: newAuth(), vault: vaultOf() })).body.error, 'bad-id');
  assert.equal((await post('/account/register', { id: 'bob', auth: b64(16), vault: vaultOf() })).status, 400);
  assert.equal((await post('/account/register', { id: 'bob', auth: newAuth(), vault: { ...vaultOf(), format: 'x' } })).body.error, 'bad-vault');
  assert.equal((await post('/account/register', { id: 'bob', auth: newAuth(), vault: { ...vaultOf(), dek: { iv: 'x' } } })).body.error, 'bad-vault');
  assert.equal((await post('/account/register', { id: 'bob', auth: newAuth(), vault: { ...vaultOf(), data: '' } })).body.error, 'bad-vault');
  assert.equal((await post('/account/register', Buffer.from('{not json'))).body.error, 'bad-json');
  const e409 = await post('/account/register', { id: 'alice.kim', auth: newAuth(), vault: vaultOf() });
  assert.equal(e409.status, 409);
  assert.equal(typeof e409.body.message, 'string');
  ok('가입: 같은 아이디 409 id-taken · 아이디/auth/보관함/JSON 형식 확인 · 오류에 message');

  // 동시에 같은 아이디로 가입하면 하나만 성공
  const [c1, c2] = await Promise.all([1, 2].map(() => post('/account/register', { id: 'twin', auth: newAuth(), vault: vaultOf() })));
  assert.deepEqual([c1.status, c2.status].sort(), [201, 409]);
  ok('동시에 같은 아이디로 가입 → 하나만 201, 나머지 409');

  // login
  const li = await post('/account/login', { id: 'ALICE.KIM', auth: authA });
  assert.equal(li.status, 200);
  assert.equal(li.body.rev, 1);
  assert.deepEqual(li.body.vault, v1);
  const tB = li.body.token;
  const wrong = await post('/account/login', { id: 'alice.kim', auth: newAuth() });
  const unknown = await post('/account/login', { id: 'ghost-user', auth: newAuth() });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  assert.equal(wrong.body.error, 'bad-login');
  ok('로그인: 성공하면 토큰 · rev · 보관함, 틀린 auth 와 없는 아이디는 똑같은 401 bad-login');

  // vault GET / PUT
  const g1 = await call(P, 'GET', '/account/vault', undefined, bearer(tA));
  assert.equal(g1.status, 200);
  assert.deepEqual(g1.body, { rev: 1, vault: v1 });
  const g304 = await call(P, 'GET', '/account/vault?rev=1', undefined, bearer(tB));
  assert.equal(g304.status, 304);
  assert.equal(g304.raw, '');
  assert.equal((await call(P, 'GET', '/account/vault?rev=0', undefined, bearer(tB))).status, 200);
  assert.equal((await call(P, 'GET', '/account/vault', undefined, bearer('x'.repeat(43)))).body.error, 'bad-token');
  assert.equal((await call(P, 'GET', '/account/vault')).status, 401);
  ok('보관함 받기: ?rev 가 같으면 304 (본문 없음) · 토큰이 없거나 틀리면 401 bad-token');

  const v2 = vaultOf('2', v1.kdf);
  const p1 = await call(P, 'PUT', '/account/vault', { baseRev: 1, vault: v2 }, bearer(tA));
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.body, { rev: 2 });
  const conflict = await call(P, 'PUT', '/account/vault', { baseRev: 1, vault: vaultOf('stale') }, bearer(tB));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'conflict');
  assert.equal(conflict.body.rev, 2);
  assert.deepEqual(conflict.body.vault, v2);
  assert.deepEqual((await call(P, 'GET', '/account/vault', undefined, bearer(tB))).body, { rev: 2, vault: v2 });
  assert.equal((await call(P, 'PUT', '/account/vault', { baseRev: 2, vault: { format: 'jam-vault' } }, bearer(tB))).body.error, 'bad-vault');
  ok('보관함 올리기: baseRev 가 맞으면 rev+1, 틀리면 409 conflict + 서버의 최신본');

  // 웹페이지 출처 차단 · 크기 제한
  const evil = await post('/account/prelogin', { id: 'alice.kim' }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.error, 'origin');
  assert.equal((await call(P, 'GET', '/account/vault', undefined, { ...bearer(tA), Origin: 'http://localhost:3000' })).status, 403);
  assert.equal((await post('/account/prelogin', { id: 'alice.kim' }, { Origin: 'file://' })).status, 200);
  assert.equal((await post('/account/prelogin', { id: 'alice.kim' }, { Origin: 'null' })).status, 200);
  const huge = await post('/account/login', Buffer.alloc(6 * 1024 * 1024 + 10, 0x20));
  assert.equal(huge.status, 413);
  assert.equal(huge.body.error, 'too-big');
  const hugeChunked = await post('/account/login', Buffer.alloc(7 * 1024 * 1024, 0x20), { chunked: true }); // 길이를 미리 알리지 않는 경우
  assert.equal(hugeChunked.status, 413);
  assert.equal((await post('/account/prelogin', { id: 'alice.kim' })).status, 200);
  const bigVault = vaultOf('big', v1.kdf);
  bigVault.data = 'A'.repeat(5 * 1024 * 1024 + 100); // 본문은 6MB 안이지만 보관함이 5MB 넘음
  assert.equal((await call(P, 'PUT', '/account/vault', { baseRev: 2, vault: bigVault }, bearer(tA))).status, 413);
  const okVault = vaultOf('fits', v1.kdf);
  okVault.data = 'A'.repeat(4 * 1024 * 1024);
  assert.deepEqual((await call(P, 'PUT', '/account/vault', { baseRev: 2, vault: okVault }, bearer(tA))).body, { rev: 3 });
  assert.equal((await call(P, 'GET', '/account/nope')).status, 404);
  assert.equal((await call(P, 'GET', '/account/login')).status, 405);
  ok('웹페이지 출처(Origin) 403 · file:// · null 은 허용 · 본문 6MB / 보관함 5MB 넘으면 413 · 4MB 보관함은 저장됨');

  // 비밀번호 바꾸기
  const tC = (await post('/account/login', { id: 'alice.kim', auth: authA })).body.token;
  const authA2 = newAuth();
  const v4 = vaultOf('4');
  const badPw = await post('/account/password', { auth: newAuth(), newAuth: authA2, baseRev: 3, vault: v4 }, bearer(tA));
  assert.equal(badPw.status, 401);
  assert.equal(badPw.body.error, 'bad-login');
  const stalePw = await post('/account/password', { auth: authA, newAuth: authA2, baseRev: 1, vault: v4 }, bearer(tA));
  assert.equal(stalePw.status, 409);
  assert.equal(stalePw.body.rev, 3);
  assert.equal((await post('/account/login', { id: 'alice.kim', auth: authA })).status, 200, '409 면 비밀번호는 그대로');
  const pw = await post('/account/password', { auth: authA, newAuth: authA2, baseRev: 3, vault: v4 }, bearer(tA));
  assert.equal(pw.status, 200, pw.raw);
  assert.deepEqual(pw.body, { rev: 4 });
  assert.equal((await call(P, 'GET', '/account/vault', undefined, bearer(tB))).body.error, 'bad-token');
  assert.equal((await call(P, 'GET', '/account/vault', undefined, bearer(tC))).body.error, 'bad-token');
  assert.deepEqual((await call(P, 'GET', '/account/vault', undefined, bearer(tA))).body, { rev: 4, vault: v4 });
  assert.equal((await post('/account/login', { id: 'alice.kim', auth: authA })).body.error, 'bad-login');
  const li2 = await post('/account/login', { id: 'alice.kim', auth: authA2 });
  assert.equal(li2.status, 200);
  assert.deepEqual(li2.body.vault, v4);
  assert.deepEqual((await post('/account/prelogin', { id: 'alice.kim' })).body.kdf, v4.kdf);
  ok('비밀번호 바꾸기: 지금 auth 확인 · baseRev 409 · 다른 토큰은 모두 끊김 · 옛 auth 로는 로그인 안 됨 · 새 kdf');

  // 로그아웃
  assert.deepEqual((await post('/account/logout', {}, bearer(tA))).body, {});
  assert.equal((await call(P, 'GET', '/account/vault', undefined, bearer(tA))).status, 401);
  assert.equal((await call(P, 'GET', '/account/vault', undefined, bearer(li2.body.token))).status, 200);
  ok('로그아웃: 그 토큰만 끊김');

  // 저장된 파일: 보관함은 그대로, auth/비밀번호 관련 원래 값은 없음
  const accFile = path.join(dataA, 'accounts', `${crypto.createHash('sha256').update('alice.kim').digest('hex')}.json`);
  const stored = JSON.parse(fs.readFileSync(accFile, 'utf8'));
  assert.equal(stored.id, 'alice.kim');
  assert.equal(stored.rev, 4);
  assert.deepEqual(stored.vault, v4);
  assert.deepEqual(Object.keys(stored.verifier).sort(), ['hash', 'salt']);
  const rawFile = fs.readFileSync(accFile, 'utf8');
  assert.ok(!rawFile.includes(authA2) && !rawFile.includes(authA));
  assert.equal(fs.readFileSync(path.join(dataA, 'secret.bin')).length, 32);
  assert.equal(fs.readdirSync(path.join(dataA, 'accounts')).filter((x) => x.endsWith('.tmp')).length, 0);
  ok('저장 파일: accounts/<sha256(id)>.json 에 보관함 그대로 + verifier(salt, hash)만 · auth 값은 없음');

  // 계정 지우기
  const tD = li2.body.token;
  const tE = (await post('/account/login', { id: 'alice.kim', auth: authA2 })).body.token;
  assert.equal((await post('/account/delete', { auth: authA }, bearer(tD))).body.error, 'bad-login');
  assert.deepEqual((await post('/account/delete', { auth: authA2 }, bearer(tD))).body, {});
  assert.equal(fs.existsSync(accFile), false);
  assert.equal((await call(P, 'GET', '/account/vault', undefined, bearer(tE))).status, 401);
  assert.equal((await post('/account/login', { id: 'alice.kim', auth: authA2 })).body.error, 'bad-login');
  assert.notDeepEqual((await post('/account/prelogin', { id: 'alice.kim' })).body.kdf, v4.kdf);
  st = JSON.parse((await call(P, 'GET', '/status')).raw);
  assert.equal(st.accounts, 1); // twin 만 남음
  ok('계정 지우기: auth 확인 · 파일 삭제 · 모든 토큰 끊김 · 그 뒤로는 가짜 kdf');
  await A.close();

  // ================= 가입 정책 =================
  const dataB = tmpData();
  const B = await createRelay({ port: 0, host: '127.0.0.1', dataDir: dataB }); // 기본 = invite
  assert.equal(JSON.parse((await call(B.port, 'GET', '/status')).raw).signup, 'invite');
  const regB = (id, invite) => call(B.port, 'POST', '/account/register', { id, auth: newAuth(), vault: vaultOf(), ...(invite !== undefined ? { invite } : {}) });
  assert.equal((await regB('carol')).body.error, 'bad-invite');
  assert.equal((await regB('carol', 'JINV-AAAA-BBBB-CCCC')).status, 403);
  const inv1 = createInvite({ dataDir: dataB });
  assert.match(inv1.code, /^JINV-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.ok(!fs.readFileSync(path.join(dataB, 'invites.json'), 'utf8').includes(inv1.code), '코드는 해시만 저장');
  // 초대 코드가 틀리면 아이디가 있는지도 알 수 없음 (id-taken 보다 먼저 확인)
  assert.equal((await regB('carol', ` ${inv1.code.toLowerCase()} `)).status, 201);
  assert.equal((await regB('dave', inv1.code)).body.error, 'bad-invite');
  assert.equal((await regB('carol', 'JINV-AAAA-BBBB-CCCC')).body.error, 'bad-invite');
  const inv2 = createInvite({ dataDir: dataB, uses: 2 });
  assert.equal((await regB('carol', inv2.code)).body.error, 'id-taken'); // 맞는 코드 + 이미 있는 아이디 → 코드는 안 씀
  assert.equal((await regB('dave', inv2.code)).status, 201);
  assert.equal((await regB('erin', inv2.code)).status, 201);
  assert.equal((await regB('frank', inv2.code)).body.error, 'bad-invite');
  const old = createInvite({ dataDir: dataB, days: 7, now: Date.now() - 8 * 24 * 60 * 60e3 });
  assert.equal((await regB('frank', old.code)).body.error, 'bad-invite');
  ok('가입 정책 invite(기본): 코드 없음/틀림/다 씀/만료 → 403 bad-invite · 여러 번 쓰는 코드 · 대소문자/공백 무시 · 코드는 해시만 저장');

  // 명령줄: --invite / --invites
  const out = execFileSync(process.execPath, [path.join(ROOT, 'jam-relay.js'), '--invite', '--uses', '3', '--days', '2', '--data', dataB], { encoding: 'utf8' });
  const cliCode = out.split(/\r?\n/)[0].trim();
  assert.match(cliCode, /^JINV-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await regB('frank', cliCode)).status, 201);
  const listed = execFileSync(process.execPath, [path.join(ROOT, 'jam-relay.js'), '--invites', '--data', dataB], { encoding: 'utf8' });
  const mine = listInvites({ dataDir: dataB }).find((x) => x.left === 2);
  assert.ok(mine && listed.includes(mine.hash), listed);
  assert.equal(listInvites({ dataDir: dataB }).length, 1, '다 쓴 · 만료된 코드는 목록에 없음');
  // --home 을 주면 <home>/data
  const home = path.dirname(tmpData());
  const out2 = execFileSync(process.execPath, [path.join(ROOT, 'jam-relay.js'), '--invite', '--home', home], { encoding: 'utf8' });
  assert.equal(listInvites({ dataDir: path.join(home, 'data') })[0].hash, crypto.createHash('sha256').update(out2.split(/\r?\n/)[0].trim()).digest('hex').slice(0, 12));
  ok('명령줄 --invite [--uses --days --data | --home] 으로 코드 만들기 · --invites 로 목록 (서버는 켜지 않음)');
  await B.close();

  const C = await createRelay({ port: 0, host: '127.0.0.1', dataDir: tmpData(), signup: 'closed' });
  const closed = await call(C.port, 'POST', '/account/register', { id: 'gina', auth: newAuth(), vault: vaultOf(), invite: 'x' });
  assert.equal(closed.status, 403);
  assert.equal(closed.body.error, 'signup-closed');
  assert.equal(JSON.parse((await call(C.port, 'GET', '/status')).raw).signup, 'closed');
  await C.close();
  ok('가입 정책 closed → 403 signup-closed');

  // ================= 시도 횟수 제한 (가짜 시계) =================
  let clock = Date.now();
  const D = await createRelay({ port: 0, host: '127.0.0.1', dataDir: tmpData(), signup: 'open', now: () => clock });
  const pd = (p, b, h) => call(D.port, 'POST', p, b, h);
  const authH = newAuth();
  assert.equal((await pd('/account/register', { id: 'henry', auth: authH, vault: vaultOf() })).status, 201);
  for (let i = 0; i < 10; i++) assert.equal((await pd('/account/login', { id: 'henry', auth: newAuth() })).status, 401);
  let lk = await pd('/account/login', { id: 'henry', auth: authH });
  assert.equal(lk.status, 429);
  assert.equal(lk.body.error, 'locked');
  assert.ok(lk.body.retryAfter > 0 && lk.body.retryAfter <= 60);
  clock += 59e3;
  assert.equal((await pd('/account/login', { id: 'henry', auth: authH })).body.error, 'locked');
  clock += 2e3;
  assert.equal((await pd('/account/login', { id: 'henry', auth: newAuth() })).status, 401); // 11번째 실패 → 2분 잠금
  lk = await pd('/account/login', { id: 'henry', auth: authH });
  assert.equal(lk.body.error, 'locked');
  assert.ok(lk.body.retryAfter > 60 && lk.body.retryAfter <= 120, String(lk.body.retryAfter));
  clock += 121e3;
  assert.equal((await pd('/account/login', { id: 'henry', auth: authH })).status, 200);
  // 성공하면 다시 0부터: 9번 틀리고 → 성공 → 9번 틀려도 잠기지 않음
  clock += 11 * 60e3; // IP 실패 창 비우기
  for (let i = 0; i < 9; i++) await pd('/account/login', { id: 'henry', auth: newAuth() });
  assert.equal((await pd('/account/login', { id: 'henry', auth: authH })).status, 200);
  clock += 11 * 60e3;
  for (let i = 0; i < 9; i++) await pd('/account/login', { id: 'henry', auth: newAuth() });
  assert.equal((await pd('/account/login', { id: 'henry', auth: authH })).status, 200);
  // 없는 아이디도 똑같이 잠김 (잠김 여부로 아이디가 있는지 알 수 없게)
  clock += 11 * 60e3;
  for (let i = 0; i < 10; i++) await pd('/account/login', { id: 'nobody-here', auth: newAuth() });
  assert.equal((await pd('/account/login', { id: 'nobody-here', auth: newAuth() })).body.error, 'locked');
  ok('아이디별 잠금: 연속 10번 틀리면 1분 → 2분 … (최대 60분, 429 locked) · 성공하면 초기화 · 없는 아이디도 똑같이');

  clock += 61 * 60e3;
  for (let i = 0; i < 20; i++) assert.equal((await pd('/account/login', { id: `user${i}`, auth: newAuth() })).status, 401);
  const slow = await pd('/account/login', { id: 'henry', auth: authH });
  assert.equal(slow.status, 429);
  assert.equal(slow.body.error, 'slow-down');
  const tH = (await (async () => {
    clock += 11 * 60e3;
    return pd('/account/login', { id: 'henry', auth: authH });
  })()).body.token;
  assert.ok(tH);
  // 비밀번호 확인 실패(계정 지우기)도 IP 실패로 셈: 9번 + 다른 아이디 로그인 실패 11번 = 20
  for (let i = 0; i < 9; i++) assert.equal((await pd('/account/delete', { auth: newAuth() }, bearer(tH))).body.error, 'bad-login');
  for (let i = 0; i < 11; i++) await pd('/account/login', { id: `other${i}`, auth: newAuth() });
  assert.equal((await pd('/account/delete', { auth: authH }, bearer(tH))).body.error, 'slow-down');
  clock += 11 * 60e3;
  // 계정 지우기 실패도 아이디 잠금에 셈 (9 + 1 = 10 → 잠김)
  assert.equal((await pd('/account/delete', { auth: newAuth() }, bearer(tH))).body.error, 'bad-login');
  assert.equal((await pd('/account/delete', { auth: authH }, bearer(tH))).body.error, 'locked');
  clock += 61 * 60e3;
  assert.equal((await pd('/account/login', { id: 'henry', auth: authH })).status, 200);
  ok('IP 별: 10분에 실패 20번 넘으면 429 slow-down (로그인 · 계정 지우기 비밀번호 확인 모두)');

  for (let i = 0; i < 4; i++) assert.equal((await pd('/account/register', { id: `reg${i}`, auth: newAuth(), vault: vaultOf() })).status, 201);
  const reg6 = await pd('/account/register', { id: 'reg-too-many', auth: newAuth(), vault: vaultOf() });
  assert.equal(reg6.status, 201); // henry 는 1시간도 더 전에 가입 → 이번이 5번째
  assert.equal((await pd('/account/register', { id: 'reg-six', auth: newAuth(), vault: vaultOf() })).body.error, 'slow-down');
  clock += 61 * 60e3;
  assert.equal((await pd('/account/register', { id: 'reg-six', auth: newAuth(), vault: vaultOf() })).status, 201);
  ok('IP 별 가입은 1시간에 5번까지 (429 slow-down)');
  await D.close();

  // ================= 다시 켜도 계정은 남고, 토큰은 사라짐 =================
  const dataE = tmpData();
  const E1 = await createRelay({ port: 0, host: '127.0.0.1', dataDir: dataE, signup: 'open' });
  const authI = newAuth();
  const vI = vaultOf('i');
  const regI = await call(E1.port, 'POST', '/account/register', { id: 'ivy', auth: authI, vault: vI });
  const fakeBefore = (await call(E1.port, 'POST', '/account/prelogin', { id: 'not-ivy' })).body;
  await E1.close();
  const E2 = await createRelay({ port: 0, host: '127.0.0.1', dataDir: dataE, signup: 'open' });
  assert.equal((await call(E2.port, 'GET', '/account/vault', undefined, bearer(regI.body.token))).body.error, 'bad-token');
  const liI = await call(E2.port, 'POST', '/account/login', { id: 'ivy', auth: authI });
  assert.equal(liI.status, 200);
  assert.deepEqual(liI.body.vault, vI);
  assert.equal(liI.body.rev, 1);
  assert.deepEqual((await call(E2.port, 'POST', '/account/prelogin', { id: 'not-ivy' })).body, fakeBefore);
  assert.equal(JSON.parse((await call(E2.port, 'GET', '/status')).raw).accounts, 1);
  await E2.close();
  ok('다시 켜도 계정 · 보관함 · 가짜 kdf 는 그대로 (secret.bin), 로그인 토큰은 사라져서 다시 로그인');

  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n계정 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  process.exit(1);
});
