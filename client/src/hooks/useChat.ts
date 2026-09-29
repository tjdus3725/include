import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { emitAck, socket, SocketError } from '../lib/socket';
import type { Ban, Channel, ConnState, LiveInfo, Message, Notice, Participant, PendingMessage } from '../lib/types';
import { uid } from '../lib/util';

export type JoinStatus = 'idle' | 'joining' | 'joined' | 'error' | 'kicked' | 'gone';
export interface ChatState {
  status: JoinStatus;
  error: string | null;
  channel: Channel | null;
  me: { role: 'owner' | 'admin' | 'member'; canModerate: boolean } | null;
  messages: Message[];
  hasMore: boolean;
  notice: Notice | null;
  participants: Participant[];
  broadcast: LiveInfo;
  /** 입장(또는 재입장)에 성공할 때마다 증가 */
  epoch: number;
}
const initial: ChatState = {
  status: 'idle', error: null, channel: null, me: null, messages: [], hasMore: false,
  notice: null, participants: [], broadcast: { live: false }, epoch: 0,
};

interface JoinAck {
  channel: Channel;
  me: ChatState['me'];
  messages: Message[];
  hasMore: boolean;
  reset: boolean;
  notice: Notice | null;
  participants: Participant[];
  broadcast: LiveInfo;
}

function merge(base: Message[], incoming: Message[]): Message[] {
  const map = new Map<number, Message>();
  for (const m of base) map.set(m.id, m);
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort((a, b) => a.id - b.id);
}

