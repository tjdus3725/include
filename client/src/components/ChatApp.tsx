import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBroadcast } from '../hooks/useBroadcast';
import { useChannels } from '../hooks/useChannels';
import { useChat } from '../hooks/useChat';
import { useConnection } from '../hooks/useConnection';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { api } from '../lib/api';
import { socket } from '../lib/socket';
import { useToast } from '../lib/toast';
import type { AppConfig, Ban, Channel, ConnState, Message, User } from '../lib/types';
import { ChannelList } from './ChannelList';
import { ChannelPanel } from './ChannelPanel';
import { Chat } from './Chat';
import { CreateChannelDialog } from './CreateChannelDialog';
import { Header } from './Header';
import { Icon, LogoMark } from './Icon';
import { KickDialog } from './KickDialog';
import { Modal } from './Modal';
import { Stage } from './Stage';

const DEFAULT_CHANNEL = 'all';
const parseHash = () => /^#\/c\/([A-Za-z0-9_-]+)$/.exec(location.hash)?.[1] ?? null;
const readLast = () => { try { return localStorage.getItem('inchat:lastChannel'); } catch { return null; } };
const writeLast = (id: string) => { try { localStorage.setItem('inchat:lastChannel', id); } catch { /* 저장 불가 환경 */ } };

export function ChatApp({ user, config, onUser, onLogout, onAuthLost }: {
  user: User; config: AppConfig; onUser: (u: User) => void; onLogout: () => void; onAuthLost: () => void;
}) {
  const toast = useToast();
  const conn = useConnection(true, onAuthLost);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [query, setQuery] = useState('');
  const { channels, loading, error: chError, refresh } = useChannels(conn, query);
  const [activeId, setActiveId] = useState<string | null>(() => parseHash() ?? readLast() ?? DEFAULT_CHANNEL);
  const [menuOpen, setMenuOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [kickTarget, setKickTarget] = useState<{ userId: string; nickname: string } | null>(null);
  const [bansVersion, setBansVersion] = useState(0);

  const select = useCallback((id: string) => {
    setActiveId(id);
    setMenuOpen(false);
    setInfoOpen(false);
  }, []);
  /** 채널 퇴장: 서버에 퇴장을 알리고(useChat 정리 단계) 채널 선택 화면으로 돌아간다 */
  const leave = useCallback(() => {
    setActiveId(null);
    setInfoOpen(false);
    setMenuOpen(true);
  }, []);
  useEffect(() => {
    if (!activeId) {
      try { localStorage.removeItem('inchat:lastChannel'); } catch { /* 저장 불가 환경 */ }
      if (parseHash()) history.replaceState(null, '', location.pathname + location.search);
      return;
    }
    writeLast(activeId);
    if (parseHash() !== activeId) history.replaceState(null, '', `#/c/${activeId}`);
  }, [activeId]);
  useEffect(() => {
    const on = () => { const h = parseHash(); if (h) setActiveId(h); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const chat = useChat(activeId, conn, config.limits.messageMax, user.isAdmin);
  const { state } = chat;
  const canModerate = !!state.me?.canModerate;
  const bc = useBroadcast({
    channelId: activeId, joined: state.status === 'joined', epoch: state.epoch,
    live: state.broadcast, canModerate, iceServers: config.iceServers,
  });
  const live = state.broadcast.live || bc.isSharing;
  const activeMeta = useMemo(() => channels.find((c) => c.id === activeId) ?? null, [channels, activeId]);
  const channel = state.channel ?? activeMeta;

  useEffect(() => { document.title = channel ? `${channel.name} · InChat` : 'InChat'; }, [channel]);

  // ---- 관리 동작 (서버가 최종 권한 검증) ----
  const guard = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) toast(ok, 'success'); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const onDelete = (m: Message) => {
    if (!window.confirm('이 메시지를 삭제할까요? 모든 사용자에게 "삭제된 메시지"로 표시됩니다.')) return;
    void guard(() => chat.actions.deleteMessage(m.id), '메시지를 삭제했습니다.');
  };
  const onKickConfirm = async (minutes: number | null, reason: string) => {
    if (!kickTarget) return;
    await chat.actions.kick(kickTarget.userId, minutes, reason);
    setBansVersion((v) => v + 1);
    toast(`${kickTarget.nickname}님을 강퇴했습니다.`, 'success');
  };
  const onDeleteChannel = async () => {
    if (!channel || !window.confirm(`"${channel.name}" 채널을 삭제할까요? 저장된 메시지도 모두 삭제되며 되돌릴 수 없습니다.`)) return;
    try {
      await api.deleteChannel(channel.id);
      toast('채널을 삭제했습니다.', 'success');
      select(DEFAULT_CHANNEL);
      void refresh();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const onCreated = (c: Channel) => { setCreateOpen(false); void refresh(); select(c.id); toast(`"${c.name}" 채널을 만들었습니다.`, 'success'); };

  // ---- 조각 ----
  const panel = (
    <ChannelPanel
      state={state} user={user} config={config} canModerate={canModerate}
      isSharing={bc.isSharing} starting={bc.share === 'starting'} shareBlocked={bc.shareBlocked}
      onStart={() => void bc.start()} onStop={() => void bc.stop()}
      onSetNotice={async (b) => { await chat.actions.setNotice(b); toast('공지를 등록했습니다.', 'success'); }}
      onClearNotice={async () => { await chat.actions.clearNotice(); toast('공지를 해제했습니다.', 'success'); }}
      onKick={(userId, nickname) => setKickTarget({ userId, nickname })}
      onListBans={async () => (await chat.actions.listBans()).bans}
      onUnban={async (uid): Promise<Ban[]> => { const r = await chat.actions.unban(uid); toast('이용 제한을 해제했습니다.', 'success'); return r.bans; }}
      onDeleteChannel={() => void onDeleteChannel()} bansVersion={bansVersion}
    />
  );
  const chatEl = (
    <Chat
      state={state} pending={chat.pending} userId={user.id} conn={conn} messageMax={config.limits.messageMax}
      loadingOlder={chat.loadingOlder} canModerate={canModerate}
      onSend={chat.send} onRetry={chat.retry} onDiscard={chat.discard} onLoadOlder={() => void chat.loadOlder()}
      onDelete={onDelete} onKick={(userId, nickname) => setKickTarget({ userId, nickname })}
    />
  );
  const stage = live ? (
    <Stage
      stream={bc.stream} isSharing={bc.isSharing} starting={bc.share === 'starting'} view={bc.view} error={bc.error}
      live={state.broadcast.live ? state.broadcast : { live: true, broadcaster: user.nickname }} viewerCount={bc.viewerCount}
      hasAudio={bc.isSharing ? bc.localHasAudio : !!state.broadcast.hasAudio}
      onStop={() => void bc.stop()} onRetry={() => void bc.retryWatch()}
    />
  ) : null;
  const shareAlert = bc.error && bc.view !== 'error' ? (
    <div role="alert" className="mx-3 mt-3 flex items-start gap-2 rounded-lg border border-coral-500/40 bg-coral-500/10 p-3 text-sm text-coral-400 lg:mx-4">
      <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
      <span className="flex-1">{bc.error}</span>
      <button className="shrink-0 underline" onClick={bc.dismissError}>닫기</button>
    </div>
  ) : null;

  const channelHeader = (
    <div className="flex items-center gap-3 border-b border-ink-600 px-3 py-2.5 lg:px-5 lg:py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-base font-bold lg:text-lg">{channel?.name ?? '채널'}</h1>
          {live && <span className="animate-pulse-dot shrink-0 rounded bg-coral-500 px-1.5 py-px text-[10px] font-extrabold text-white">LIVE</span>}
        </div>
        <p className="truncate text-xs text-mist-400 lg:text-sm">
          {channel?.description || '설명이 없는 채널입니다.'}
          <span className="ml-2 text-mist-500">· {state.participants.length}명 접속</span>
        </p>
      </div>
      {canModerate && (
        bc.isSharing
          ? <button className="btn-danger !px-3" onClick={() => void bc.stop()}><Icon name="stop" size={14} /><span className="hidden sm:inline">방송 종료</span></button>
          : <button className="btn-primary !px-3" onClick={() => void bc.start()} disabled={bc.share === 'starting' || state.broadcast.live || state.status !== 'joined'} title={state.broadcast.live ? '이미 방송 중입니다' : '화면 공유 방송 시작'}>
              <Icon name="monitor" size={16} /><span className="hidden sm:inline">방송 시작</span>
            </button>
      )}
      <button className="btn-ghost !px-3" onClick={leave} aria-label="채널 나가기" title="채널 나가기"><Icon name="logout" size={16} /><span className="hidden xl:inline">나가기</span></button>
      {!isDesktop && <button className="btn-secondary !px-3" onClick={() => setInfoOpen(true)} aria-label="채널 정보와 참여자"><Icon name="users" size={16} /><span className="hidden sm:inline">참여자·관리</span></button>}
    </div>
  );

  // 참여할 수 없는 상태(강퇴/삭제/오류) 안내
  const blocked = state.status === 'kicked' || state.status === 'gone' || state.status === 'error';
  const blockedEl = blocked && (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="card max-w-md p-6 text-center" role="alert">
        <Icon name={state.status === 'kicked' ? 'ban' : 'alert'} size={32} className="mx-auto text-coral-400" />
        <p className="mt-3 text-sm leading-relaxed text-mist-200">{state.error}</p>
        <div className="mt-5 flex justify-center gap-2">
          {state.status === 'error' && conn === 'connected' && <button className="btn-secondary" onClick={() => { const id = activeId; setActiveId(null); setTimeout(() => setActiveId(id), 0); }}>다시 시도</button>}
          {activeId !== DEFAULT_CHANNEL && <button className="btn-primary" onClick={() => select(DEFAULT_CHANNEL)}>전체 채팅으로 이동</button>}
        </div>
      </div>
    </div>
  );

  let content: React.ReactNode;
  if (!activeId) {
    content = (
      <div className="flex min-w-0 flex-1 items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <span className="mx-auto block w-fit"><LogoMark size={56} /></span>
          <h1 className="mt-4 text-lg font-bold">채널에서 나갔어요</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-mist-400">참여할 채널을 선택하거나 새 채널을 만들어 보세요.</p>
          <div className="mt-5 flex justify-center gap-2">
            <button className="btn-primary" onClick={() => select(DEFAULT_CHANNEL)}>전체 채팅으로 입장</button>
            <button className="btn-secondary" onClick={() => setCreateOpen(true)}>채널 만들기</button>
          </div>
        </div>
      </div>
    );
  } else if (blocked) content = <div className="flex min-w-0 flex-1 flex-col">{channelHeader}{blockedEl}</div>;
  else if (isDesktop) {
    content = (
      <>
        <div className="flex min-w-0 flex-1 flex-col">
          {channelHeader}
          {shareAlert}
          {live ? (<><div className="p-4 pb-3">{stage}</div><div className="flex min-h-0 flex-1 flex-col border-t border-ink-600">{panel}</div></>) : chatEl}
        </div>
        <div className="flex w-[380px] shrink-0 flex-col xl:w-[420px]">{live ? chatEl : panel}</div>
      </>
    );
  } else {
    content = (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {channelHeader}
        {shareAlert}
        {stage}
        {chatEl}
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <Header user={user} config={config} conn={conn} query={query} onQuery={setQuery} onToggleMenu={() => setMenuOpen((o) => !o)} menuOpen={menuOpen} onUser={onUser} onLogout={onLogout} />
      <ConnectionBanner conn={conn} />
      <div className="relative flex min-h-0 flex-1">
        <aside className="hidden w-72 shrink-0 flex-col border-r border-ink-600 bg-ink-900 lg:flex">
          <ChannelList channels={channels} loading={loading} error={chError} activeId={activeId} query={query} onQuery={setQuery} onSelect={select} onCreate={() => setCreateOpen(true)} onRetry={() => void refresh()} showSearch={false} />
        </aside>
        {menuOpen && (
          <div className="absolute inset-0 z-30 lg:hidden" onMouseDown={(e) => { if (e.target === e.currentTarget) setMenuOpen(false); }}>
            <div className="animate-fade-in absolute inset-0 bg-black/50" onClick={() => setMenuOpen(false)} />
            <div className="animate-fade-in relative flex max-h-[80%] flex-col border-b border-ink-600 bg-ink-900 shadow-2xl shadow-black/60">
              <ChannelList channels={channels} loading={loading} error={chError} activeId={activeId} query={query} onQuery={setQuery} onSelect={select} onCreate={() => { setMenuOpen(false); setCreateOpen(true); }} onRetry={() => void refresh()} showSearch />
            </div>
          </div>
        )}
        <main className="flex min-h-0 min-w-0 flex-1">{content}</main>
      </div>
      {createOpen && <CreateChannelDialog config={config} onClose={() => setCreateOpen(false)} onCreated={onCreated} />}
      {kickTarget && <KickDialog nickname={kickTarget.nickname} onClose={() => setKickTarget(null)} onConfirm={onKickConfirm} />}
      {infoOpen && !isDesktop && <Modal title={channel?.name ?? '채널 정보'} onClose={() => setInfoOpen(false)}><div className="-m-5 flex max-h-[70dvh] flex-col">{panel}</div></Modal>}
    </div>
  );
}

function ConnectionBanner({ conn }: { conn: ConnState }) {
  const [recovered, setRecovered] = useState(false);
  const was = useRef<ConnState>('connecting');
  const everConnected = useRef(false);
  useEffect(() => {
    if (conn === 'connected') {
      if (everConnected.current && was.current !== 'connected') {
        setRecovered(true);
        const t = setTimeout(() => setRecovered(false), 3000);
        was.current = conn;
        return () => clearTimeout(t);
      }
      everConnected.current = true;
    } else setRecovered(false);
    was.current = conn;
  }, [conn]);

  if (conn === 'connected') {
    return recovered ? <div role="status" className="bg-mint-500/20 px-4 py-1.5 text-center text-sm text-mint-300">다시 연결되었습니다. 놓친 메시지를 불러왔어요.</div> : null;
  }
  return (
    <div role="alert" className="flex items-center justify-center gap-3 bg-amber-400/15 px-4 py-1.5 text-sm text-amber-400">
      <Icon name="wifiOff" size={15} />
      <span>{conn === 'connecting' ? '서버에 연결하는 중입니다…' : conn === 'reconnecting' ? '연결이 끊겨 다시 연결하는 중입니다…' : '서버와 연결이 끊겼습니다. 자동으로 다시 연결합니다.'}</span>
      <button className="underline" onClick={() => socket.connect()}>지금 다시 연결</button>
    </div>
  );
}
