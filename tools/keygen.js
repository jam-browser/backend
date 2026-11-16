'use strict';
/**
 * 릴리스 서명 키 만들기 (처음 한 번만)
 *
 *   node tools/keygen.js --out C:\경로\jam-backend-release.pem
 *
 *  - 비밀키는 --out 경로에 저장 (저장소 밖에 두고 꼭 백업하세요. 잃어버리면 이미 설치된 서버에 업데이트를 보낼 수 없어요)
 *  - 공개키는 저장소의 release-key.pub.pem 에 저장 (서버가 업데이트를 확인할 때 씀)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const i = process.argv.indexOf('--out');
const out = i >= 0 ? process.argv[i + 1] : null;
if (!out) {
  console.error('사용법: node tools/keygen.js --out <비밀키 저장 경로>');
  process.exit(1);
}
if (fs.existsSync(out)) {
  console.error(`이미 있어요: ${out} (덮어쓰지 않아요)`);
  process.exit(1);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(path.join(__dirname, '..', 'release-key.pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
console.log(`private key: ${out}\npublic key:  release-key.pub.pem`);
