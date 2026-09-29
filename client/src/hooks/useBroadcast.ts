import { useCallback, useEffect, useRef, useState } from 'react';
import { emitAck, socket } from '../lib/socket';
import type { LiveInfo } from '../lib/types';
import { readableMediaError } from '../lib/util';

type SignalData =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit };

interface Args {
  /** 지금 보고 있는 채널 (방송 중인 채널과 다를 수 있음) */
  channelId: string | null;
  joined: boolean;
  /** 채널 입장 성공 횟수 (재연결 후 다시 시청을 시작하기 위해 사용) */
  epoch: number;
  live: LiveInfo;
  canBroadcast: boolean;
  iceServers: RTCIceServer[];
}

export type ShareState = 'idle' | 'starting' | 'live';
export type ViewState = 'idle' | 'connecting' | 'playing' | 'error';

const CONNECT_TIMEOUT_MS = 15000;
const MAX_BITRATE = 2_500_000; // 시청자 1명당 약 2.5Mbps 로 제한해 방송자 PC/Wi-Fi 부하를 줄임

const ENDED_TEXT: Record<string, string> = {
  stopped: '방송이 종료되었습니다.',
  revoked: '방송 권한이 회수되어 방송이 종료되었습니다.',
  kicked: '채널에서 강퇴되어 방송이 종료되었습니다.',
  'channel-deleted': '채널이 삭제되어 방송이 종료되었습니다.',
  disconnected: '연결이 끊겨 방송이 종료되었습니다.',
};

/**
 * 방송(송출)은 "지금 보고 있는 채널"과 분리되어 있습니다.
 *  - 송출: 방송을 시작한 채널(shareChannelId)에 묶이며, 다른 채널로 이동해도 캡처·연결이 유지됩니다.
 *          방송 종료 버튼(또는 관리자 조치·연결 끊김 등 불가피한 경우)에서만 끝납니다.
 *  - 시청: 지금 보고 있는 채널이 방송 중이면 자동으로 시청합니다.
 */
