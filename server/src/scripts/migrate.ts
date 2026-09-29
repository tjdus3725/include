import { migrate } from '../db.js';
import { config } from '../config.js';

const r = migrate();
console.log(`DB 경로: ${config.dbPath}`);
console.log(r.from === r.to ? `이미 최신 상태입니다. (스키마 버전 ${r.to})` : `스키마 버전 ${r.from} → ${r.to} 로 적용했습니다.`);
