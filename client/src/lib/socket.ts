import { io } from 'socket.io-client';

/**
 * 주소를 지정하지 않으면 현재 페이지와 같은 Origin 으로 연결합니다.
 * (개발 모드에서는 Vite 프록시가, 배포 모드에서는 Express 서버가 /socket.io 를 처리)
 */
export const socket = io({
  autoConnect: false,
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  reconnectionDelay: 500,
  reconnectionDelayMax: 4000,
  timeout: 8000,
});

export class SocketError extends Error {
  constructor(public code: string, message: string, public retryAfterMs?: number) {
    super(message);
  }
}

/** ack 콜백 기반 이벤트를 Promise 로 바꿉니다. 실패 시 사용자에게 보여줄 수 있는 메시지를 가진 SocketError 로 reject. */
export function emitAck<T extends object = object>(event: string, data: unknown, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socket.connected) {
      reject(new SocketError('DISCONNECTED', '서버와 연결이 끊겨 있습니다. 연결이 복구되면 다시 시도해 주세요.'));
      return;
    }
    socket.timeout(timeoutMs).emit(event, data, (err: Error | null, res: any) => {
      if (err) return reject(new SocketError('TIMEOUT', '서버 응답이 없습니다. 네트워크 상태를 확인하고 다시 시도해 주세요.'));
      if (res?.ok) return resolve(res as T);
      const e = res?.error;
      reject(new SocketError(e?.code ?? 'UNKNOWN', e?.message ?? '요청을 처리하지 못했습니다.', e?.retryAfterMs));
    });
  });
}
