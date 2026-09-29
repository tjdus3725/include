import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBroadcast } from '../hooks/useBroadcast';
import { useChannels } from '../hooks/useChannels';
import { useChat } from '../hooks/useChat';
import { useConnection } from '../hooks/useConnection';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { api } from '../lib/api';
import { socket } from '../lib/socket';
import { useToast } from '../lib/toast';
import type { AppConfig, Ban, Channel, ConnState, EntryMode, Message, User } from '../lib/types';
import { useRequests } from '../hooks/useRequests';
import { ChannelList } from './ChannelList';
import { ChannelPanel } from './ChannelPanel';
import { Chat } from './Chat';
import { ChatOverlay } from './ChatOverlay';
import { CreateChannelDialog } from './CreateChannelDialog';
import { EntryDialog } from './EntryDialog';
import { LobbyScreen } from './LobbyScreen';
import { NotificationBell } from './NotificationBell';
import { RequestDialog } from './RequestDialog';
import { Header } from './Header';
import { Icon } from './Icon';
import { KickDialog } from './KickDialog';
import { Modal } from './Modal';
import { Stage } from './Stage';

const parseHash = () => /^#\/c\/([A-Za-z0-9_-]+)$/.exec(location.hash)?.[1] ?? null;
const IDENTITY_KEY = 'inchat:entry';
const readIdentities = (): Record<string, EntryMode> => {
  try { return JSON.parse(sessionStorage.getItem(IDENTITY_KEY) ?? '{}') as Record<string, EntryMode>; } catch { return {}; }
};
const writeIdentities = (m: Record<string, EntryMode>) => { try { sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(m)); } catch { /* 저장 불가 환경 */ } };

