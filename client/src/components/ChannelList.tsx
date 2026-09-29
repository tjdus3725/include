import type { Channel } from '../lib/types';
import { Icon } from './Icon';

export function ChannelList({ channels, loading, error, activeId, query, onQuery, onSelect, onCreate, onRetry, showSearch }: {
  channels: Channel[]; loading: boolean; error: string | null; activeId: string | null; query: string;
  onQuery: (q: string) => void; onSelect: (id: string) => void; onCreate: () => void; onRetry: () => void; showSearch: boolean;
}) {
  return (
    <nav aria-label="채널 목록" className="flex min-h-0 flex-1 flex-col">
      {showSearch && (
        <div className="relative px-3 pt-3">
          <Icon name="search" size={16} className="pointer-events-none absolute left-6 top-1/2 mt-1.5 -translate-y-1/2 text-mist-500" />
          <input className="field !pl-9" placeholder="채널 검색" value={query} onChange={(e) => onQuery(e.target.value)} aria-label="채널 검색" />
        </div>
      )}
      <div className="flex items-center justify-between px-4 pb-1 pt-4">
        <h2 className="text-xs font-bold uppercase tracking-wider text-mist-500">채널 {channels.length > 0 && `· ${channels.length}`}</h2>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {loading && <li className="px-3 py-2 text-sm text-mist-500">불러오는 중…</li>}
        {error && (
          <li className="rounded-lg border border-coral-500/40 bg-coral-500/10 p-3 text-sm text-coral-400">
            {error} <button className="ml-1 underline" onClick={onRetry}>다시 시도</button>
          </li>
        )}
        {!loading && !error && channels.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-mist-500">{query ? `"${query}"에 해당하는 채널이 없습니다.` : '채널이 없습니다. 새 채널을 만들어 보세요.'}</li>
        )}
        {channels.map((c) => {
          const active = c.id === activeId;
          return (
            <li key={c.id}>
              <button onClick={() => onSelect(c.id)} aria-current={active ? 'page' : undefined}
                className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-mint-400 ${active ? 'bg-ink-600 text-white' : 'text-mist-300 hover:bg-ink-700 hover:text-mist-100'}`}>
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${active ? 'bg-mint-400/15 text-mint-300' : 'bg-ink-700 text-mist-400 group-hover:bg-ink-600'}`}>
                  <Icon name={c.live ? 'radio' : 'hash'} size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{c.name}</span>
                    {c.live && <span className="animate-pulse-dot shrink-0 rounded bg-coral-500 px-1.5 py-px text-[10px] font-extrabold tracking-wide text-white">LIVE</span>}
                  </span>
                  <span className="block truncate text-xs text-mist-500">{c.description || (c.ownerNickname ? `${c.ownerNickname}님의 채널` : '설명이 없습니다')}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-xs text-mist-400" title={`${c.onlineCount}명 접속 중`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${c.onlineCount > 0 ? 'bg-mint-400' : 'bg-ink-500'}`} />
                  {c.onlineCount}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-ink-600 p-3">
        <button className="btn-secondary w-full" onClick={onCreate}><Icon name="plus" size={16} /> 채널 만들기</button>
      </div>
    </nav>
  );
}
