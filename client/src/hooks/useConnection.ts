import { useEffect, useState } from 'react';
import { socket } from '../lib/socket';
import type { ConnState } from '../lib/types';

/** 로그인한 동안 Socket.IO 연결을 유지하고 연결 상태를 알려줍니다. */
export function useConnection(enabled: boolean, onAuthLost: () => void): ConnState {
  const [state, setState] = useState<ConnState>('connecting');

  useEffect(() => {
    if (!enabled) return;
    const onConnect = () => setState('connected');
    const onDisconnect = (reason: string) => {
      setState('disconnected');
      // 서버가 끊은 경우에는 자동 재연결이 되지 않으므로 직접 다시 연결
      if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 500);
    };
    const onAttempt = () => setState('reconnecting');
    const onError = (err: Error) => {
      if (err.message === 'AUTH_REQUIRED') return onAuthLost();
      setState((s) => (s === 'connected' ? 'disconnected' : 'reconnecting'));
    };
    const onEnded = () => onAuthLost();
    const wake = () => {
      if (document.visibilityState === 'visible' && !socket.connected && !socket.active) socket.connect();
    };
    // 네트워크가 돌아오면 실제 소켓 상태를 기준으로 표시를 복구하고, 끊겨 있으면 즉시 재연결을 시도
    const onOnline = () => {
      if (socket.connected) setState('connected');
      else {
        setState('reconnecting');
        socket.connect();
      }
    };
    // 브라우저가 오프라인이라고 알리면 빠르게 안내 (실제 연결 종료는 소켓 이벤트로 확정)
    const onOffline = () => setState('disconnected');

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onError);
    socket.on('session:ended', onEnded);
    socket.io.on('reconnect_attempt', onAttempt);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    setState('connecting');
    socket.connect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onError);
      socket.off('session:ended', onEnded);
      socket.io.off('reconnect_attempt', onAttempt);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      socket.disconnect();
    };
  }, [enabled, onAuthLost]);

  return state;
}
