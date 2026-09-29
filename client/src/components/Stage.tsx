import { useEffect, useRef, useState } from 'react';
import type { ViewState } from '../hooks/useBroadcast';
import type { LiveInfo } from '../lib/types';
import { fmtElapsed } from '../lib/util';
import { Icon } from './Icon';

interface Props {
  stream: MediaStream | null;
  isSharing: boolean;
  starting: boolean;
  view: ViewState;
  error: string | null;
  live: LiveInfo;
  viewerCount: number;
  hasAudio: boolean;
  onStop: () => void;
  onRetry: () => void;
}

export function Stage({ stream, isSharing, starting, view, error, live, viewerCount, hasAudio, onStop, onRetry }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [full, setFull] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  // 스트림 연결 및 자동 재생 (소리 재생이 차단되면 음소거로 재생하고 안내)
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.srcObject = stream;
    if (!stream) return;
    v.muted = isSharing || muted;
    v.play().then(() => setNeedsTap(false)).catch(() => {
      v.muted = true;
      setMuted(true);
      v.play().then(() => setNeedsTap(false)).catch(() => setNeedsTap(true));
    });
  }, [stream, isSharing]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMute = () => {
    const v = video.current;
    const next = !muted;
    setMuted(next);
    if (v) {
      v.muted = next;
      if (v.paused) void v.play().catch(() => {});
    }
  };
  const tapPlay = () => { const v = video.current; if (v) { void v.play().then(() => setNeedsTap(false)).catch(() => {}); } };
  const toggleFull = async () => {
    const el = box.current;
    const v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (el?.requestFullscreen) await el.requestFullscreen();
      else v?.webkitEnterFullscreen?.(); // iOS Safari
    } catch { /* 사용자가 거부한 경우 */ }
  };

  const elapsed = live.startedAt ? fmtElapsed(now - live.startedAt) : '';
  const busy = starting || view === 'connecting';
  const showVideo = !!stream && (isSharing || view === 'playing');

  return (
    <div>
      <div ref={box} className="group relative aspect-video max-h-[62dvh] w-full overflow-hidden bg-black lg:max-h-none lg:rounded-xl" aria-label="방송 화면">
        <video ref={video} playsInline autoPlay muted={isSharing || muted} className={`h-full w-full bg-black object-contain ${showVideo ? '' : 'invisible'}`} />

        {busy && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-950/85 text-sm text-mist-300" role="status">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-mint-400 border-t-transparent" />
            {starting ? '공유할 화면을 선택해 주세요…' : '방송에 연결하는 중…'}
          </div>
        )}
        {view === 'error' && !isSharing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-950/90 p-6 text-center" role="alert">
            <Icon name="alert" size={28} className="text-coral-400" />
            <p className="max-w-md text-sm text-mist-200">{error ?? '방송을 불러오지 못했습니다.'}</p>
            <button className="btn-primary" onClick={onRetry}><Icon name="refresh" size={16} /> 다시 시도</button>
          </div>
        )}
        {needsTap && (
          <button onClick={tapPlay} className="absolute inset-0 flex items-center justify-center bg-black/60 text-lg font-bold">
            <span className="rounded-full bg-mint-400 px-6 py-3 text-ink-950">▶ 눌러서 시청 시작</span>
          </button>
        )}

        {/* 상단 상태 */}
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2">
          <span className="animate-pulse-dot rounded bg-coral-500 px-2 py-0.5 text-xs font-extrabold tracking-wide text-white">LIVE</span>
          {elapsed && <span className="rounded bg-black/60 px-2 py-0.5 text-xs tabular-nums text-mist-100">{elapsed}</span>}
          <span className="flex items-center gap-1 rounded bg-black/60 px-2 py-0.5 text-xs text-mist-100"><Icon name="users" size={12} /> {isSharing ? viewerCount : live.viewerCount ?? 0}</span>
        </div>

        {/* 하단 컨트롤 */}
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/80 to-transparent p-2 pt-8 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
          <span className="min-w-0 flex-1 truncate pl-1 text-xs text-mist-200">{live.broadcaster ? `${live.broadcaster}님의 방송` : ''}</span>
          {!isSharing && (
            <button className="btn-ghost !p-2 !text-white" onClick={toggleMute} aria-label={muted ? '음소거 해제' : '음소거'} aria-pressed={muted}>
              <Icon name={muted ? 'volumeOff' : 'volume'} size={20} />
            </button>
          )}
          <button className="btn-ghost !p-2 !text-white" onClick={toggleFull} aria-label={full ? '전체 화면 종료' : '전체 화면'}>
            <Icon name={full ? 'shrink' : 'expand'} size={20} />
          </button>
          {isSharing && <button className="btn-danger !py-1.5" onClick={onStop}><Icon name="stop" size={14} /> 방송 종료</button>}
        </div>
      </div>

      {isSharing && error === null && (
        <p className="mt-2 px-3 text-xs text-mist-500 lg:px-0">내 화면 미리보기입니다. (에코 방지를 위해 소리는 재생되지 않습니다)</p>
      )}
      {!hasAudio && (showVideo || isSharing) && (
        <p className="mt-2 flex items-start gap-1.5 px-3 text-xs text-amber-400 lg:px-0" role="note">
          <Icon name="volumeOff" size={14} className="mt-0.5 shrink-0" />
          <span>이 방송에는 소리가 포함되어 있지 않습니다. 공유 대상(탭/창/전체 화면)과 브라우저·운영체제에 따라 오디오 공유가 지원되지 않을 수 있습니다. (Chrome/Edge 에서 "탭" 공유 시 "탭 오디오 공유"를 선택하면 소리를 함께 보낼 수 있습니다)</span>
        </p>
      )}
    </div>
  );
}
