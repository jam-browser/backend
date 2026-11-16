'use strict';
/**
 * 릴리스 서명 규칙 (Ed25519)
 *
 *  서명하는 내용 = "jam-relay|<버전>|<zip 파일의 SHA-256>"
 *   - 버전까지 묶어서 서명하므로, 옛날 버전 파일을 새 버전인 척 올려도 통과하지 못한다
 *   - 비밀키는 배포하는 사람 PC 에만 있고(저장소에 없음), 서버에는 공개키(release-key.pub.pem)만 있다
 */
const crypto = require('crypto');

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const message = (version, zip) => Buffer.from(`jam-relay|${version}|${sha256hex(zip)}`);

function signRelease(privateKeyPem, version, zip) {
  return crypto.sign(null, message(version, zip), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

function verifyRelease(publicKeyPem, version, zip, signatureBase64) {
  try {
    const sig = Buffer.from(String(signatureBase64).trim(), 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, message(version, zip), crypto.createPublicKey(publicKeyPem), sig);
  } catch {
    return false;
  }
}

module.exports = { signRelease, verifyRelease, sha256hex };