export function useChat(channelId: string | null, conn: ConnState, messageMax: number) {
  const [state, setState] = useState<ChatState>(initial);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const loadedFor = useRef<string | null>(null);

  // 채널이 바뀌면 상태 초기화, 이전 채널에서 퇴장
  useEffect(() => {
    setState({ ...initial, status: channelId ? 'joining' : 'idle' });
    setPending([]);
    loadedFor.current = null;
    if (!channelId) return;
    return () => {
      if (socket.connected) socket.emit('channel:leave', { channelId });
    };
  }, [channelId]);

  // 연결될 때마다(최초 + 재연결) 입장. 재연결이면 마지막으로 받은 메시지 ID 이후만 동기화
  useEffect(() => {
    if (!channelId || conn !== 'connected') return;
    let cancelled = false;
    const cur = stateRef.current;
    const lastId = loadedFor.current === channelId && cur.messages.length ? cur.messages[cur.messages.length - 1].id : undefined;
    setState((s) => (s.status === 'joined' ? s : { ...s, status: 'joining', error: null }));
    emitAck<JoinAck>('channel:join', { channelId, lastId }, 10000)
      .then((r) => {
        if (cancelled) return;
        loadedFor.current = channelId;
        setState((s) => ({
          ...s,
          status: 'joined',
          error: null,
          channel: r.channel,
          me: r.me,
          messages: r.reset ? r.messages : merge(s.messages, r.messages),
          hasMore: r.reset ? r.hasMore : s.hasMore,
          notice: r.notice,
          participants: r.participants,
          broadcast: r.broadcast,
          epoch: s.epoch + 1,
        }));
        // 서버가 확인한 메시지는 임시 목록에서 제거
        setPending((p) => p.filter((x) => !r.messages.some((m) => m.clientId === x.clientId)));
      })
      .catch((e: SocketError) => {
        if (cancelled) return;
        setState((s) => ({ ...s, status: e.code === 'BANNED' ? 'kicked' : 'error', error: e.message }));
      });
    return () => { cancelled = true; };
  }, [channelId, conn]);

  // 실시간 이벤트
  useEffect(() => {
    if (!channelId) return;
    const mine = (d: { channelId: string }) => d.channelId === channelId;
    const onNew = (m: Message) => {
      if (!mine(m)) return;
      setState((s) => ({ ...s, messages: merge(s.messages, [m]) }));
      if (m.clientId) setPending((p) => p.filter((x) => x.clientId !== m.clientId));
    };
    const onDeleted = (d: { channelId: string; messageId: number }) => {
      if (!mine(d)) return;
      setState((s) => ({ ...s, messages: s.messages.map((m) => (m.id === d.messageId ? { ...m, deleted: true, body: '' } : m)) }));
    };
    const onNotice = (d: { channelId: string; notice: Notice | null }) => mine(d) && setState((s) => ({ ...s, notice: d.notice }));
    const onPresence = (d: { channelId: string; participants: Participant[] }) => mine(d) && setState((s) => ({ ...s, participants: d.participants }));
    const onStarted = (d: { channelId: string; broadcaster: string; startedAt: number; hasAudio: boolean }) =>
      mine(d) && setState((s) => ({ ...s, broadcast: { live: true, broadcaster: d.broadcaster, startedAt: d.startedAt, hasAudio: d.hasAudio } }));
    const onEnded = (d: { channelId: string }) => mine(d) && setState((s) => ({ ...s, broadcast: { live: false } }));
    const onKicked = (d: { channelId: string; reason: string; expiresAt: number | null }) => {
      if (!mine(d)) return;
      const until = d.expiresAt ? `${new Date(d.expiresAt).toLocaleString('ko-KR')}까지` : '기한 없이';
      setState((s) => ({ ...s, status: 'kicked', error: `채널 관리자에 의해 강퇴되었습니다. (${until} 재입장 제한)${d.reason ? ` 사유: ${d.reason}` : ''}` }));
    };
    const onGone = (d: { channelId: string }) => mine(d) && setState((s) => ({ ...s, status: 'gone', error: '채널이 삭제되었습니다.' }));
    const onStats = (d: { stats: { id: string; onlineCount: number; live: boolean; viewerCount?: number }[] }) => {
      const st = d.stats.find((x) => x.id === channelId);
      if (st) setState((s) => (s.broadcast.live && st.live ? { ...s, broadcast: { ...s.broadcast, viewerCount: st.viewerCount } } : s));
    };
    socket.on('message:new', onNew);
    socket.on('message:deleted', onDeleted);
    socket.on('notice:update', onNotice);
    socket.on('presence:update', onPresence);
    socket.on('broadcast:started', onStarted);
    socket.on('broadcast:ended', onEnded);
    socket.on('channel:kicked', onKicked);
    socket.on('channel:deleted', onGone);
    socket.on('channels:stats', onStats);
    return () => {
      socket.off('message:new', onNew);
      socket.off('message:deleted', onDeleted);
      socket.off('notice:update', onNotice);
      socket.off('presence:update', onPresence);
      socket.off('broadcast:started', onStarted);
      socket.off('broadcast:ended', onEnded);
      socket.off('channel:kicked', onKicked);
      socket.off('channel:deleted', onGone);
      socket.off('channels:stats', onStats);
    };
  }, [channelId]);

  // ---- 전송 ----
  const transmit = useCallback(
    async (clientId: string, body: string) => {
      if (!channelId) return;
      try {
        const r = await emitAck<{ message: Message }>('message:send', { channelId, clientId, body }, 8000);
        setState((s) => ({ ...s, messages: merge(s.messages, [r.message]) }));
        setPending((p) => p.filter((x) => x.clientId !== clientId));
      } catch (e) {
        const err = e as SocketError;
        // 재시도해도 소용없는 오류(입력 검증)는 목록에서 바로 제거하지 않고 사유와 함께 남겨 사용자가 판단하게 한다
        setPending((p) => p.map((x) => (x.clientId === clientId ? { ...x, status: 'failed', error: err.message } : x)));
      }
    },
    [channelId],
  );

  /** 입력 검증에 실패하면 이유를 담은 문자열을, 전송을 시작했다면 null 을 반환 */
  const send = useCallback(
    (raw: string): string | null => {
      const body = raw.replace(/\r\n?/g, '\n').trim();
      if (!body) return '빈 메시지는 보낼 수 없습니다.';
      if ([...body].length > messageMax) return `메시지는 ${messageMax}자 이하로 입력해 주세요.`;
      if (stateRef.current.status !== 'joined') return '채널에 연결되는 중입니다. 잠시 후 다시 시도해 주세요.';
      const clientId = uid();
      setPending((p) => [...p, { clientId, body, createdAt: Date.now(), status: 'sending' }]);
      void transmit(clientId, body);
      return null;
    },
    [messageMax, transmit],
  );
  const retry = useCallback(
    (clientId: string) => {
      const item = pending.find((p) => p.clientId === clientId);
      if (!item) return;
      setPending((p) => p.map((x) => (x.clientId === clientId ? { ...x, status: 'sending', error: undefined } : x)));
      void transmit(clientId, item.body); // 같은 clientId 로 재전송 → 서버가 중복 저장하지 않음
    },
    [pending, transmit],
  );
  const discard = useCallback((clientId: string) => setPending((p) => p.filter((x) => x.clientId !== clientId)), []);

  const loadOlder = useCallback(async () => {
    const s = stateRef.current;
    if (!channelId || loadingOlder || !s.hasMore || !s.messages.length) return;
    setLoadingOlder(true);
    try {
      const r = await api.older(channelId, s.messages[0].id);
      setState((cur) => (cur.channel?.id === channelId ? { ...cur, messages: merge(cur.messages, r.messages), hasMore: r.hasMore } : cur));
    } finally {
      setLoadingOlder(false);
    }
  }, [channelId, loadingOlder]);

  // ---- 관리 ----
  const actions = {
    deleteMessage: (messageId: number) => emitAck('message:delete', { channelId, messageId }),
    setNotice: (body: string) => emitAck('notice:set', { channelId, body }),
    clearNotice: () => emitAck('notice:clear', { channelId }),
    kick: (userId: string, minutes: number | null, reason: string) =>
      emitAck<{ bans: Ban[] }>('user:kick', { channelId, userId, minutes, reason: reason || undefined }),
    unban: (userId: string) => emitAck<{ bans: Ban[] }>('user:unban', { channelId, userId }),
    listBans: () => emitAck<{ bans: Ban[] }>('ban:list', { channelId }),
  };

  return { state, pending, send, retry, discard, loadOlder, loadingOlder, actions };
}
