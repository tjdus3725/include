import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { AppConfig, User } from '../lib/types';

export function useSession() {
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  const boot = useCallback(async () => {
    setLoading(true);
    setBootError(null);
    try {
      const [cfg, me] = await Promise.all([api.config(), api.me()]);
      setConfig(cfg);
      setUser(me.user);
    } catch (e) {
      setBootError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void boot(); }, [boot]);

  const login = useCallback(async (nickname: string) => {
    const { user } = await api.login(nickname);
    setUser(user);
  }, []);
  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* 이미 만료된 세션이어도 로컬 상태는 정리 */ }
    setUser(null);
  }, []);
  const authLost = useCallback(() => setUser(null), []);

  return { user, setUser, config, loading, bootError, retry: boot, login, logout, authLost };
}
