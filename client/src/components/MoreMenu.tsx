import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';

export interface MenuItem { label: string; icon?: IconName; danger?: boolean; onClick: () => void }

/** 세로 점 세 개(more_vert) 버튼과 팝업 메뉴. 스크롤 영역에 잘리지 않도록 body 에 고정 위치로 그린다. */
export function MoreMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // 메뉴를 버튼 근처에 배치 (아래 공간이 부족하면 위로). 스크롤/리사이즈 때도 버튼을 따라간다.
  const place = () => {
    if (!btn.current || !menu.current) return;
    const r = btn.current.getBoundingClientRect();
    const m = menu.current.getBoundingClientRect();
    const top = r.bottom + m.height + 8 > window.innerHeight ? Math.max(8, r.top - m.height - 4) : r.bottom + 4;
    const left = Math.min(Math.max(8, r.right - m.width), window.innerWidth - m.width - 8);
    setPos({ top, left });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDoc = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); btn.current?.focus(); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (items.length === 0) return null;
  return (
    <>
      <button ref={btn} type="button" className="rounded p-1 text-mist-400 hover:bg-ink-600 hover:text-mist-100 focus-visible:outline-2 focus-visible:outline-mint-400"
        aria-haspopup="menu" aria-expanded={open} aria-label={label} title="더보기" onClick={() => { setPos(null); setOpen((o) => !o); }}>
        <Icon name="moreVert" size={16} />
      </button>
      {open && createPortal(
        <div ref={menu} role="menu" style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          className="animate-fade-in z-[70] min-w-44 rounded-xl border border-ink-600 bg-ink-800 p-1.5 shadow-xl shadow-black/50">
          {items.map((it) => (
            <button key={it.label} role="menuitem" type="button"
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-ink-600 focus-visible:outline-2 focus-visible:outline-mint-400 ${it.danger ? 'text-coral-400' : 'text-mist-200'}`}
              onClick={() => { setOpen(false); it.onClick(); }}>
              {it.icon && <Icon name={it.icon} size={15} />}{it.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
