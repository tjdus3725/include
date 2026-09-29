import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { log } from './log.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/**
 * 마이그레이션 목록. PRAGMA user_version 으로 적용 여부를 판단하며,
 * 스키마를 바꿀 때는 이 배열 끝에 새 항목만 추가합니다. (기존 항목은 수정하지 않습니다)
 */
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: '초기 스키마',
    sql: `
    CREATE TABLE users (
      id           TEXT PRIMARY KEY,
      nickname     TEXT NOT NULL,
      nickname_key TEXT NOT NULL UNIQUE,
      color        TEXT NOT NULL,
      is_admin     INTEGER NOT NULL DEFAULT 0,
      last_ip_hash TEXT,
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    -- 사용자 세션: 토큰 원문은 저장하지 않고 SHA-256 해시만 저장
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_sessions_user ON sessions(user_id);

    CREATE TABLE channels (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      name_key    TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      is_default  INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 100,
      created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at  INTEGER NOT NULL
    );

    -- 채널별 권한
    CREATE TABLE channel_roles (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('owner')),
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, user_id)
    );

    CREATE TABLE messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('user','system')),
      body       TEXT NOT NULL,
      client_id  TEXT,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX idx_messages_channel ON messages(channel_id, id);
    -- 같은 사용자의 같은 clientId 는 한 번만 저장 (재전송 중복 방지)
    CREATE UNIQUE INDEX idx_messages_client ON messages(user_id, client_id) WHERE client_id IS NOT NULL;

    CREATE TABLE notices (
      channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at INTEGER NOT NULL
    );

    -- 이용 제한(강퇴 후 재입장 제한)
    CREATE TABLE bans (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nickname   TEXT NOT NULL,
      ip_hash    TEXT,
      reason     TEXT NOT NULL DEFAULT '',
      banned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (channel_id, user_id)
    );
    CREATE INDEX idx_bans_ip ON bans(channel_id, ip_hash);

    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `,
  },
  {
    name: '채널별 방송 권한(broadcaster) 역할 추가',
    // SQLite 는 CHECK 제약을 변경할 수 없어 테이블을 새로 만들어 데이터를 옮긴다
    sql: `
    CREATE TABLE channel_roles_new (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('owner','broadcaster')),
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, user_id)
    );
    INSERT INTO channel_roles_new (channel_id, user_id, role, granted_at) SELECT channel_id, user_id, role, granted_at FROM channel_roles;
    DROP TABLE channel_roles;
    ALTER TABLE channel_roles_new RENAME TO channel_roles;
    `,
  },
  {
    name: '익명 입장(메시지 별칭)과 방송 권한 요청',
    sql: `
    -- 익명으로 입장한 사용자의 메시지는 그 시점의 별칭을 함께 저장한다
    ALTER TABLE messages ADD COLUMN alias TEXT;

    CREATE TABLE broadcast_requests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      anonymous    INTEGER NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted','dismissed')),
      created_at   INTEGER NOT NULL,
      resolved_at  INTEGER,
      resolved_by  TEXT
    );
    CREATE INDEX idx_requests_channel ON broadcast_requests(channel_id, status);
    `,
  },
  {
    name: '기본 방(전체 채팅·자유 대화·코딩 스터디·프로젝트 발표) 삭제',
    // 기본 방을 더 이상 자동 생성하지 않는다. 이미 만들어진 기본 방은 메시지·공지·이용 제한·방송 권한 요청과 함께 삭제된다(ON DELETE CASCADE).
    sql: `DELETE FROM channels WHERE is_default = 1;`,
  },
];

export function migrate(): { from: number; to: number } {
  const from = db.pragma('user_version', { simple: true }) as number;
  for (let v = from; v < MIGRATIONS.length; v++) {
    const m = MIGRATIONS[v];
    log.info(`DB 마이그레이션 적용 (${v + 1}/${MIGRATIONS.length}): ${m.name}`);
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return { from, to: MIGRATIONS.length };
}
