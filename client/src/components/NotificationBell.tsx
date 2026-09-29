import { useEffect, useRef, useState } from 'react';
import type { BroadcastRequest } from '../lib/types';
import { fmtTime } from '../lib/util';
import { useToast } from '../lib/toast';
import { Icon } from './Icon';

function when(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `오늘 ${fmtTime(ts)}` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${fmtTime(ts)}`;
}

/** 관리자 헤더의 알림: 누가 언제 어느 채널에서 방송 권한을 요청했는지 보고 바로 부여/무시한다 */
export function NotificationBell({ requests, onGrant, onDismiss }: {
  requests: BroadcastRequest[]; onGrant: (r: BroadcastRequest) => Promise<void>; onDismiss: (r: BroadcastRequest) => Promise<void>;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const act = async (r: BroadcastRequest, kind: 'grant' | 'dismiss') => {
    setBusyId(r.id);
    try {
      await (kind === 'grant' ? onGrant(r) : onDismiss(r));
      toast(kind === 'grant' ? `${r.displayName}님에게 방송 권한을 부여했습니다.` : '요청을 무시했습니다.', kind === 'grant' ? 'success' : 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost relative !p-2" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} aria-label={`알림 ${requests.length}건`} title="방송 권한 요청 알림">
        <Icon name="bell" size={20} />
        {requests.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-coral-500 px-1 text-[10px] font-extrabold text-white">{requests.length > 9 ? '9+' : requests.length}</span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="방송 권한 요청 알림" className="animate-fade-in absolute right-0 top-full z-40 mt-2 w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border border-ink-600 bg-ink-800 shadow-xl shadow-black/50">
          <div className="border-b border-ink-600 px-4 py-3 text-sm font-bold">방송 권한 요청 · {requests.length}</div>
          <ul className="max-h-96 overflow-y-auto">
            {requests.length === 0 && <li className="px-4 py-8 text-center text-sm text-mist-500">새 요청이 없습니다.</li>}
            {requests.map((r) => (
              <li key={r.id} className="border-b border-ink-700 px-4 py-3 last:border-0">
                <p className="text-sm leading-snug"><b>{r.displayName}</b>{r.anonymous && <span className="ml-1 rounded bg-ink-600 px-1 text-[10px] text-mist-300">익명</span>}님이 <b>{r.channelName}</b> 채널에서 방송 권한을 요청했어요.</p>
                <p className="mt-0.5 text-xs text-mist-500">{when(r.createdAt)}</p>
                <div className="mt-2 flex gap-2">
                  <button className="btn-primary !py-1 text-xs" disabled={busyId === r.id} onClick={() => void act(r, 'grant')}>방송 권한 부여</button>
                  <button className="btn-secondary !py-1 text-xs" disabled={busyId === r.id} onClick={() => void act(r, 'dismiss')}>무시</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
