import type { AppConfig, ConnState, User } from '../lib/types';
import { Icon } from './Icon';
import type { ReactNode } from 'react';
import { ProfileMenu } from './ProfileMenu';

const connLabel: Record<ConnState, { text: string; dot: string }> = {
  connected: { text: '연결됨', dot: 'bg-mint-400' },
  connecting: { text: '연결 중', dot: 'bg-amber-400 animate-pulse-dot' },
  reconnecting: { text: '재연결 중', dot: 'bg-amber-400 animate-pulse-dot' },
  disconnected: { text: '연결 끊김', dot: 'bg-coral-500' },
};

export function Header({ user, config, conn, query, onQuery, onToggleMenu, menuOpen, onUser, onLogout, bell }: {
  user: User; config: AppConfig; conn: ConnState; query: string; onQuery: (q: string) => void;
  onToggleMenu: () => void; menuOpen: boolean; onUser: (u: User) => void; onLogout: () => void;
  /** 관리자에게만 보이는 알림 아이콘 (계정 표시 왼쪽) */
  bell?: ReactNode;
}) {
  const c = connLabel[conn];
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-ink-600 bg-ink-900 px-2 pt-[env(safe-area-inset-top)] sm:gap-3 sm:px-4 lg:h-16">
      <button className="btn-ghost !p-2 lg:hidden" onClick={onToggleMenu} aria-label="채널 목록 열기/닫기" aria-expanded={menuOpen}>
        <Icon name={menuOpen ? 'x' : 'menu'} size={22} />
      </button>
      {/* 제공된 로고 이미지는 수정 없이 그대로 사용 */}
      <a href="/" className="shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-mint-400" aria-label="InChat 홈">
        <img src="/logo.webp" alt="InChat" className="h-10 w-auto lg:h-14" />
      </a>
      <div className="relative mx-auto hidden w-full max-w-md md:block">
        <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mist-500" />
        <input className="field !rounded-full !pl-9 !pr-9" placeholder="채널 검색" value={query} onChange={(e) => onQuery(e.target.value)} aria-label="채널 검색" />
        {query && <button className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-mist-400 hover:text-white" onClick={() => onQuery('')} aria-label="검색어 지우기"><Icon name="x" size={14} /></button>}
      </div>
      <div className="ml-auto flex items-center gap-1 sm:gap-3 md:ml-0">
        <span className="flex items-center gap-1.5 rounded-full bg-ink-800 px-2.5 py-1 text-xs text-mist-300" role="status" title="서버 연결 상태">
          <span className={`h-2 w-2 rounded-full ${c.dot}`} />
          <span className="hidden sm:inline">{c.text}</span>
          <span className="sr-only sm:hidden">{c.text}</span>
        </span>
        {bell}
        <ProfileMenu user={user} config={config} onUser={onUser} onLogout={onLogout} />
      </div>
    </header>
  );
}