export function ChatApp({ user, config, onUser, onLogout, onAuthLost }: {
  user: User; config: AppConfig; onUser: (u: User) => void; onLogout: () => void; onAuthLost: () => void;
}) {
  const toast = useToast();
  const conn = useConnection(true, onAuthLost);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [query, setQuery] = useState('');
  const { channels, loading, error: chError, refresh } = useChannels(conn, query);
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const userIdRef = useRef(user.id);
  userIdRef.current = user.id;
  // 입장 방식(내 닉네임/익명)은 방마다 고른 값을 이 탭에서 기억한다. 아직 고르지 않은 방은 입장 전에 반드시 묻는다.
  const [identities, setIdentities] = useState<Record<string, EntryMode>>(readIdentities);
  const [activeId, setActiveId] = useState<string | null>(() => { const h = parseHash(); return h && readIdentities()[h] ? h : null; });
  const [entryFor, setEntryFor] = useState<string | null>(() => { const h = parseHash(); return h && !readIdentities()[h] ? h : null; });
  const [requestAdmin, setRequestAdmin] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [kickTarget, setKickTarget] = useState<{ userId: string; nickname: string } | null>(null);
  const [bansVersion, setBansVersion] = useState(0);
  const [overlayOn, setOverlayOn] = useState(true);
  const [pipWin, setPipWin] = useState<Window | null>(null);

  const enter = useCallback((id: string, mode: EntryMode) => {
    setIdentities((m) => { const next = { ...m, [id]: mode }; writeIdentities(next); return next; });
    setActiveId(id);
    setEntryFor(null);
    setMenuOpen(false);
    setInfoOpen(false);
  }, []);
  /** 방을 고르면 입장 방식(내 닉네임/익명)을 먼저 묻는다 */
  const select = useCallback((id: string) => {
    setMenuOpen(false);
    setInfoOpen(false);
    // 채널을 개설한 관리자는 익명으로 입장할 수 없다: 묻지 않고 본인 닉네임으로 바로 입장
    if (channelsRef.current.find((c) => c.id === id)?.ownerId === userIdRef.current) { enter(id, 'nick'); return; }
    setEntryFor(id);
  }, [enter]);
  /** 채널 퇴장: 서버에 퇴장을 알리고(useChat 정리 단계) 로비로 돌아간다 */
  const leave = useCallback(() => {
    setActiveId(null);
    setInfoOpen(false);
    setMenuOpen(false);
  }, []);
  useEffect(() => {
    if (!activeId) {
      if (parseHash() && !entryFor) history.replaceState(null, '', location.pathname + location.search);
      return;
    }
    if (parseHash() !== activeId) history.replaceState(null, '', `#/c/${activeId}`);
  }, [activeId, entryFor]);
  useEffect(() => {
    const on = () => {
      const h = parseHash();
      if (!h) return;
      const known = readIdentities()[h];
      if (known) enter(h, known); else setEntryFor(h);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [enter]);

  const ownsActive = !!activeId && channels.find((c) => c.id === activeId)?.ownerId === user.id;
  const anonymous = !!activeId && identities[activeId] === 'anon' && !ownsActive;
  useEffect(() => {
    if (entryFor && channels.find((c) => c.id === entryFor)?.ownerId === user.id) enter(entryFor, 'nick');
  }, [entryFor, channels, user.id, enter]);
  const chat = useChat(activeId, conn, config.limits.messageMax, user.isAdmin, anonymous);
  const { state } = chat;
  const canModerate = !!state.me?.canModerate;
  const canBroadcast = !!state.me?.canBroadcast;
  const bc = useBroadcast({
    channelId: activeId, joined: state.status === 'joined', epoch: state.epoch,
    live: state.broadcast, canBroadcast, iceServers: config.iceServers,
  });
  const canReview = user.isAdmin || channels.some((c) => c.ownerId === user.id);
  const reqs = useRequests(conn, canReview);
  // 방송 권한을 새로 받으면 본인에게만 알려준다 (다른 참여자에게는 공개되지 않는다)
  const prevCan = useRef<boolean | null>(null);
  useEffect(() => { prevCan.current = null; }, [activeId]);
  useEffect(() => {
    if (state.status !== 'joined') return;
    if (prevCan.current === false && canBroadcast) toast('방송 권한이 부여되었습니다. 이제 이 채널에서 방송을 시작할 수 있어요.', 'success');
    prevCan.current = canBroadcast;
  }, [canBroadcast, state.status, toast]);
  const live = state.broadcast.live || bc.isSharingHere;
  const sharingElsewhere = bc.isSharing && !bc.isSharingHere;
  const shareChannel = channels.find((c) => c.id === bc.shareChannelId) ?? null;
  const activeMeta = useMemo(() => channels.find((c) => c.id === activeId) ?? null, [channels, activeId]);
  const channel = state.channel ?? activeMeta;

  useEffect(() => { document.title = activeId && channel ? `${channel.name} · InChat` : 'InChat 로비'; }, [channel, activeId]);

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
  /** 채팅 창 띄우기: Chrome/Edge 는 항상 위에 떠 있는 PiP 창, 그 외에는 팝업 창 */
  const popOutChat = async () => {
    const dpip = (window as unknown as { documentPictureInPicture?: { requestWindow: (o: object) => Promise<Window> } }).documentPictureInPicture;
    if (dpip) {
      try {
        const w = await dpip.requestWindow({ width: 380, height: 560 });
        for (const ss of Array.from(document.styleSheets)) {
          try {
            const st = w.document.createElement('style');
            st.textContent = Array.from(ss.cssRules).map((r) => r.cssText).join('\n');
            w.document.head.appendChild(st);
          } catch { /* 접근할 수 없는 스타일시트는 건너뜀 */ }
        }
        w.document.body.style.cssText = 'margin:0;background:#0b1220;font-family:system-ui,"Malgun Gothic","Apple SD Gothic Neo",sans-serif';
        w.addEventListener('pagehide', () => setPipWin(null));
        setPipWin(w);
        return;
      } catch { /* 지원하지 않거나 거부되면 팝업으로 */ }
    }
    if (!bc.shareChannelId) return;
    const win = window.open(`${location.pathname}#/overlay/${bc.shareChannelId}`, 'inchat-overlay', 'popup,width=380,height=560');
    if (!win) toast('팝업이 차단되었습니다. 브라우저의 팝업 허용 후 다시 눌러 주세요.', 'error');
  };
  // 방송이 끝나면 떠 있던 PiP 채팅 창도 닫는다
  useEffect(() => { if (!bc.isSharing && pipWin) { pipWin.close(); setPipWin(null); } }, [bc.isSharing, pipWin]);

  const onSetBroadcaster = (userId: string, nickname: string, grant: boolean) => {
    if (!grant && !window.confirm(`${nickname}님의 방송 권한을 회수할까요? 방송 중이라면 방송도 종료됩니다.`)) return;
    void guard(async () => {
      await (grant ? chat.actions.grantBroadcaster(userId) : chat.actions.revokeBroadcaster(userId));
      setBansVersion((v) => v + 1);
    }, grant ? `${nickname}님에게 방송 권한을 부여했습니다.` : `${nickname}님의 방송 권한을 회수했습니다.`);
  };
  const onDeleteChannel = async () => {
    if (!channel || !window.confirm(`"${channel.name}" 채널을 삭제할까요? 저장된 메시지도 모두 삭제되며 되돌릴 수 없습니다.`)) return;
    try {
      await api.deleteChannel(channel.id);
      toast('채널을 삭제했습니다.', 'success');
      leave();
      void refresh();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const onCreated = (c: Channel) => { setCreateOpen(false); void refresh(); enter(c.id, 'nick'); toast(`"${c.name}" 채널을 만들었습니다.`, 'success'); };

  // ---- 조각 ----
  const panel = (
    <ChannelPanel
      state={state} user={user} config={config} canModerate={canModerate} canBroadcast={canBroadcast}
      isSharing={bc.isSharingHere} starting={bc.startingHere} sharingElsewhere={sharingElsewhere} shareBlocked={bc.shareBlocked}
      onStart={() => void bc.start()} onStop={() => void bc.stop()}
      onSetNotice={async (b) => { await chat.actions.setNotice(b); toast('공지를 등록했습니다.', 'success'); }}
      onClearNotice={async () => { await chat.actions.clearNotice(); toast('공지를 해제했습니다.', 'success'); }}
      onKick={(userId, nickname) => setKickTarget({ userId, nickname })}
      onListBans={async () => (await chat.actions.listBans()).bans}
      onSetBroadcaster={onSetBroadcaster}
      onListBroadcasters={async () => (await chat.actions.listBroadcasters()).broadcasters}
      onUnban={async (uid): Promise<Ban[]> => { const r = await chat.actions.unban(uid); toast('이용 제한을 해제했습니다.', 'success'); return r.bans; }}
      onDeleteChannel={() => void onDeleteChannel()} bansVersion={bansVersion}
      onRequestBroadcast={(name) => setRequestAdmin(name)}
    />
  );
  const chatEl = (
    <Chat
      state={state} pending={chat.pending} userId={user.id} conn={conn} messageMax={config.limits.messageMax}
      loadingOlder={chat.loadingOlder} canModerate={canModerate}
      onSend={chat.send} onRetry={chat.retry} onDiscard={chat.discard} onLoadOlder={() => void chat.loadOlder()}
      onDelete={onDelete} onKick={(userId, nickname) => setKickTarget({ userId, nickname })} onSetBroadcaster={onSetBroadcaster}
      onRequestBroadcast={canBroadcast ? undefined : (name) => setRequestAdmin(name)}
    />
  );
  const stage = live ? (
    <Stage
      stream={bc.stream} isSharing={bc.isSharingHere} starting={bc.startingHere} view={bc.view} error={bc.error}
      live={state.broadcast.live ? state.broadcast : { live: true, broadcaster: user.nickname }} viewerCount={bc.viewerCount}
      hasAudio={bc.isSharingHere ? bc.localHasAudio : !!state.broadcast.hasAudio}
      onStop={() => void bc.stop()} onRetry={() => void bc.retryWatch()}
      overlayOn={overlayOn} onToggleOverlay={() => setOverlayOn((o) => !o)} onPopOut={() => void popOutChat()}
      overlay={<ChatOverlay messages={state.messages} broadcasterId={state.broadcast.broadcasterId} broadcasterName={state.broadcast.broadcaster ?? user.nickname} className="h-full" />}
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
      {canBroadcast && (
        bc.isSharingHere
          ? <button className="btn-danger !px-3" onClick={() => void bc.stop()}><Icon name="stop" size={14} /><span className="hidden sm:inline">방송 종료</span></button>
          : <button className="btn-primary !px-3" onClick={() => void bc.start()} disabled={bc.share === 'starting' || state.broadcast.live || sharingElsewhere || state.status !== 'joined'}
              title={sharingElsewhere ? '다른 채널에서 방송 중입니다' : state.broadcast.live ? '이미 방송 중입니다' : '화면 공유 방송 시작'}>
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
          <button className="btn-primary" onClick={leave}>로비로 이동</button>
        </div>
      </div>
    </div>
  );

  let content: React.ReactNode;
  if (!activeId) {
    content = <LobbyScreen user={user} channels={channels} loading={loading} onPick={(c) => select(c.id)} onCreate={() => setCreateOpen(true)} />;
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
      <Header user={user} config={config} conn={conn} query={query} onQuery={setQuery} onToggleMenu={() => setMenuOpen((o) => !o)} menuOpen={menuOpen} onUser={onUser} onLogout={onLogout}
        bell={canReview ? <NotificationBell requests={reqs.requests} onGrant={reqs.grant} onDismiss={reqs.dismiss} /> : undefined} />
      <ConnectionBanner conn={conn} />
      {sharingElsewhere && (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-coral-500/40 bg-coral-500/10 px-4 py-2 text-sm">
          <span className="animate-pulse-dot rounded bg-coral-500 px-1.5 py-px text-[10px] font-extrabold text-white">LIVE</span>
          <span className="min-w-0 flex-1 text-mist-100">
            <b>{shareChannel?.name ?? '다른 채널'}</b>에서 방송 중입니다 · 시청자 {bc.viewerCount}명 <span className="text-mist-400">(다른 채널에 있어도 방송은 계속됩니다)</span>
          </span>
          <button className="btn-secondary !py-1 text-xs" onClick={() => bc.shareChannelId && enter(bc.shareChannelId, identities[bc.shareChannelId] ?? 'nick')}>방송 채널로 이동</button>
          <button className="btn-danger !py-1 text-xs" onClick={() => void bc.stop()}><Icon name="stop" size={12} /> 방송 종료</button>
        </div>
      )}
      {bc.error && !activeId && (
        <div role="alert" className="flex items-center gap-2 border-b border-coral-500/40 bg-coral-500/10 px-4 py-2 text-sm text-coral-400">
          <span className="flex-1">{bc.error}</span><button className="underline" onClick={bc.dismissError}>닫기</button>
        </div>
      )}
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
      {entryFor && (
        <EntryDialog
          channel={channels.find((c) => c.id === entryFor) ?? { id: entryFor, name: '채널', description: '' }}
          user={user} initial={identities[entryFor] ?? 'nick'}
          onCancel={() => { setEntryFor(null); if (!activeId && parseHash()) history.replaceState(null, '', location.pathname + location.search); }}
          onConfirm={(mode) => enter(entryFor, mode)}
        />
      )}
      {requestAdmin && activeId && <RequestDialog channelId={activeId} channelName={channel?.name ?? ''} adminName={requestAdmin} onClose={() => setRequestAdmin(null)} />}
      {kickTarget && <KickDialog nickname={kickTarget.nickname} onClose={() => setKickTarget(null)} onConfirm={onKickConfirm} />}
      {pipWin && createPortal(
        <div style={{ height: '100vh', padding: 12, boxSizing: 'border-box' }}>
          <ChatOverlay messages={state.messages} broadcasterId={state.broadcast.broadcasterId} broadcasterName={state.broadcast.broadcaster ?? user.nickname} className="h-full" />
        </div>,
        pipWin.document.body,
      )}
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
