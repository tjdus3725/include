import crypto from 'node:crypto';
import cookie from 'cookie';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { AppError } from './errors.js';
import * as repo from './repo.js';

const DAY = 24 * 3600 * 1000;

export function issueSession(userId: string): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + config.sessionTtlDays * DAY;
  repo.insertSession(repo.hashToken(token), userId, expiresAt);
  return { token, expiresAt };
}

export function tokenFromCookieHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const v = cookie.parse(header)[config.cookieName];
  return v && v.length <= 200 ? v : undefined;
}

export function authenticateToken(token: string | undefined) {
  if (!token) return undefined;
  const hash = repo.hashToken(token);
  const found = repo.getSessionUser(hash);
  if (!found) return undefined;
  // 슬라이딩 만료: 하루 이상 지났으면 만료일 연장
  const target = Date.now() + config.sessionTtlDays * DAY;
  if (target - found.expiresAt > DAY) repo.extendSession(hash, target);
  return { user: found.user, tokenHash: hash };
}

export function setSessionCookie(req: Request, res: Response, token: string, expiresAt: number) {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(config.cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      path: '/',
      expires: new Date(expiresAt),
    }),
  );
}
export function clearSessionCookie(req: Request, res: Response) {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(config.cookieName, '', { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: 0 }),
  );
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: { user: repo.UserRow; tokenHash: string };
  }
}

export function attachAuth(req: Request, _res: Response, next: NextFunction) {
  req.auth = authenticateToken(tokenFromCookieHeader(req.headers.cookie));
  next();
}
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(new AppError('AUTH_REQUIRED', '로그인이 필요합니다. 닉네임을 입력해 다시 입장해 주세요.', 401));
  next();
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Origin 검사: 요청 Host 와 같은 Origin 이거나 ALLOWED_ORIGINS 에 있어야 합니다. */
export function isOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // 브라우저가 아닌 클라이언트(curl 등) — 쿠키 기반 CSRF 대상이 아님
  if (config.allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
export function originGuard(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!isOriginAllowed(req.headers.origin, req.headers.host)) {
    return next(new AppError('ORIGIN_FORBIDDEN', '허용되지 않은 출처의 요청입니다.', 403));
  }
  next();
}
