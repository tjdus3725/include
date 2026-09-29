import { useEffect, useState } from 'react';
import type { Channel, User } from '../lib/types';
import { fmtElapsed } from '../lib/util';
import { Icon, LogoMark } from './Icon';

/** 입장 직후 보이는 로비: 지금 진행 중인 방송 방을 고른다 */
export function LobbyScreen({ user, channels, loading, onPick, onCreate }: {
  user: User; channels: Channel[]; loading: boolean; onPick: (c: Channel) => void; onCreate: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const live = channels.filter((c) => c.live);
  const others = channels.filter((c) => !c.live);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center gap-3">
          <LogoMark size={36} />
          <div>
            <h1 className="text-xl font-bold">방송 로비</h1>
            <p className="text-sm text-mist-400">{user.nickname}님, 입장할 방을 골라 주세요. 방을 고르면 내 닉네임 또는 익명 중에 선택해서 들어갑니다.</p>
          </div>
        </div>

        <section className="mt-6" aria-label="진행 중인 방송">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-mist-300">
            <span className="animate-pulse-dot rounded bg-coral-500 px-1.5 py-px text-[10px] font-extrabold text-white">LIVE</span> 지금 진행 중인 방송 · {live.length}
          </h2>
          {loading && <p className="text-sm text-mist-500">불러오는 중…</p>}
          {!loading && live.length === 0 && (
            <div className="card p-6 text-center text-sm text-mist-400">
              지금 진행 중인 방송이 없어요.<br />아래 방에서 채팅하며 기다리거나, 방송 권한이 있다면 방에 들어가 방송을 시작해 보세요.
            </div>
          )}
          <ul className="grid gap-3 sm:grid-cols-2">
            {live.map((c) => (
              <li key={c.id}>
                <button onClick={() => onPick(c)} className="card group flex w-full items-start gap-3 p-4 text-left transition-colors hover:border-mint-400/60 hover:bg-ink-700 focus-visible:outline-2 focus-visible:outline-mint-400">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-coral-500/15 text-coral-400"><Icon name="radio" size={22} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-bold">{c.name}</span>
                      <span className="animate-pulse-dot shrink-0 rounded bg-coral-500 px-1.5 py-px text-[10px] font-extrabold text-white">LIVE</span>
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-mist-300">{c.broadcaster ? `${c.broadcaster}님의 방송` : '방송 중'}{c.description ? ` · ${c.description}` : ''}</span>
                    <span className="mt-2 flex items-center gap-3 text-xs text-mist-400">
                      <span className="flex items-center gap-1"><Icon name="users" size={12} /> 시청 {c.viewerCount ?? 0}</span>
                      <span>접속 {c.onlineCount}명</span>
                      {c.startedAt && <span className="tabular-nums">{fmtElapsed(now - c.startedAt)} 경과</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-8" aria-label="전체 방">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-mist-300">방송하지 않는 방 · {others.length}</h2>
            <button className="btn-secondary !py-1.5 text-xs" onClick={onCreate}><Icon name="plus" size={14} /> 방 만들기</button>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {others.map((c) => (
              <li key={c.id}>
                <button onClick={() => onPick(c)} className="flex w-full items-center gap-3 rounded-xl border border-ink-600 bg-ink-800 px-3.5 py-3 text-left hover:bg-ink-700 focus-visible:outline-2 focus-visible:outline-mint-400">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink-700 text-mist-400"><Icon name="hash" size={16} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{c.name}</span>
                    <span className="block truncate text-xs text-mist-500">{c.description || '설명이 없습니다'}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-mist-400"><span className={`h-1.5 w-1.5 rounded-full ${c.onlineCount > 0 ? 'bg-mint-400' : 'bg-ink-500'}`} />{c.onlineCount}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
