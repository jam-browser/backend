'use strict';
/**
 * Jam 중계 서버 (라우팅) + 브라우저 계정
 *
 * 호스트 PC와 참여자 사이에 "길만 이어주는" 서버예요.
 *  - 호스트 앱이 먼저 중계 서버에 접속해 경로 번호(route)를 받는다           →  /host
 *  - 참여자는 초대 코드에 들어 있는 경로로 접속한다                       →  /join/<route>
 *  - 중계 서버가 호스트에게 "손님 왔어요" 알림 → 호스트가 연결을 하나 더 열어 받는다 →  /accept/<route>/<id>
 *  - 그 뒤로는 두 연결 사이에서 데이터를 **그대로** 넘겨줄 뿐이에요
 *
 * 내용은 호스트와 참여자 사이에서 이미 암호화되어 있고(초대 코드의 비밀키), 중계 서버는 키가 없어서 볼 수 없어요.
 * Jam 데이터는 아무것도 저장하지 않아요. 기록하는 것은 접속/종료 로그(시간, IP 일부)뿐이에요.
 *
 * 브라우저 계정(accounts.js)만 디스크에 저장해요: 아이디, 앱이 이미 암호화한 보관함(서버는 열 수 없음),
 * 비밀번호에서 만든 로그인 확인 값(비밀번호 자체는 아님). 데이터 폴더는 꼭 백업하세요.
 *
 * 실행:
 *   node jam-relay.js                       포트 3031 (또는 환경 변수 PORT)
 *   node jam-relay.js --config C:\JamRelay\config.json --home C:\JamRelay
 *        --home 을 주면 그 폴더의 current.txt 를 지켜보다가, 자동 업데이트로 버전이 바뀌면
 *        진행 중인 Jam 이 없을 때 스스로 종료한다 → 실행 스크립트(run-relay.cmd)가 새 버전으로 다시 켠다
 *   node jam-relay.js --invite [--uses N (기본 1)] [--days D (기본 7)] [--home <폴더> | --data <폴더>]
 *        계정 가입용 초대 코드(JINV-XXXX-XXXX-XXXX)를 만들어 출력하고 끝 (서버는 켜지 않음, 코드는 해시만 저장)
 *   node jam-relay.js --invites [--home <폴더> | --data <폴더>]      쓸 수 있는 초대 코드 목록 (해시 앞부분 · 남은 횟수 · 기한)
 *
 * HTTP:
 *   GET /          "Jam relay"
 *   GET /version   현재 버전 (자동 업데이트 확인용)
 *   GET /status    (같은 PC 에서만) 진행 중인 Jam 수 · 손님 수 · 계정 수(accounts) · 가입 정책(signup)
 *   GET /presence/<ID>  다른 기기에서 이어 보기: 호스트 앱이 제어 연결로 맡긴 암호문 (없으면 404, IP 마다 1분에 30번)
 *        ID 는 브라우저 계정 개인 키에서 만든 무작위 값, 암호문은 같은 계정 기기만 풀 수 있어요. 메모리에만, 호스트 연결이 끊기면 지움
 *
 *   브라우저 계정 (JSON 본문 최대 6MB → 넘으면 413, 응답은 JSON + Cache-Control: no-store,
 *   Origin 헤더가 있고 file:// · null 이 아니면 403 — 웹페이지는 못 씀. 오류: { error: "<코드>", message: "<한국어>" })
 *     아이디: 앞뒤 공백 제거 + 소문자, /^[a-z0-9][a-z0-9._-]{2,31}$/ · auth: 32바이트의 base64
 *     vault: 앱이 암호화한 JSON 객체 (format: "jam-vault", kdf · dek · data 객체, 5MB 이하). 서버는 열지 않고 그대로 보관
 *   POST /account/prelogin  { id }                          → 200 { kdf }  (없는 아이디도 늘 같은 가짜 kdf → 아이디가 있는지 알 수 없음)
 *   POST /account/register  { id, auth, vault, invite? }    → 201 { token, rev: 1 } · 409 id-taken · 403 signup-closed / bad-invite
 *   POST /account/login     { id, auth }                    → 200 { token, rev, vault } · 401 bad-login (없는 아이디 · 틀린 auth 같은 응답)
 *   GET  /account/vault[?rev=N]   (Authorization: Bearer)   → 200 { rev, vault } · rev 가 같으면 304 · 401 bad-token
 *   PUT  /account/vault     { baseRev, vault }   (Bearer)   → 200 { rev } · baseRev 가 다르면 409 { error: 'conflict', rev, vault }
 *   POST /account/password  { auth, newAuth, baseRev, vault } (Bearer) → 200 { rev } · 다른 기기 토큰은 모두 끊김 · 401 bad-login · 409 conflict
 *   POST /account/logout    (Bearer)                        → 200 {}
 *   POST /account/delete    { auth } (Bearer)               → 200 {} (계정 파일 · 토큰 삭제) · 401 bad-login
 *   토큰은 메모리에만 (30일, 계정당 20개) → 서버를 다시 켜면 앱이 다시 로그인
 *   시도 제한: IP 마다 10분에 비밀번호 확인 실패 20번(+ 틀린 초대 코드) → 429 slow-down, 가입은 IP 마다 1시간에 5번 → 429 slow-down,
 *            한 아이디가 연속 10번 틀리면 1분 · 2분 · 4분 … 최대 60분 잠금 → 429 locked (성공하면 초기화)
 *
 * 환경 변수 / config.json:
 *   PORT / port                    포트 (기본 3031)
 *   JAM_RELAY_PFX / pfx            (선택) TLS 인증서(PFX) → wss:// 로 동작
 *   JAM_RELAY_PFX_PASS / pfxPass   (선택) PFX 비밀번호
 *   JAM_RELAY_CERT, JAM_RELAY_KEY / cert, key   (선택) PEM 인증서/키
 *   JAM_RELAY_MAX_ROUTES / maxRoutes            동시에 열 수 있는 Jam 수 (기본 200)
 *   JAM_RELAY_MAX_MBPS / maxMbps                서버 전체 전송 한도 Mbps (기본 0 = 제한 없음)
 *   JAM_RELAY_JAM_MBPS / jamMbps                Jam 하나(호스트 + 손님 모두) 한도 Mbps (기본 0 = 제한 없음)
 *   JAM_RELAY_GUEST_MBPS / guestMbps            손님 연결 하나의 한쪽 방향 한도 Mbps (기본 0 = 제한 없음)
 *   JAM_RELAY_MAX_GUESTS / maxGuests            Jam 하나의 손님 수 (기본 64)
 *   JAM_RELAY_MSG_RATE / msgRate                연결 하나의 초당 메시지 수 (기본 0 = 제한 없음)
 *   JAM_RELAY_DATA / dataDir                    계정 데이터 폴더 (기본: --home 이 있으면 <home>/data, 없으면 ./data · 명령줄 --data 가 우선)
 *   JAM_RELAY_SIGNUP / signup                   가입 정책: invite (기본, 초대 코드 필요) · open (누구나) · closed (가입 막음)
 *   (--config 없이 --home 만 주면 <home>/config.json 을 읽어요)
 *
 * 한도를 넘으면 데이터를 버리지 않고, 보내는 쪽 연결을 잠깐 멈춰요 (TCP 가 자연스럽게 느려짐).
 * 화면 미러링을 하는 호스트 앱은 밀림을 보고 초당 장수 · 화질을 낮추고, 파일 전송은 기다렸다 이어서 보내요.
 * (내용은 암호화돼 있어서 서버는 무엇이 미러링인지 모르고, 바이트 양만 봐요)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { createAccounts, createInvite, listInvites } = require('./accounts');

const VERSION = require('./package.json').version;
const MAX_CONNS_PER_IP = 30;
const MAX_PAYLOAD = 64 * 1024;
const ROUTE_GRACE = 2 * 60e3; // 호스트가 잠깐 끊겨도 2분은 경로 유지
const PENDING_TIMEOUT = 15000; // 호스트가 15초 안에 받지 않으면 손님 연결 종료
const MAX_BUFFER = 64; // 짝이 맺어지기 전에 쌓아 둘 메시지 수
const HIGH_WATER = 2 * 1024 * 1024; // 받는 쪽에 이만큼 쌓이면 보내는 쪽을 멈춤
// 다른 기기에서 이어 보기: 호스트가 맡긴 { 무작위 ID → 암호문 }. 서버는 내용을 풀 수 없고(계정 키는 기기에만), 메모리에만 둠
const PRESENCE_ID = /^[A-Za-z0-9_-]{43}$/;
const MAX_PRESENCE_BLOB = 2048;
const PRESENCE_LOOKUPS_PER_MIN = 30; // IP 하나가 1분에 찾을 수 있는 횟수
const mbps = (n) => (Number(n) > 0 ? (Number(n) * 1e6) / 8 : 0); // Mbps → 초당 바이트 (0 = 제한 없음)

// 토큰 통: take(n) → 지금부터 기다려야 하는 ms (0 이면 바로)
function bucket(rate, burst = rate) {
  let tokens = burst;
  let at = Date.now();
  return {
    rate,
    take(n) {
      if (!rate) return 0;
      const now = Date.now();
      tokens = Math.min(burst, tokens + ((now - at) / 1000) * rate);
      at = now;
      tokens -= n;
      return tokens >= 0 ? 0 : Math.ceil((-tokens / rate) * 1000);
    },
  };
}

const b32 = 'abcdefghijkmnpqrstuvwxyz23456789';
const randomId = (n) => Array.from(crypto.randomBytes(n), (x) => b32[x % b32.length]).join('');
const maskIp = (ip) => String(ip || '').replace(/^::ffff:/, '').replace(/\.\d+$/, '.x');
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

// 한도는 모두 설정으로. 기본은 제한 없음 (0) — 서버 주인이 필요하면 config.json 으로 정함. 넘으면 버리지 않고 잠깐 멈춤
// dataDir · signup: 브라우저 계정 (accounts.js). now: (테스트용) 시계
function createRelay({ port = 3031, host = '0.0.0.0', tls = null, maxRoutes = 200, log = () => {}, onFrame = null, maxMbps = 0, jamMbps = 0, guestMbps = 0, maxGuests = 64, msgRate = 0, dataDir = 'data', signup = 'invite', now = Date.now } = {}) {
  const serverBucket = bucket(mbps(maxMbps));
  const accounts = createAccounts({ dataDir, signup, log, now });
  const traffic = { bytes: 0, paused: 0 }; // /status 용
  const routes = new Map(); // route → { token, control, guests: Map(id → guest), closeTimer }
  const connsPerIp = new Map();
  let nextGuestId = 1;
  const presence = new Map(); // id → { blob, route, at } — 그 Jam 의 호스트 연결이 있는 동안만
  const lookups = new Map(); // ip → { n, reset }
  function dropPresence(route) {
    const r = routes.get(route);
    if (!r || !r.presence) return;
    const p = presence.get(r.presence);
    if (p && p.route === route) presence.delete(r.presence);
    r.presence = null;
  }

  const stats = () => ({
    routes: routes.size,
    guests: [...routes.values()].reduce((n, r) => n + r.guests.size, 0),
    connections: [...connsPerIp.values()].reduce((a, b) => a + b, 0),
    presence: presence.size,
    bytes: traffic.bytes,
    pauses: traffic.paused,
    limits: { maxMbps: Number(maxMbps) || 0, jamMbps: Number(jamMbps) || 0, guestMbps: Number(guestMbps) || 0, maxGuests, msgRate: Number(msgRate) || 0 },
  });

  const handler = (req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/version') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(VERSION);
    }
    if (url === '/status') {
      if (!isLoopback(req.socket.remoteAddress)) {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ version: VERSION, ...stats(), accounts: accounts.count(), signup: accounts.policy }));
    }
    // 브라우저 계정: 로그인 · 암호화된 보관함 동기화 (accounts.js)
    if (url === '/account' || url.startsWith('/account/')) return accounts.handle(req, res);
    // 다른 기기에서 이어 보기: 무작위 ID 로 암호문 찾기 (없으면 404 — ID 가 있는지 없는지만 알 수 있고, 내용은 못 풂)
    const pm = /^\/presence\/([A-Za-z0-9_-]{43})$/.exec(url);
    if (pm) {
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'GET') return json(405, { error: 'method' });
      const ip = req.socket.remoteAddress || '';
      const now = Date.now();
      let l = lookups.get(ip);
      if (!l || l.reset < now) lookups.set(ip, (l = { n: 0, reset: now + 60e3 }));
      if (++l.n > PRESENCE_LOOKUPS_PER_MIN) return json(429, { error: 'slow down' });
      if (lookups.size > 10000) for (const [k, v] of lookups) if (v.reset < now) lookups.delete(k);
      const p = presence.get(pm[1]);
      const r = p && routes.get(p.route);
      if (!p || !r || !r.control) return json(404, { error: 'none' });
      return json(200, { blob: p.blob, at: p.at });
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Jam relay\n');
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  const sendJson = (ws, obj) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));

  // 연결 하나의 한쪽 방향: 메시지 수 · 바이트 한도를 넘거나 받는 쪽이 밀리면 보내는 쪽(src)을 잠깐 멈춘다
  function flow(src, dst, routeBucket) {
    const count = bucket(Number(msgRate) || 0, (Number(msgRate) || 0) * 2);
    const bytes = bucket(mbps(guestMbps), mbps(guestMbps)); // 1초 분량까지 몰아서 보낼 수 있음
    let timer = null;
    const resumeLater = (ms) => {
      if (timer) return;
      if (!src.isPaused) {
        src.pause();
        traffic.paused++;
      }
      timer = setTimeout(function check() {
        timer = null;
        if (src.readyState !== WebSocket.OPEN) return;
        if (dst.readyState === WebSocket.OPEN && dst.bufferedAmount > HIGH_WATER / 2) {
          timer = setTimeout(check, 50); // 받는 쪽이 아직 밀림
          return;
        }
        src.resume();
      }, Math.max(10, Math.min(ms, 2000)));
    };
    return (data) => {
      const n = data.length || data.byteLength || 0;
      traffic.bytes += n;
      const wait = Math.max(count.take(1), bytes.take(n), routeBucket.take(n), serverBucket.take(n));
      if (wait > 0) resumeLater(wait);
      else if (dst.bufferedAmount > HIGH_WATER) resumeLater(50);
    };
  }

  function closeRoute(route, reason) {
    const r = routes.get(route);
    if (!r) return;
    dropPresence(route);
    routes.delete(route);
    clearTimeout(r.closeTimer);
    for (const g of r.guests.values()) g.ws.close(4410, reason);
    log(`route ${route} closed (${reason})`);
  }

  // 두 연결을 이어서 데이터를 그대로 넘긴다 (텍스트/바이너리 구분 유지)
  // 버리지 않는다: 한도를 넘으면 보내는 쪽을 잠깐 멈춤 (받은 메시지는 그대로 전달)
  function pipe(a, b, label, routeBucket = bucket(0)) {
    const upFlow = flow(a, b, routeBucket);
    const downFlow = flow(b, a, routeBucket);
    a.on('message', (data, isBinary) => {
      if (onFrame) onFrame(label, 'up', data, isBinary);
      if (b.readyState === WebSocket.OPEN) b.send(data, { binary: isBinary });
      upFlow(data);
    });
    b.on('message', (data, isBinary) => {
      if (onFrame) onFrame(label, 'down', data, isBinary);
      if (a.readyState === WebSocket.OPEN) a.send(data, { binary: isBinary });
      downFlow(data);
    });
    const end = () => {
      if (a.readyState <= WebSocket.OPEN) a.close();
      if (b.readyState <= WebSocket.OPEN) b.close();
    };
    a.on('close', end);
    b.on('close', end);
    a.on('error', end);
    b.on('error', end);
  }

  server.on('upgrade', (req, socket, head) => {
    const ip = req.socket.remoteAddress || '';
    const origin = req.headers.origin;
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
      socket.destroy();
    };
    // 웹페이지(http/https 출처)는 중계 서버에 접속할 수 없다. Jam Browser 앱(file://)만 허용
    if (origin && origin !== 'file://' && origin !== 'null') return reject(403, 'Forbidden');
    if ((connsPerIp.get(ip) || 0) >= MAX_CONNS_PER_IP) return reject(429, 'Too Many');

    let url;
    try {
      url = new URL(req.url, 'http://relay');
    } catch {
      return reject(400, 'Bad Request');
    }
    const parts = url.pathname.split('/').filter(Boolean);

    wss.handleUpgrade(req, socket, head, (ws) => {
      connsPerIp.set(ip, (connsPerIp.get(ip) || 0) + 1);
      ws.on('close', () => {
        const n = (connsPerIp.get(ip) || 1) - 1;
        if (n <= 0) connsPerIp.delete(ip);
        else connsPerIp.set(ip, n);
      });
      ws.on('error', () => {});
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));

      // ---------- 호스트 제어 연결 ----------
      if (parts[0] === 'host' && parts.length === 1) {
        const want = url.searchParams.get('route');
        const existing = want && routes.get(want);
        let route;
        if (existing && safeEq(existing.token, url.searchParams.get('token'))) {
          route = want; // 호스트 재접속: 같은 경로 유지
          clearTimeout(existing.closeTimer);
          if (existing.control && existing.control !== ws) existing.control.close();
          existing.control = ws;
        } else {
          if (routes.size >= maxRoutes) return ws.close(4429, 'relay full');
          do route = randomId(10);
          while (routes.has(route));
          routes.set(route, { token: crypto.randomBytes(24).toString('base64url'), control: ws, guests: new Map(), closeTimer: null, bucket: bucket(mbps(jamMbps)) });
          log(`route ${route} opened by ${maskIp(ip)}`);
        }
        const r = routes.get(route);
        sendJson(ws, { type: 'route', route, token: r.token });
        // 호스트 제어 연결로 오는 메시지: 다른 기기에서 이어 보기 { type: 'presence', id, blob } (blob 이 없으면 지움)
        ws.on('message', (raw, isBinary) => {
          if (isBinary || raw.length > 4096) return;
          let m;
          try {
            m = JSON.parse(raw);
          } catch {
            return;
          }
          const cur = routes.get(route);
          if (!m || m.type !== 'presence' || !cur || cur.control !== ws) return;
          dropPresence(route);
          if (typeof m.id === 'string' && PRESENCE_ID.test(m.id) && typeof m.blob === 'string' && m.blob.length <= MAX_PRESENCE_BLOB && /^[A-Za-z0-9_-]+$/.test(m.blob)) {
            presence.set(m.id, { blob: m.blob, route, at: Date.now() });
            cur.presence = m.id;
          }
        });
        ws.on('close', () => {
          const cur = routes.get(route);
          if (!cur || cur.control !== ws) return;
          cur.control = null;
          cur.closeTimer = setTimeout(() => closeRoute(route, 'host gone'), ROUTE_GRACE);
        });
        return;
      }

      // ---------- 참여자 ----------
      if (parts[0] === 'join' && parts.length === 2) {
        const r = routes.get(parts[1]);
        if (!r || !r.control) return ws.close(4404, 'no such jam');
        if (r.guests.size >= maxGuests) return ws.close(4429, 'jam full');
        const id = String(nextGuestId++);
        const guest = { ws, buffer: [], paired: false };
        r.guests.set(id, guest);
        guest.take = (data, isBinary) => {
          if (guest.buffer.length < MAX_BUFFER) guest.buffer.push([data, isBinary]);
        };
        ws.on('message', guest.take);
        guest.timer = setTimeout(() => !guest.paired && ws.close(4408, 'host did not answer'), PENDING_TIMEOUT);
        ws.on('close', () => {
          clearTimeout(guest.timer);
          r.guests.delete(id);
        });
        // 손님 IP 는 호스트에게만 알려준다 (참여 요청 카드 표시, 잘못된 코드 차단용)
        sendJson(r.control, { type: 'incoming', id, ip: ip.replace(/^::ffff:/, '') });
        return;
      }

      // ---------- 호스트가 손님 연결을 받는 데이터 연결 ----------
      if (parts[0] === 'accept' && parts.length === 3) {
        const r = routes.get(parts[1]);
        if (!r || !safeEq(r.token, url.searchParams.get('token'))) return ws.close(4403, 'bad token');
        const guest = r.guests.get(parts[2]);
        if (!guest || guest.paired || guest.ws.readyState !== WebSocket.OPEN) return ws.close(4404, 'guest gone');
        guest.paired = true;
        clearTimeout(guest.timer);
        guest.ws.off('message', guest.take);
        pipe(guest.ws, ws, `${parts[1]}#${parts[2]}`, r.bucket);
        for (const [data, isBinary] of guest.buffer) ws.send(data, { binary: isBinary });
        guest.buffer = [];
        return;
      }

      ws.close(4400, 'unknown path');
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  function close() {
    clearInterval(heartbeat);
    for (const route of [...routes.keys()]) closeRoute(route, 'relay stopping');
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve({ port: server.address().port, close, routes, stats });
    });
  });
}

// ---------- 명령줄 실행 ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else out[a.slice(2)] = true;
    } else if (/^\d+$/.test(a)) out.port = a;
  }
  return out;
}

function loadSettings(args, { withTls = true } = {}) {
  let cfg = {};
  // --config 가 없으면 --home 폴더의 config.json (초대 코드 명령에서 --home 만 줘도 같은 설정을 쓰도록)
  const cfgFile = args.config || (typeof args.home === 'string' && fs.existsSync(path.join(args.home, 'config.json')) ? path.join(args.home, 'config.json') : null);
  if (cfgFile) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    } catch (e) {
      console.error(`config 를 읽지 못했어요: ${e.message}`);
    }
  }
  const env = process.env;
  const port = Number(args.port ?? env.PORT ?? cfg.port ?? 3031);
  const pfx = env.JAM_RELAY_PFX || cfg.pfx;
  const pfxPass = env.JAM_RELAY_PFX_PASS || cfg.pfxPass;
  const cert = env.JAM_RELAY_CERT || cfg.cert;
  const key = env.JAM_RELAY_KEY || cfg.key;
  let tls = null;
  if (!withTls) tls = null;
  else if (pfx) tls = { pfx: fs.readFileSync(pfx), passphrase: pfxPass || undefined };
  else if (cert && key) tls = { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
  const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  // 계정 데이터 폴더: --data > JAM_RELAY_DATA > config dataDir > (--home 이 있으면) <home>/data > ./data
  const dataDir = path.resolve(
    (typeof args.data === 'string' && args.data) || env.JAM_RELAY_DATA || cfg.dataDir || (typeof args.home === 'string' ? path.join(args.home, 'data') : 'data'),
  );
  const signup = String(env.JAM_RELAY_SIGNUP || cfg.signup || 'invite').trim().toLowerCase();
  return {
    dataDir,
    signup,
    port,
    tls,
    maxRoutes: Number(env.JAM_RELAY_MAX_ROUTES || cfg.maxRoutes || 200),
    maxMbps: num(env.JAM_RELAY_MAX_MBPS ?? cfg.maxMbps, 0),
    jamMbps: num(env.JAM_RELAY_JAM_MBPS ?? cfg.jamMbps, 0),
    guestMbps: num(env.JAM_RELAY_GUEST_MBPS ?? cfg.guestMbps, 0),
    maxGuests: Math.max(1, Math.min(1000, num(env.JAM_RELAY_MAX_GUESTS ?? cfg.maxGuests, 64))),
    msgRate: num(env.JAM_RELAY_MSG_RATE ?? cfg.msgRate, 0),
  };
}

// 자동 업데이트: current.txt 가 다른 버전을 가리키면, 진행 중인 Jam 이 없을 때 종료 → run-relay.cmd 가 새 버전으로 다시 켠다
function watchForUpdate(home, relay, log) {
  const file = path.join(home, 'current.txt');
  const MAX_WAIT = 6 * 60 * 60e3; // 새 버전이 나온 뒤 6시간 넘게 계속 바쁘면 그냥 교체 (호스트 앱은 자동으로 다시 연결)
  let since = null;
  setInterval(() => {
    let want;
    try {
      want = fs.readFileSync(file, 'utf8').trim();
    } catch {
      return;
    }
    if (!want || want === VERSION) {
      since = null;
      return;
    }
    since = since || Date.now();
    const busy = relay.stats().routes > 0;
    if (busy && Date.now() - since < MAX_WAIT) return;
    log(`switching to ${want} (now ${VERSION}${busy ? ', forced after waiting' : ''})`);
    relay.close().finally(() => process.exit(0));
  }, Number(process.env.JAM_RELAY_WATCH_MS) || 15000).unref();
}

module.exports = { createRelay, createInvite, listInvites, loadSettings, VERSION };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
  // 초대 코드 만들기 / 목록: 서버를 켜지 않고 바로 끝남
  if (args.invite || args.invites) {
    const { dataDir } = loadSettings(args, { withTls: false });
    try {
      if (args.invite) {
        const inv = createInvite({ dataDir, uses: args.uses === undefined ? 1 : Number(args.uses), days: args.days === undefined ? 7 : Number(args.days) });
        console.log(inv.code);
        console.log(`(${inv.maxUses}번 쓸 수 있고 ${new Date(inv.exp).toLocaleString()} 까지 유효 · 서버에는 해시만 저장돼서 이 코드는 다시 볼 수 없어요)`);
      } else {
        const list = listInvites({ dataDir });
        if (!list.length) console.log('쓸 수 있는 초대 코드가 없어요');
        for (const x of list) console.log(`${x.hash}…  남은 횟수 ${x.left}  ~ ${new Date(x.exp).toLocaleString()}`);
      }
      process.exit(0);
    } catch (e) {
      console.error(`초대 코드를 처리하지 못했어요 (${dataDir}): ${e.message}`);
      process.exit(1);
    }
  }
  const s = loadSettings(args);
  createRelay({ port: s.port, tls: s.tls, maxRoutes: s.maxRoutes, maxMbps: s.maxMbps, jamMbps: s.jamMbps, guestMbps: s.guestMbps, maxGuests: s.maxGuests, msgRate: s.msgRate, dataDir: s.dataDir, signup: s.signup, log })
    .then((relay) => {
      log(`Jam relay ${VERSION} listening on ${s.tls ? 'wss' : 'ws'}://0.0.0.0:${relay.port}`);
      log(`accounts: signup ${s.signup}, data ${s.dataDir}`);
      if (args.home) watchForUpdate(args.home, relay, log);
      // 업데이트 전 자체 점검용: 포트를 알려주고 바로 응답할 수 있게
      if (args.selftest) console.log(`SELFTEST_PORT=${relay.port}`);
    })
    .catch((e) => {
      console.error('failed to start:', e.message);
      process.exit(1);
    });
}
