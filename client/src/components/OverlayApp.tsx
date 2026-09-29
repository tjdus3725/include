import { useEffect } from 'react';
import { useConnection } from '../hooks/useConnection';
import { useChat } from '../hooks/useChat';
import { useSession } from '../hooks/useSession';
import { ChatOverlay } from './ChatOverlay';

/**
 * 채팅만 보여주는 오버레이 화면: `#/overlay/<채널ID>` (팝업 창용)
 * `?transparent=1` 을 붙이면 배경이 투명해져 OBS 브라우저 소스 등에서 방송 화면 위에 합성할 수 있다.
 * 로그인은 다른 창과 같은 브라우저의 세션을 그대로 쓴다. (OBS 는 소스의 "상호작용"에서 한 번 입장해야 한다)
 */
export function OverlayApp({ channelId }: { channelId: string }) {
  const s = useSession();
  const transparent = new URLSearchParams(location.hash.split('?')[1] ?? '').has('transparent');
  useEffect(() => {
    document.documentElement.classList.toggle('overlay-transparent', transparent);
    document.title = 'InChat 채팅 오버레이';
  }, [transparent]);

  if (s.loading) return null;
  if (!s.user) {
    return (
      <div className="flex h-dvh items-center justify-center p-4 text-center text-sm text-mist-300">
        <div>InChat 에 먼저 입장(닉네임 입력)한 뒤 이 창을 다시 열어 주세요.<br /><a className="text-mint-300 underline" href="/" target="_blank" rel="noreferrer">InChat 열기</a></div>
      </div>
    );
  }
  return <OverlayInner channelId={channelId} onAuthLost={s.authLost} max={s.config?.limits.messageMax ?? 500} />;
}

function OverlayInner({ channelId, onAuthLost, max }: { channelId: string; onAuthLost: () => void; max: number }) {
  const conn = useConnection(true, onAuthLost);
  const { state } = useChat(channelId, conn, max);
  return (
    <div className="h-dvh p-3">
      <ChatOverlay messages={state.messages} broadcasterId={state.broadcast.broadcasterId} broadcasterName={state.broadcast.broadcaster} className="h-full" />
    </div>
  );
}
