import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatState } from '../hooks/useChat';
import type { ConnState, Message, Notice, PendingMessage } from '../lib/types';
import { charCount, dayKey, fmtDate, fmtTime } from '../lib/util';
import { Icon } from './Icon';
import { Avatar } from './ProfileMenu';

interface Props {
  state: ChatState;
  pending: PendingMessage[];
  userId: string;
  conn: ConnState;
  messageMax: number;
  loadingOlder: boolean;
  canModerate: boolean;
  onSend: (body: string) => string | null;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
  onLoadOlder: () => void;
  onDelete: (m: Message) => void;
  onKick: (userId: string, nickname: string) => void;
}

export function Chat(p: Props) {
  const { state } = p;
  const items = state.messages;
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prev = useRef({ firstId: 0, lastId: 0, pending: 0, height: 0, top: 0, channel: '' });
  const [newCount, setNewCount] = useState(0);

  const scrollToBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setNewCount(0);
  }, []);

  const onScroll = () => {
    const el = scroller.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    // 이전 메시지를 앞에 붙일 때 현재 보고 있던 위치를 복원하기 위해 스크롤 시점의 값을 기록
    prev.current.top = el.scrollTop;
    prev.current.height = el.scrollHeight;
    if (atBottom.current) setNewCount(0);
    if (el.scrollTop < 40 && state.hasMore && !p.loadingOlder) p.onLoadOlder();
  };

  // 새 메시지/이전 메시지 로딩에 따른 스크롤 처리
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const pv = prev.current;
    const channel = state.channel?.id ?? '';
    const firstId = items[0]?.id ?? 0;
    const lastId = items[items.length - 1]?.id ?? 0;
    const last = items[items.length - 1];
    const lastPending = p.pending.length > pv.pending;

    if (pv.channel !== channel || pv.lastId === 0) {
      // 채널을 처음 열었을 때는 항상 맨 아래로
      el.scrollTop = el.scrollHeight;
      atBottom.current = true;
      setNewCount(0);
    } else if (firstId < pv.firstId && lastId === pv.lastId) {
      // 이전 메시지를 앞에 붙인 경우: 보고 있던 위치 유지
      el.scrollTop = el.scrollHeight - pv.height + pv.top;
    } else if (lastId > pv.lastId || lastPending) {
      const added = items.filter((m) => m.id > pv.lastId && m.userId !== p.userId && m.kind !== 'system').length;
      const mine = lastPending || last?.userId === p.userId;
      if (atBottom.current || mine) scrollToBottom();
      else if (added > 0) setNewCount((c) => c + added);
    }
    prev.current = { firstId, lastId, pending: p.pending.length, height: el.scrollHeight, top: el.scrollTop, channel };
  }, [items, p.pending.length, state.channel?.id, p.userId, scrollToBottom]); // eslint-disable-line react-hooks/exhaustive-deps

  // 입력창 높이 변화/모바일 키보드로 영역이 줄어들 때 맨 아래 유지
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows: React.ReactNode[] = [];
  let lastDay = '';
  let lastUser: string | null = null;
  let lastAt = 0;
  for (const m of items) {
    const dk = dayKey(m.createdAt);
    if (dk !== lastDay) {
      rows.push(<div key={`d${dk}`} className="my-3 flex items-center gap-3 text-xs text-mist-500"><span className="h-px flex-1 bg-ink-600" />{fmtDate(m.createdAt)}<span className="h-px flex-1 bg-ink-600" /></div>);
      lastDay = dk; lastUser = null;
    }
    const grouped = m.kind === 'user' && m.userId === lastUser && m.createdAt - lastAt < 5 * 60_000;
    rows.push(<MessageRow key={m.id} m={m} mine={m.userId === p.userId} grouped={grouped} canModerate={p.canModerate} ownerId={state.channel?.ownerId ?? null} onDelete={p.onDelete} onKick={p.onKick} />);
    lastUser = m.kind === 'user' ? m.userId : null;
    lastAt = m.createdAt;
  }

  const joined = state.status === 'joined';
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-800 lg:border-l lg:border-ink-600" aria-label="실시간 채팅">
      <div className="flex items-center justify-between border-b border-ink-600 px-4 py-2.5">
        <h2 className="text-sm font-bold">실시간 채팅</h2>
        <span className="flex items-center gap-1.5 text-xs text-mist-400" aria-label={`${state.participants.length}명 접속 중`}>
          <Icon name="users" size={14} /> {state.participants.length}명 접속
        </span>
      </div>
      {state.notice && <NoticeBar notice={state.notice} />}
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" className="absolute inset-0 overflow-y-auto px-3 py-3">
          {state.hasMore && (
            <button className="btn-ghost mx-auto mb-2 flex !py-1.5 text-xs" onClick={p.onLoadOlder} disabled={p.loadingOlder}>
              <Icon name="chevronUp" size={14} /> {p.loadingOlder ? '불러오는 중…' : '이전 메시지 불러오기'}
            </button>
          )}
          {state.status === 'joining' && items.length === 0 && <p className="py-8 text-center text-sm text-mist-500">채널에 입장하는 중…</p>}
          {joined && items.length === 0 && p.pending.length === 0 && (
            <p className="py-10 text-center text-sm text-mist-500">아직 메시지가 없어요.<br />첫 인사를 남겨 보세요!</p>
          )}
          {rows}
          {p.pending.map((x) => <PendingRow key={x.clientId} x={x} onRetry={p.onRetry} onDiscard={p.onDiscard} />)}
        </div>
        {newCount > 0 && (
          <button onClick={scrollToBottom} className="animate-fade-in absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-mint-400 px-4 py-2 text-sm font-bold text-ink-950 shadow-lg shadow-black/40 hover:bg-mint-300">
            <Icon name="arrowDown" size={15} /> 새 메시지 {newCount}개
          </button>
        )}
      </div>
      <Composer conn={p.conn} joined={joined} max={p.messageMax} onSend={p.onSend} channelName={state.channel?.name ?? ''} />
    </section>
  );
}

