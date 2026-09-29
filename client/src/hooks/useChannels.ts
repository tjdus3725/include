import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { socket } from '../lib/socket';
import type { Channel, ChannelStat, ConnState } from '../lib/types';

export function useChannels(conn: ConnState, query: string) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  const refresh = useCallback(async () => {
    try {
      const r = await api.channels(queryRef.current.trim() || undefined);
      setChannels(r.channels);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 검색어 변경(디바운스) / 연결 복구 시 조회
  useEffect(() => {
    const t = setTimeout(() => void refresh(), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, conn === 'connected', refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onChanged = () => void refresh();
    const onStats = (d: { stats: ChannelStat[] }) =>
      setChannels((list) =>
        list.map((c) => {
          const s = d.stats.find((x) => x.id === c.id);
          return s ? { ...c, ...s } : c;
        }),
      );
    socket.on('channels:changed', onChanged);
    socket.on('channels:stats', onStats);
    return () => {
      socket.off('channels:changed', onChanged);
      socket.off('channels:stats', onStats);
    };
  }, [refresh]);

  return { channels, loading, error, refresh };
}
