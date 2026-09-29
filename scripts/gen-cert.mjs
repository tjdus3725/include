// LAN 에서 HTTPS 를 쓰기 위한 로컬 CA 와 서버 인증서를 생성합니다. (외부 도구/계정 불필요)
//  - certs/inchat-local-ca.crt : 다른 기기에 설치해 "신뢰"할 로컬 CA 인증서 (공개해도 되는 파일)
//  - certs/inchat-local-ca.key : CA 개인키 (절대 공유 금지)
//  - certs/server.crt/.key     : 서버 인증서 (localhost, 호스트명, 현재 LAN IP 포함)
// IP 가 바뀌면 다시 실행하세요. CA 는 재사용되므로 다른 기기에 다시 설치할 필요가 없습니다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.CERT_DIR ? path.resolve(root, process.env.CERT_DIR) : path.join(root, 'certs');
fs.mkdirSync(dir, { recursive: true });
const p = (f) => path.join(dir, f);
const serial = () => crypto.randomBytes(16).toString('hex');
const pki = forge.pki;

// ---- CA (있으면 재사용) ----
let caCert, caKey;
if (fs.existsSync(p('inchat-local-ca.crt')) && fs.existsSync(p('inchat-local-ca.key'))) {
  caCert = pki.certificateFromPem(fs.readFileSync(p('inchat-local-ca.crt'), 'utf8'));
  caKey = pki.privateKeyFromPem(fs.readFileSync(p('inchat-local-ca.key'), 'utf8'));
  console.log('기존 로컬 CA 를 재사용합니다.');
} else {
  const keys = pki.rsa.generateKeyPair(2048);
  caKey = keys.privateKey;
  caCert = pki.createCertificate();
  caCert.publicKey = keys.publicKey;
  caCert.serialNumber = serial();
  caCert.validity.notBefore = new Date(Date.now() - 24 * 3600e3);
  caCert.validity.notAfter = new Date(Date.now() + 3650 * 24 * 3600e3);
  const subj = [{ name: 'commonName', value: 'InChat Local CA' }, { name: 'organizationName', value: 'InChat' }];
  caCert.setSubject(subj);
  caCert.setIssuer(subj);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  caCert.sign(caKey, forge.md.sha256.create());
  fs.writeFileSync(p('inchat-local-ca.crt'), pki.certificateToPem(caCert));
  fs.writeFileSync(p('inchat-local-ca.key'), pki.privateKeyToPem(caKey), { mode: 0o600 });
  console.log('새 로컬 CA 를 만들었습니다.');
}

// ---- 서버 인증서 ----
const ips = new Set(['127.0.0.1']);
for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) ips.add(i.address);
for (const extra of (process.env.CERT_EXTRA_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)) ips.add(extra);
const dns = new Set(['localhost', os.hostname()]);

const keys = pki.rsa.generateKeyPair(2048);
const cert = pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = serial();
cert.validity.notBefore = new Date(Date.now() - 24 * 3600e3);
cert.validity.notAfter = new Date(Date.now() + 800 * 24 * 3600e3); // Apple 기기의 825일 제한 이내
cert.setSubject([{ name: 'commonName', value: 'InChat Server' }, { name: 'organizationName', value: 'InChat' }]);
cert.setIssuer(caCert.subject.attributes);
const altNames = [];
for (const d of dns) altNames.push({ type: 2, value: d });
for (const ip of ips) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) altNames.push({ type: 7, ip });
  else altNames.push({ type: 2, value: ip });
}
altNames.push({ type: 7, ip: '::1' });
cert.setExtensions([
  { name: 'basicConstraints', cA: false },
  { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
  { name: 'extKeyUsage', serverAuth: true },
  { name: 'subjectAltName', altNames },
  { name: 'subjectKeyIdentifier' },
]);
cert.sign(caKey, forge.md.sha256.create());
fs.writeFileSync(p('server.crt'), pki.certificateToPem(cert));
fs.writeFileSync(p('server.key'), pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });

console.log(`\n인증서를 만들었습니다: ${dir}`);
console.log(`  포함된 주소: ${[...dns, ...ips].join(', ')}`);
console.log(`  서버 인증서 만료: ${cert.validity.notAfter.toISOString().slice(0, 10)}`);
console.log('\n다음 단계');
console.log('  1) .env 에서 HTTPS=true 로 설정하고 서버를 다시 시작하세요.');
console.log('  2) 다른 기기(스마트폰/노트북)는 http://<서버IP>:3000/inchat-ca.crt 에서 CA 인증서를 받아 "신뢰"로 설치하세요. (README 참고)');
