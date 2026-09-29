import { z } from 'zod';
import { config } from './config.js';
import { AppError } from './errors.js';

const cp = (s: string) => [...s].length;

const RESERVED = ['관리자', '운영자', '시스템', '방장', 'admin', 'administrator', 'system', 'inchat', 'moderator', 'root'];

/** 닉네임 정규화: NFC, 앞뒤 공백 제거 */
export function normalizeNickname(raw: unknown): string {
  return typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
}
export function nicknameKey(nick: string): string {
  return nick.toLowerCase();
}
export function validateNickname(raw: unknown): string {
  const nick = normalizeNickname(raw);
  const { nicknameMin: min, nicknameMax: max } = config.limits;
  if (cp(nick) < min || cp(nick) > max) {
    throw new AppError('INVALID_NICKNAME', `닉네임은 ${min}~${max}자로 입력해 주세요.`, 400);
  }
  if (!/^[가-힣A-Za-z0-9_-]+$/.test(nick)) {
    throw new AppError('INVALID_NICKNAME', '닉네임에는 한글, 영문, 숫자, 밑줄(_), 하이픈(-)만 사용할 수 있습니다.', 400);
  }
  if (RESERVED.includes(nicknameKey(nick))) {
    throw new AppError('INVALID_NICKNAME', '사용할 수 없는 닉네임입니다.', 400);
  }
  return nick;
}

export function validateChannelName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  const { channelNameMin: min, channelNameMax: max } = config.limits;
  if (cp(name) < min || cp(name) > max) {
    throw new AppError('INVALID_CHANNEL', `채널 이름은 ${min}~${max}자로 입력해 주세요.`, 400);
  }
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(name)) {
    throw new AppError('INVALID_CHANNEL', '채널 이름에는 글자, 숫자, 공백, 밑줄, 하이픈, 마침표만 사용할 수 있습니다.', 400);
  }
  return name;
}
export function validateChannelDescription(raw: unknown): string {
  const desc = typeof raw === 'string' ? cleanText(raw).replace(/\s+/g, ' ').trim() : '';
  if (cp(desc) > config.limits.channelDescMax) {
    throw new AppError('INVALID_CHANNEL', `채널 설명은 ${config.limits.channelDescMax}자 이하로 입력해 주세요.`, 400);
  }
  return desc;
}

/** 제어문자와 방향 전환/제로폭 문자를 제거 (줄바꿈은 보존) */
export function cleanText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/[​‎‏‪-‮⁦-⁩﻿]/g, '');
}

export function validateMessageBody(raw: unknown, max = config.limits.messageMax): string {
  if (typeof raw !== 'string') throw new AppError('INVALID_MESSAGE', '메시지 형식이 올바르지 않습니다.', 400);
  let body = cleanText(raw).trim();
  body = body.replace(/\n{3,}/g, '\n\n');
  if (body.length === 0) throw new AppError('EMPTY_MESSAGE', '빈 메시지는 보낼 수 없습니다.', 400);
  if (cp(body) > max) {
    throw new AppError('MESSAGE_TOO_LONG', `메시지는 ${max}자 이하로 입력해 주세요. (현재 ${cp(body)}자)`, 400);
  }
  if (body.split('\n').length > 12) {
    throw new AppError('MESSAGE_TOO_LONG', '줄바꿈은 12줄까지만 사용할 수 있습니다.', 400);
  }
  return body;
}

// ---- 스키마 ----
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const schemas = {
  channelId: z.object({ channelId: id }),
  join: z.object({ channelId: id, lastId: z.number().int().nonnegative().optional() }),
  send: z.object({ channelId: id, clientId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/), body: z.unknown() }),
  del: z.object({ channelId: id, messageId: z.number().int().positive() }),
  notice: z.object({ channelId: id, body: z.unknown() }),
  kick: z.object({
    channelId: id,
    userId: id,
    minutes: z.number().int().min(1).max(60 * 24 * 365).nullable().optional(),
    reason: z.string().max(100).optional(),
  }),
  unban: z.object({ channelId: id, userId: id }),
  target: z.object({ channelId: id, userId: id }),
  start: z.object({ channelId: id, hasAudio: z.boolean() }),
  signal: z.object({
    channelId: id,
    to: z.string().min(1).max(64),
    data: z.discriminatedUnion('type', [
      z.object({ type: z.literal('offer'), sdp: z.string().max(100_000) }),
      z.object({ type: z.literal('answer'), sdp: z.string().max(100_000) }),
      z.object({
        type: z.literal('candidate'),
        candidate: z.object({
          candidate: z.string().max(2000),
          sdpMid: z.string().max(64).nullable().optional(),
          sdpMLineIndex: z.number().int().nullable().optional(),
          usernameFragment: z.string().max(64).nullable().optional(),
        }),
      }),
    ]),
  }),
  login: z.object({ nickname: z.unknown() }),
  me: z.object({ nickname: z.unknown().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }),
  createChannel: z.object({ name: z.unknown(), description: z.unknown().optional() }),
  claim: z.object({ code: z.string().min(1).max(200) }),
};

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new AppError('BAD_REQUEST', '요청 형식이 올바르지 않습니다.', 400);
  return r.data;
}

export const PROFILE_COLORS = [
  '#2dd4bf', '#22d3ee', '#38bdf8', '#818cf8', '#a78bfa',
  '#f472b6', '#fb7185', '#fb923c', '#fbbf24', '#a3e635',
];
