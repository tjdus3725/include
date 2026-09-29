import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 프로젝트 루트 (server/src 또는 server/dist 기준 두 단계 위) */
export const ROOT_DIR = path.resolve(here, '..', '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

function int(name: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`환경변수 ${name} 값이 올바르지 않습니다: "${raw}" (허용 범위 ${min}~${max})`);
  }
  return n;
}
function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}
function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
function resolvePath(p: string | undefined, def: string): string {
  if (!p) return def;
  return path.isAbsolute(p) ? p : path.resolve(ROOT_DIR, p);
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: int('PORT', 3000, 1, 65535),
  httpsEnabled: bool('HTTPS', false),
  httpsPort: int('HTTPS_PORT', 3443, 1, 65535),
  certDir: resolvePath(process.env.CERT_DIR, path.join(ROOT_DIR, 'certs')),
  dbPath: resolvePath(process.env.DB_PATH, path.join(ROOT_DIR, 'data', 'inchat.sqlite')),
  clientDist: path.join(ROOT_DIR, 'client', 'dist'),
  /** 같은 Origin(요청 Host와 동일)은 항상 허용. 추가로 허용할 Origin 목록 */
  allowedOrigins: list('ALLOWED_ORIGINS'),
  cookieName: 'inchat_sid',
  sessionTtlDays: int('SESSION_TTL_DAYS', 30, 1, 365),
  adminCode: process.env.ADMIN_CODE || '',
  ipHashSecret: process.env.IP_HASH_SECRET || '',
  banByIp: bool('BAN_BY_IP', false),
  stunUrls: list('STUN_URLS'),
  maxViewers: int('MAX_VIEWERS_PER_BROADCAST', 8, 1, 100),
  limits: {
    nicknameMin: 2,
    nicknameMax: 12,
    channelNameMin: 2,
    channelNameMax: 30,
    channelDescMax: 100,
    messageMax: int('MESSAGE_MAX_LENGTH', 500, 50, 4000),
    noticeMax: 200,
    maxChannelsPerUser: int('MAX_CHANNELS_PER_USER', 5, 1, 100),
    maxChannelsTotal: int('MAX_CHANNELS_TOTAL', 100, 4, 1000),
    historyPage: 50,
    syncMax: 200,
  },
  rate: {
    httpPerMinute: int('HTTP_RATE_PER_MINUTE', 300, 10, 100000),
    loginPerTenMinutes: int('LOGIN_RATE_PER_10MIN', 20, 1, 1000),
    msgBurst: int('MSG_BURST', 5, 1, 100),
    msgRefillMs: int('MSG_REFILL_MS', 1000, 50, 60000),
    msgMinGapMs: int('MSG_MIN_GAP_MS', 300, 0, 10000),
    duplicateWindowMs: int('DUPLICATE_WINDOW_MS', 10000, 0, 600000),
    socketEventsPer10s: int('SOCKET_EVENTS_PER_10S', 60, 5, 10000),
  },
  leaveGraceMs: int('LEAVE_GRACE_MS', 4000, 0, 60000),
} as const;