export function useBroadcast({ channelId, joined, epoch, live, canBroadcast, iceServers }: Args) {
  const [share, setShare] = useState<ShareState>('idle');
  const [shareChannelId, setShareChannelId] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localHasAudio, setLocalHasAudio] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);

  const localRef = useRef<MediaStream | null>(null);
  const shareRef = useRef<ShareState>('idle');
  shareRef.current = share;
  const shareChannelRef = useRef<string | null>(null);
  const senders = useRef(new Map<string, RTCPeerConnection>()); // 방송자: viewerSocketId -> pc
  const senderQueue = useRef(new Map<string, RTCIceCandidateInit[]>());
  const viewerPc = useRef<RTCPeerConnection | null>(null);
  const viewerQueue = useRef<RTCIceCandidateInit[]>([]);
  const broadcasterId = useRef<string | null>(null);
  const timers = useRef<{ connect?: ReturnType<typeof setTimeout>; disc?: ReturnType<typeof setTimeout> }>({});
  const iceRef = useRef(iceServers);
  iceRef.current = iceServers;
  const channelRef = useRef(channelId);
  channelRef.current = channelId;

  const secure = typeof window !== 'undefined' && window.isSecureContext;
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
  const canShare = canBroadcast && secure && supported;
  const shareBlocked: null | 'insecure' | 'unsupported' = !secure ? 'insecure' : !supported ? 'unsupported' : null;

  const sharingHere = share !== 'idle' && shareChannelId === channelId;

  const signal = useCallback((channel: string | null, to: string, data: SignalData) => {
    if (channel) void emitAck('webrtc:signal', { channelId: channel, to, data }).catch(() => {});
  }, []);

  // ---------- 방송자(송출) ----------
  const closeSender = useCallback((viewerId: string) => {
    senders.current.get(viewerId)?.close();
    senders.current.delete(viewerId);
    senderQueue.current.delete(viewerId);
    setViewerCount(senders.current.size);
  }, []);

  const cleanupLocal = useCallback(() => {
    localRef.current?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    localRef.current = null;
    shareRef.current = 'idle'; // 렌더 전에 뒤따르는 서버 이벤트가 상태를 덮어쓰지 않도록 즉시 반영
    shareChannelRef.current = null;
    for (const id of [...senders.current.keys()]) closeSender(id);
    setLocalStream(null);
    setShare('idle');
    setShareChannelId(null);
    setViewerCount(0);
  }, [closeSender]);

  const connectViewer = useCallback(
    async (viewerId: string) => {
      const local = localRef.current;
      const ch = shareChannelRef.current;
      if (!local || !ch) return;
      closeSender(viewerId);
      const pc = new RTCPeerConnection({ iceServers: iceRef.current });
      senders.current.set(viewerId, pc);
      setViewerCount(senders.current.size);
      local.getTracks().forEach((t) => pc.addTrack(t, local));
      pc.onicecandidate = (e) => { if (e.candidate) signal(ch, viewerId, { type: 'candidate', candidate: e.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          if (senders.current.get(viewerId) === pc) closeSender(viewerId);
        }
      };
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signal(ch, viewerId, { type: 'offer', sdp: offer.sdp ?? '' });
      } catch {
        closeSender(viewerId);
      }
    },
    [closeSender, signal],
  );

  const start = useCallback(async () => {
    const ch = channelId;
    if (!ch || shareRef.current !== 'idle') return;
    setError(null);
    if (!window.isSecureContext) {
      setError('이 주소(http://내부IP)에서는 브라우저가 화면 공유를 막습니다. HTTPS 주소 또는 서버 컴퓨터의 localhost 로 접속해 주세요.');
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError('이 기기/브라우저는 화면 공유를 지원하지 않습니다. 데스크톱 Chrome, Edge, Firefox 등에서 시도해 주세요. (대부분의 스마트폰 브라우저는 화면 공유를 지원하지 않습니다)');
      return;
    }
    shareRef.current = 'starting';
    shareChannelRef.current = ch;
    setShareChannelId(ch);
    setShare('starting');
    const fail = (msg: string) => {
      shareRef.current = 'idle';
      shareChannelRef.current = null;
      setShare('idle');
      setShareChannelId(null);
      setError(msg);
    };
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: true });
    } catch (e) {
      return fail(readableMediaError(e));
    }
    const hasAudio = media.getAudioTracks().length > 0;
    media.getVideoTracks().forEach((t) => { try { t.contentHint = 'detail'; } catch { /* 일부 브라우저 미지원 */ } });
    localRef.current = media;
    try {
      await emitAck('broadcast:start', { channelId: ch, hasAudio });
    } catch (e) {
      media.getTracks().forEach((t) => t.stop());
      localRef.current = null;
      return fail((e as Error).message);
    }
    // 브라우저의 "공유 중지" 버튼으로 캡처 자체가 끝난 경우: 더 이상 보낼 영상이 없어 방송도 마칠 수밖에 없다
    media.getVideoTracks()[0].onended = () => {
      void emitAck('broadcast:stop', { channelId: ch }).catch(() => {});
      cleanupLocal();
      setError('브라우저에서 화면 공유가 중지되어 방송을 마쳤습니다.');
    };
    setLocalHasAudio(hasAudio);
    setLocalStream(media);
    setShare('live');
  }, [channelId, cleanupLocal]);

  /** 방송 종료 버튼: 보고 있는 채널과 관계없이 방송 중인 채널의 방송을 종료 */
  const stop = useCallback(async () => {
    const ch = shareChannelRef.current;
    if (ch) await emitAck('broadcast:stop', { channelId: ch }).catch(() => {});
    cleanupLocal();
  }, [cleanupLocal]);

  // ---------- 시청자 ----------
  const closeViewer = useCallback((notify: boolean) => {
    clearTimeout(timers.current.connect);
    clearTimeout(timers.current.disc);
    viewerPc.current?.close();
    viewerPc.current = null;
    viewerQueue.current = [];
    broadcasterId.current = null;
    if (notify && channelRef.current && socket.connected) socket.emit('broadcast:unwatch', { channelId: channelRef.current });
    setRemoteStream(null);
    setView('idle');
  }, []);

  const watch = useCallback(async () => {
    const ch = channelRef.current;
    if (!ch) return;
    setView('connecting');
    setError(null);
    try {
      const r = await emitAck<{ broadcasterId: string }>('broadcast:watch', { channelId: ch });
      broadcasterId.current = r.broadcasterId;
      clearTimeout(timers.current.connect);
      timers.current.connect = setTimeout(() => {
        if (!viewerPc.current || viewerPc.current.connectionState !== 'connected') {
          setView('error');
          setError('방송 연결 시간이 초과되었습니다. 방화벽이나 공유기의 AP 격리(기기 간 통신 차단) 설정을 확인한 뒤 다시 시도해 주세요.');
        }
      }, CONNECT_TIMEOUT_MS);
    } catch (e) {
      // 내 방송이거나 방금 종료된 방송을 시청하려던 경우는 오류가 아니다 (다른 안내 문구를 덮어쓰지 않는다)
      const code = (e as { code?: string }).code;
      if (code === 'INVALID_TARGET' || code === 'NOT_LIVE') { setView('idle'); return; }
      setView('error');
      setError((e as Error).message);
    }
  }, []);

  const handleOffer = useCallback(
    async (from: string, sdp: string) => {
      const ch = channelRef.current;
      viewerPc.current?.close();
      const pc = new RTCPeerConnection({ iceServers: iceRef.current });
      viewerPc.current = pc;
      pc.ontrack = (e) => {
        setRemoteStream(e.streams[0] ?? new MediaStream([e.track]));
        setView('playing');
        setError(null);
        clearTimeout(timers.current.connect);
      };
      pc.onicecandidate = (e) => { if (e.candidate) signal(ch, from, { type: 'candidate', candidate: e.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => {
        if (viewerPc.current !== pc) return;
        clearTimeout(timers.current.disc);
        if (pc.connectionState === 'failed') {
          setView('error');
          setError('방송 연결에 실패했습니다. 같은 네트워크인지, 방화벽/AP 격리 설정을 확인하고 다시 시도해 주세요.');
        } else if (pc.connectionState === 'disconnected') {
          timers.current.disc = setTimeout(() => {
            if (viewerPc.current === pc && pc.connectionState !== 'connected') {
              setView('error');
              setError('방송 연결이 끊어졌습니다. 다시 시도해 주세요.');
            }
          }, 6000);
        }
      };
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        for (const c of viewerQueue.current) await pc.addIceCandidate(c).catch(() => {});
        viewerQueue.current = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signal(ch, from, { type: 'answer', sdp: answer.sdp ?? '' });
      } catch {
        setView('error');
        setError('방송 연결 협상에 실패했습니다. 다시 시도해 주세요.');
      }
    },
    [signal],
  );

  // ---------- 소켓 이벤트 ----------
  useEffect(() => {
    // 시청자가 방송 시작 직후(시작 응답 처리 전)에 들어와도 놓치지 않도록, share 상태가 아니라 로컬 스트림 유무로 판단
    const onJoinedViewer = (d: { viewerId: string }) => { if (localRef.current) void connectViewer(d.viewerId); };
    const onLeftViewer = (d: { viewerId: string }) => closeSender(d.viewerId);
    const onSignal = async (d: { channelId: string; from: string; data: SignalData }) => {
      const { from, data } = d;
      const pc = senders.current.get(from);
      if (pc) {
        if (d.channelId !== shareChannelRef.current) return;
        if (data.type === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp }).catch(() => {});
          for (const c of senderQueue.current.get(from) ?? []) await pc.addIceCandidate(c).catch(() => {});
          senderQueue.current.delete(from);
          // 시청자 1명당 비트레이트 상한
          pc.getSenders().forEach((s) => {
            if (s.track?.kind !== 'video') return;
            try {
              const p = s.getParameters();
              if (!p.encodings?.length) p.encodings = [{}];
              p.encodings[0].maxBitrate = MAX_BITRATE;
              void s.setParameters(p).catch(() => {});
            } catch { /* 무시 */ }
          });
        } else if (data.type === 'candidate') {
          if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
          else senderQueue.current.set(from, [...(senderQueue.current.get(from) ?? []), data.candidate]);
        }
        return;
      }
      if (d.channelId !== channelRef.current || from !== broadcasterId.current) return;
      if (data.type === 'offer') void handleOffer(from, data.sdp);
      else if (data.type === 'candidate') {
        if (viewerPc.current?.remoteDescription) await viewerPc.current.addIceCandidate(data.candidate).catch(() => {});
        else viewerQueue.current.push(data.candidate);
      }
    };
    // 관리자 조치(권한 회수·강퇴·다른 탭에서 종료)나 채널 삭제로 서버가 방송을 끝낸 경우 로컬 리소스 정리
    const onEnded = (d: { channelId: string; reason: string }) => {
      if (d.channelId !== shareChannelRef.current || shareRef.current === 'idle') return;
      cleanupLocal();
      setError(ENDED_TEXT[d.reason] ?? ENDED_TEXT.stopped);
    };
    const onDisconnect = () => {
      if (shareRef.current !== 'idle') {
        cleanupLocal();
        setError('서버와 연결이 끊겨 방송이 종료되었습니다. 연결이 복구되면 다시 방송을 시작해 주세요.');
      }
      closeViewer(false);
    };
    socket.on('broadcast:viewer-joined', onJoinedViewer);
    socket.on('broadcast:viewer-left', onLeftViewer);
    socket.on('webrtc:signal', onSignal);
    socket.on('broadcast:ended', onEnded);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('broadcast:viewer-joined', onJoinedViewer);
      socket.off('broadcast:viewer-left', onLeftViewer);
      socket.off('webrtc:signal', onSignal);
      socket.off('broadcast:ended', onEnded);
      socket.off('disconnect', onDisconnect);
    };
  }, [cleanupLocal, closeSender, closeViewer, connectViewer, handleOffer]);

  // 보고 있는 채널이 (내가 송출 중이 아닌) 방송 중이면 자동으로 시청. 다른 채널에서 송출 중이어도 시청은 가능하다.
  useEffect(() => {
    if (!channelId || !joined || !live.live || sharingHere) return;
    void watch();
    return () => closeViewer(true);
  }, [channelId, joined, epoch, live.live, live.startedAt, sharingHere, watch, closeViewer]);

  // 채널을 옮기면 시청 관련 오류만 초기화한다. (송출은 유지)
  useEffect(() => { setError(null); }, [channelId]);
  // 화면이 완전히 사라질 때(로그아웃 등)에만 송출 자원 정리
  useEffect(() => () => {
    clearTimeout(timers.current.connect);
    clearTimeout(timers.current.disc);
    if (shareRef.current !== 'idle') cleanupLocal();
  }, [cleanupLocal]);

  return {
    share, shareChannelId, view, error, viewerCount, localHasAudio,
    stream: sharingHere ? localStream : remoteStream,
    /** 어느 채널에서든 내가 송출 중 */
    isSharing: share === 'live',
    /** 지금 보고 있는 채널에서 내가 송출 중 */
    isSharingHere: share === 'live' && shareChannelId === channelId,
    startingHere: share === 'starting' && shareChannelId === channelId,
    canShare, shareBlocked, start, stop, retryWatch: watch,
    dismissError: () => setError(null),
  };
}
