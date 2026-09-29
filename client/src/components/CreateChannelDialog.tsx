import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import type { AppConfig, Channel } from '../lib/types';
import { Modal } from './Modal';

export function CreateChannelDialog({ config, onClose, onCreated }: { config: AppConfig; onClose: () => void; onCreated: (c: Channel) => void }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { channelNameMin: nmin, channelNameMax: nmax, channelDescMax: dmax } = config.limits;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.replace(/\s+/g, ' ').trim();
    if ([...n].length < nmin || [...n].length > nmax) return setError(`채널 이름은 ${nmin}~${nmax}자로 입력해 주세요.`);
    setBusy(true);
    setError(null);
    try {
      const { channel } = await api.createChannel(n, desc.trim());
      onCreated(channel);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="새 채널 만들기" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="ch-name" className="mb-1.5 block text-sm font-medium">채널 이름</label>
          <input id="ch-name" className="field" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="예: 알고리즘 스터디" autoComplete="off" />
          <p className="mt-1 text-xs text-mist-500">{nmin}~{nmax}자 · 글자, 숫자, 공백, _ - . 사용 가능</p>
        </div>
        <div>
          <label htmlFor="ch-desc" className="mb-1.5 block text-sm font-medium">설명 <span className="text-mist-500">(선택)</span></label>
          <textarea id="ch-desc" rows={3} className="field resize-none" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="어떤 이야기를 나누는 채널인가요?" />
          <p className={`mt-1 text-right text-xs ${[...desc].length > dmax ? 'text-coral-400' : 'text-mist-500'}`}>{[...desc].length}/{dmax}</p>
        </div>
        <p className="rounded-lg bg-ink-700 p-3 text-xs leading-relaxed text-mist-400">채널을 만든 사람은 공지 고정, 메시지 삭제, 강퇴, 방송 시작 같은 관리 권한을 가집니다.</p>
        {error && <p role="alert" className="text-sm text-coral-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>취소</button>
          <button className="btn-primary" disabled={busy}>{busy ? '만드는 중…' : '만들기'}</button>
        </div>
      </form>
    </Modal>
  );
}
