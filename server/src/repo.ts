import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { AppError } from './errors.js';
import { nicknameKey } from './validation.js';

// ---------- 타입 ----------
export interface UserRow {
  id: string;
  nickname: string;
  nickname_key: string;
  color: string;
  is_admin: number;
  last_ip_hash: string | null;
  created_at: number;
  last_seen_at: number;
}
export interface ChannelRow {
  id: string;
  name: string;
  description: string;
  is_default: number;
  sort_order: number;
  created_by: string | null;
  created_at: number;
}
export interface MessageDTO {
  id: number;
  channelId: string;
  kind: 'user' | 'system';
  userId: string | null;
  nickname: string | null;
  color: string | null;
  body: string;
  createdAt: number;
  deleted: boolean;
  /** 보낸 클라이언트가 붙인 임시 ID (전송 중 메시지와 서버 메시지를 맞추는 용도) */
  clientId: string | null;
  /** 익명으로 보낸 메시지 여부 (nickname 에는 별칭이 들어간다) */
  anonymous: boolean;
}
export interface BanRow {
  channel_id: string;
  user_id: string;
  nickname: string;
  ip_hash: string | null;
  reason: string;
  banned_by: string | null;
  created_at: number;
  expires_at: number | null;
}

// ---------- meta / 해시 ----------
export function getMeta(key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}
export function setMeta(key: string, value: string) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
let ipSecret: string | undefined;
function getIpSecret(): string {
  if (ipSecret) return ipSecret;
  ipSecret = config.ipHashSecret || getMeta('ip_hash_secret');
  if (!ipSecret) {
    ipSecret = crypto.randomBytes(32).toString('hex');
    setMeta('ip_hash_secret', ipSecret);
  }
  return ipSecret;
}
export function hashIp(ip: string | undefined): string {
  return crypto.createHmac('sha256', getIpSecret()).update(ip ?? 'unknown').digest('hex').slice(0, 32);
}
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---------- 사용자 ----------
export function createUser(nickname: string, color: string, ipHash: string): UserRow {
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO users (id, nickname, nickname_key, color, is_admin, last_ip_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(id, nickname, nicknameKey(nickname), color, ipHash, now, now);
  } catch (e) {
    if (String((e as Error).message).includes('UNIQUE')) {
      throw new AppError('NICKNAME_TAKEN', '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해 주세요.', 409);
    }
    throw e;
  }
  return getUser(id)!;
}
export function getUser(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}
export function updateUser(id: string, patch: { nickname?: string; color?: string }) {
  try {
    if (patch.nickname !== undefined) {
      db.prepare('UPDATE users SET nickname = ?, nickname_key = ? WHERE id = ?').run(patch.nickname, nicknameKey(patch.nickname), id);
    }
    if (patch.color !== undefined) db.prepare('UPDATE users SET color = ? WHERE id = ?').run(patch.color, id);
  } catch (e) {
    if (String((e as Error).message).includes('UNIQUE')) {
      throw new AppError('NICKNAME_TAKEN', '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해 주세요.', 409);
    }
    throw e;
  }
}
export function setUserIp(id: string, ipHash: string) {
  db.prepare('UPDATE users SET last_ip_hash = ?, last_seen_at = ? WHERE id = ?').run(ipHash, Date.now(), id);
}
export function setAdmin(id: string, isAdmin: boolean) {
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
}

// ---------- 세션 ----------
export function insertSession(tokenHash: string, userId: string, expiresAt: number) {
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, userId, Date.now(), expiresAt);
}
export function getSessionUser(tokenHash: string): { user: UserRow; expiresAt: number } | undefined {
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at AS s_expires FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(tokenHash, Date.now()) as (UserRow & { s_expires: number }) | undefined;
  if (!row) return undefined;
  const { s_expires, ...user } = row;
  return { user, expiresAt: s_expires };
}
export function extendSession(tokenHash: string, expiresAt: number) {
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(expiresAt, tokenHash);
}
export function deleteSession(tokenHash: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}
export function purgeStale() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  // 세션이 없고 30일 이상 활동이 없으며 채널을 만들지 않은 사용자 정리(닉네임 반환)
  db.prepare(
    `DELETE FROM users WHERE last_seen_at < ? AND is_admin = 0
       AND id NOT IN (SELECT user_id FROM sessions)
       AND id NOT IN (SELECT user_id FROM channel_roles)`,
  ).run(now - 30 * 24 * 3600 * 1000);
  db.prepare('DELETE FROM bans WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
}

