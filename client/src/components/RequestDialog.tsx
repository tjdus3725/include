import { useState } from 'react';
import { emitAck } from '../lib/socket';
import { useToast } from '../lib/toast';
import { Icon } from './Icon';
import { Modal } from './Modal';

/** 일반 사용자가 관리자 계정을 눌렀을 때: 방송 요청 보내기 */
export function RequestDialog({ channelId, channelName, adminName, onClose }: { channelId: string; channelName: string; adminName: string; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await emitAck('broadcast:request', { channelId });
      toast('방송 요청을 보냈습니다. 관리자가 확인하면 알려 드릴게요.', 'success');
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="방송 요청 보내기" onClose={onClose}>
      <div className="space-y-4">
        <p className="flex items-start gap-2 text-sm leading-relaxed text-mist-200">
          <Icon name="radio" size={18} className="mt-0.5 shrink-0 text-mint-300" />
          <span><b>{adminName}</b> 관리자에게 <b>"{channelName}"</b> 채널의 방송 권한을 요청할까요? 관리자가 승인하면 방송을 시작할 수 있어요.</span>
        </p>
        {error && <p role="alert" className="text-sm text-coral-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>취소</button>
          <button className="btn-primary" onClick={() => void send()} disabled={busy}>{busy ? '보내는 중…' : '전송'}</button>
        </div>
      </div>
    </Modal>
  );
}
