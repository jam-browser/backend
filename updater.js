'use strict';
/**
 * Jam 중계 서버 자동 업데이트 (Windows 작업 스케줄러가 6시간마다 실행)
 *
 *   node versions\<현재버전>\updater.js --home C:\JamRelay
 *
 * 1. GitHub 릴리스(jam-browser/backend)의 최신 버전을 확인
 * 2. 더 새 버전이면 jam-relay-<버전>.zip 과 .sig 를 받는다
 * 3. **지금 설치된 버전에 들어 있는 공개키**로 서명을 확인 → 아니면 설치하지 않음
 * 4. versions\<새버전> 에 풀고, 따로 한 번 실행해 보는 자체 점검(/version 응답)을 통과해야 다음 단계
 * 5. current.txt 를 새 버전으로 바꾼다 → 중계 서버가 진행 중인 Jam 이 없을 때 스스로 재시작하며 새 버전으로 바뀐다
 * 6. 새 버전이 응답하지 않으면 이전 버전으로 되돌리고, 그 버전은 다시 시도하지 않는다
 *
 * 옵션: --check (확인만) --force (자동 업데이트 꺼져 있어도 / 실패한 버전도 다시 시도)
 *       --api <주소> --allow-http (테스트용)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const { verifyRelease } = require('./release-sign');

const SELF_VERSION = require('./package.json').version;

// ---------- 인자 · 설정 ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[argv[i].slice(2)] = next;
      i++;
    } else out[argv[i].slice(2)] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const HOME = path.resolve(String(args.home || path.join(__dirname, '..', '..')));
const API = String(args.api || 'https://api.github.com').replace(/\/+$/, '');
const ALLOW_HTTP = !!args['allow-http'];

const readText = (f, fallback = '') => {
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    return fallback;
  }
};
const readJson = (f, fallback = {}) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};
// 원자적으로 쓰기 (임시 파일에 쓰고 이름 바꾸기)
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const config = {
  repo: 'jam-browser/backend',
  port: 3031,
  autoUpdate: true,
  verifySeconds: 180,
  keepVersions: 2,
  ...readJson(path.join(HOME, 'config.json')),
};
const STATE_FILE = path.join(HOME, 'update-state.json');
const state = readJson(STATE_FILE, { bad: [] });
const saveState = () => writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

// ---------- 버전 비교 ----------
const parseVer = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : null;
};
function cmpVer(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// ---------- 네트워크 ----------
function request(url, { maxBytes = 60 * 1024 * 1024, redirects = 5, accept = 'application/octet-stream' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(ALLOW_HTTP && u.protocol === 'http:')) return reject(new Error(`https 가 아닌 주소는 받지 않아요: ${url}`));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers: { 'User-Agent': 'jam-relay-updater', Accept: accept }, timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('리다이렉트가 너무 많아요'));
        return resolve(request(new URL(res.headers.location, u).toString(), { maxBytes, redirects: redirects - 1, accept }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new Error('파일이 너무 커요'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('시간 초과')));
    req.on('error', reject);
  });
}

// 실행 중인 중계 서버의 버전 (없으면 null)
function runningVersion(port) {
  return new Promise((resolve) => {
    const tryLib = (lib, opts) =>
      new Promise((res) => {
        const req = lib.get({ host: '127.0.0.1', port, path: '/version', timeout: 3000, ...opts }, (r) => {
          let body = '';
          r.on('data', (d) => (body += d));
          r.on('end', () => res(r.statusCode === 200 ? body.trim() : null));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => res(null));
      });
    tryLib(http, {}).then((v) => (v ? resolve(v) : tryLib(https, { rejectUnauthorized: false }).then(resolve)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 새 버전을 다른 포트로 잠깐 띄워서 /version 이 맞게 나오는지 확인
function selfTest(dir, version) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'jam-relay.js'), '--port', '0', '--selftest'], { cwd: dir, windowsHide: true });
    let out = '';
    let done = false;
    let exited = false;
    child.once('exit', () => (exited = true));
    // 점검 프로세스가 완전히 끝난 뒤에 알려준다 (Windows 는 실행 중인 폴더의 이름을 바꿀 수 없음)
    const finish = (ok, why) => {
      if (done) return;
      done = true;
      if (exited) return resolve({ ok, why });
      child.once('exit', () => resolve({ ok, why }));
      child.kill();
    };
    const timer = setTimeout(() => finish(false, '시간 초과'), 15000);
    child.stdout.on('data', async (d) => {
      out += d;
      const m = /SELFTEST_PORT=(\d+)/.exec(out);
      if (!m) return;
      const v = await runningVersion(Number(m[1]));
      clearTimeout(timer);
      finish(v === version, v === version ? '' : `버전 응답이 달라요 (${v})`);
    });
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(false, `바로 종료됨 (코드 ${code}): ${out.slice(-300)}`);
    });
  });
}

function cleanup(keep) {
  const dir = path.join(HOME, 'versions');
  const names = fs.readdirSync(dir).filter((n) => parseVer(n));
  names.sort(cmpVer).reverse();
  let kept = 0;
  for (const n of names) {
    if (keep.includes(n)) continue;
    if (kept < Math.max(0, config.keepVersions - keep.length)) {
      kept++;
      continue;
    }
    fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    log(`old version ${n} removed`);
  }
  for (const n of fs.readdirSync(dir)) if (n.endsWith('.tmp')) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
}

// 로그 파일이 너무 커지면 하나 밀어 두기
function rotateLogs() {
  for (const name of ['relay.log', 'updater.log']) {
    const f = path.join(HOME, 'logs', name);
    try {
      if (fs.statSync(f).size > 10 * 1024 * 1024) fs.renameSync(f, `${f}.1`);
    } catch {}
  }
}

// ---------- 본 작업 ----------
async function main() {
  rotateLogs();
  const current = readText(path.join(HOME, 'current.txt'));
  if (!parseVer(current)) throw new Error(`current.txt 가 올바르지 않아요: "${current}"`);
  if (config.autoUpdate === false && !args.force && !args.check) return log('자동 업데이트가 꺼져 있어요 (config.json autoUpdate)');

  // 지난번 업데이트가 아직 확인 대기 중이면 먼저 확인
  if (state.pending) {
    const v = await runningVersion(config.port);
    if (v === state.pending) {
      log(`update to ${state.pending} confirmed (running)`);
      delete state.pending;
      saveState();
    } else log(`update to ${state.pending} still waiting (running: ${v || 'none'})`);
  }

  const rel = JSON.parse((await request(`${API}/repos/${config.repo}/releases/latest`, { accept: 'application/vnd.github+json', maxBytes: 2 * 1024 * 1024 })).toString('utf8'));
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  if (!parseVer(latest)) throw new Error(`릴리스 버전을 알 수 없어요: ${rel.tag_name}`);
  if (cmpVer(latest, current) <= 0) return log(`up to date (${current}, latest ${latest})`);
  if (state.bad?.includes(latest) && !args.force) return log(`${latest} failed before; skipping (use --force to retry)`);
  log(`new version ${latest} available (installed ${current})`);
  if (args.check) return;

  const zipName = `jam-relay-${latest}.zip`;
  const zipAsset = (rel.assets || []).find((a) => a.name === zipName);
  const sigAsset = (rel.assets || []).find((a) => a.name === `${zipName}.sig`);
  if (!zipAsset || !sigAsset) throw new Error(`릴리스에 ${zipName} / .sig 가 없어요`);
  const zip = await request(zipAsset.browser_download_url);
  const sig = (await request(sigAsset.browser_download_url, { maxBytes: 4096 })).toString('utf8');

  // 신뢰의 기준은 "지금 설치된 버전"의 공개키
  const pubKey = fs.readFileSync(path.join(HOME, 'versions', current, 'release-key.pub.pem'), 'utf8');
  if (!verifyRelease(pubKey, latest, zip, sig)) {
    state.bad = [...new Set([...(state.bad || []), latest])];
    saveState();
    throw new Error(`서명이 맞지 않아요 — ${latest} 는 설치하지 않아요`);
  }
  log(`signature ok for ${latest}`);

  // 풀기 → 확인 → 자체 점검
  const versionsDir = path.join(HOME, 'versions');
  const tmp = path.join(versionsDir, `${latest}.tmp`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const zipFile = path.join(HOME, `${zipName}.download`);
  fs.writeFileSync(zipFile, zip);
  try {
    execFileSync('tar', ['-xf', zipFile, '-C', tmp], { windowsHide: true, stdio: 'ignore' });
  } finally {
    fs.rmSync(zipFile, { force: true });
  }
  const pkg = readJson(path.join(tmp, 'package.json'));
  if (pkg.version !== latest) throw new Error(`압축 안의 버전(${pkg.version})이 릴리스(${latest})와 달라요`);
  for (const need of ['jam-relay.js', 'updater.js', 'release-sign.js', 'release-key.pub.pem', path.join('node_modules', 'ws', 'package.json')]) {
    if (!fs.existsSync(path.join(tmp, need))) throw new Error(`압축에 ${need} 가 없어요`);
  }
  const test = await selfTest(tmp, latest);
  if (!test.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    state.bad = [...new Set([...(state.bad || []), latest])];
    saveState();
    throw new Error(`새 버전 자체 점검 실패: ${test.why}`);
  }
  log(`self-test ok for ${latest}`);
  const target = path.join(versionsDir, latest);
  fs.rmSync(target, { recursive: true, force: true });
  // 백신 검사 등으로 잠깐 잠겨 있을 수 있어서 몇 번 다시 시도
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, target);
      break;
    } catch (e) {
      if (i >= 10 || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      await sleep(500);
    }
  }

  // 교체
  const before = await runningVersion(config.port);
  writeAtomic(path.join(HOME, 'previous.txt'), current);
  writeAtomic(path.join(HOME, 'current.txt'), latest);
  log(`switched current.txt ${current} -> ${latest}`);

  if (!before) {
    log('relay was not running; it will start with the new version');
  } else {
    // 중계 서버가 쉬고 있으면 곧 새 버전으로 재시작한다. 응답이 아예 없으면 되돌린다
    const deadline = Date.now() + config.verifySeconds * 1000;
    let last = before;
    let sawAny = false;
    while (Date.now() < deadline) {
      await sleep(3000);
      last = await runningVersion(config.port);
      if (last) sawAny = true;
      if (last === latest) break;
    }
    if (last === latest) {
      log(`relay is now running ${latest}`);
    } else if (last === current || (sawAny && last)) {
      // 진행 중인 Jam 이 있어서 아직 안 바뀜 → 다음 실행 때 확인
      state.pending = latest;
      saveState();
      log(`relay busy; will switch when idle (still ${last})`);
    } else {
      writeAtomic(path.join(HOME, 'current.txt'), current);
      state.bad = [...new Set([...(state.bad || []), latest])];
      saveState();
      throw new Error(`${latest} 가 응답하지 않아 ${current} 로 되돌렸어요`);
    }
  }
  cleanup([latest, current]);
}

// 동시에 두 번 돌지 않게
const LOCK = path.join(HOME, 'update.lock');
try {
  const st = fs.statSync(LOCK);
  if (Date.now() - st.mtimeMs > 60 * 60e3) fs.rmSync(LOCK, { force: true });
} catch {}
let fd;
try {
  fd = fs.openSync(LOCK, 'wx');
} catch {
  log('another update is running');
  process.exit(0);
}
log(`updater ${SELF_VERSION} (home ${HOME})`);
main()
  .then(() => {
    fs.closeSync(fd);
    fs.rmSync(LOCK, { force: true });
  })
  .catch((e) => {
    log(`ERROR ${e.message}`);
    fs.closeSync(fd);
    fs.rmSync(LOCK, { force: true });
    process.exitCode = 1;
  });
