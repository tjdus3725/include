// .env 가 없으면 .env.example 을 복사하고 비밀값(ADMIN_CODE 등)을 무작위로 채웁니다.
// 포트 지정: npm run setup -- --port=80 [--https-port=443]
//   80/443 을 쓰면 접속 주소에서 포트 번호를 생략할 수 있습니다. (예: http://192.168.0.31)
//   .env 가 이미 있어도 --port 옵션을 주면 해당 값만 갱신합니다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const existed = fs.existsSync(envPath);

const flags = [];
for (const [flag, key] of [['port', 'PORT'], ['https-port', 'HTTPS_PORT']]) {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (!arg) continue;
  const v = Number.parseInt(arg.split('=')[1], 10);
  if (!Number.isInteger(v) || v < 1 || v > 65535) {
    console.error(`--${flag} 값이 올바르지 않습니다: ${arg}`);
    process.exit(1);
  }
  flags.push([key, v]);
}

if (existed && flags.length === 0) {
  console.log('.env 가 이미 있습니다. 변경하지 않았습니다. (포트만 바꾸려면: npm run setup -- --port=80)');
  process.exit(0);
}

let text;
let adminCode = null;
if (existed) {
  text = fs.readFileSync(envPath, 'utf8');
} else {
  text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  adminCode = crypto.randomBytes(9).toString('base64url');
  text = text.replace(/^ADMIN_CODE=.*$/m, `ADMIN_CODE=${adminCode}`);
  text = text.replace(/^IP_HASH_SECRET=.*$/m, `IP_HASH_SECRET=${crypto.randomBytes(24).toString('hex')}`);
}
for (const [key, v] of flags) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, `${key}=${v}`) : `${text.trimEnd()}\n${key}=${v}\n`;
  console.log(`${key}=${v} 로 설정했습니다.`);
}
fs.writeFileSync(envPath, text, { mode: 0o600 });

if (!existed) {
  console.log('.env 를 만들었습니다.');
  console.log(`서버 관리자 코드: ${adminCode}`);
  console.log('  → 접속 후 프로필 메뉴의 "서버 관리자 인증"에 입력하면 기본 채널도 관리/방송할 수 있습니다.');
  console.log('  → 이 코드는 .env 파일에만 저장되며 서버 로그에는 남지 않습니다.');
}
if (flags.some(([k, v]) => k === 'PORT' && v < 1024)) {
  console.log('참고: 1024 미만 포트는 macOS/Linux 에서 관리자 권한(sudo)이 필요하고, Windows 는 방화벽에서 해당 포트를 허용해야 합니다.');
}
