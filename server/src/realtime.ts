import type { Server, Socket } from 'socket.io';
import type { ZodTypeAny, z } from 'zod';
import { config } from './config.js';
import { AppError, toPayload, type ErrorPayload } from './errors.js';
import { log } from './log.js';
import * as repo from './repo.js';
import { authenticateToken, isOriginAllowed, tokenFromCookieHeader } from './auth.js';
import { TokenBucket } from './rateLimit.js';
import { parse, schemas, validateMessageBody, cleanText } from './validation.js';

type Ack<T = unknown> = (res: ({ ok: true } & T) | { ok: false; error: ErrorPayload }) => void;

interface SocketData {
  userId: string;
  tokenHash: string;
  ipHash: string;
  channelId: string | null;
}
type S = Socket<any, any, any, SocketData>;

interface Broadcast {
  channelId: string;
  socketId: string;
  userId: string;
  nickname: string;
  startedAt: number;
  hasAudio: boolean;
  viewers: Map<string, { userId: string; nickname: string }>;
}

let io: Server;
const LOBBY = 'lobby';
const room = (id: string) => `ch:${id}`;

/** channelId -> userId -> socketId 집합 (여러 탭은 한 명으로 계산) */
const presence = new Map<string, Map<string, Set<string>>>();
const broadcasts = new Map<string, Broadcast>();
const pendingLeave = new Map<string, NodeJS.Timeout>();
const lastSent = new Map<string, { body: string; at: number }>();

/** 채널별 표시 신원: 익명으로 입장하면 그 채널에서는 별칭(익명1234)으로만 보인다 */
const identities = new Map<string, { anonymous: boolean; alias: string }>();
const idKey = (channelId: string, userId: string) => `${channelId}:${userId}`;
function makeAlias(channelId: string, userId: string): string {
  // 같은 사용자는 같은 채널에서 항상 같은 별칭 (강퇴·대화 맥락 유지). 접속 중인 다른 사람과 겹치면 번호를 올린다.
  let n = Number.parseInt(repo.hashIp(`${channelId}:${userId}`).slice(0, 8), 16) % 10000;
  for (let i = 0; i < 10000; i++, n = (n + 1) % 10000) {
    const alias = `익명${String(n).padStart(4, '0')}`;
    const clash = [...identities].some(([k, v]) => k.startsWith(`${channelId}:`) && !k.endsWith(`:${userId}`) && v.anonymous && v.alias === alias);
    if (!clash) return alias;
  }
  return `익명${userId.slice(0, 4)}`;
}
export function displayName(channelId: string, user: repo.UserRow): string {
  const i = identities.get(idKey(channelId, user.id));
  return i?.anonymous ? i.alias : user.nickname;
}
/** 사용자 ID 로 표시 이름 조회: 접속 중이면 현재 신원, 아니면 마지막 입장 방식(익명이면 별칭) */
function nameIn(channelId: string, userId: string): string {
  const i = identities.get(idKey(channelId, userId));
  return i ? (i.anonymous ? i.alias : (repo.getUser(userId)?.nickname ?? '알 수 없음')) : repo.lastDisplayName(channelId, userId);
}
const withNames = (channelId: string, rows: { userId: string }[]) => rows.map((r) => ({ userId: r.userId, nickname: nameIn(channelId, r.userId) }));

/** 알림을 저장하고 접속 중인 그 사용자의 모든 탭에 실시간으로 보낸다 */
function pushNotification(userId: string, kind: string, channelId: string | null, data: Record<string, unknown>) {
  const n = repo.addNotification(userId, kind, channelId, data);
  for (const s of io.sockets.sockets.values()) if ((s as S).data.userId === userId) s.emit('notification:new', { notification: n });
}
const channelNameOf = (channelId: string) => repo.getChannel(channelId)?.name ?? '';

const isAnon = (channelId: string, userId: string) => !!identities.get(idKey(channelId, userId))?.anonymous;

/** 방송 요청을 검토할 수 있는 접속자(그 채널의 개설자, 서버 관리자)에게만 이벤트를 보낸다 */
function emitToReviewers(channelId: string, event: string, payload: unknown) {
  for (const s of io.sockets.sockets.values()) {
    const u = repo.getUser((s as S).data.userId);
    if (u && repo.canModerate(u, channelId)) s.emit(event, payload);
  }
}

const eventBucket = new TokenBucket(config.rate.socketEventsPer10s, 10_000 / config.rate.socketEventsPer10s);
const msgBucket = new TokenBucket(config.rate.msgBurst, config.rate.msgRefillMs);
const lastMsgAt = new Map<string, number>();

