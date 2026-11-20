'use strict';
/**
 * 브라우저 계정 (아이디 + 비밀번호 로그인, 암호화된 보관함 동기화)
 *
 * 서버가 저장하는 것:
 *  - 아이디
 *  - 보관함(vault): 앱이 이미 종단 간 암호화한 JSON. 서버는 열쇠가 없어서 열 수 없고, 형식만 확인한 뒤 그대로 보관
 *  - 로그인 확인 값(verifier): 앱이 비밀번호에서 만든 auth 값(32바이트)을 한 번 더 scrypt 한 것.
 *    비밀번호 자체도, auth 자체도 저장하지 않아요. auth 로는 보관함을 풀 수 없어요 (앱이 비밀번호에서 따로 만든 키로만 풀림)
 *
 * 저장 위치 (dataDir):
 *   secret.bin                       서버 비밀값 32바이트 (없는 아이디에 줄 가짜 kdf 를 만들 때)
 *   accounts/<sha256hex(id)>.json    { id, rev, verifier, vault, createdAt, updatedAt }
 *   invites.json                     [{ hash: sha256hex(code), uses, maxUses, exp }]   (초대 코드는 해시만)
 *
 * 로그인 토큰은 메모리에만 (30일). 서버를 다시 켜면 앱이 다시 로그인해요.
 * HTTP 계약은 jam-relay.js 맨 위 설명 참고.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const MAX_BODY = 6 * 1024 * 1024;
const MAX_VAULT = 5 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const TOKEN_TTL = 30 * 24 * 60 * 60e3;
const MAX_TOKENS_PER_ACCOUNT = 20;
const IP_FAIL_WINDOW = 10 * 60e3;
const IP_FAIL_MAX = 20;
const REG_WINDOW = 60 * 60e3;
const REG_MAX = 5;
const LOCK_AFTER = 10;
const CACHE_BYTES = 48 * 1024 * 1024;
const POLICIES = ['invite', 'open', 'closed'];
// 초대 코드 글자: 헷갈리는 0 O 1 I L 은 뺌
const INVITE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

// 백신 검사 등으로 잠깐 잠겨 있을 수 있어서 이름 바꾸기는 몇 번 다시 시도 (동기: 이벤트 루프 사이에 끼어드는 요청이 없게)
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 10 || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      sleepSync(50);
    }
  }
}

// ---------- 초대 코드 (명령줄 --invite 와 서버가 같이 씀) ----------
function readInvites(dataDir) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dataDir, 'invites.json'), 'utf8'));
    return Array.isArray(list) ? list.filter((x) => isObj(x) && typeof x.hash === 'string') : [];
  } catch {
    return [];
  }
}
function writeInvites(dataDir, list, now = Date.now()) {
  // 다 쓴 것 · 만료된 것은 정리
  const live = list.filter((x) => x.exp > now && x.uses < x.maxUses);
  writeAtomic(path.join(dataDir, 'invites.json'), JSON.stringify(live, null, 1));
}
function randomInviteCode() {
  const out = [];
  while (out.length < 12) {
    for (const b of crypto.randomBytes(16)) {
      if (b >= 248) continue; // 31 의 배수(248)까지만 써서 글자가 고르게 나오도록
      out.push(INVITE_ABC[b % INVITE_ABC.length]);
      if (out.length === 12) break;
    }
  }
  return `JINV-${out.slice(0, 4).join('')}-${out.slice(4, 8).join('')}-${out.slice(8).join('')}`;
}
const normInvite = (code) => (typeof code === 'string' ? code.trim().toUpperCase() : '');

/** 초대 코드 만들기 → { code, maxUses, exp }. 코드는 해시만 저장하니, 돌려준 코드를 지금 전해 줘야 해요 */
function createInvite({ dataDir, uses = 1, days = 7, now = Date.now() } = {}) {
  if (!dataDir) throw new Error('dataDir 가 필요해요');
  const maxUses = Math.max(1, Math.floor(Number(uses) || 1));
  const exp = now + Math.max(1 / 24, Number(days) || 7) * 24 * 60 * 60e3;
  const code = randomInviteCode();
  const list = readInvites(dataDir);
  list.push({ hash: sha256hex(code), uses: 0, maxUses, exp });
  writeInvites(dataDir, list, now);
  return { code, maxUses, exp };
}

