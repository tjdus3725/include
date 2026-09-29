import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import type { AppConfig, User } from '../lib/types';
import { copyText } from '../lib/util';
import { Icon } from './Icon';
import { Modal } from './Modal';

export function Avatar({ nickname, color, size = 32 }: { nickname: string; color: string; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-ink-950" aria-hidden="true"
      style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}>
      {[...nickname][0]?.toUpperCase()}
    </span>
  );
}

export function ProfileMenu({ user, config, onUser, onLogout }: { user: User; config: AppConfig; onUser: (u: User) => void; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<null | 'profile' | 'admin' | 'invite'>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const item = 'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-mist-200 hover:bg-ink-600 focus-visible:outline-2 focus-visible:outline-mint-400';
  return (
    <div className="relative" ref={ref}>
      <button className="flex items-center gap-2 rounded-full py-1 pl-1 pr-3 hover:bg-ink-700 focus-visible:outline-2 focus-visible:outline-mint-400" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="내 프로필">
        <Avatar nickname={user.nickname} color={user.color} />
        <span className="hidden max-w-32 truncate text-sm font-semibold sm:block">{user.nickname}</span>
        {user.isAdmin && <span className="hidden rounded bg-mint-400/15 px-1.5 py-px text-[10px] font-bold text-mint-300 sm:block">서버 관리자</span>}
      </button>
      {open && (
        <div role="menu" className="animate-fade-in absolute right-0 top-full z-40 mt-2 w-60 rounded-xl border border-ink-600 bg-ink-800 p-1.5 shadow-xl shadow-black/50">
          <div className="flex items-center gap-3 border-b border-ink-600 px-3 pb-3 pt-2">
            <Avatar nickname={user.nickname} color={user.color} size={36} />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{user.nickname}</p>
              <p className="text-xs text-mist-500">{user.isAdmin ? '서버 관리자' : '일반 사용자'}</p>
            </div>
          </div>
          <div className="pt-1.5">
            <button role="menuitem" className={item} onClick={() => { setOpen(false); setDialog('profile'); }}><Icon name="user" size={16} /> 프로필 수정</button>
            <button role="menuitem" className={item} onClick={() => { setOpen(false); setDialog('invite'); }}><Icon name="info" size={16} /> 접속 주소 · 화면 공유 안내</button>
            {!user.isAdmin && <button role="menuitem" className={item} onClick={() => { setOpen(false); setDialog('admin'); }}><Icon name="shield" size={16} /> 서버 관리자 인증</button>}
            <button role="menuitem" className={`${item} text-coral-400`} onClick={() => { setOpen(false); onLogout(); }}><Icon name="logout" size={16} /> 나가기(로그아웃)</button>
          </div>
        </div>
      )}
      {dialog === 'profile' && <ProfileDialog user={user} config={config} onClose={() => setDialog(null)} onUser={onUser} />}
      {dialog === 'admin' && <AdminDialog config={config} onClose={() => setDialog(null)} onUser={onUser} />}
      {dialog === 'invite' && <InviteDialog config={config} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ProfileDialog({ user, config, onClose, onUser }: { user: User; config: AppConfig; onClose: () => void; onUser: (u: User) => void }) {
  const toast = useToast();
  const [nick, setNick] = useState(user.nickname);
  const [color, setColor] = useState(user.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const patch: { nickname?: string; color?: string } = {};
      if (nick.trim() !== user.nickname) patch.nickname = nick.trim();
      if (color !== user.color) patch.color = color;
      if (Object.keys(patch).length) onUser((await api.updateMe(patch)).user);
      toast('프로필을 저장했습니다.', 'success');
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="프로필 수정" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="pf-nick" className="mb-1.5 block text-sm font-medium">닉네임</label>
          <input id="pf-nick" className="field" value={nick} onChange={(e) => setNick(e.target.value)} autoComplete="off" />
          <p className="mt-1 text-xs text-mist-500">권한은 닉네임이 아니라 세션에 묶여 있어, 닉네임을 바꿔도 관리 권한은 이동하지 않습니다.</p>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">프로필 색상</legend>
          <div className="flex flex-wrap gap-2">
            {config.colors.map((c) => (
              <button type="button" key={c} onClick={() => setColor(c)} aria-label={`색상 ${c}`} aria-pressed={color === c}
                className={`h-8 w-8 rounded-full border-2 transition ${color === c ? 'scale-110 border-white' : 'border-transparent hover:scale-105'}`} style={{ background: c }} />
            ))}
          </div>
        </fieldset>
        {error && <p role="alert" className="text-sm text-coral-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>취소</button>
          <button className="btn-primary" disabled={busy}>저장</button>
        </div>
      </form>
    </Modal>
  );
}

function AdminDialog({ config, onClose, onUser }: { config: AppConfig; onClose: () => void; onUser: (u: User) => void }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onUser((await api.claimAdmin(code)).user);
      toast('서버 관리자로 인증되었습니다.', 'success');
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="서버 관리자 인증" onClose={onClose}>
      {!config.adminEnabled ? (
        <p className="text-sm leading-relaxed text-mist-300">서버 관리자 기능이 꺼져 있습니다. 서버 컴퓨터의 <code className="rounded bg-ink-700 px-1">.env</code> 파일에 <code className="rounded bg-ink-700 px-1">ADMIN_CODE</code> 를 설정하고 서버를 다시 시작하세요. (<code className="rounded bg-ink-700 px-1">npm run setup</code> 이 무작위 코드를 만들어 줍니다)</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm leading-relaxed text-mist-300">서버 컴퓨터의 <code className="rounded bg-ink-700 px-1">.env</code> 에 있는 관리자 코드를 입력하면 모든 방(다른 사람이 만든 방 포함)을 관리하고 방송할 수 있습니다.</p>
          <input type="password" className="field" value={code} onChange={(e) => setCode(e.target.value)} placeholder="관리자 코드" autoComplete="off" aria-label="관리자 코드" />
          {error && <p role="alert" className="text-sm text-coral-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>취소</button>
            <button className="btn-primary" disabled={busy || !code}>인증</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function InviteDialog({ config, onClose }: { config: AppConfig; onClose: () => void }) {
  const toast = useToast();
  const secure = window.isSecureContext;
  const copy = async (t: string) => toast((await copyText(t)) ? '주소를 복사했습니다.' : '복사하지 못했습니다. 직접 선택해 복사해 주세요.', 'info');
  const urls = config.lanUrls;
  const httpsBase = config.https;
  // 기본 포트(https 443)면 포트 번호를 생략한 주소가 된다
  const httpsUrls = httpsBase ? urls.map((u) => u.replace(/^http:\/\/([^:/]+)(?::\d+)?/, `https://$1${httpsBase.port === 443 ? '' : `:${httpsBase.port}`}`)) : [];
  const all = [...httpsUrls, ...urls];
  const [selected, setSelected] = useState(urls[0] ?? all[0] ?? '');
  const [qr, setQr] = useState('');

  // QR 코드는 브라우저에서 직접 생성한다 (외부 서비스로 주소를 보내지 않음)
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    QRCode.toString(selected, { type: 'svg', margin: 1, width: 192, errorCorrectionLevel: 'M' })
      .then((svg) => { if (alive) setQr(svg); })
      .catch(() => { if (alive) setQr(''); });
    return () => { alive = false; };
  }, [selected]);

  return (
    <Modal title="접속 주소 · 화면 공유 안내" onClose={onClose} wide>
      <div className="space-y-5 text-sm">
        <section>
          <h3 className="mb-2 font-bold">같은 네트워크의 다른 기기에서 접속할 주소</h3>
          <div className="flex flex-col gap-4 sm:flex-row">
            <ul className="min-w-0 flex-1 space-y-1.5">
              {all.map((u) => (
                <li key={u} className={`flex items-center gap-2 rounded-lg px-3 py-2 ${selected === u ? 'bg-ink-600 ring-1 ring-mint-400/50' : 'bg-ink-700'}`}>
                  <button className="min-w-0 flex-1 truncate text-left" onClick={() => setSelected(u)} aria-pressed={selected === u} title="QR 코드로 보기"><code>{u}</code></button>
                  {u.startsWith('https') && <span className="rounded bg-mint-400/15 px-1.5 text-[10px] font-bold text-mint-300">화면 공유 가능</span>}
                  <button className="btn-ghost !p-1.5" onClick={() => copy(u)} aria-label={`${u} 복사`}><Icon name="copy" size={15} /></button>
                </li>
              ))}
              {all.length === 0 && <li className="text-mist-400">내부 IP 를 찾지 못했습니다. Wi-Fi/LAN 연결을 확인하세요.</li>}
            </ul>
            {qr && (
              <figure className="mx-auto shrink-0 text-center">
                <div className="rounded-lg bg-white p-1.5" role="img" aria-label={`${selected} 접속 QR 코드`} dangerouslySetInnerHTML={{ __html: qr }} />
                <figcaption className="mt-1.5 max-w-48 break-all text-xs text-mist-400">스마트폰 카메라로 스캔<br />{selected}</figcaption>
              </figure>
            )}
          </div>
          <p className="mt-2 text-xs text-mist-500">주소를 누르면 해당 주소의 QR 코드가 표시됩니다. 서버 PC 의 IP 가 바뀌면 주소도 바뀌므로 공유기에서 IP 를 고정해 두세요.</p>
        </section>
        <section className="rounded-lg border border-ink-600 p-3 leading-relaxed text-mist-300">
          <h3 className="mb-1 font-bold text-mist-100">화면 공유(방송) 안내</h3>
          <ul className="list-disc space-y-1 pl-5">
            <li><b>시청·채팅</b>은 http:// 주소로도 됩니다.</li>
            <li><b>방송(화면 공유 시작)</b>은 브라우저 정책상 <b>HTTPS</b> 또는 서버 컴퓨터의 <b>localhost</b> 에서만 가능합니다.</li>
            <li>현재 접속 상태: {secure ? <span className="text-mint-300">보안 컨텍스트 (방송 가능)</span> : <span className="text-amber-400">보안 컨텍스트 아님 (방송 불가, 시청·채팅만 가능)</span>}</li>
            {config.https ? (
              <li>다른 기기에서 HTTPS 경고 없이 쓰려면 <a className="text-mint-300 underline" href={config.https.caUrl}>로컬 인증서(CA)를 내려받아</a> 신뢰 등록하세요. (README 참고)</li>
            ) : (
              <li>서버에서 <code className="rounded bg-ink-700 px-1">npm run cert</code> 실행 후 <code className="rounded bg-ink-700 px-1">.env</code> 의 <code className="rounded bg-ink-700 px-1">HTTPS=true</code> 로 바꿔 서버를 다시 시작하세요.</li>
            )}
            <li>스마트폰 브라우저는 대부분 화면 공유(방송)를 지원하지 않지만 시청은 가능합니다.</li>
          </ul>
        </section>
      </div>
    </Modal>
  );
}