function NoticeBar({ notice }: { notice: Notice }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-ink-600 bg-mint-400/8 px-4 py-2.5" role="note">
      <button className="flex w-full items-start gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="공지 펼치기/접기">
        <Icon name="pin" size={15} className="mt-0.5 shrink-0 text-mint-300" />
        <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-mist-100 ${open ? '' : 'line-clamp-2'}`}>{notice.body}</span>
      </button>
      {open && notice.authorNickname && <p className="mt-1 pl-6 text-xs text-mist-500">{notice.authorNickname} · {fmtTime(notice.updatedAt)}</p>}
    </div>
  );
}

function MessageRow({ m, mine, grouped, canModerate, ownerId, onDelete, onKick }: {
  m: Message; mine: boolean; grouped: boolean; canModerate: boolean; ownerId: string | null;
  onDelete: (m: Message) => void; onKick: (userId: string, nickname: string) => void;
}) {
  if (m.kind === 'system') {
    return <div className="my-2 text-center"><span className="inline-block rounded-full bg-ink-700 px-3 py-1 text-xs text-mist-400">{m.body}</span></div>;
  }
  const canKick = canModerate && !mine && m.userId && m.userId !== ownerId;
  const actions = canModerate && !m.deleted && (
    <span className="flex shrink-0 items-center gap-0.5 self-center opacity-100 transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100">
      <button className="rounded p-1 text-mist-500 hover:bg-ink-600 hover:text-coral-400" onClick={() => onDelete(m)} aria-label="메시지 삭제" title="메시지 삭제"><Icon name="trash" size={14} /></button>
      {canKick && <button className="rounded p-1 text-mist-500 hover:bg-ink-600 hover:text-coral-400" onClick={() => onKick(m.userId!, m.nickname ?? '')} aria-label={`${m.nickname} 강퇴`} title="강퇴"><Icon name="ban" size={14} /></button>}
    </span>
  );

  // 삭제된 메시지 (내용은 서버가 보내지 않음)
  const bodyEl = m.deleted
    ? <span className="italic text-mist-500">관리자가 삭제한 메시지입니다.</span>
    : <span className="whitespace-pre-wrap break-words">{m.body}</span>; // 항상 일반 텍스트로 렌더링

  if (mine) {
    return (
      <div className={`group flex items-end justify-end gap-1.5 ${grouped ? 'mt-0.5' : 'mt-3'}`}>
        {actions}
        <time className="mb-0.5 shrink-0 text-[11px] text-mist-500" dateTime={new Date(m.createdAt).toISOString()}>{fmtTime(m.createdAt)}</time>
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-mint-500/25 px-3 py-2 text-sm leading-relaxed text-mist-100 ring-1 ring-mint-400/30">{bodyEl}</div>
      </div>
    );
  }
  return (
    <div className={`group flex gap-2.5 ${grouped ? 'mt-0.5' : 'mt-3'}`}>
      <div className="w-8 shrink-0">{!grouped && <Avatar nickname={m.nickname ?? '?'} color={m.color ?? '#64748f'} />}</div>
      <div className="min-w-0 max-w-[85%]">
        {!grouped && (
          <p className="mb-0.5 flex items-baseline gap-2">
            <span className="truncate text-sm font-bold" style={{ color: m.color ?? undefined }}>{m.nickname ?? '알 수 없음'}</span>
            <time className="text-[11px] text-mist-500" dateTime={new Date(m.createdAt).toISOString()}>{fmtTime(m.createdAt)}</time>
          </p>
        )}
        <div className="flex gap-1">
          <div className="rounded-2xl rounded-tl-md bg-ink-700 px-3 py-2 text-sm leading-relaxed text-mist-100">{bodyEl}</div>
          {actions}
        </div>
      </div>
    </div>
  );
}

function PendingRow({ x, onRetry, onDiscard }: { x: PendingMessage; onRetry: (id: string) => void; onDiscard: (id: string) => void }) {
  const failed = x.status === 'failed';
  return (
    <div className="mt-3 flex flex-col items-end gap-1">
      <div className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3 py-2 text-sm leading-relaxed ${failed ? 'bg-coral-500/15 text-mist-200 ring-1 ring-coral-500/50' : 'bg-mint-500/10 text-mist-300 ring-1 ring-mint-400/15'}`}>{x.body}</div>
      {failed ? (
        <div className="flex max-w-[90%] flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-coral-400" role="alert">
          <span>전송 실패: {x.error}</span>
          <button className="font-bold underline" onClick={() => onRetry(x.clientId)}>다시 보내기</button>
          <button className="text-mist-400 underline" onClick={() => onDiscard(x.clientId)}>삭제</button>
        </div>
      ) : <span className="text-[11px] text-mist-500">전송 중…</span>}
    </div>
  );
}

