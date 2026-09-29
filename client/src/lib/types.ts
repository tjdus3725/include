export interface User { id: string; nickname: string; color: string; isAdmin: boolean; createdAt: number }

export interface AppConfig {
  limits: { nicknameMin: number; nicknameMax: number; channelNameMin: number; channelNameMax: number; channelDescMax: number; messageMax: number; noticeMax: number; historyPage: number };
  colors: string[];
  adminEnabled: boolean;
  iceServers: RTCIceServer[];
  https: { port: number; url: string; caUrl: string } | null;
  lanUrls: string[];
  maxViewers: number;
  onlineUsers: number;
}

export interface LiveInfo { live: boolean; broadcaster?: string; broadcasterId?: string; startedAt?: number; hasAudio?: boolean; viewerCount?: number }
export interface Channel extends LiveInfo {
  id: string; name: string; description: string; isDefault: boolean;
  ownerId: string | null; ownerNickname: string | null; createdAt: number; onlineCount: number;
}
export interface ChannelStat extends LiveInfo { id: string; onlineCount: number }

export interface Message {
  id: number; channelId: string; kind: 'user' | 'system'; userId: string | null;
  nickname: string | null; color: string | null; body: string; createdAt: number;
  deleted: boolean; clientId: string | null;
}
export interface PendingMessage { clientId: string; body: string; createdAt: number; status: 'sending' | 'failed'; error?: string }

export interface Participant { id: string; nickname: string; color: string; role: 'owner' | 'admin' | 'broadcaster' | 'member'; broadcasting: boolean }
export interface Notice { body: string; updatedAt: number; authorNickname: string | null }
export interface Broadcaster { userId: string; nickname: string }
export interface Ban { userId: string; nickname: string; reason: string; createdAt: number; expiresAt: number | null }

export interface ErrorPayload { code: string; message: string; retryAfterMs?: number }
export type Ack<T = object> = ({ ok: true } & T) | { ok: false; error: ErrorPayload };

export type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