// ---------- 공개 조회 ----------
export function onlineCount(channelId: string): number {
  return presence.get(channelId)?.size ?? 0;
}
export function isLive(channelId: string): boolean {
  return broadcasts.has(channelId);
}
export function liveInfo(channelId: string) {
  const b = broadcasts.get(channelId);
  return b ? { live: true as const, broadcaster: b.nickname, broadcasterId: b.userId, startedAt: b.startedAt, hasAudio: b.hasAudio, viewerCount: b.viewers.size } : { live: false as const };
}
export function totalOnlineUsers(): number {
  const s = new Set<string>();
  for (const m of presence.values()) for (const u of m.keys()) s.add(u);
  return s.size;
}

// ---------- 유틸 ----------
function socketsInRoom(channelId: string): S[] {
  const ids = io.sockets.adapter.rooms.get(room(channelId));
  return [...(ids ?? [])].map((id) => io.sockets.sockets.get(id) as S | undefined).filter((s): s is S => !!s);
}
function participantsOf(channelId: string, viewerIsModerator = false) {
  const m = presence.get(channelId);
  if (!m) return [];
  const ownerId = repo.getOwnerId(channelId);
  const b = broadcasts.get(channelId);
  const out = [];
  for (const userId of m.keys()) {
    const u = repo.getUser(userId);
    if (!u) continue;
    out.push({
      id: u.id,
      nickname: displayName(channelId, u),
      color: isAnon(channelId, u.id) ? repo.ANON_COLOR : u.color,
      // '방송 권한 보유자' 정보는 채널 관리자(개설자·서버 관리자)에게만 내려간다 (일반 사용자에게는 일반 참여자로 보임)
      role: u.id === ownerId ? 'owner' : u.is_admin ? 'admin' : repo.isManager(channelId, u.id) ? 'manager' : viewerIsModerator && repo.isBroadcaster(channelId, u.id) ? 'broadcaster' : 'member',
      broadcasting: b?.userId === u.id,
    });
  }
  const rank = { owner: 0, admin: 1, manager: 2, broadcaster: 3, member: 4 } as const;
  return out.sort((a, b2) => rank[a.role as keyof typeof rank] - rank[b2.role as keyof typeof rank] || a.nickname.localeCompare(b2.nickname, 'ko'));
}

const dirty = new Set<string>();
let flushTimer: NodeJS.Timeout | undefined;
function scheduleFlush(channelId: string) {
  dirty.add(channelId);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    const ids = [...dirty];
    dirty.clear();
    const stats = ids.map((id) => ({ id, onlineCount: onlineCount(id), ...liveInfo(id) }));
    io.to(LOBBY).emit('channels:stats', { stats });
    // 받는 사람마다 볼 수 있는 정보가 다르므로(방송 권한 표시) 소켓별로 보낸다
    for (const id of ids) {
      const plain = participantsOf(id, false);
      const full = participantsOf(id, true);
      for (const sk of socketsInRoom(id)) {
        const viewer = repo.getUser(sk.data.userId);
        const mod = !!viewer && repo.canModerate(viewer, id);
        sk.emit('presence:update', { channelId: id, participants: mod ? full : plain });
      }
    }
  }, 150);
}

function postSystem(channelId: string, body: string) {
  if (!repo.getChannel(channelId)) return;
  const msg = repo.insertMessage(channelId, null, 'system', body);
  io.to(room(channelId)).emit('message:new', msg);
}

function requireUser(socket: S): repo.UserRow {
  const user = repo.getUser(socket.data.userId);
  if (!user) {
    socket.disconnect(true);
    throw new AppError('AUTH_REQUIRED', '세션이 만료되었습니다. 다시 입장해 주세요.', 401);
  }
  return user;
}
function requireJoined(socket: S, channelId: string) {
  if (socket.data.channelId !== channelId) {
    throw new AppError('NOT_JOINED', '먼저 채널에 입장해야 합니다.', 400);
  }
}
function requireBanPower(user: repo.UserRow, channelId: string) {
  if (!repo.canBan(user, channelId)) throw new AppError('FORBIDDEN', '차단 권한이 없습니다. (채널 관리자, 매니저, 서버 관리자만 가능)', 403);
}
function requireModerator(user: repo.UserRow, channelId: string) {
  if (!repo.canModerate(user, channelId)) {
    throw new AppError('FORBIDDEN', '이 작업은 채널 관리자만 할 수 있습니다.', 403);
  }
}
function fmtDuration(min: number): string {
  if (min % (60 * 24) === 0) return `${min / (60 * 24)}일`;
  if (min % 60 === 0) return `${min / 60}시간`;
  return `${min}분`;
}

