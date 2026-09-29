import { useEffect, useRef, useState } from 'react';
import type { AppNotification, BroadcastRequest, ManagedBroadcaster } from '../lib/types';
import { fmtTime } from '../lib/util';
import { useToast } from '../lib/toast';
import { Icon } from './Icon';

function when(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `오늘 ${fmtTime(ts)}` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${fmtTime(ts)}`;
}

function describe(n: AppNotification): { text: React.ReactNode; canOpen: boolean } {
  const ch = <b>{n.data.channelName ?? '채널'}</b>;
  switch (n.kind) {
    case 'channel_created': return { text: <>새 채널 {ch}이(가) 개설되었어요.{n.data.creator ? <> ({n.data.creator}님)</> : null}</>, canOpen: true };
    case 'broadcast_started': return { text: <>{ch} 채널에서 방송이 시작되었어요.{n.data.broadcaster ? <> ({n.data.broadcaster}님)</> : null}</>, canOpen: true };
    case 'broadcaster_granted': return { text: <>{ch} 채널에서 <b>방송 권한</b>이 부여되었어요. 이제 방송을 시작할 수 있어요.</>, canOpen: true };
    case 'broadcaster_revoked': return { text: <>{ch} 채널의 방송 권한이 회수되었어요.</>, canOpen: false };
    case 'request_declined': return { text: <>{ch} 채널에 보낸 방송 요청이 거절되었어요.</>, canOpen: false };
    case 'manager_appointed': return { text: <>{ch} 채널의 <b>매니저</b>로 임명되었어요. 이 채널에서 사용자를 차단하고 해제할 수 있어요.</>, canOpen: true };
    case 'manager_revoked': return { text: <>{ch} 채널의 매니저 권한이 회수되었어요.</>, canOpen: false };
    default: return { text: '새 알림', canOpen: false };
  }
}

interface Props {
  notifications: AppNotification[];
  unread: number;
  onMarkRead: () => Promise<void>;
  onClear: () => Promise<void>;
  onOpenChannel: (channelId: string) => void;
  /** 채널 관리자/서버 관리자에게만 true: "방송 권한 관리" 탭(요청 처리, 보유자 회수) */
  showManage: boolean;
  requests: BroadcastRequest[];
  holders: ManagedBroadcaster[];
  onGrant: (r: BroadcastRequest) => Promise<void>;
  onDismiss: (r: BroadcastRequest) => Promise<void>;
  onRevokeHolder: (h: ManagedBroadcaster) => Promise<void>;
  onOpenManage: () => void;
}

/** 모든 사용자의 알림 아이콘. 관리자에게는 방송 권한 요청 처리(부여/거절)와 보유자 회수 탭이 추가된다. */
export function NotificationBell(p: Props) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'feed' | 'manage'>('feed');
  const [busy, setBusy] = useState<string | null>(null);
  const [seen, setSeen] = useState<Set<number>>(new Set()); // 열었을 때 안 읽은 항목을 강조하기 위한 스냅샷
  const ref = useRef<HTMLDivElement>(null);

  const total = p.unread + p.requests.length;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    if (open) return close();
    setSeen(new Set(p.notifications.filter((n) => !n.read).map((n) => n.id)));
    // 요청이 있으면 관리 탭을 먼저 보여준다
    setTab(p.showManage && p.requests.length > 0 ? 'manage' : 'feed');
    if (p.showManage) p.onOpenManage();
    setOpen(true);
  };
  function close() {
    setOpen(false);
    if (p.unread > 0) void p.onMarkRead().catch(() => {});
  }

  const run = async (key: string, fn: () => Promise<void>, ok: string) => {
    setBusy(key);
    try { await fn(); toast(ok, 'success'); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  };

  const tabBtn = (id: 'feed' | 'manage', label: string, count: number) => (
    <button role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
      className={`flex-1 border-b-2 px-3 py-2.5 text-sm font-semibold ${tab === id ? 'border-mint-400 text-mint-300' : 'border-transparent text-mist-400 hover:text-mist-100'}`}>
      {label}{count > 0 && <span className="ml-1.5 rounded-full bg-coral-500 px-1.5 text-[10px] font-extrabold text-white">{count}</span>}
    </button>
  );

  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost relative !p-2" onClick={toggle} aria-haspopup="dialog" aria-expanded={open} aria-label={`알림 ${total}건`} title="알림">
        <Icon name="bell" size={20} />
        {total > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-coral-500 px-1 text-[10px] font-extrabold text-white">{total > 9 ? '9+' : total}</span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="알림" className="animate-fade-in absolute right-0 top-full z-40 mt-2 w-[min(24rem,calc(100vw-1.5rem))] rounded-xl border border-ink-600 bg-ink-800 shadow-xl shadow-black/50">
          {p.showManage && <div role="tablist" className="flex border-b border-ink-600">{tabBtn('feed', '알림', p.unread)}{tabBtn('manage', '방송 권한 관리', p.requests.length)}</div>}
          {!p.showManage && <div className="border-b border-ink-600 px-4 py-3 text-sm font-bold">알림</div>}

          {tab === 'feed' && (
            <>
              <ul className="max-h-96 overflow-y-auto">
                {p.notifications.length === 0 && <li className="px-4 py-8 text-center text-sm text-mist-500">새 알림이 없습니다.<br /><span className="text-xs">입장해 본 방에서 방송이 시작되면 여기에 표시돼요.</span></li>}
                {p.notifications.map((n) => {
                  const d = describe(n);
                  return (
                    <li key={n.id} className={`border-b border-ink-700 px-4 py-3 last:border-0 ${seen.has(n.id) ? 'bg-mint-400/8' : ''}`}>
                      <p className="text-sm leading-snug">{d.text}</p>
                      <div className="mt-1 flex items-center gap-3">
                        <span className="text-xs text-mist-500">{when(n.createdAt)}</span>
                        {d.canOpen && n.channelId && <button className="text-xs font-semibold text-mint-300 hover:underline" onClick={() => { close(); p.onOpenChannel(n.channelId!); }}>채널로 이동</button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {p.notifications.length > 0 && (
                <div className="border-t border-ink-600 p-2 text-right">
                  <button className="btn-ghost !py-1 text-xs" onClick={() => void run('clear', p.onClear, '알림을 모두 지웠습니다.')}>모두 지우기</button>
                </div>
              )}
            </>
          )}

          {tab === 'manage' && p.showManage && (
            <div className="max-h-[26rem] overflow-y-auto">
              <h3 className="px-4 pb-1 pt-3 text-xs font-bold uppercase tracking-wider text-mist-500">방송 권한 요청 · {p.requests.length}</h3>
              <ul>
                {p.requests.length === 0 && <li className="px-4 py-3 text-sm text-mist-500">대기 중인 요청이 없습니다.</li>}
                {p.requests.map((r) => (
                  <li key={r.id} className="border-b border-ink-700 px-4 py-3">
                    <p className="text-sm leading-snug"><b>{r.displayName}</b>{r.anonymous && <span className="ml-1 rounded bg-ink-600 px-1 text-[10px] text-mist-300">익명</span>}님이 <b>{r.channelName}</b> 채널에서 방송 권한을 요청했어요.</p>
                    <p className="mt-0.5 text-xs text-mist-500">{when(r.createdAt)}</p>
                    <div className="mt-2 flex gap-2">
                      <button className="btn-primary !py-1 text-xs" disabled={busy === `r${r.id}`} onClick={() => void run(`r${r.id}`, () => p.onGrant(r), `${r.displayName}님에게 방송 권한을 부여했습니다.`)}>부여</button>
                      <button className="btn-secondary !py-1 text-xs" disabled={busy === `r${r.id}`} onClick={() => void run(`r${r.id}`, () => p.onDismiss(r), '요청을 거절했습니다.')}>거절</button>
                    </div>
                  </li>
                ))}
              </ul>
              <h3 className="px-4 pb-1 pt-4 text-xs font-bold uppercase tracking-wider text-mist-500">방송 권한 보유자 · {p.holders.length}</h3>
              <ul className="pb-2">
                {p.holders.length === 0 && <li className="px-4 py-3 text-sm text-mist-500">내가 관리하는 채널에 방송 권한을 가진 사용자가 없습니다.</li>}
                {p.holders.map((h) => (
                  <li key={`${h.channelId}:${h.userId}`} className="flex items-center gap-2 px-4 py-2">
                    <span className="min-w-0 flex-1 text-sm"><b className="block truncate">{h.displayName}</b><span className="block truncate text-xs text-mist-500">{h.channelName}</span></span>
                    <button className="btn-secondary !py-1 text-xs" disabled={busy === `h${h.channelId}${h.userId}`}
                      onClick={() => { if (window.confirm(`${h.displayName}님의 방송 권한을 회수할까요? 방송 중이라면 방송도 종료됩니다.`)) void run(`h${h.channelId}${h.userId}`, () => p.onRevokeHolder(h), '방송 권한을 회수했습니다.'); }}>회수</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
