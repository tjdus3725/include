import type { Message } from '../lib/types';

/**
 * 방송 화면 위에 띄우는 채팅 오버레이. 배경은 투명하고 글자에만 그림자를 넣어 어떤 화면 위에서도 읽히게 한다.
 *  - 새 메시지는 아래에 붙고 기존 메시지는 위로 밀려 올라가며, 영역을 넘어간 메시지는 보이지 않는다.
 *  - 일반 사용자 메시지는 왼쪽, 방송자 메시지는 오른쪽 정렬.
 */
export function ChatOverlay({ messages, broadcasterId, broadcasterName, max = 40, className = '' }: {
  messages: Message[]; broadcasterId?: string | null; broadcasterName?: string | null; max?: number; className?: string;
}) {
  const shown = messages.filter((m) => m.kind === 'user' && !m.deleted).slice(-max);
  const shadow = { textShadow: '0 1px 2px rgba(0,0,0,.95), 0 0 6px rgba(0,0,0,.8)' } as const;
  return (
    <div
      className={`pointer-events-none flex flex-col justify-end gap-1.5 overflow-hidden ${className}`}
      // 위쪽으로 갈수록 서서히 사라져 잘림이 자연스럽다
      style={{ maskImage: 'linear-gradient(to top, black 70%, transparent)', WebkitMaskImage: 'linear-gradient(to top, black 70%, transparent)' }}
      aria-hidden="true"
    >
      {shown.map((m) => {
        const isCaster = broadcasterId ? m.userId === broadcasterId : !!broadcasterName && m.nickname === broadcasterName;
        return (
          <div key={m.id} className={`animate-fade-in flex shrink-0 flex-col ${isCaster ? 'items-end text-right' : 'items-start text-left'}`}>
            <span className="max-w-full break-words text-[15px] leading-snug text-white" style={shadow}>
              <b className="mr-1.5" style={{ color: m.color ?? '#7ee8d8' }}>{isCaster ? `★ ${m.nickname}` : m.nickname}</b>
              <span className="whitespace-pre-wrap">{m.body}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