/** 쓸 수 있는 초대 코드 목록 (코드 자체는 저장돼 있지 않아서 해시 앞부분만) */
function listInvites({ dataDir, now = Date.now() } = {}) {
  return readInvites(dataDir)
    .filter((x) => x.exp > now && x.uses < x.maxUses)
    .map((x) => ({ hash: x.hash.slice(0, 12), left: x.maxUses - x.uses, exp: x.exp }));
}

// ---------- 계정 서버 ----------
function createAccounts({ dataDir, signup = 'invite', log = () => {}, now = Date.now } = {}) {
  dataDir = path.resolve(dataDir || 'data');
  const policy = POLICIES.includes(signup) ? signup : 'invite';
  if (policy !== signup) log(`unknown signup policy "${signup}", using "invite"`);
  const accountsDir = path.join(dataDir, 'accounts');

  // 서버 비밀값: 처음 필요할 때 만든다 (그냥 켜기만 해서는 data 폴더를 만들지 않음 — 업데이트 자체 점검 등)
  let secret = null;
  function serverSecret() {
    if (secret) return secret;
    const file = path.join(dataDir, 'secret.bin');
    try {
      const b = fs.readFileSync(file);
      if (b.length === 32) return (secret = b);
    } catch {}
    const b = crypto.randomBytes(32);
    writeAtomic(file, b);
    return (secret = b);
  }

  // ---------- 계정 파일 (디스크가 원본, 메모리 캐시는 수정 시각 · 크기로 확인) ----------
  const cache = new Map(); // file → { mtimeMs, size, acc }
  let cacheBytes = 0;
  const fileOf = (id) => path.join(accountsDir, `${sha256hex(id)}.json`);
  function remember(file, acc) {
    forget(file);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, acc });
    cacheBytes += st.size;
    for (const [k, v] of cache) {
      if (cacheBytes <= CACHE_BYTES || k === file) break;
      cache.delete(k);
      cacheBytes -= v.size;
    }
  }
  function forget(file) {
    const c = cache.get(file);
    if (c) {
      cache.delete(file);
      cacheBytes -= c.size;
    }
  }
  function load(id) {
    if (!ID_RE.test(id)) return null;
    const file = fileOf(id);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      forget(file);
      return null;
    }
    const c = cache.get(file);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) {
      cache.delete(file); // 최근에 쓴 것을 뒤로 (오래된 것부터 버림)
      cache.set(file, c);
      return c.acc;
    }
    let acc;
    try {
      acc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      log(`account file unreadable: ${path.basename(file)} (${e.message})`);
      return null;
    }
    if (!isObj(acc) || acc.id !== id) return null;
    remember(file, acc);
    return acc;
  }
  function save(acc) {
    const file = fileOf(acc.id);
    writeAtomic(file, JSON.stringify(acc));
    remember(file, acc);
  }
  function remove(id) {
    const file = fileOf(id);
    forget(file);
    fs.rmSync(file, { force: true });
  }
  function count() {
    try {
      return fs.readdirSync(accountsDir).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)).length;
    } catch {
      return 0;
    }
  }

  // ---------- 로그인 확인 값 ----------
  async function makeVerifier(authBuf) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(authBuf, salt, 32, SCRYPT);
    return { salt: salt.toString('base64'), hash: hash.toString('base64') };
  }
  // 없는 아이디도 똑같이 scrypt 를 한 번 돌린다 (걸리는 시간으로 아이디가 있는지 알 수 없게)
  const dummyVerifier = { salt: crypto.randomBytes(16).toString('base64'), hash: crypto.randomBytes(32).toString('base64') };
  async function checkAuth(verifier, authBuf) {
    const v = isObj(verifier) ? verifier : dummyVerifier;
    const want = Buffer.from(String(v.hash || ''), 'base64');
    const got = await scrypt(authBuf || Buffer.alloc(32), Buffer.from(String(v.salt || ''), 'base64'), 32, SCRYPT);
    return v !== dummyVerifier && !!authBuf && want.length === 32 && crypto.timingSafeEqual(got, want);
  }

  // ---------- 토큰 (메모리에만) ----------
  const tokens = new Map(); // token → { id, exp }
  const byId = new Map(); // id → Set(token) — 넣은 순서 = 오래된 순서
  function issueToken(id) {
    const t = now();
    if (tokens.size > 5000) for (const [k, v] of tokens) if (v.exp <= t) dropToken(k);
    const token = crypto.randomBytes(32).toString('base64url');
    tokens.set(token, { id, exp: t + TOKEN_TTL });
    let set = byId.get(id);
    if (!set) byId.set(id, (set = new Set()));
    set.add(token);
    for (const old of set) {
      if (set.size <= MAX_TOKENS_PER_ACCOUNT) break;
      dropToken(old);
    }
    return token;
  }
  function dropToken(token) {
    const v = tokens.get(token);
    if (!v) return;
    tokens.delete(token);
    const set = byId.get(v.id);
    if (set) {
      set.delete(token);
      if (!set.size) byId.delete(v.id);
    }
  }
  function dropTokensOf(id, keep = null) {
    for (const t of [...(byId.get(id) || [])]) if (t !== keep) dropToken(t);
  }
  function bearer(req) {
    const m = /^Bearer\s+([A-Za-z0-9_-]{43})\s*$/.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const v = tokens.get(m[1]);
    if (!v) return null;
    if (v.exp <= now()) {
      dropToken(m[1]);
      return null;
    }
    const acc = load(v.id);
    if (!acc) {
      dropTokensOf(v.id);
      return null;
    }
    return { token: m[1], id: v.id, acc };
  }

  // ---------- 시도 횟수 제한 (메모리) ----------
  const ipFails = new Map(); // ip → [시각]
  const ipRegs = new Map(); // ip → [시각]
  const idFails = new Map(); // id → { fails, until, at }
  function recent(map, ip, windowMs) {
    const t = now();
    const list = (map.get(ip) || []).filter((x) => x > t - windowMs);
    if (list.length) map.set(ip, list);
    else map.delete(ip);
    if (map.size > 10000) for (const k of [...map.keys()]) if (k !== ip) recent(map, k, windowMs);
    return list;
  }
  const ipBlocked = (ip) => recent(ipFails, ip, IP_FAIL_WINDOW).length >= IP_FAIL_MAX;
  const ipFail = (ip) => ipFails.set(ip, [...recent(ipFails, ip, IP_FAIL_WINDOW), now()]);
  function lockedFor(id) {
    const f = idFails.get(id);
    const left = f ? f.until - now() : 0;
    return left > 0 ? left : 0;
  }
  function idFail(id) {
    const t = now();
    if (idFails.size > 10000) for (const [k, v] of idFails) if (v.at < t - 24 * 60 * 60e3 && v.until < t) idFails.delete(k);
    const f = idFails.get(id) || { fails: 0, until: 0, at: t };
    f.fails++;
    f.at = t;
    // 연속 10번 틀리면 잠금: 1분, 2분, 4분 … 최대 60분
    if (f.fails >= LOCK_AFTER) f.until = t + Math.min(2 ** (f.fails - LOCK_AFTER), 60) * 60e3;
    idFails.set(id, f);
  }

  // ---------- 입력 확인 ----------
  function parseAuth(v) {
    if (typeof v !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(v)) return null;
    const b = Buffer.from(v, 'base64');
    return b.length === 32 ? b : null;
  }
  // 보관함은 열어 보지 않는다: 형식 표시와 kdf · dek · data 객체가 있는지만 확인
  function checkVault(v) {
    // 앱의 금고 파일: dek · data 는 암호문(base64 문자열), kdf 는 객체. 내용은 보지 않음
    const sealed = (x) => typeof x === 'string' && x.length > 0 && /^[A-Za-z0-9+/=]+$/.test(x);
    if (!isObj(v) || v.format !== 'jam-vault' || !isObj(v.kdf) || !sealed(v.dek) || !sealed(v.data)) return 'bad';
    if (Buffer.byteLength(JSON.stringify(v)) > MAX_VAULT) return 'big';
    return null;
  }
  const isRev = (v) => Number.isInteger(v) && v >= 0;

  function findInvite(code, list) {
    const c = normInvite(code);
    if (!c) return -1;
    const h = sha256hex(c);
    const t = now();
    return list.findIndex((x) => safeHexEq(x.hash, h) && x.exp > t && x.uses < x.maxUses);
  }
  const safeHexEq = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  // ---------- HTTP ----------
  const MSG = {
    origin: '웹페이지에서는 계정 기능을 쓸 수 없어요',
    'too-big': '보낸 내용이 너무 커요',
    'bad-json': '요청 형식이 잘못됐어요',
    'bad-request': '요청 내용이 잘못됐어요',
    'bad-id': '아이디는 영문 소문자 · 숫자 · . _ - 로 3~32자여야 해요 (첫 글자는 영문 소문자나 숫자)',
    'bad-vault': '보관함 형식이 잘못됐어요',
    'id-taken': '이미 있는 아이디예요',
    'signup-closed': '이 서버는 지금 새 가입을 받지 않아요',
    'bad-invite': '초대 코드가 맞지 않거나, 이미 쓰였거나, 기한이 지났어요',
    'bad-login': '아이디 또는 비밀번호가 맞지 않아요',
    'bad-token': '로그인이 풀렸어요. 다시 로그인해 주세요',
    conflict: '다른 기기에서 먼저 바뀌었어요. 서버의 최신 내용과 합친 뒤 다시 보내 주세요',
    'slow-down': '시도가 너무 많아요. 잠시 뒤에 다시 해 주세요',
    locked: '로그인 실패가 많아서 이 아이디는 잠시 잠겼어요',
    'not-found': '없는 주소예요',
    method: '지원하지 않는 요청 방식이에요',
    'server-error': '서버에서 문제가 생겼어요. 잠시 뒤에 다시 해 주세요',
  };

  // 받지 않을 본문은 읽어서 버린다 (바로 끊으면 앱이 응답을 못 읽고 연결 오류만 봄). 너무 길면 끊음
  function discard(req, already = 0) {
    let n = already;
    req.on('data', (d) => {
      n += d.length;
      if (n > 4 * MAX_BODY) req.destroy();
    });
    req.resume();
  }

  async function handle(req, res) {
    const send = (code, obj, headers = {}) => {
      if (res.headersSent) return;
      if (code === 304) {
        res.writeHead(304, { 'Cache-Control': 'no-store', ...headers });
        return res.end();
      }
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...headers });
      res.end(body);
    };
    const fail = (code, error, extra = {}, headers = {}) => send(code, { error, message: extra.message || MSG[error] || error, ...extra }, headers);

    // 웹페이지(http/https 출처)는 쓸 수 없다. Jam Browser 앱(file:// 또는 출처 없음)만
    const origin = req.headers.origin;
    if (origin && origin !== 'file://' && origin !== 'null') {
      discard(req);
      return fail(403, 'origin');
    }

    let url;
    try {
      url = new URL(req.url || '/', 'http://relay');
    } catch {
      discard(req);
      return fail(400, 'bad-request');
    }
    const route = url.pathname.replace(/\/+$/, '');
    const routes = {
      '/account/prelogin': ['POST'],
      '/account/register': ['POST'],
      '/account/login': ['POST'],
      '/account/vault': ['GET', 'PUT'],
      '/account/password': ['POST'],
      '/account/logout': ['POST'],
      '/account/delete': ['POST'],
    };
    if (!routes[route]) {
      discard(req);
      return fail(404, 'not-found');
    }
    if (!routes[route].includes(req.method)) {
      discard(req);
      return fail(405, 'method', {}, { Allow: routes[route].join(', ') });
    }

    // 본문 읽기 (최대 6MB)
    let body = {};
    if (req.method !== 'GET') {
      const tooBig = () => {
        fail(413, 'too-big');
        discard(req);
      };
      if (Number(req.headers['content-length']) > MAX_BODY) return tooBig();
      const raw = await new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        let over = false;
        req.on('data', (d) => {
          if (over) return;
          size += d.length;
          if (size > MAX_BODY) {
            over = true;
            discard(req, size);
            return resolve(null);
          }
          chunks.push(d);
        });
        req.on('end', () => !over && resolve(Buffer.concat(chunks)));
        req.on('error', () => resolve(undefined));
        req.on('aborted', () => resolve(undefined));
      });
      if (raw === undefined) return;
      if (raw === null) return tooBig();
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return fail(400, 'bad-json');
        }
      }
      if (!isObj(body)) return fail(400, 'bad-json');
    }

    const ip = req.socket.remoteAddress || '';
    const slowDown = () => fail(429, 'slow-down', {}, { 'Retry-After': '600' });
    const locked = (ms) => {
      const min = Math.ceil(ms / 60e3);
      return fail(429, 'locked', { message: `로그인 실패가 많아서 이 아이디는 ${min}분 동안 잠겼어요`, retryAfter: Math.ceil(ms / 1000) }, { 'Retry-After': String(Math.ceil(ms / 1000)) });
    };

    // ---------- 1. prelogin: 그 계정의 kdf (없는 아이디면 늘 같은 가짜) ----------
    if (route === '/account/prelogin') {
      const id = normId(body.id);
      if (!ID_RE.test(id)) return fail(400, 'bad-id');
      const acc = load(id);
      if (acc && isObj(acc.vault) && isObj(acc.vault.kdf)) return send(200, { kdf: acc.vault.kdf });
      const salt = crypto.createHmac('sha256', serverSecret()).update(`prelogin|${id}`).digest().subarray(0, 32);
      return send(200, { kdf: { alg: 'scrypt', N: 131072, r: 8, p: 1, salt: salt.toString('base64') } });
    }

    // ---------- 2. register ----------
    if (route === '/account/register') {
      if (policy === 'closed') return fail(403, 'signup-closed');
      if (ipBlocked(ip)) return slowDown();
      if (recent(ipRegs, ip, REG_WINDOW).length >= REG_MAX) return slowDown();
      const id = normId(body.id);
      if (!ID_RE.test(id)) return fail(400, 'bad-id');
      const auth = parseAuth(body.auth);
      if (!auth) return fail(400, 'bad-request', { message: 'auth 값이 잘못됐어요' });
      const vc = checkVault(body.vault);
      if (vc === 'big') return fail(413, 'too-big');
      if (vc) return fail(400, 'bad-vault');
      // 초대 코드를 아이디보다 먼저 확인 (초대 코드 없이 아이디가 있는지 떠보지 못하게)
      if (policy === 'invite' && findInvite(body.invite, readInvites(dataDir)) < 0) {
        ipFail(ip);
        return fail(403, 'bad-invite');
      }
      if (load(id)) return fail(409, 'id-taken');
      const verifier = await makeVerifier(auth);
      // scrypt 를 기다리는 동안 바뀌었을 수 있어서 다시 확인 → 여기부터는 동기로 한 번에 처리
      if (load(id) || fs.existsSync(fileOf(id))) return fail(409, 'id-taken');
      if (policy === 'invite') {
        const list = readInvites(dataDir);
        const i = findInvite(body.invite, list);
        if (i < 0) return fail(403, 'bad-invite');
        list[i].uses++;
        writeInvites(dataDir, list, now());
      }
      const at = new Date(now()).toISOString();
      save({ id, rev: 1, verifier, vault: body.vault, createdAt: at, updatedAt: at });
      ipRegs.set(ip, [...recent(ipRegs, ip, REG_WINDOW), now()]);
      log(`account registered (${policy})`);
      return send(201, { token: issueToken(id), rev: 1 });
    }

    // ---------- 3. login ----------
    if (route === '/account/login') {
      if (ipBlocked(ip)) return slowDown();
      const id = normId(body.id);
      const left = lockedFor(id);
      if (left) return locked(left);
      const auth = parseAuth(body.auth);
      const acc = load(id);
      // 없는 아이디 · 틀린 auth 모두 같은 응답, 같은 계산
      const good = await checkAuth(acc && acc.verifier, auth);
      if (!good || !acc) {
        ipFail(ip);
        if (ID_RE.test(id)) idFail(id);
        return fail(401, 'bad-login');
      }
      idFails.delete(id);
      const cur = load(id) || acc;
      return send(200, { token: issueToken(id), rev: cur.rev, vault: cur.vault });
    }

    // ---------- 여기부터는 로그인 토큰 필요 ----------
    const who = bearer(req);
    if (!who) return fail(401, 'bad-token');

    // 비밀번호 확인 (비밀번호 바꾸기 · 계정 지우기): 로그인처럼 시도 횟수 제한
    async function verifyCurrent(authValue) {
      if (ipBlocked(ip)) return slowDown(), false;
      const left = lockedFor(who.id);
      if (left) return locked(left), false;
      const before = who.acc.verifier;
      const ok = await checkAuth(before, parseAuth(authValue));
      const now2 = load(who.id);
      // 기다리는 동안 다른 기기에서 비밀번호가 바뀌었으면 실패로
      if (!ok || !now2 || !isObj(now2.verifier) || now2.verifier.salt !== (isObj(before) && before.salt)) {
        if (!now2) return fail(401, 'bad-token'), false;
        ipFail(ip);
        idFail(who.id);
        return fail(401, 'bad-login'), false;
      }
      idFails.delete(who.id);
      return true;
    }

    // ---------- 4/5. 보관함 받기 · 올리기 ----------
    if (route === '/account/vault') {
      if (req.method === 'GET') {
        const q = url.searchParams.get('rev');
        if (q !== null && /^\d+$/.test(q) && Number(q) === who.acc.rev) return send(304);
        return send(200, { rev: who.acc.rev, vault: who.acc.vault });
      }
      if (!isRev(body.baseRev)) return fail(400, 'bad-request', { message: 'baseRev 가 잘못됐어요' });
      const vc = checkVault(body.vault);
      if (vc === 'big') return fail(413, 'too-big');
      if (vc) return fail(400, 'bad-vault');
      const acc = who.acc;
      if (body.baseRev !== acc.rev) return fail(409, 'conflict', { rev: acc.rev, vault: acc.vault });
      const next = { ...acc, rev: acc.rev + 1, vault: body.vault, updatedAt: new Date(now()).toISOString() };
      save(next);
      return send(200, { rev: next.rev });
    }

    // ---------- 6. 비밀번호 바꾸기 (보관함도 새 키로 다시 암호화해서 같이 옴) ----------
    if (route === '/account/password') {
      const newAuth = parseAuth(body.newAuth);
      if (!newAuth) return fail(400, 'bad-request', { message: 'newAuth 값이 잘못됐어요' });
      if (!isRev(body.baseRev)) return fail(400, 'bad-request', { message: 'baseRev 가 잘못됐어요' });
      const vc = checkVault(body.vault);
      if (vc === 'big') return fail(413, 'too-big');
      if (vc) return fail(400, 'bad-vault');
      if (!(await verifyCurrent(body.auth))) return;
      const verifier = await makeVerifier(newAuth);
      const acc = load(who.id);
      if (!acc) return fail(401, 'bad-token');
      if (body.baseRev !== acc.rev) return fail(409, 'conflict', { rev: acc.rev, vault: acc.vault });
      const next = { ...acc, rev: acc.rev + 1, verifier, vault: body.vault, updatedAt: new Date(now()).toISOString() };
      save(next);
      dropTokensOf(who.id, who.token); // 다른 기기는 새 비밀번호로 다시 로그인
      log('account password changed');
      return send(200, { rev: next.rev });
    }

    // ---------- 7. 로그아웃 ----------
    if (route === '/account/logout') {
      dropToken(who.token);
      return send(200, {});
    }

    // ---------- 8. 계정 지우기 ----------
    if (route === '/account/delete') {
      if (!(await verifyCurrent(body.auth))) return;
      remove(who.id);
      dropTokensOf(who.id);
      idFails.delete(who.id);
      log('account deleted');
      return send(200, {});
    }
    return fail(404, 'not-found');
  }

  return {
    policy,
    dataDir,
    count,
    handle: (req, res) =>
      handle(req, res).catch((e) => {
        log(`account error: ${e && e.message}`);
        if (!res.headersSent) {
          const body = JSON.stringify({ error: 'server-error', message: MSG['server-error'] });
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(body);
        }
      }),
  };
}

module.exports = { createAccounts, createInvite, listInvites, MAX_BODY, MAX_VAULT };
