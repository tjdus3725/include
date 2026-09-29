import { useEffect, useState } from 'react';
import type { ChatState } from '../hooks/useChat';
import type { Ban, Broadcaster, User } from '../lib/types';
import type { AppConfig } from '../lib/types';
import { Icon } from './Icon';
import { MoreMenu } from './MoreMenu';
import { Avatar } from './ProfileMenu';

interface Props {
  state: ChatState;
  user: User;
  config: AppConfig;
  canModerate: boolean;
  canBroadcast: boolean;
  isSharing: boolean;
  starting: boolean;
  /** 이 채널이 아닌 다른 채널에서 내가 방송 중 */
  sharingElsewhere: boolean;
  shareBlocked: null | 'insecure' | 'unsupported';
  onStart: () => void;
  onStop: () => void;
  onSetNotice: (body: string) => Promise<void>;
  onClearNotice: () => Promise<void>;
  onKick: (userId: string, nickname: string) => void;
  onListBans: () => Promise<Ban[]>;
  onUnban: (userId: string) => Promise<Ban[]>;
  onSetBroadcaster: (userId: string, nickname: string, grant: boolean) => void;
  onListBroadcasters: () => Promise<Broadcaster[]>;
  onDeleteChannel: () => void;
  bansVersion: number;
  /** 일반 사용자가 관리자 계정을 눌렀을 때 (방송 요청 보내기) */
  onRequestBroadcast: (adminName: string) => void;
}

const roleBadge = { owner: '채널 관리자', admin: '서버 관리자', broadcaster: '방송 권한', member: '' } as const;

