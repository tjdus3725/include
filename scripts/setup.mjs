// .env 가 없으면 .env.example 을 복사하고 비밀값(ADMIN_CODE 등)을 무작위로 채웁니다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  console.log('.env 가 이미 있습니다. 변경하지 않았습니다.');
  process.exit(0);
}
let text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const adminCode = crypto.randomBytes(9).toString('base64url');
text = text.replace(/^ADMIN_CODE=.*$/m, `ADMIN_CODE=${adminCode}`);
text = text.replace(/^IP_HASH_SECRET=.*$/m, `IP_HASH_SECRET=${crypto.randomBytes(24).toString('hex')}`);
fs.writeFileSync(envPath, text, { mode: 0o600 });
console.log('.env 를 만들었습니다.');
console.log(`서버 관리자 코드: ${adminCode}`);
console.log('  → 접속 후 프로필 메뉴의 "서버 관리자 인증"에 입력하면 기본 채널도 관리/방송할 수 있습니다.');
console.log('  → 이 코드는 .env 파일에만 저장되며 서버 로그에는 남지 않습니다.');
