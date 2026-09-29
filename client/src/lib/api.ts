import type { AppConfig, Channel, Message, User } from './types';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('NETWORK', '서버에 연결할 수 없습니다. 서버가 실행 중인지, 같은 네트워크에 연결되어 있는지 확인해 주세요.', 0);
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* JSON 이 아닌 응답 */
  }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(e?.code ?? 'HTTP_ERROR', e?.message ?? `요청이 실패했습니다. (HTTP ${res.status})`, res.status);
  }
  return data as T;
}

export const api = {
  config: () => request<AppConfig>('GET', '/api/config'),
  me: () => request<{ user: User | null }>('GET', '/api/me'),
  login: (nickname: string) => request<{ user: User }>('POST', '/api/session', { nickname }),
  logout: () => request<{ ok: true }>('DELETE', '/api/session'),
  updateMe: (patch: { nickname?: string; color?: string }) => request<{ user: User }>('PATCH', '/api/me', patch),
  claimAdmin: (code: string) => request<{ user: User }>('POST', '/api/admin/claim', { code }),
  channels: (q?: string) => request<{ channels: Channel[] }>('GET', `/api/channels${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createChannel: (name: string, description: string) => request<{ channel: Channel }>('POST', '/api/channels', { name, description }),
  deleteChannel: (id: string) => request<{ ok: true }>('DELETE', `/api/channels/${encodeURIComponent(id)}`),
  older: (id: string, before: number) =>
    request<{ messages: Message[]; hasMore: boolean }>('GET', `/api/channels/${encodeURIComponent(id)}/messages?before=${before}&limit=50`),
};