// ---------- 입장 / 퇴장 ----------
function joinChannel(socket: S, user: repo.UserRow, channelId: string) {
  if (socket.data.channelId && socket.data.channelId !== channelId) leaveChannel(socket, true);
  const key = `${channelId}:${user.id}`;
  const m = presence.get(channelId) ?? new Map<string, Set<string>>();
  presence.set(channelId, m);
  const set = m.get(user.id) ?? new Set<string>();
  const first = set.size === 0;
  set.add(socket.id);
  m.set(user.id, set);
  socket.data.channelId = channelId;
  socket.join(room(channelId));
  if (first) {
    const t = pendingLeave.get(key);
    if (t) {
      // 새로고침·재연결로 곧바로 돌아온 경우 퇴장/입장 메시지를 생략
      clearTimeout(t);
      pendingLeave.delete(key);
    } else {
      postSystem(channelId, `${displayName(channelId, user)}님이 입장했습니다.`);
    }
  }
  scheduleFlush(channelId);
}

function leaveChannel(socket: S, immediate: boolean) {
  const channelId = socket.data.channelId;
  if (!channelId) return;
  socket.data.channelId = null;
  socket.leave(room(channelId));
  // 방송자가 채널을 떠나도 방송은 유지된다(종료는 방송 종료 요청·연결 끊김·권한 회수·강퇴·채널 삭제뿐). 시청자만 정리한다.
  const b = broadcasts.get(channelId);
  if (b && b.viewers.delete(socket.id)) {
    io.to(b.socketId).emit('broadcast:viewer-left', { viewerId: socket.id });
    scheduleFlush(channelId);
  }
  const m = presence.get(channelId);
  const set = m?.get(socket.data.userId);
  if (!m || !set) return;
  set.delete(socket.id);
  if (set.size > 0) return;
  m.delete(socket.data.userId);
  if (m.size === 0) presence.delete(channelId);
  scheduleFlush(channelId);
  const user = repo.getUser(socket.data.userId);
  if (!user) return;
  const key = `${channelId}:${user.id}`;
  const leaveName = displayName(channelId, user); // 나간 뒤 다른 방식으로 다시 들어와도 나갈 때의 이름으로 알린다
  const announce = () => {
    pendingLeave.delete(key);
    if (!presence.get(channelId)?.has(user.id)) postSystem(channelId, `${leaveName}님이 퇴장했습니다.`);
  };
  if (immediate || config.leaveGraceMs === 0) announce();
  else {
    const old = pendingLeave.get(key);
    if (old) clearTimeout(old);
    pendingLeave.set(key, setTimeout(announce, config.leaveGraceMs));
  }
}

type EndReason = 'stopped' | 'disconnected' | 'channel-deleted' | 'revoked' | 'kicked';
const END_TEXT: Record<Exclude<EndReason, 'channel-deleted'>, (n: string) => string> = {
  stopped: (n) => `${n}님이 방송을 종료했습니다.`,
  disconnected: (n) => `${n}님의 방송 연결이 끊겨 방송이 종료되었습니다.`,
  revoked: (n) => `${n}님의 방송 권한이 회수되어 방송이 종료되었습니다.`,
  kicked: (n) => `${n}님이 강퇴되어 방송이 종료되었습니다.`,
};

export function endBroadcast(channelId: string, reason: EndReason) {
  const b = broadcasts.get(channelId);
  if (!b) return;
  broadcasts.delete(channelId);
  // 방송자는 다른 채널에 있을 수 있으므로 채널 룸과 방송자 소켓 양쪽에 알린다 (중복 수신 없음)
  io.to(room(channelId)).to(b.socketId).emit('broadcast:ended', { channelId, reason });
  if (reason !== 'channel-deleted') postSystem(channelId, END_TEXT[reason](b.nickname));
  scheduleFlush(channelId);
}

/** 채널 삭제 시 실시간 자원 정리 */
export function destroyChannelRuntime(channelId: string) {
  const b = broadcasts.get(channelId);
  if (b) {
    broadcasts.delete(channelId);
    io.to(room(channelId)).to(b.socketId).emit('broadcast:ended', { channelId, reason: 'channel-deleted' });
  }
  io.to(room(channelId)).emit('channel:deleted', { channelId });
  for (const s of socketsInRoom(channelId)) {
    s.data.channelId = null;
    s.leave(room(channelId));
  }
  presence.delete(channelId);
  io.to(LOBBY).emit('channels:changed', {});
}
export function notifyChannelsChanged() {
  io.to(LOBBY).emit('channels:changed', {});
}
export function disconnectSession(tokenHash: string) {
  for (const s of io.sockets.sockets.values()) {
    if ((s as S).data.tokenHash === tokenHash) {
      s.emit('session:ended', {});
      s.disconnect(true);
    }
  }
}
export function refreshUser(userId: string) {
  for (const [channelId, m] of presence) if (m.has(userId)) scheduleFlush(channelId);
}