// ---------- 채널 ----------
export function listChannels(q?: string): (ChannelRow & { owner_id: string | null; owner_nickname: string | null })[] {
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => '\\' + c).toLowerCase()}%` : null;
  return db
    .prepare(
      `SELECT c.*, r.user_id AS owner_id, u.nickname AS owner_nickname
       FROM channels c
       LEFT JOIN channel_roles r ON r.channel_id = c.id AND r.role = 'owner'
       LEFT JOIN users u ON u.id = r.user_id
       WHERE (? IS NULL OR c.name_key LIKE ? ESCAPE '\\' OR lower(c.description) LIKE ? ESCAPE '\\')
       ORDER BY c.is_default DESC, c.sort_order ASC, c.created_at ASC`,
    )
    .all(like, like, like) as never;
}
export function getChannel(id: string): (ChannelRow & { owner_id: string | null; owner_nickname: string | null }) | undefined {
  return db
    .prepare(
      `SELECT c.*, r.user_id AS owner_id, u.nickname AS owner_nickname
       FROM channels c
       LEFT JOIN channel_roles r ON r.channel_id = c.id AND r.role = 'owner'
       LEFT JOIN users u ON u.id = r.user_id
       WHERE c.id = ?`,
    )
    .get(id) as never;
}
export function createChannel(name: string, description: string, ownerId: string): string {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM channels').get() as { n: number }).n;
  if (total >= config.limits.maxChannelsTotal) {
    throw new AppError('CHANNEL_LIMIT', '서버에 만들 수 있는 채널 수 한도에 도달했습니다.', 409);
  }
  const mine = (db.prepare('SELECT COUNT(*) AS n FROM channels WHERE created_by = ?').get(ownerId) as { n: number }).n;
  if (mine >= config.limits.maxChannelsPerUser) {
    throw new AppError('CHANNEL_LIMIT', `채널은 한 사람당 최대 ${config.limits.maxChannelsPerUser}개까지 만들 수 있습니다.`, 409);
  }
  const id = crypto.randomBytes(6).toString('base64url');
  const now = Date.now();
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO channels (id, name, name_key, description, is_default, sort_order, created_by, created_at)
         VALUES (?, ?, ?, ?, 0, 100, ?, ?)`,
      ).run(id, name, name.toLowerCase(), description, ownerId, now);
      db.prepare(`INSERT INTO channel_roles (channel_id, user_id, role, granted_at) VALUES (?, ?, 'owner', ?)`).run(id, ownerId, now);
    })();
  } catch (e) {
    if (String((e as Error).message).includes('UNIQUE')) {
      throw new AppError('CHANNEL_EXISTS', '같은 이름의 채널이 이미 있습니다.', 409);
    }
    throw e;
  }
  return id;
}
export function deleteChannel(id: string) {
  db.prepare('DELETE FROM channels WHERE id = ?').run(id);
}
export function isOwner(channelId: string, userId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM channel_roles WHERE channel_id = ? AND user_id = ? AND role = 'owner'`).get(channelId, userId);
}
export function getOwnerId(channelId: string): string | null {
  return (db.prepare(`SELECT user_id FROM channel_roles WHERE channel_id = ? AND role = 'owner'`).get(channelId) as { user_id: string } | undefined)?.user_id ?? null;
}
/** 서버에서 검증하는 관리 권한: 채널 소유자 또는 서버 관리자 */
export function canModerate(user: UserRow, channelId: string): boolean {
  return user.is_admin === 1 || isOwner(channelId, user.id);
}
export function isBroadcaster(channelId: string, userId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM channel_roles WHERE channel_id = ? AND user_id = ? AND role = 'broadcaster'`).get(channelId, userId);
}
/** 방송 시작 권한: 채널 관리자(소유자/서버 관리자) 또는 관리자가 부여한 방송 권한 보유자 */
export function canBroadcast(user: UserRow, channelId: string): boolean {
  return canModerate(user, channelId) || isBroadcaster(channelId, user.id);
}
export function grantBroadcaster(channelId: string, userId: string) {
  db.prepare(`INSERT OR IGNORE INTO channel_roles (channel_id, user_id, role, granted_at) VALUES (?, ?, 'broadcaster', ?)`).run(channelId, userId, Date.now());
}
export function revokeBroadcaster(channelId: string, userId: string): boolean {
  return db.prepare(`DELETE FROM channel_roles WHERE channel_id = ? AND user_id = ? AND role = 'broadcaster'`).run(channelId, userId).changes > 0;
}
export function listBroadcasters(channelId: string) {
  return db
    .prepare(`SELECT u.id AS userId, u.nickname FROM channel_roles r JOIN users u ON u.id = r.user_id WHERE r.channel_id = ? AND r.role = 'broadcaster' ORDER BY r.granted_at`)
    .all(channelId) as { userId: string; nickname: string }[];
}
// ---- 매니저: 차단/차단 해제만 할 수 있는 채널별 역할 ----
export function isManager(channelId: string, userId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM channel_roles WHERE channel_id = ? AND user_id = ? AND role = 'manager'`).get(channelId, userId);
}
export function grantManager(channelId: string, userId: string) {
  db.prepare(`INSERT OR IGNORE INTO channel_roles (channel_id, user_id, role, granted_at) VALUES (?, ?, 'manager', ?)`).run(channelId, userId, Date.now());
}
export function revokeManager(channelId: string, userId: string): boolean {
  return db.prepare(`DELETE FROM channel_roles WHERE channel_id = ? AND user_id = ? AND role = 'manager'`).run(channelId, userId).changes > 0;
}
export function listManagers(channelId: string) {
  return db
    .prepare(`SELECT u.id AS userId, u.nickname FROM channel_roles r JOIN users u ON u.id = r.user_id WHERE r.channel_id = ? AND r.role = 'manager' ORDER BY r.granted_at`)
    .all(channelId) as { userId: string; nickname: string }[];
}
/** 차단/차단 해제 권한: 서버 관리자, 채널 개설자, 매니저 */
export function canBan(user: UserRow, channelId: string): boolean {
  return canModerate(user, channelId) || isManager(channelId, user.id);
}
/**
 * 누가 누구를 차단할 수 있는가 (위계: 서버 관리자 > 채널 관리자 > 매니저 > 그 외)
 *  - 서버 관리자는 차단할 수 없다 (다른 서버 관리자 포함: 관리자는 차단 검사를 받지 않는다)
 *  - 서버 관리자: 그 외 모든 계정
 *  - 채널 관리자: 자기 채널의 매니저·일반 사용자
 *  - 매니저: 일반 사용자와 방송 권한 보유자만 (서버/채널 관리자, 다른 매니저는 불가)
 * 거부 사유(한국어)를 돌려주고, 가능하면 null.
 */
export function banDenied(actor: UserRow, target: UserRow, channelId: string): string | null {
  if (target.id === actor.id) return '자기 자신은 차단할 수 없습니다.';
  if (target.is_admin === 1) return '서버 관리자는 차단할 수 없습니다.';
  if (actor.is_admin === 1) return null;
  if (isOwner(channelId, target.id)) return '채널 관리자는 차단할 수 없습니다.';
  if (isOwner(channelId, actor.id)) return null;
  if (isManager(channelId, actor.id)) return isManager(channelId, target.id) ? '매니저는 다른 매니저를 차단할 수 없습니다.' : null;
  return '차단 권한이 없습니다.';
}
export function roleOf(user: UserRow, channelId: string): 'owner' | 'admin' | 'manager' | 'broadcaster' | 'member' {
  if (isOwner(channelId, user.id)) return 'owner';
  if (user.is_admin === 1) return 'admin';
  if (isManager(channelId, user.id)) return 'manager';
  return isBroadcaster(channelId, user.id) ? 'broadcaster' : 'member';
}

// ---------- 채널 방문 기록 / 알림 ----------
export function recordVisit(userId: string, channelId: string, anonymous: boolean, alias: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO channel_visits (user_id, channel_id, first_at, last_at, anonymous, alias) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_at = excluded.last_at, anonymous = excluded.anonymous, alias = excluded.alias`,
  ).run(userId, channelId, now, now, anonymous ? 1 : 0, alias);
}
export function visitorIds(channelId: string): string[] {
  return (db.prepare('SELECT user_id FROM channel_visits WHERE channel_id = ?').all(channelId) as { user_id: string }[]).map((r) => r.user_id);
}
/** 접속 중이 아닌 사용자의 표시 이름: 마지막 입장이 익명이면 별칭 */
export function lastDisplayName(channelId: string, userId: string): string {
  const v = db.prepare('SELECT anonymous, alias FROM channel_visits WHERE user_id = ? AND channel_id = ?').get(userId, channelId) as { anonymous: number; alias: string | null } | undefined;
  if (v?.anonymous && v.alias) return v.alias;
  return getUser(userId)?.nickname ?? '알 수 없음';
}

