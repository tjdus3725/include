import { useState, type FormEvent } from 'react';
import type { AppConfig } from '../lib/types';

export function LoginScreen({ config, onLogin, bootError, onRetry }: {
  config: AppConfig | null; onLogin: (nick: string) => Promise<void>; bootError: string | null; onRetry: () => void;
}) {
  const [nick, setNick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const min = config?.limits.nicknameMin ?? 2;
  const max = config?.limits.nicknameMax ?? 12;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = nick.trim();
    const len = [...v].length;
    if (len < min || len > max) return setError(`닉네임은 ${min}~${max}자로 입력해 주세요.`);
    if (!/^[가-힣A-Za-z0-9_-]+$/.test(v)) return setError('닉네임에는 한글, 영문, 숫자, 밑줄(_), 하이픈(-)만 사용할 수 있습니다.');
    setBusy(true);
    setError(null);
    try {
      await onLogin(v);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        {/* 제공된 로고 이미지는 수정 없이 그대로 사용 */}
        <img src="/logo.webp" alt="InChat" className="mx-auto mb-6 w-full max-w-xs rounded-2xl border border-ink-600" />
        <div className="card p-6 shadow-xl shadow-black/30">
          <h1 className="text-xl font-bold">우리 안에서 연결되는 대화</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-mist-400">
            같은 네트워크에 있는 사람들과 실시간으로 채팅하고 화면을 공유해 보세요. 닉네임만 정하면 바로 입장할 수 있어요.
          </p>
          {bootError ? (
            <div role="alert" className="mt-5 rounded-lg border border-coral-500/50 bg-coral-500/10 p-3 text-sm text-coral-400">
              {bootError}
              <button className="btn-secondary mt-3 w-full" onClick={onRetry}>다시 시도</button>
            </div>
          ) : (
            <form onSubmit={submit} className="mt-5 space-y-3" noValidate>
              <div>
                <label htmlFor="nick" className="mb-1.5 block text-sm font-medium text-mist-200">닉네임</label>
                <input id="nick" className="field !py-2.5 !text-base" value={nick} autoFocus autoComplete="off" autoCapitalize="off" spellCheck={false}
                  placeholder="예: 코딩하는고양이" onChange={(e) => { setNick(e.target.value); setError(null); }} aria-describedby="nick-help" aria-invalid={!!error} />
                <p id="nick-help" className="mt-1.5 text-xs text-mist-500">{min}~{max}자 · 한글, 영문, 숫자, _ - 사용 가능</p>
              </div>
              {error && <p role="alert" className="text-sm text-coral-400">{error}</p>}
              <button className="btn-primary w-full !py-2.5 !text-base" disabled={busy || !config}>{busy ? '입장하는 중…' : '입장하기'}</button>
            </form>
          )}
          <p className="mt-4 text-xs leading-relaxed text-mist-500">
            로그인 정보는 이 브라우저에 세션으로 저장되며, 새로고침해도 유지됩니다. 브라우저 데이터를 지우면 새 닉네임으로 다시 입장해야 합니다.
          </p>
        </div>
      </div>
    </main>
  );
}
