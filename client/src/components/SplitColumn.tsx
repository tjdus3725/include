import { useCallback, useEffect, useRef, useState } from 'react';

const KEY = 'inchat.split.chatRatio';
const MIN_PX = 120;

function loadRatio(): number {
  try {
    const v = Number.parseFloat(localStorage.getItem(KEY) ?? '');
    if (Number.isFinite(v) && v > 0.1 && v < 0.9) return v;
  } catch { /* 저장소를 못 쓰면 기본값 */ }
  return 0.5;
}

interface Props {
  top: React.ReactNode;
  bottom: React.ReactNode;
}

/** 위/아래 두 창을 드래그(또는 방향키)로 크기 조절하는 세로 분할. 아래 창(채팅)의 기본 높이는 절반. */
export function SplitColumn({ top, bottom }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(loadRatio); // 아래 창이 차지하는 비율
  const drag = useRef(false);

  const clamp = useCallback((r: number) => {
    const h = ref.current?.clientHeight ?? 0;
    if (h <= MIN_PX * 2 + 8) return 0.5;
    return Math.min(1 - (MIN_PX + 4) / h, Math.max((MIN_PX + 4) / h, r));
  }, []);
  const save = (r: number) => { try { localStorage.setItem(KEY, String(r)); } catch { /* 무시 */ } };

  const onMove = useCallback((e: PointerEvent) => {
    if (!drag.current || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setRatio(clamp((rect.bottom - e.clientY) / rect.height));
  }, [clamp]);
  const onUp = useCallback(() => {
    if (!drag.current) return;
    drag.current = false;
    document.body.style.userSelect = '';
    setRatio((r) => { save(r); return r; });
  }, []);
  useEffect(() => {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp); };
  }, [onMove, onUp]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = (e.key === 'ArrowUp' ? 0.05 : -0.05);
    setRatio((r) => { const n = clamp(r + step); save(n); return n; });
  };

  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 overflow-hidden" style={{ flex: `${1 - ratio} 1 0` }}>{top}</div>
      <div
        role="separator" aria-orientation="horizontal" aria-label="참여자 목록과 채팅의 크기 조절 (위아래 방향키 또는 드래그)"
        aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(ratio * 100)} tabIndex={0}
        className="group relative z-10 h-2 shrink-0 cursor-row-resize touch-none border-y border-ink-600 bg-ink-800 hover:bg-mint-400/20 focus-visible:bg-mint-400/30 focus-visible:outline-none"
        onPointerDown={(e) => { drag.current = true; document.body.style.userSelect = 'none'; (e.target as Element).setPointerCapture?.(e.pointerId); }}
        onKeyDown={onKey}
        onDoubleClick={() => { setRatio(0.5); save(0.5); }}
        title="드래그하여 크기 조절 (더블클릭: 절반으로)"
      >
        <span className="absolute left-1/2 top-1/2 h-1 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-500 group-hover:bg-mint-400" />
      </div>
      <div className="flex min-h-0 flex-col" style={{ flex: `${ratio} 1 0` }}>{bottom}</div>
    </div>
  );
}