function Composer({ conn, joined, max, onSend, channelName }: { conn: ConnState; joined: boolean; max: number; onSend: (b: string) => string | null; channelName: string }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const compEnd = useRef(0);
  const n = charCount(text.trim());
  const over = n > max;
  const offline = conn !== 'connected' || !joined;

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  const submit = () => {
    if (offline) return setError('연결이 복구되면 전송할 수 있어요. 입력한 내용은 그대로 유지됩니다.');
    const err = onSend(text);
    setError(err);
    if (!err) setText('');
    ta.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // 한글 등 IME 조합 중의 Enter 는 조합 확정용이므로 전송하지 않는다.
    // (Chrome: isComposing / Safari: 조합 종료 직후 keyCode 229 또는 compositionend 직후 keydown)
    if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229 || performance.now() - compEnd.current < 30) return;
    e.preventDefault();
    submit();
  };

  return (
    <div className="border-t border-ink-600 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {error && <p role="alert" className="mb-2 text-xs text-coral-400">{error}</p>}
      <div className="flex items-end gap-2">
        <textarea
          ref={ta} rows={1} value={text} enterKeyHint="send" aria-label="메시지 입력"
          className={`field max-h-33 min-h-10 flex-1 resize-none !rounded-xl !py-2.5 leading-normal ${over ? '!border-coral-500' : ''}`}
          placeholder={offline ? '연결 중… 연결되면 보낼 수 있어요' : `${channelName}에 메시지 보내기`}
          onChange={(e) => { setText(e.target.value); setError(null); }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; compEnd.current = performance.now(); }}
        />
        <button className="btn-primary !h-10 !w-11 shrink-0 !p-0" onClick={submit} disabled={offline || n === 0 || over} aria-label="메시지 전송" type="button">
          <Icon name="send" size={18} />
        </button>
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-mist-500">
        <span className="hidden sm:inline">Enter 전송 · Shift+Enter 줄바꿈</span>
        {n > max * 0.8 && <span className={`ml-auto text-xs ${over ? 'text-coral-400' : ''}`}>{n}/{max}</span>}
      </div>
    </div>
  );
}