// ---------- 핸들러 래퍼 ----------
function handle<T extends ZodTypeAny>(socket: S, event: string, schema: T, fn: (data: z.infer<T>, user: repo.UserRow) => unknown | Promise<unknown>) {
  socket.on(event, async (raw: unknown, ack?: Ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const wait = eventBucket.take(socket.id);
      if (wait > 0) throw new AppError('RATE_LIMITED', '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', 429, { retryAfterMs: wait });
      const data = parse(schema, raw);
      const user = requireUser(socket);
      const result = await fn(data, user);
      reply({ ok: true, ...((result as object) ?? {}) });
    } catch (e) {
      if (!(e instanceof AppError)) log.error(`소켓 이벤트 ${event} 처리 중 오류:`, (e as Error).stack ?? e);
      reply({ ok: false, error: toPayload(e) });
    }
  });
}

// ---------- 초기화 ----------
export function initRealtime(server: Server) {
  io = server;

  io.use((socket, next) => {
    const auth = authenticateToken(tokenFromCookieHeader(socket.handshake.headers.cookie));
    if (!auth) {
      const err = new Error('AUTH_REQUIRED') as Error & { data?: unknown };
      err.data = { code: 'AUTH_REQUIRED', message: '로그인이 필요합니다.' };
      return next(err);
    }
    const ipHash = repo.hashIp(socket.handshake.address);
    repo.setUserIp(auth.user.id, ipHash);
    (socket as S).data = { userId: auth.user.id, tokenHash: auth.tokenHash, ipHash, channelId: null };
    next();
  });

  io.on('connection', (raw) => {
    const socket = raw as S;
    socket.join(LOBBY);

    // 채널 입장 (재연결 시 lastId 로 누락 메시지 동기화)
    handle(socket, 'channel:join', schemas.join, (d, user) => {
      const ch = repo.getChannel(d.channelId);
      if (!ch) throw new AppError('CHANNEL_NOT_FOUND', '존재하지 않는 채널입니다.', 404);
      const mod = repo.canModerate(user, ch.id);
      if (user.is_admin !== 1) { // 서버 관리자만 이용 제한을 받지 않는다 (개설자도 서버 관리자에게 차단될 수 있다)
        const ban = repo.getActiveBan(ch.id, user.id, socket.data.ipHash);
        if (ban) {
          const until = ban.expires_at ? `${new Date(ban.expires_at).toLocaleString('ko-KR')}까지` : '기한 없이';
          throw new AppError('BANNED', `이 채널에서 이용이 제한되었습니다. (${until})${ban.reason ? ` 사유: ${ban.reason}` : ''}`, 403);
        }
      }
      // 이 입장에서 사용할 신원(내 닉네임 / 익명 별칭). 같은 사용자의 다른 탭도 같은 신원을 쓴다.
      // 채널을 개설한 관리자는 익명으로 입장할 수 없다 (항상 본인 닉네임)
      const anonymous = !!d.anonymous && !repo.isOwner(ch.id, user.id);
      const alias = makeAlias(ch.id, user.id);
      identities.set(idKey(ch.id, user.id), { anonymous, alias });
      repo.recordVisit(user.id, ch.id, anonymous, alias); // 이 채널의 방송 시작 알림을 받기 위한 방문 기록
      joinChannel(socket, user, ch.id);
      let messages: repo.MessageDTO[];
      let hasMore = false;
      let reset = true;
      const synced = d.lastId ? repo.messagesAfter(ch.id, d.lastId, config.limits.syncMax) : null;
      if (synced) {
        messages = synced;
        reset = false;
      } else {
        ({ messages, hasMore } = repo.latestMessages(ch.id, config.limits.historyPage));
      }
      return {
        channel: channelDTO(ch),
        me: { role: repo.roleOf(user, ch.id), canModerate: mod, canBroadcast: repo.canBroadcast(user, ch.id), canBan: repo.canBan(user, ch.id) },
        messages,
        hasMore,
        reset,
        notice: repo.getNotice(ch.id),
        participants: participantsOf(ch.id, mod),
        broadcast: broadcastSummary(ch.id, socket),
      };
    });

    handle(socket, 'channel:leave', schemas.channelId, (d) => {
      if (socket.data.channelId === d.channelId) leaveChannel(socket, true);
    });

    // 메시지 전송
    handle(socket, 'message:send', schemas.send, (d, user) => {
      requireJoined(socket, d.channelId);
      if (user.is_admin !== 1 && repo.getActiveBan(d.channelId, user.id, socket.data.ipHash)) {
        throw new AppError('BANNED', '이 채널에서 이용이 제한되었습니다.', 403);
      }
      // 재전송(같은 clientId)은 이미 저장된 메시지를 그대로 돌려줘 중복 저장을 막는다
      const existing = repo.findByClientId(user.id, d.clientId);
      if (existing) return { message: existing, duplicate: true };
      const body = validateMessageBody(d.body);

      const now = Date.now();
      const gap = now - (lastMsgAt.get(user.id) ?? 0);
      if (gap < config.rate.msgMinGapMs) {
        throw new AppError('RATE_LIMITED', '메시지를 너무 빠르게 보내고 있습니다. 잠시 후 다시 시도해 주세요.', 429, { retryAfterMs: config.rate.msgMinGapMs - gap });
      }
      const wait = msgBucket.take(user.id);
      if (wait > 0) {
        throw new AppError('RATE_LIMITED', `메시지를 너무 자주 보내고 있습니다. ${Math.ceil(wait / 1000)}초 후 다시 시도해 주세요.`, 429, { retryAfterMs: wait });
      }
      const dupKey = `${d.channelId}:${user.id}`;
      const last = lastSent.get(dupKey);
      if (last && last.body === body && now - last.at < config.rate.duplicateWindowMs) {
        throw new AppError('DUPLICATE_MESSAGE', '같은 내용을 연달아 보낼 수 없습니다.', 429);
      }
      lastMsgAt.set(user.id, now);
      lastSent.set(dupKey, { body, at: now });
      const anon = identities.get(idKey(d.channelId, user.id));
      const message = repo.insertMessage(d.channelId, user.id, 'user', body, d.clientId, anon?.anonymous ? anon.alias : undefined);
      io.to(room(d.channelId)).emit('message:new', message);
      return { message };
    });

    // ---- 관리 기능 (모두 서버에서 권한 검증) ----
    handle(socket, 'message:delete', schemas.del, (d, user) => {
      requireModerator(user, d.channelId);
      if (!repo.markDeleted(d.channelId, d.messageId)) throw new AppError('MESSAGE_NOT_FOUND', '삭제할 메시지를 찾을 수 없습니다.', 404);
      io.to(room(d.channelId)).emit('message:deleted', { channelId: d.channelId, messageId: d.messageId });
    });

    handle(socket, 'notice:set', schemas.notice, (d, user) => {
      requireModerator(user, d.channelId);
      if (!repo.getChannel(d.channelId)) throw new AppError('CHANNEL_NOT_FOUND', '존재하지 않는 채널입니다.', 404);
      const body = validateMessageBody(d.body, config.limits.noticeMax);
      repo.setNotice(d.channelId, body, user.id);
      const notice = repo.getNotice(d.channelId);
      io.to(room(d.channelId)).emit('notice:update', { channelId: d.channelId, notice });
      return { notice };
    });
    handle(socket, 'notice:clear', schemas.channelId, (d, user) => {
      requireModerator(user, d.channelId);
      repo.clearNotice(d.channelId);
      io.to(room(d.channelId)).emit('notice:update', { channelId: d.channelId, notice: null });
    });

    handle(socket, 'user:kick', schemas.kick, (d, user) => {
      requireBanPower(user, d.channelId);
      const target = repo.getUser(d.userId);
      if (!target) throw new AppError('USER_NOT_FOUND', '대상 사용자를 찾을 수 없습니다.', 404);
      const denied = repo.banDenied(user, target, d.channelId); // 서버 관리자 > 채널 관리자 > 매니저 위계
      if (denied) throw new AppError('INVALID_TARGET', denied, 403);
      const reason = cleanText(d.reason ?? '').trim();
      const expiresAt = d.minutes ? Date.now() + d.minutes * 60_000 : null;
      const targetName = displayName(d.channelId, target);
      repo.addBan(d.channelId, target, user.id, reason, expiresAt, targetName);
      for (const s of socketsInRoom(d.channelId)) {
        if (s.data.userId !== target.id) continue;
        s.emit('channel:kicked', { channelId: d.channelId, reason, expiresAt });
        leaveChannel(s, true);
      }
      if (broadcasts.get(d.channelId)?.userId === target.id) endBroadcast(d.channelId, 'kicked');
      repo.revokeBroadcaster(d.channelId, target.id);
      repo.revokeManager(d.channelId, target.id);
      const span = d.minutes ? `${fmtDuration(d.minutes)} 동안 ` : '';
      postSystem(d.channelId, `${targetName}님이 ${span}이용 제한과 함께 강퇴되었습니다.`);
      return { bans: repo.listBans(d.channelId) };
    });
    // ---- 방송 권한 (채널 관리자만) ----
    const notifyRole = (channelId: string, userId: string) => {
      const target = repo.getUser(userId);
      if (!target) return;
      for (const s of socketsInRoom(channelId)) {
        if (s.data.userId === userId) s.emit('role:update', { channelId, role: repo.roleOf(target, channelId), canBroadcast: repo.canBroadcast(target, channelId), canBan: repo.canBan(target, channelId) });
      }
      scheduleFlush(channelId);
    };
    handle(socket, 'broadcaster:grant', schemas.target, (d, user) => {
      requireModerator(user, d.channelId);
      const target = repo.getUser(d.userId);
      if (!target) throw new AppError('USER_NOT_FOUND', '대상 사용자를 찾을 수 없습니다.', 404);
      if (repo.canModerate(target, d.channelId)) throw new AppError('INVALID_TARGET', '채널 관리자는 이미 방송할 수 있습니다.', 400);
      if (repo.isBroadcaster(d.channelId, target.id)) throw new AppError('ALREADY_GRANTED', '이미 방송 권한이 있습니다.', 409);
      repo.grantBroadcaster(d.channelId, target.id);
      for (const id of repo.resolvePendingFor(d.channelId, target.id, 'granted', user.id)) emitToReviewers(d.channelId, 'request:resolved', { id });
      pushNotification(target.id, 'broadcaster_granted', d.channelId, { channelName: channelNameOf(d.channelId) });
      notifyRole(d.channelId, target.id);
      return { broadcasters: withNames(d.channelId, repo.listBroadcasters(d.channelId)) };
    });
    handle(socket, 'broadcaster:revoke', schemas.target, (d, user) => {
      requireModerator(user, d.channelId);
      const target = repo.getUser(d.userId);
      if (!target) throw new AppError('USER_NOT_FOUND', '대상 사용자를 찾을 수 없습니다.', 404);
      if (!repo.revokeBroadcaster(d.channelId, target.id)) throw new AppError('NOT_GRANTED', '방송 권한이 없는 사용자입니다.', 400);
      // 방송 중이면 권한 회수와 함께 방송을 종료한다 (관리자의 명시적 조치)
      if (broadcasts.get(d.channelId)?.userId === target.id) endBroadcast(d.channelId, 'revoked');
      pushNotification(target.id, 'broadcaster_revoked', d.channelId, { channelName: channelNameOf(d.channelId) });
      notifyRole(d.channelId, target.id);
      return { broadcasters: withNames(d.channelId, repo.listBroadcasters(d.channelId)) };
    });
    // ---- 방송 권한 요청 (일반 사용자 → 채널 관리자/서버 관리자) ----
    handle(socket, 'broadcast:request', schemas.channelId, (d, user) => {
      requireJoined(socket, d.channelId);
      if (repo.canBroadcast(user, d.channelId)) throw new AppError('ALREADY_GRANTED', '이미 이 채널에서 방송할 수 있습니다.', 409);
      if (repo.getPendingRequest(d.channelId, user.id)) {
        throw new AppError('ALREADY_REQUESTED', '이미 방송 요청을 보냈습니다. 관리자가 확인할 때까지 기다려 주세요.', 409);
      }
      const req = repo.createRequest(d.channelId, user.id, displayName(d.channelId, user), isAnon(d.channelId, user.id));
      emitToReviewers(d.channelId, 'request:new', { request: req });
    });
    handle(socket, 'request:list', schemas.none, (_d, user) => ({ requests: repo.listRequestsFor(user) }));
    handle(socket, 'request:dismiss', schemas.dismiss, (d, user) => {
      const req = repo.getRequest(d.requestId);
      if (!req || req.status !== 'pending') throw new AppError('REQUEST_NOT_FOUND', '이미 처리되었거나 없는 요청입니다.', 404);
      requireModerator(user, req.channelId);
      repo.resolveRequest(req.id, 'dismissed', user.id);
      emitToReviewers(req.channelId, 'request:resolved', { id: req.id });
      pushNotification(req.userId, 'request_declined', req.channelId, { channelName: req.channelName });
    });
    // ---- 매니저 (차단/차단 해제만 가능한 채널별 역할, 임명은 채널 관리자·서버 관리자) ----
    handle(socket, 'manager:appoint', schemas.target, (d, user) => {
      requireModerator(user, d.channelId);
      const target = repo.getUser(d.userId);
      if (!target) throw new AppError('USER_NOT_FOUND', '대상 사용자를 찾을 수 없습니다.', 404);
      if (repo.canModerate(target, d.channelId)) throw new AppError('INVALID_TARGET', '채널 관리자·서버 관리자는 매니저로 임명할 수 없습니다.', 400);
      if (repo.isManager(d.channelId, target.id)) throw new AppError('ALREADY_MANAGER', '이미 매니저입니다.', 409);
      repo.grantManager(d.channelId, target.id);
      pushNotification(target.id, 'manager_appointed', d.channelId, { channelName: channelNameOf(d.channelId) });
      notifyRole(d.channelId, target.id);
      return { managers: withNames(d.channelId, repo.listManagers(d.channelId)) };
    });
    handle(socket, 'manager:revoke', schemas.target, (d, user) => {
      requireModerator(user, d.channelId);
      if (!repo.revokeManager(d.channelId, d.userId)) throw new AppError('NOT_MANAGER', '매니저가 아닌 사용자입니다.', 400);
      pushNotification(d.userId, 'manager_revoked', d.channelId, { channelName: channelNameOf(d.channelId) });
      notifyRole(d.channelId, d.userId);
      return { managers: withNames(d.channelId, repo.listManagers(d.channelId)) };
    });
    handle(socket, 'manager:list', schemas.channelId, (d, user) => {
      requireModerator(user, d.channelId);
      return { managers: withNames(d.channelId, repo.listManagers(d.channelId)) };
    });
    // 내가 관리하는 채널들의 방송 권한 보유자 (알림창의 "방송 권한 관리" 탭)
    handle(socket, 'broadcaster:overview', schemas.none, (_d, user) => ({
      broadcasters: repo.listManagedBroadcasters(user).map((r) => ({ ...r, displayName: nameIn(r.channelId, r.userId) })),
    }));
    // ---- 알림 ----
    handle(socket, 'notification:list', schemas.none, (_d, user) => ({ notifications: repo.listNotifications(user.id) }));
    handle(socket, 'notification:read', schemas.none, (_d, user) => { repo.markNotificationsRead(user.id); });
    handle(socket, 'notification:clear', schemas.none, (_d, user) => { repo.clearNotifications(user.id); });
    handle(socket, 'broadcaster:list', schemas.channelId, (d, user) => {
      requireModerator(user, d.channelId);
      return { broadcasters: withNames(d.channelId, repo.listBroadcasters(d.channelId)) };
    });
    handle(socket, 'user:unban', schemas.unban, (d, user) => {
      requireBanPower(user, d.channelId);
      repo.removeBan(d.channelId, d.userId);
      return { bans: repo.listBans(d.channelId) };
    });
    handle(socket, 'ban:list', schemas.channelId, (d, user) => {
      requireBanPower(user, d.channelId);
      return { bans: repo.listBans(d.channelId) };
    });

    // ---- 방송 ----
    handle(socket, 'broadcast:start', schemas.start, (d, user) => {
      requireJoined(socket, d.channelId);
      if (!repo.canBroadcast(user, d.channelId)) {
        throw new AppError('FORBIDDEN', '이 채널에서 방송할 권한이 없습니다. 채널 관리자에게 방송 권한을 요청하세요.', 403);
      }
      if (broadcasts.has(d.channelId)) throw new AppError('ALREADY_LIVE', '이미 이 채널에서 방송이 진행 중입니다.', 409);
      if ([...broadcasts.values()].some((x) => x.socketId === socket.id)) {
        throw new AppError('ALREADY_LIVE', '이미 다른 채널에서 방송 중입니다. 먼저 방송을 종료해 주세요.', 409);
      }
      const b: Broadcast = {
        channelId: d.channelId, socketId: socket.id, userId: user.id, nickname: displayName(d.channelId, user),
        startedAt: Date.now(), hasAudio: d.hasAudio, viewers: new Map(),
      };
      broadcasts.set(d.channelId, b);
      io.to(room(d.channelId)).emit('broadcast:started', { channelId: d.channelId, broadcaster: b.nickname, broadcasterId: b.userId, startedAt: b.startedAt, hasAudio: b.hasAudio });
      postSystem(d.channelId, `${b.nickname}님이 방송을 시작했습니다.`);
      // 이 채널에 입장해 본 적이 있는 모든 사용자에게 알림 (차단된 사용자 제외)
      const chName = channelNameOf(d.channelId);
      for (const uid of repo.visitorIds(d.channelId)) {
        if (uid === user.id || repo.getActiveBan(d.channelId, uid)) continue;
        pushNotification(uid, 'broadcast_started', d.channelId, { channelName: chName, broadcaster: b.nickname });
      }
      scheduleFlush(d.channelId);
    });
    // 방송 종료: 방송 중인 소켓 본인이거나 채널 관리자. 방송자는 다른 채널에 있어도 종료할 수 있다.
    handle(socket, 'broadcast:stop', schemas.channelId, (d, user) => {
      const b = broadcasts.get(d.channelId);
      if (!repo.canModerate(user, d.channelId) && b?.socketId !== socket.id) {
        throw new AppError('FORBIDDEN', '이 작업은 방송 중인 사용자 또는 채널 관리자만 할 수 있습니다.', 403);
      }
      if (!b) throw new AppError('NOT_LIVE', '진행 중인 방송이 없습니다.', 400);
      endBroadcast(d.channelId, 'stopped');
    });
    handle(socket, 'broadcast:watch', schemas.channelId, (d, user) => {
      requireJoined(socket, d.channelId);
      const b = broadcasts.get(d.channelId);
      if (!b) throw new AppError('NOT_LIVE', '진행 중인 방송이 없습니다.', 400);
      if (b.socketId === socket.id) throw new AppError('INVALID_TARGET', '방송 중인 화면에서는 시청할 수 없습니다.', 400);
      if (b.viewers.has(socket.id)) io.to(b.socketId).emit('broadcast:viewer-left', { viewerId: socket.id });
      else if (b.viewers.size >= config.maxViewers) {
        throw new AppError('VIEWER_LIMIT', `시청자 수 한도(${config.maxViewers}명)에 도달해 시청할 수 없습니다. 방송자의 PC 부하를 보호하기 위한 설정입니다.`, 409);
      }
      const vname = displayName(d.channelId, user);
      b.viewers.set(socket.id, { userId: user.id, nickname: vname });
      io.to(b.socketId).emit('broadcast:viewer-joined', { viewerId: socket.id, nickname: vname });
      scheduleFlush(d.channelId);
      return { broadcasterId: b.socketId, hasAudio: b.hasAudio };
    });
    handle(socket, 'broadcast:unwatch', schemas.channelId, (d) => {
      const b = broadcasts.get(d.channelId);
      if (b?.viewers.delete(socket.id)) {
        io.to(b.socketId).emit('broadcast:viewer-left', { viewerId: socket.id });
        scheduleFlush(d.channelId);
      }
    });
    // WebRTC 연결 협상 메시지 중계 (영상 자체는 서버를 거치지 않음)
    handle(socket, 'webrtc:signal', schemas.signal, (d) => {
      const b = broadcasts.get(d.channelId);
      if (!b) throw new AppError('NOT_LIVE', '진행 중인 방송이 없습니다.', 400);
      const fromBroadcaster = b.socketId === socket.id;
      const allowed = fromBroadcaster ? b.viewers.has(d.to) : b.viewers.has(socket.id) && d.to === b.socketId;
      if (!allowed) throw new AppError('FORBIDDEN', '허용되지 않은 시그널링 대상입니다.', 403);
      io.to(d.to).emit('webrtc:signal', { channelId: d.channelId, from: socket.id, data: d.data });
    });

    socket.on('disconnect', () => {
      // 방송자 소켓이 끊기면(탭 종료·네트워크 단절) 화면 캡처도 사라지므로 방송을 종료한다
      for (const b of [...broadcasts.values()]) if (b.socketId === socket.id) endBroadcast(b.channelId, 'disconnected');
      leaveChannel(socket, false);
      eventBucket.delete(socket.id);
    });
  });
}

function broadcastSummary(channelId: string, socket: S) {
  const b = broadcasts.get(channelId);
  if (!b) return { live: false };
  return { live: true, broadcaster: b.nickname, broadcasterId: b.userId, startedAt: b.startedAt, hasAudio: b.hasAudio, viewerCount: b.viewers.size, mine: b.socketId === socket.id };
}

export function channelDTO(ch: repo.ChannelRow & { owner_id: string | null; owner_nickname: string | null }) {
  return {
    id: ch.id,
    name: ch.name,
    description: ch.description,
    isDefault: !!ch.is_default,
    ownerId: ch.owner_id,
    ownerNickname: ch.owner_nickname,
    createdAt: ch.created_at,
    onlineCount: onlineCount(ch.id),
    ...liveInfo(ch.id),
  };
}

export { isOriginAllowed };
