// 이 컴퓨터의 내부 IP 와 접속 URL 을 출력합니다.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });
const port = process.env.PORT || 3000;
const hport = process.env.HTTPS_PORT || 3443;
const https = ['1', 'true', 'yes', 'on'].includes((process.env.HTTPS || '').toLowerCase());
let found = false;
for (const [name, list] of Object.entries(os.networkInterfaces())) {
  for (const i of list ?? []) {
    if (i.family !== 'IPv4' || i.internal) continue;
    found = true;
    console.log(`[${name}] ${i.address}`);
    console.log(`   HTTP : http://${i.address}:${port}`);
    if (https) console.log(`   HTTPS: https://${i.address}:${hport}   (화면 공유용)`);
  }
}
if (!found) console.log('내부 IP 를 찾지 못했습니다. Wi-Fi/LAN 연결을 확인하세요.');