export interface NotificationDTO { id: number; kind: string; channelId: string | null; data: Record<string, unknown>; createdAt: number; read: boolean }
type NotifRow = { id: number; kind: string; channel_id: string | null; data: string; created_at: number; read_at: number | null };
const notifDTO = (r: NotifRow): NotificationDTO => ({ id: r.id, kind: r.kind, channelId: r.channel_id, data: JSON.parse(r.data) as Record<string, unknown>, createdAt: r.created_at, read: r.read_at !== null });
export function addNotification(userId: string, kind: string, channelId: string | null, data: Record<string, unknown>): NotificationDTO {
  const info = db.prepare('INSERT INTO notifications (user_id, kind, channel_id, data, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, kind, channelId, JSON.stringify(data), Date.now());
  // 사용자당 최근 50개만 보관
  db.prepare('DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50)').run(userId, userId);
  return notifDTO(db.prepare('SELECT id, kind, channel_id, data, created_at, read_at FROM notifications WHERE id = ?').get(Number(info.lastInsertRowid)) as NotifRow);
}
export function listNotifications(userId: string): NotificationDTO[] {
  return (db.prepare('SELECT id, kind, channel_id, data, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(userId) as NotifRow[]).map(notifDTO);
}
export function markNotificationsRead(userId: string) {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(Date.now(), userId);
}
export function clearNotifications(userId: string) {
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
}
/** 내가 관리하는 채널(서버 관리자는 전부, 개설자는 자기 채널)의 방송 권한 보유자 */
export function listManagedBroadcasters(user: UserRow) {
  const base = `SELECT r.channel_id AS channelId, c.name AS channelName, r.user_id AS userId
                FROM channel_roles r JOIN channels c ON c.id = r.channel_id WHERE r.role = 'broadcaster'`;
  return (user.is_admin === 1
    ? db.prepare(`${base} ORDER BY c.name, r.granted_at`).all()
    : db.prepare(`${base} AND r.channel_id IN (SELECT channel_id FROM channel_roles WHERE user_id = ? AND role = 'owner') ORDER BY c.name, r.granted_at`).all(user.id)) as { channelId: string; channelName: string; userId: string }[];
}

// ---------- 메시지 ----------
const MSG_SELECT = `SELECT m.id, m.channel_id, m.kind, m.body, m.created_at, m.deleted_at, m.user_id, m.client_id, m.alias, u.nickname, u.color
  FROM messages m LEFT JOIN users u ON u.id = m.user_id`;
type MsgRow = {
  id: number; channel_id: string; kind: 'user' | 'system'; body: string; created_at: number;
  deleted_at: number | null; user_id: string | null; client_id: string | null; alias: string | null; nickname: string | null; color: string | null;
};
function toDTO(r: MsgRow): MessageDTO {
  return {
    id: r.id,
    channelId: r.channel_id,
    kind: r.kind,
    userId: r.user_id,
    nickname: r.alias ?? r.nickname,
    color: r.alias ? ANON_COLOR : r.color,
    body: r.deleted_at ? '' : r.body,
    createdAt: r.created_at,
    deleted: !!r.deleted_at,
    clientId: r.client_id,
    anonymous: !!r.alias,
  };
}
export const ANON_COLOR = '#94a3b8';
export function insertMessage(channelId: string, userId: string | null, kind: 'user' | 'system', body: string, clientId?: string, alias?: string): MessageDTO {
  const info = db
    .prepare('INSERT INTO messages (channel_id, user_id, kind, body, client_id, alias, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(channelId, userId, kind, body, clientId ?? null, alias ?? null, Date.now());
  return getMessage(Number(info.lastInsertRowid))!;
}
export function getMessage(id: number): MessageDTO | undefined {
  const r = db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(id) as MsgRow | undefined;
  return r ? toDTO(r) : undefined;
}
export function findByClientId(userId: string, clientId: string): MessageDTO | undefined {
  const r = db.prepare(`${MSG_SELECT} WHERE m.user_id = ? AND m.client_id = ?`).get(userId, clientId) as MsgRow | undefined;
  return r ? toDTO(r) : undefined;
}
/** 가장 최근 메시지 limit개 (오름차순 반환) + 더 있는지 여부 */
export function latestMessages(channelId: string, limit: number) {
  const rows = db.prepare(`${MSG_SELECT} WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT ?`).all(channelId, limit + 1) as MsgRow[];
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse().map(toDTO), hasMore };
}
export function messagesBefore(channelId: string, beforeId: number, limit: number) {
  const rows = db.prepare(`${MSG_SELECT} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(channelId, beforeId, limit + 1) as MsgRow[];
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse().map(toDTO), hasMore };
}
/** afterId 이후 메시지 (재연결 동기화용). 한도를 넘으면 null 반환 */
export function messagesAfter(channelId: string, afterId: number, limit: number): MessageDTO[] | null {
  const rows = db.prepare(`${MSG_SELECT} WHERE m.channel_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`).all(channelId, afterId, limit + 1) as MsgRow[];
  if (rows.length > limit) return null;
  return rows.map(toDTO);
}
export function markDeleted(channelId: string, messageId: number): boolean {
  const r = db
    .prepare(`UPDATE messages SET deleted_at = ? WHERE id = ? AND channel_id = ? AND kind = 'user' AND deleted_at IS NULL`)
    .run(Date.now(), messageId, channelId);
  return r.changes > 0;
}

// ---------- 공지 ----------
export interface NoticeDTO { body: string; updatedAt: number; authorNickname: string | null }
export function getNotice(channelId: string): NoticeDTO | null {
  const r = db
    .prepare(`SELECT n.body, n.updated_at, u.nickname FROM notices n LEFT JOIN users u ON u.id = n.created_by WHERE n.channel_id = ?`)
    .get(channelId) as { body: string; updated_at: number; nickname: string | null } | undefined;
  return r ? { body: r.body, updatedAt: r.updated_at, authorNickname: r.nickname } : null;
}
export function setNotice(channelId: string, body: string, userId: string) {
  db.prepare(
    `INSERT INTO notices (channel_id, body, created_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET body = excluded.body, created_by = excluded.created_by, updated_at = excluded.updated_at`,
  ).run(channelId, body, userId, Date.now());
}
export function clearNotice(channelId: string) {
  db.prepare('DELETE FROM notices WHERE channel_id = ?').run(channelId);
}

// ---------- 이용 제한 ----------
export function getActiveBan(channelId: string, userId: string, ipHash?: string | null): BanRow | undefined {
  const now = Date.now();
  const byIp = config.banByIp && ipHash;
  return db
    .prepare(
      `SELECT * FROM bans WHERE channel_id = ? AND (expires_at IS NULL OR expires_at > ?)
         AND (user_id = ? ${byIp ? 'OR ip_hash = ?' : ''}) LIMIT 1`,
    )
    .get(...(byIp ? [channelId, now, userId, ipHash] : [channelId, now, userId])) as BanRow | undefined;
}
export function addBan(channelId: string, target: UserRow, bannedBy: string, reason: string, expiresAt: number | null, displayName?: string) {
  db.prepare(
    `INSERT INTO bans (channel_id, user_id, nickname, ip_hash, reason, banned_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, user_id) DO UPDATE SET nickname = excluded.nickname, ip_hash = excluded.ip_hash,
       reason = excluded.reason, banned_by = excluded.banned_by, created_at = excluded.created_at, expires_at = excluded.expires_at`,
  ).run(channelId, target.id, displayName ?? target.nickname, target.last_ip_hash, reason, bannedBy, Date.now(), expiresAt);
}
export function removeBan(channelId: string, userId: string): boolean {
  return db.prepare('DELETE FROM bans WHERE channel_id = ? AND user_id = ?').run(channelId, userId).changes > 0;
}
export function listBans(channelId: string) {
  return (db.prepare(`SELECT user_id, nickname, reason, created_at, expires_at FROM bans
      WHERE channel_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC`).all(channelId, Date.now()) as {
    user_id: string; nickname: string; reason: string; created_at: number; expires_at: number | null;
  }[]).map((b) => ({ userId: b.user_id, nickname: b.nickname, reason: b.reason, createdAt: b.created_at, expiresAt: b.expires_at }));
}

// ---------- 방송 권한 요청 ----------
export interface RequestDTO { id: number; channelId: string; channelName: string; userId: string; displayName: string; anonymous: boolean; createdAt: number }
type ReqRow = { id: number; channel_id: string; channel_name: string; user_id: string; display_name: string; anonymous: number; status: string; created_at: number };
const REQ_SELECT = `SELECT r.id, r.channel_id, c.name AS channel_name, r.user_id, r.display_name, r.anonymous, r.status, r.created_at
  FROM broadcast_requests r JOIN channels c ON c.id = r.channel_id`;
const reqDTO = (r: ReqRow): RequestDTO => ({ id: r.id, channelId: r.channel_id, channelName: r.channel_name, userId: r.user_id, displayName: r.display_name, anonymous: !!r.anonymous, createdAt: r.created_at });
export function getPendingRequest(channelId: string, userId: string): RequestDTO | undefined {
  const r = db.prepare(`${REQ_SELECT} WHERE r.channel_id = ? AND r.user_id = ? AND r.status = 'pending'`).get(channelId, userId) as ReqRow | undefined;
  return r && reqDTO(r);
}
export function createRequest(channelId: string, userId: string, displayName: string, anonymous: boolean): RequestDTO {
  const info = db.prepare(`INSERT INTO broadcast_requests (channel_id, user_id, display_name, anonymous, created_at) VALUES (?, ?, ?, ?, ?)`).run(channelId, userId, displayName, anonymous ? 1 : 0, Date.now());
  return reqDTO(db.prepare(`${REQ_SELECT} WHERE r.id = ?`).get(Number(info.lastInsertRowid)) as ReqRow);
}
export function getRequest(id: number): (RequestDTO & { status: string }) | undefined {
  const r = db.prepare(`${REQ_SELECT} WHERE r.id = ?`).get(id) as ReqRow | undefined;
  return r && { ...reqDTO(r), status: r.status };
}
/** 검토 권한이 있는 요청 목록: 서버 관리자는 전부, 채널 개설자는 자기 채널의 요청 (최신순) */
export function listRequestsFor(user: UserRow): RequestDTO[] {
  const rows = user.is_admin === 1
    ? (db.prepare(`${REQ_SELECT} WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT 100`).all() as ReqRow[])
    : (db.prepare(`${REQ_SELECT} WHERE r.status = 'pending' AND r.channel_id IN (SELECT channel_id FROM channel_roles WHERE user_id = ? AND role = 'owner') ORDER BY r.created_at DESC LIMIT 100`).all(user.id) as ReqRow[]);
  return rows.map(reqDTO);
}
export function resolveRequest(id: number, status: 'granted' | 'dismissed', by: string): boolean {
  return db.prepare(`UPDATE broadcast_requests SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending'`).run(status, Date.now(), by, id).changes > 0;
}
/** 권한을 부여/회수하면 그 사용자의 대기 중 요청을 함께 정리하고 정리된 ID 를 돌려준다 */
export function resolvePendingFor(channelId: string, userId: string, status: 'granted' | 'dismissed', by: string): number[] {
  const ids = (db.prepare(`SELECT id FROM broadcast_requests WHERE channel_id = ? AND user_id = ? AND status = 'pending'`).all(channelId, userId) as { id: number }[]).map((x) => x.id);
  for (const id of ids) resolveRequest(id, status, by);
  return ids;
}
export function ownsAnyChannel(userId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM channel_roles WHERE user_id = ? AND role = 'owner' LIMIT 1`).get(userId);
}
