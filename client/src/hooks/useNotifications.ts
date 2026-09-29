import { useCallback, useEffect, useState } from 'react';
import { emitAck, socket } from '../lib/socket';
import type { AppNotification, ConnState, ManagedBroadcaster } from '../lib/types';

/** 알림함: 방송 시작, 방송 권한 요청 결과, 권한/매니저 변경 등. (관리자에게는 "방송 권한 관리" 데이터도 함께) */
export function useNotifications(conn: ConnState, canReview: boolean) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [holders, setHolders] = useState<ManagedBroadcaster[]>([]);

  const reloadHolders = useCallback(() => {
    if (!canReview) { setHolders([]); return Promise.resolve(); }
    return emitAck<{ broadcasters: ManagedBroadcaster[] }>('broadcaster:overview', {}).then((r) => setHolders(r.broadcasters)).catch(() => {});
  }, [canReview]);

  useEffect(() => {
    if (conn !== 'connected') return;
    emitAck<{ notifications: AppNotification[] }>('notification:list', {}).then((r) => setItems(r.notifications)).catch(() => {});
    void reloadHolders();
  }, [conn, reloadHolders]);

  useEffect(() => {
    const onNew = (d: { notification: AppNotification }) => setItems((l) => (l.some((x) => x.id === d.notification.id) ? l : [d.notification, ...l].slice(0, 50)));
    socket.on('notification:new', onNew);
    return () => { socket.off('notification:new', onNew); };
  }, []);

  const markRead = useCallback(async () => {
    await emitAck('notification:read', {});
    setItems((l) => l.map((x) => ({ ...x, read: true })));
  }, []);
  const clear = useCallback(async () => {
    await emitAck('notification:clear', {});
    setItems([]);
  }, []);
  const revoke = useCallback(async (h: ManagedBroadcaster) => {
    await emitAck('broadcaster:revoke', { channelId: h.channelId, userId: h.userId });
    setHolders((l) => l.filter((x) => !(x.channelId === h.channelId && x.userId === h.userId)));
  }, []);

  return { items, unread: items.filter((x) => !x.read).length, holders, reloadHolders, markRead, clear, revoke };
}
