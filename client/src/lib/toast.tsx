import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type Kind = 'info' | 'success' | 'error';
interface Toast { id: number; kind: Kind; text: string }
const Ctx = createContext<(text: string, kind?: Kind) => void>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, kind: Kind = 'info') => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  const color: Record<Kind, string> = {
    info: 'border-ink-500 bg-ink-700 text-mist-100',
    success: 'border-mint-500/60 bg-ink-700 text-mint-300',
    error: 'border-coral-500/60 bg-ink-700 text-coral-400',
  };
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-16 z-[100] flex flex-col items-center gap-2 px-4 lg:top-20" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`animate-fade-in pointer-events-auto max-w-md rounded-lg border px-4 py-2.5 text-sm shadow-lg shadow-black/40 ${color[t.kind]}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