export function ChannelPanel(p: Props) {
  const { state } = p;
  const ch = state.channel;
  const [noticeText, setNoticeText] = useState('');
  const [noticeBusy, setNoticeBusy] = useState(false);
  const [noticeErr, setNoticeErr] = useState<string | null>(null);
  const [bans, setBans] = useState<Ban[]>([]);
  const [banErr, setBanErr] = useState<string | null>(null);
  const [casters, setCasters] = useState<Broadcaster[]>([]);

  useEffect(() => { setNoticeText(state.notice?.body ?? ''); }, [state.notice?.body, ch?.id]);
  useEffect(() => {
    if (!p.canModerate || state.status !== 'joined') return;
    p.onListBans().then((b) => { setBans(b); setBanErr(null); }).catch((e: Error) => setBanErr(e.message));
  }, [p.canModerate, ch?.id, state.status, p.bansVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!p.canModerate || state.status !== 'joined') return;
    p.onListBroadcasters().then(setCasters).catch(() => {});
  }, [p.canModerate, ch?.id, state.status, p.bansVersion, state.participants]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ch) return <div className="p-4 text-sm text-mist-500">채널 정보를 불러오는 중…</div>;
  const live = state.broadcast.live;
  const httpsUrl = p.config.https ? p.config.https.url : null;

  const saveNotice = async () => {
    setNoticeBusy(true);
    setNoticeErr(null);
    try { await p.onSetNotice(noticeText); } catch (e) { setNoticeErr((e as Error).message); } finally { setNoticeBusy(false); }
  };
  const clearNotice = async () => {
    setNoticeBusy(true);
    setNoticeErr(null);
    try { await p.onClearNotice(); setNoticeText(''); } catch (e) { setNoticeErr((e as Error).message); } finally { setNoticeBusy(false); }
  };

  const section = 'border-b border-ink-600 p-4';
  const h = 'mb-2.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-mist-500';
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-ink-800 lg:border-l lg:border-ink-600" aria-label="채널 정보">
      <div className={section}>
        <h3 className={h}><Icon name="radio" size={14} /> 방송</h3>
        {p.canBroadcast ? (
          <>
            {p.isSharing ? (
              <button className="btn-danger w-full" onClick={p.onStop}><Icon name="stop" size={14} /> 방송 종료</button>
            ) : (
              <button className="btn-primary w-full" onClick={p.onStart} disabled={p.starting || live || p.sharingElsewhere}>
                <Icon name="monitor" size={16} /> {p.starting ? '화면 선택 중…' : live ? '이미 방송 중입니다' : p.sharingElsewhere ? '다른 채널에서 방송 중입니다' : '화면 공유 방송 시작'}
              </button>
            )}
            {p.shareBlocked === 'insecure' && (
              <p className="mt-2 rounded-lg bg-amber-400/10 p-2.5 text-xs leading-relaxed text-amber-400" role="note">
                지금 주소는 보안 연결이 아니어서 브라우저가 화면 공유를 막습니다. 서버 컴퓨터에서는 <b>localhost</b> 로, 다른 기기에서는 <b>HTTPS</b> 주소로 접속해 주세요.
                {httpsUrl ? <> HTTPS 주소: <a className="underline" href={httpsUrl}>{httpsUrl}</a></> : ' (서버에서 npm run cert 후 HTTPS=true 설정 필요)'}
              </p>
            )}
            {p.shareBlocked === 'unsupported' && (
              <p className="mt-2 rounded-lg bg-amber-400/10 p-2.5 text-xs leading-relaxed text-amber-400" role="note">이 브라우저/기기는 화면 공유를 지원하지 않습니다. 데스크톱 Chrome·Edge·Firefox 에서 방송할 수 있어요.</p>
            )}
          </>
        ) : (
          <p className="text-sm text-mist-400">{live ? `${state.broadcast.broadcaster}님이 방송 중입니다.` : '방송은 채널 관리자만 시작할 수 있습니다.'}</p>
        )}
      </div>

      {p.canModerate && (
        <div className={section}>
          <h3 className={h}><Icon name="pin" size={14} /> 공지 고정</h3>
          <textarea className="field resize-none" rows={3} value={noticeText} onChange={(e) => setNoticeText(e.target.value)} placeholder="채팅 상단에 고정할 공지를 입력하세요" maxLength={p.config.limits.noticeMax + 50} aria-label="공지 내용" />
          <div className="mt-2 flex items-center gap-2">
            <button className="btn-primary !py-1.5" onClick={saveNotice} disabled={noticeBusy || !noticeText.trim()}>공지 등록</button>
            {state.notice && <button className="btn-secondary !py-1.5" onClick={clearNotice} disabled={noticeBusy}>공지 해제</button>}
            <span className="ml-auto text-xs text-mist-500">{[...noticeText].length}/{p.config.limits.noticeMax}</span>
          </div>
          {noticeErr && <p role="alert" className="mt-2 text-xs text-coral-400">{noticeErr}</p>}
        </div>
      )}

      <div className={section}>
        <h3 className={h}><Icon name="users" size={14} /> 참여자 · {state.participants.length}</h3>
        <ul className="space-y-1">
          {state.participants.map((u) => (
            <li key={u.id} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-ink-700">
              {!p.canBroadcast && (u.role === 'owner' || u.role === 'admin') && u.id !== p.user.id ? (
                <button className="flex min-w-0 flex-1 items-center gap-2.5 rounded text-left hover:underline focus-visible:outline-2 focus-visible:outline-mint-400" onClick={() => p.onRequestBroadcast(u.nickname)} title="눌러서 방송 요청 보내기" aria-label={`${u.nickname} 관리자에게 방송 요청 보내기`}>
                  <Avatar nickname={u.nickname} color={u.color} size={28} />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: u.color }}>{u.nickname}</span>
                </button>
              ) : (
                <>
                  <Avatar nickname={u.nickname} color={u.color} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="truncate text-sm font-semibold" style={{ color: u.color }}>{u.nickname}</span>
                    {u.id === p.user.id && <span className="ml-1 text-xs text-mist-500">(나)</span>}
                  </span>
                </>
              )}
              {u.broadcasting && <span className="rounded bg-coral-500 px-1.5 py-px text-[10px] font-extrabold text-white">방송 중</span>}
              {roleBadge[u.role] && <span className="rounded bg-mint-400/15 px-1.5 py-px text-[10px] font-bold text-mint-300">{roleBadge[u.role]}</span>}
              {p.canModerate && u.id !== p.user.id && (u.role === 'member' || u.role === 'broadcaster') && (
                <MoreMenu label={`${u.nickname} 관리 메뉴`} items={[
                  u.role === 'broadcaster'
                    ? { label: '방송 권한 회수', icon: 'stop', onClick: () => p.onSetBroadcaster(u.id, u.nickname, false) }
                    : { label: '방송 권한 부여', icon: 'radio', onClick: () => p.onSetBroadcaster(u.id, u.nickname, true) },
                  { label: '강퇴', icon: 'ban', danger: true, onClick: () => p.onKick(u.id, u.nickname) },
                ]} />
              )}
            </li>
          ))}
          {state.participants.length === 0 && <li className="text-sm text-mist-500">접속 중인 사람이 없습니다.</li>}
        </ul>
      </div>

      {p.canModerate && (
        <div className={section}>
          <h3 className={h}><Icon name="radio" size={14} /> 방송 권한 보유자 · {casters.length}</h3>
          <ul className="space-y-1.5">
            {casters.map((c) => (
              <li key={c.userId} className="flex items-center gap-2 rounded-lg bg-ink-700 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-semibold">{c.nickname}</span>
                <button className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => p.onSetBroadcaster(c.userId, c.nickname, false)}>회수</button>
              </li>
            ))}
            {casters.length === 0 && <li className="text-sm text-mist-500">관리자 외에 방송 권한을 가진 사용자가 없습니다. 참여자 옆 ⋮ 메뉴에서 부여할 수 있어요.</li>}
          </ul>
        </div>
      )}

      {p.canModerate && (
        <div className={section}>
          <h3 className={h}><Icon name="ban" size={14} /> 이용 제한 목록 · {bans.length}</h3>
          {banErr && <p role="alert" className="text-xs text-coral-400">{banErr}</p>}
          <ul className="space-y-1.5">
            {bans.map((b) => (
              <li key={b.userId} className="flex items-center gap-2 rounded-lg bg-ink-700 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{b.nickname}</span>
                  <span className="block text-xs text-mist-500">{b.expiresAt ? `${new Date(b.expiresAt).toLocaleString('ko-KR')}까지` : '기한 없음'}{b.reason ? ` · ${b.reason}` : ''}</span>
                </span>
                <button className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => p.onUnban(b.userId).then(setBans).catch((e: Error) => setBanErr(e.message))}>해제</button>
              </li>
            ))}
            {bans.length === 0 && !banErr && <li className="text-sm text-mist-500">제한된 사용자가 없습니다.</li>}
          </ul>
        </div>
      )}

      {p.canModerate && !ch.isDefault && (
        <div className="p-4">
          <button className="btn-ghost w-full !text-coral-400 hover:!bg-coral-500/10" onClick={p.onDeleteChannel}><Icon name="trash" size={15} /> 채널 삭제</button>
        </div>
      )}
    </div>
  );
}
