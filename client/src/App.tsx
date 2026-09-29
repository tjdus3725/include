import { useSession } from './hooks/useSession';
import { ChatApp } from './components/ChatApp';
import { LoginScreen } from './components/LoginScreen';
import { LogoMark } from './components/Icon';

export function App() {
  const s = useSession();
  if (s.loading) {
    return (
      <div className="flex h-dvh items-center justify-center" role="status" aria-label="불러오는 중">
        <span className="animate-pulse-dot"><LogoMark size={56} /></span>
      </div>
    );
  }
  if (!s.user || !s.config) {
    return <LoginScreen config={s.config} onLogin={s.login} bootError={s.bootError} onRetry={s.retry} />;
  }
  return <ChatApp user={s.user} config={s.config} onUser={s.setUser} onLogout={s.logout} onAuthLost={s.authLost} />;
}
