'use strict';
/**
 * 릴리스 파일 만들기 (배포하는 사람 PC 에서)
 *
 *   node tools/make-release.js --key <비밀키.pem> [--out dist] [--publish]
 *
 *  - 실행에 필요한 파일 + node_modules(ws) 를 jam-relay-<버전>.zip 으로 묶고
 *  - 비밀키로 서명해서 jam-relay-<버전>.zip.sig 를 만든다
 *  - 저장소의 release-key.pub.pem 으로 바로 검증해 본다
 *  - --publish 면 GitHub 릴리스(v<버전>)를 만들어 두 파일을 올린다 (gh CLI 필요)
 *
 * 비밀키 경로는 --key 또는 환경 변수 JAM_RELEASE_KEY. 비밀키는 절대 저장소에 넣지 마세요.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { signRelease, verifyRelease, sha256hex } = require('../release-sign');

const ROOT = path.join(__dirname, '..');
const SYSTEM_TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const TAR = process.platform === 'win32' && fs.existsSync(SYSTEM_TAR) ? SYSTEM_TAR : 'tar';
const FILES = ['jam-relay.js', 'updater.js', 'release-sign.js', 'package.json', 'package-lock.json', 'release-key.pub.pem', 'LICENSE', 'README.md', 'windows'];

function copy(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) copy(path.join(src, n), path.join(dst, n));
  } else fs.copyFileSync(src, dst);
}

/**
 * @param opts.key        비밀키 PEM 문자열
 * @param opts.outDir     결과 폴더
 * @param opts.srcDir     소스 폴더 (기본: 저장소)
 * @param opts.version    (테스트용) 버전 덮어쓰기
 * @param opts.patch      (테스트용) staging 폴더를 고치는 함수
 * @param opts.modulesFrom (테스트용) npm 대신 이 폴더의 node_modules 복사
 */
function buildRelease({ key, outDir, srcDir = ROOT, version, patch, modulesFrom }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'));
  const ver = version || pkg.version;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), `jam-relay-${ver}-`));
  try {
    for (const f of FILES) if (fs.existsSync(path.join(srcDir, f))) copy(path.join(srcDir, f), path.join(staging, f));
    if (version) fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ ...pkg, version: ver }, null, 2) + '\n');
    if (modulesFrom) copy(path.join(modulesFrom, 'node_modules'), path.join(staging, 'node_modules'));
    else execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: staging, stdio: 'ignore' });
    if (patch) patch(staging);
    fs.mkdirSync(outDir, { recursive: true });
    const zipPath = path.join(outDir, `jam-relay-${ver}.zip`);
    fs.rmSync(zipPath, { force: true });
    // Windows 10+ 의 tar(bsdtar) 는 확장자가 .zip 이면 zip 으로 만든다
    execFileSync(TAR, ['-a', '-cf', zipPath, '-C', staging, '.'], { windowsHide: true, stdio: 'ignore' });
    const zip = fs.readFileSync(zipPath);
    const sig = signRelease(key, ver, zip);
    fs.writeFileSync(`${zipPath}.sig`, sig + '\n');
    return { version: ver, zipPath, sigPath: `${zipPath}.sig`, sha256: sha256hex(zip) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { buildRelease };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const keyPath = opt('key') || process.env.JAM_RELEASE_KEY;
  if (!keyPath) {
    console.error('비밀키 경로가 필요해요: --key <파일> 또는 JAM_RELEASE_KEY');
    process.exit(1);
  }
  const outDir = path.resolve(opt('out') || path.join(ROOT, 'dist'));
  const r = buildRelease({ key: fs.readFileSync(keyPath, 'utf8'), outDir });
  const pub = fs.readFileSync(path.join(ROOT, 'release-key.pub.pem'), 'utf8');
  if (!verifyRelease(pub, r.version, fs.readFileSync(r.zipPath), fs.readFileSync(r.sigPath, 'utf8'))) {
    console.error('서명 검증 실패: 비밀키와 release-key.pub.pem 이 짝이 아니에요');
    process.exit(1);
  }
  console.log(`built ${path.basename(r.zipPath)} (sha256 ${r.sha256}) + signature, verified with release-key.pub.pem`);
  if (argv.includes('--publish')) {
    const repo = opt('repo') || 'jam-browser/backend';
    execFileSync('gh', ['release', 'create', `v${r.version}`, '--repo', repo, '--title', `Jam relay ${r.version}`,
      '--notes', `중계 서버 ${r.version}. 설치된 서버는 서명을 확인한 뒤 자동으로 업데이트해요.\n\nSHA-256: \`${r.sha256}\``,
      r.zipPath, r.sigPath], { stdio: 'inherit' });
  }
}
