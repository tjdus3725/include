import { useCallback, useEffect, useState } from 'react';
import { emitAck, socket } from '../lib/socket';
import type { BroadcastRequest, ConnState } from '../lib/types';

/** 방송 권한 요청 알림함: 서버 관리자(전체) 또는 채널 소유자(자기 채널)만 의미가 있다. */
export function useRequests(conn: ConnState, canReview: boolean) {
  const [requests, setRequests] = useState<BroadcastRequest[]>([]);

  useEffect(() => {
    if (!canReview) { setRequests([]); return; }
    if (conn === 'connected') {
      emitAck<{ requests: BroadcastRequest[] }>('request:list', {}).then((r) => setRequests(r.requests)).catch(() => {});
    }
  }, [canReview, conn]);

  useEffect(() => {
    if (!canReview) return;
    const onNew = (d: { request: BroadcastRequest }) => setRequests((l) => (l.some((x) => x.id === d.request.id) ? l : [d.request, ...l]));
    const onResolved = (d: { id: number }) => setRequests((l) => l.filter((x) => x.id !== d.id));
    socket.on('request:new', onNew);
    socket.on('request:resolved', onResolved);
    return () => { socket.off('request:new', onNew); socket.off('request:resolved', onResolved); };
  }, [canReview]);

  const grant = useCallback(async (r: BroadcastRequest) => {
    try {
      await emitAck('broadcaster:grant', { channelId: r.channelId, userId: r.userId });
    } catch (e) {
      // 이미 권한이 있으면 요청만 정리하고 넘어간다
      if ((e as { code?: string }).code !== 'ALREADY_GRANTED') throw e;
      await emitAck('request:dismiss', { requestId: r.id }).catch(() => {});
    }
    setRequests((l) => l.filter((x) => x.id !== r.id));
  }, []);
  const dismiss = useCallback(async (r: BroadcastRequest) => {
    await emitAck('request:dismiss', { requestId: r.id });
    setRequests((l) => l.filter((x) => x.id !== r.id));
  }, []);

  return { requests, grant, dismiss };
}
