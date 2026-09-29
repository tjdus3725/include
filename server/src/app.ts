import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { AppError, toPayload } from './errors.js';
import { log } from './log.js';
import * as repo from './repo.js';
import {
  attachAuth, clearSessionCookie, issueSession, originGuard, requireAuth, safeEqual, setSessionCookie,
} from './auth.js';
import { PROFILE_COLORS, parse, schemas, validateChannelDescription, validateChannelName, validateNickname } from './validation.js';
import { channelDTO, destroyChannelRuntime, disconnectSession, notifyChannelsChanged, refreshUser, totalOnlineUsers } from './realtime.js';

const userDTO = (u: repo.UserRow) => ({ id: u.id, nickname: u.nickname, color: u.color, isAdmin: !!u.is_admin, createdAt: u.created_at });

/** 기본 포트(http 80 / https 443)는 주소에서 생략해 사용자가 입력할 내용을 줄인다 */
function portSuffix(scheme: string, port: number): string {
  return (scheme === 'http' && port === 80) || (scheme === 'https' && port === 443) ? '' : `:${port}`;
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // 보안 헤더 (외부 CDN/폰트를 쓰지 않으므로 self 만 허용)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'display-capture=(self), microphone=(), camera=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  });

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.rate.httpPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' } }),
  });
  const loginLimiter = rateLimit({
    windowMs: 10 * 60_000,
    limit: config.rate.loginPerTenMinutes,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: '시도 횟수가 너무 많습니다. 10분 뒤 다시 시도해 주세요.' } }),
  });
  const claimLimiter = rateLimit({
    windowMs: 10 * 60_000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: '관리자 인증 시도가 너무 많습니다. 10분 뒤 다시 시도해 주세요.' } }),
  });

  const api = express.Router();
  api.use(limiter, express.json({ limit: '4kb' }), originGuard, attachAuth);

  api.get('/health', (_req, res) => res.json({ ok: true }));

  // 클라이언트가 필요로 하는 공개 설정 (비밀값 없음)
  api.get('/config', (req, res) => {
    const host = req.hostname;
    res.json({
      limits: config.limits,
      colors: PROFILE_COLORS,
      adminEnabled: !!config.adminCode,
      iceServers: config.stunUrls.length ? [{ urls: config.stunUrls }] : [],
      https: config.httpsEnabled ? { port: config.httpsPort, url: `https://${host}${portSuffix('https', config.httpsPort)}`, caUrl: '/inchat-ca.crt' } : null,
      lanUrls: lanAddresses().map((ip) => `${req.protocol}://${ip}${portSuffix(req.protocol, req.socket.localPort ?? config.port)}`),
      maxViewers: config.maxViewers,
      onlineUsers: totalOnlineUsers(),
    });
  });

  // ----- 세션 -----
  api.get('/me', (req, res) => {
    res.json({ user: req.auth ? userDTO(req.auth.user) : null });
  });
  api.post('/session', loginLimiter, (req, res) => {
    if (req.auth) return void res.json({ user: userDTO(req.auth.user) });
    const { nickname } = parse(schemas.login, req.body);
    const nick = validateNickname(nickname);
    const color = PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)];
    const user = repo.createUser(nick, color, repo.hashIp(req.socket.remoteAddress));
    const { token, expiresAt } = issueSession(user.id);
    setSessionCookie(req, res, token, expiresAt);
    log.info(`새 사용자 입장: ${user.nickname}`);
    res.status(201).json({ user: userDTO(user) });
  });
  api.delete('/session', requireAuth, (req, res) => {
    repo.deleteSession(req.auth!.tokenHash);
    disconnectSession(req.auth!.tokenHash);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });
  api.patch('/me', requireAuth, (req, res) => {
    const d = parse(schemas.me, req.body);
    const patch: { nickname?: string; color?: string } = {};
    if (d.nickname !== undefined) patch.nickname = validateNickname(d.nickname);
    if (d.color !== undefined) {
      if (!PROFILE_COLORS.includes(d.color.toLowerCase())) throw new AppError('INVALID_COLOR', '사용할 수 없는 프로필 색상입니다.', 400);
      patch.color = d.color.toLowerCase();
    }
    repo.updateUser(req.auth!.user.id, patch);
    refreshUser(req.auth!.user.id);
    res.json({ user: userDTO(repo.getUser(req.auth!.user.id)!) });
  });
  // 서버 관리자 인증: ADMIN_CODE 를 아는 사용자만 모든 채널을 관리할 수 있음
  api.post('/admin/claim', requireAuth, claimLimiter, (req, res) => {
    if (!config.adminCode) throw new AppError('ADMIN_DISABLED', '서버 관리자 기능이 비활성화되어 있습니다. (.env 의 ADMIN_CODE 를 설정하세요)', 403);
    const { code } = parse(schemas.claim, req.body);
    if (!safeEqual(code, config.adminCode)) throw new AppError('INVALID_CODE', '관리자 코드가 올바르지 않습니다.', 403);
    repo.setAdmin(req.auth!.user.id, true);
    refreshUser(req.auth!.user.id);
    res.json({ user: userDTO(repo.getUser(req.auth!.user.id)!) });
  });

  // ----- 채널 -----
  api.get('/channels', requireAuth, (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 50) : '';
    const channels = repo.listChannels(q || undefined).map(channelDTO);
    channels.sort((a, b) => Number(b.live) - Number(a.live));
    res.json({ channels });
  });
  api.post('/channels', requireAuth, (req, res) => {
    const d = parse(schemas.createChannel, req.body);
    const id = repo.createChannel(validateChannelName(d.name), validateChannelDescription(d.description), req.auth!.user.id);
    notifyChannelsChanged();
    res.status(201).json({ channel: channelDTO(repo.getChannel(id)!) });
  });
  api.get('/channels/:id', requireAuth, (req, res) => {
    const ch = repo.getChannel(req.params.id);
    if (!ch) throw new AppError('CHANNEL_NOT_FOUND', '존재하지 않는 채널입니다.', 404);
    res.json({ channel: channelDTO(ch) });
  });
  api.delete('/channels/:id', requireAuth, (req, res) => {
    const ch = repo.getChannel(req.params.id);
    if (!ch) throw new AppError('CHANNEL_NOT_FOUND', '존재하지 않는 채널입니다.', 404);
    if (!repo.canModerate(req.auth!.user, ch.id)) throw new AppError('FORBIDDEN', '채널 생성자만 채널을 삭제할 수 있습니다.', 403);
    if (ch.is_default) throw new AppError('DEFAULT_CHANNEL', '기본 채널은 삭제할 수 없습니다.', 400);
    destroyChannelRuntime(ch.id);
    repo.deleteChannel(ch.id);
    notifyChannelsChanged();
    res.json({ ok: true });
  });
  // 이전 메시지 페이지 조회 (before 보다 오래된 메시지 limit개)
  api.get('/channels/:id/messages', requireAuth, (req, res) => {
    const ch = repo.getChannel(req.params.id);
    if (!ch) throw new AppError('CHANNEL_NOT_FOUND', '존재하지 않는 채널입니다.', 404);
    const user = req.auth!.user;
    if (user.is_admin !== 1 && repo.getActiveBan(ch.id, user.id, repo.hashIp(req.socket.remoteAddress))) {
      throw new AppError('BANNED', '이 채널에서 이용이 제한되었습니다.', 403);
    }
    const before = Number.parseInt(String(req.query.before ?? ''), 10);
    if (!Number.isFinite(before) || before <= 0) throw new AppError('BAD_REQUEST', 'before 값이 올바르지 않습니다.', 400);
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? config.limits.historyPage), 10) || config.limits.historyPage, 1), 100);
    res.json(repo.messagesBefore(ch.id, before, limit));
  });
  api.use((_req, _res, next) => next(new AppError('NOT_FOUND', '요청한 API를 찾을 수 없습니다.', 404)));

  app.use('/api', api);

  // 다른 기기에서 내려받아 신뢰 등록할 로컬 CA 인증서(공개 인증서만 제공)
  app.get('/inchat-ca.crt', (_req, res, next) => {
    const p = path.join(config.certDir, 'inchat-local-ca.crt');
    if (!fs.existsSync(p)) return next(new AppError('NOT_FOUND', '인증서가 아직 생성되지 않았습니다. npm run cert 를 실행하세요.', 404));
    res.type('application/x-x509-ca-cert').download(p, 'inchat-local-ca.crt');
  });

  // 빌드된 프런트엔드를 같은 Origin 에서 제공
  if (fs.existsSync(path.join(config.clientDist, 'index.html'))) {
    app.use(express.static(config.clientDist, { index: false, maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(config.clientDist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.status(200).type('text/plain; charset=utf-8').send('InChat 서버가 실행 중이지만 빌드된 화면이 없습니다.\n개발 모드: npm run dev / 배포 모드: npm run build 후 npm start');
    });
  }

  // 오류 처리: 원인을 숨기지 않되 내부 정보(스택)는 응답에 싣지 않는다
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return void res.status(err.status).json({ error: toPayload(err) });
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      return void res.status(400).json({ error: { code: 'BAD_JSON', message: '요청 본문이 올바른 JSON이 아닙니다.' } });
    }
    if ((err as { type?: string }).type === 'entity.too.large') {
      return void res.status(413).json({ error: { code: 'TOO_LARGE', message: '요청 본문이 너무 큽니다.' } });
    }
    log.error('HTTP 처리 중 오류:', (err as Error).stack ?? err);
    res.status(500).json({ error: toPayload(err) });
  });

  return app;
}
