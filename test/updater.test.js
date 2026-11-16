'use strict';
// 자동 업데이트 테스트: node test/updater.test.js
//  가짜 GitHub 릴리스 서버 + 임시 설치 폴더로 updater.js 를 실제로 돌려 본다
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');
const { buildRelease } = require('../tools/make-release');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

function freePort() {
  return new Promise((r) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
}

function getVersion(port) {
  return new Promise((resolve) => {
    http
      .get({ host: '127.0.0.1', port, path: '/version', timeout: 1500 }, (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => resolve(b.trim()));
      })
      .on('error', () => resolve(null));
  });
}

(async () => {
  let n = 0;
  const ok = (s) => console.log(`  ✓ ${s}`, ++n && '');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-upd-test-'));
  const HOME = path.join(tmp, 'JamRelay');
  const OUT = path.join(tmp, 'releases');
  const official = keypair(); // 진짜 배포 키 (테스트용)
  const attacker = keypair(); // 다른 사람 키

  // 공개키만 바꾼 소스 사본 (설치된 서버가 믿는 키 = official.pub)
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  for (const f of ['jam-relay.js', 'updater.js', 'release-sign.js', 'package.json', 'package-lock.json', 'LICENSE', 'README.md', 'windows']) {
    if (fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(src, f), { recursive: true });
  }
  fs.writeFileSync(path.join(src, 'release-key.pub.pem'), official.pub);
  const build = (version, key = official.priv, patch) => buildRelease({ key, outDir: OUT, srcDir: src, version, patch, modulesFrom: ROOT });

  // --- 1.0.0 설치된 상태 만들기
  const r100 = build('1.0.0');
  fs.mkdirSync(path.join(HOME, 'versions', '1.0.0'), { recursive: true });
  execFileSync('tar', ['-xf', r100.zipPath, '-C', path.join(HOME, 'versions', '1.0.0')]);
  fs.writeFileSync(path.join(HOME, 'current.txt'), '1.0.0');
  const relayPort = await freePort();
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ repo: 'test/backend', port: relayPort, verifySeconds: 40 }));

  // --- 가짜 GitHub
  let latest = null; // { version, zip, sig }
  const api = http.createServer((req, res) => {
    if (req.url === '/repos/test/backend/releases/latest') {
      const base = `http://127.0.0.1:${api.address().port}/dl`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        tag_name: `v${latest.version}`,
        assets: [
          { name: `jam-relay-${latest.version}.zip`, browser_download_url: `${base}/zip` },
          { name: `jam-relay-${latest.version}.zip.sig`, browser_download_url: `${base}/sig` },
        ],
      }));
    }
    if (req.url === '/dl/zip') return res.end(fs.readFileSync(latest.zip));
    if (req.url === '/dl/sig') return res.end(fs.readFileSync(latest.sig));
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const publish = (r, sigFrom) => (latest = { version: r.version, zip: r.zipPath, sig: sigFrom || r.sigPath });

  const runUpdater = () =>
    new Promise((resolve) => {
      const cur = fs.readFileSync(path.join(HOME, 'current.txt'), 'utf8').trim();
      const child = spawn(process.execPath, [path.join(HOME, 'versions', cur, 'updater.js'), '--home', HOME, '--api', `http://127.0.0.1:${api.address().port}`, '--allow-http']);
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('exit', (code) => resolve({ code, out }));
    });
  const current = () => fs.readFileSync(path.join(HOME, 'current.txt'), 'utf8').trim();

  // A. 최신이면 아무것도 안 함
  publish(r100);
  let res = await runUpdater();
  assert.match(res.out, /up to date/);
  ok('같은 버전이면 그대로');

  // B. 다른 사람 키로 서명한 릴리스 → 설치 안 함
  const r101 = build('1.0.1', attacker.priv);
  publish(r101);
  res = await runUpdater();
  assert.match(res.out, /서명이 맞지 않아요/);
  assert.equal(current(), '1.0.0');
  ok('배포 키가 아닌 서명 → 거절 (GitHub 계정이 털려도 서버는 안전)');

  // B2. 진짜 서명이지만 zip 이 바뀜 → 거절
  const r101b = build('1.0.6');
  const tampered = path.join(OUT, 'tampered.zip');
  fs.copyFileSync(r101b.zipPath, tampered);
  fs.appendFileSync(tampered, Buffer.from('x'));
  latest = { version: '1.0.6', zip: tampered, sig: r101b.sigPath };
  res = await runUpdater();
  assert.match(res.out, /서명이 맞지 않아요/);
  assert.equal(current(), '1.0.0');
  ok('파일이 한 바이트라도 바뀌면 거절');

  // C. 서명은 맞지만 실행하면 바로 죽는 버전 → 자체 점검에서 걸러짐
  const r102 = build('1.0.2', official.priv, (dir) => fs.writeFileSync(path.join(dir, 'jam-relay.js'), "throw new Error('broken build');\n"));
  publish(r102);
  res = await runUpdater();
  assert.match(res.out, /자체 점검 실패/);
  assert.equal(current(), '1.0.0');
  assert.ok(!fs.existsSync(path.join(HOME, 'versions', '1.0.2')));
  ok('고장 난 새 버전은 교체 전에 걸러짐');

  // D. 정상 업데이트 (중계 서버가 꺼져 있을 때)
  const r103 = build('1.0.3');
  publish(r103);
  res = await runUpdater();
  assert.equal(current(), '1.0.3', res.out);
  assert.match(res.out, /signature ok/);
  assert.match(res.out, /self-test ok/);
  assert.equal(fs.readFileSync(path.join(HOME, 'previous.txt'), 'utf8').trim(), '1.0.0');
  ok('정상 업데이트: 서명 확인 → 자체 점검 → current.txt 교체');

  // E. 실행 중인 중계 서버가 스스로 새 버전으로 바뀜 (run-relay.cmd 와 같은 감시 루프)
  let stopLoop = false;
  let child = null;
  (async () => {
    while (!stopLoop) {
      const v = current();
      child = spawn(process.execPath, [path.join(HOME, 'versions', v, 'jam-relay.js'), '--port', String(relayPort), '--home', HOME], {
        env: { ...process.env, JAM_RELAY_WATCH_MS: '500' },
        stdio: 'ignore',
      });
      await new Promise((r) => child.once('exit', r));
      await sleep(300);
    }
  })();
  for (let i = 0; i < 40 && (await getVersion(relayPort)) !== '1.0.3'; i++) await sleep(250);
  assert.equal(await getVersion(relayPort), '1.0.3');
  const r104 = build('1.0.4');
  publish(r104);
  res = await runUpdater();
  assert.match(res.out, /relay is now running 1\.0\.4/);
  assert.equal(await getVersion(relayPort), '1.0.4');
  const kept = fs.readdirSync(path.join(HOME, 'versions')).sort();
  assert.deepEqual(kept, ['1.0.3', '1.0.4']);
  ok('실행 중인 서버가 쉬는 사이 새 버전으로 재시작 · 이전 버전 하나만 남기고 정리');

  // F. Jam 이 진행 중이면 끝날 때까지 기다림 (강제로 끊지 않음)
  const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ ...cfg, verifySeconds: 6 }));
  const host = new WebSocket(`ws://127.0.0.1:${relayPort}/host`);
  await new Promise((r) => host.once('message', r));
  const r105 = build('1.0.5');
  publish(r105);
  res = await runUpdater();
  assert.match(res.out, /relay busy; will switch when idle/);
  assert.equal(await getVersion(relayPort), '1.0.4');
  const state = JSON.parse(fs.readFileSync(path.join(HOME, 'update-state.json'), 'utf8'));
  assert.equal(state.pending, '1.0.5');
  ok('진행 중인 Jam 이 있으면 끝날 때까지 교체를 미룸');

  host.close();
  stopLoop = true;
  child.kill();
  api.close();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n자동 업데이트 테스트 통과 (${n}개)`);
  process.exit(0);
})().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
