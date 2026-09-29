import { useState, type FormEvent } from 'react';
import { Modal } from './Modal';

const OPTIONS: { label: string; minutes: number | null }[] = [
  { label: '10분', minutes: 10 },
  { label: '1시간', minutes: 60 },
  { label: '1일', minutes: 60 * 24 },
  { label: '영구', minutes: null },
];

export function KickDialog({ nickname, onClose, onConfirm }: { nickname: string; onClose: () => void; onConfirm: (minutes: number | null, reason: string) => Promise<void> }) {
  const [idx, setIdx] = useState(1);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onConfirm(OPTIONS[idx].minutes, reason.trim());
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`${nickname}님 강퇴`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">재입장 제한 기간</legend>
          <div className="grid grid-cols-4 gap-2">
            {OPTIONS.map((o, i) => (
              <button type="button" key={o.label} aria-pressed={idx === i} onClick={() => setIdx(i)}
                className={`rounded-lg border px-2 py-2 text-sm font-semibold ${idx === i ? 'border-mint-400 bg-mint-400/15 text-mint-300' : 'border-ink-500 text-mist-300 hover:bg-ink-700'}`}>{o.label}</button>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor="kick-reason" className="mb-1.5 block text-sm font-medium">사유 <span className="text-mist-500">(선택)</span></label>
          <input id="kick-reason" className="field" value={reason} maxLength={100} onChange={(e) => setReason(e.target.value)} placeholder="본인에게 표시됩니다" />
        </div>
        <p className="rounded-lg bg-ink-700 p-3 text-xs leading-relaxed text-mist-400">
          이 서비스는 익명 세션 방식이라, 대상이 브라우저 데이터를 지우고 새 닉네임으로 다시 입장하면 제한을 완전히 막을 수는 없습니다.
        </p>
        {error && <p role="alert" className="text-sm text-coral-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>취소</button>
          <button className="btn-danger" disabled={busy}>강퇴하기</button>
        </div>
      </form>
    </Modal>
  );
}
