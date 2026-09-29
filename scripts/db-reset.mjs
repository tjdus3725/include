// 데이터베이스 파일을 삭제합니다. 서버를 먼저 종료한 뒤 `npm run db:reset -- --yes` 로 실행하세요.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });
const p = process.env.DB_PATH ? path.resolve(root, process.env.DB_PATH) : path.join(root, 'data', 'inchat.sqlite');

if (!process.argv.includes('--yes')) {
  console.log(`다음 DB 를 삭제합니다: ${p}`);
  console.log('모든 사용자, 채널, 메시지가 사라집니다. 계속하려면 다음처럼 실행하세요:');
  console.log('  npm run db:reset -- --yes');
  process.exit(1);
}
let removed = 0;
for (const f of [p, `${p}-wal`, `${p}-shm`]) {
  if (fs.existsSync(f)) { fs.rmSync(f); removed++; }
}
console.log(removed ? 'DB 를 삭제했습니다. 서버를 다시 시작하면 새 DB 와 기본 채널이 생성됩니다.' : '삭제할 DB 파일이 없습니다.');
