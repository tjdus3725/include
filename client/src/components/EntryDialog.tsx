import { useState } from 'react';
import type { Channel, EntryMode, User } from '../lib/types';
import { Icon } from './Icon';
import { Modal } from './Modal';

/** 방에 들어갈 때 신원 선택: 처음 입력한 닉네임 또는 익명(방마다 자동으로 붙는 별칭) */
export function EntryDialog({ channel, user, initial, onCancel, onConfirm }: {
  channel: Pick<Channel, 'id' | 'name' | 'description'>; user: User; initial: EntryMode; onCancel: () => void; onConfirm: (m: EntryMode) => void;
}) {
  const [mode, setMode] = useState<EntryMode>(initial);
  const opt = (m: EntryMode, title: string, desc: string, icon: 'user' | 'shield') => (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors ${mode === m ? 'border-mint-400 bg-mint-400/10' : 'border-ink-500 hover:bg-ink-700'}`}>
      <input type="radio" name="entry" className="mt-1 accent-[var(--color-mint-400)]" checked={mode === m} onChange={() => setMode(m)} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 font-semibold"><Icon name={icon} size={15} /> {title}</span>
        <span className="mt-0.5 block text-sm text-mist-400">{desc}</span>
      </span>
    </label>
  );
  return (
    <Modal title={`"${channel.name}" 입장`} onClose={onCancel}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); onConfirm(mode); }}>
        <fieldset className="space-y-2.5">
          <legend className="mb-2 text-sm text-mist-300">어떻게 입장할까요?</legend>
          {opt('nick', `내 닉네임으로 입장`, `"${user.nickname}" (으)로 채팅에 표시됩니다.`, 'user')}
          {opt('anon', '익명으로 입장', '이 방에서만 "익명1234" 같은 별칭으로 보입니다. 방송 시청과 채팅은 그대로 할 수 있어요.', 'shield')}
        </fieldset>
        <p className="rounded-lg bg-ink-700 p-3 text-xs leading-relaxed text-mist-400">
          익명이어도 채널 관리자는 부적절한 메시지를 삭제하거나 이용을 제한할 수 있습니다. 입장 방식은 방에 들어올 때마다 다시 고를 수 있어요.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onCancel}>취소</button>
          <button className="btn-primary" autoFocus>입장하기</button>
        </div>
      </form>
    </Modal>
  );
}
