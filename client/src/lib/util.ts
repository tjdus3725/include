/** 보안 컨텍스트가 아닌 http://내부IP 에서는 crypto.randomUUID 가 없으므로 getRandomValues 로 대체 */
export function uid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const timeFmt = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
export const fmtTime = (ts: number) => timeFmt.format(ts);
export const fmtDate = (ts: number) => dateFmt.format(ts);
export const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
export const charCount = (s: string) => [...s].length;

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 보안 컨텍스트가 아닌 경우의 대체 방법
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

export function readableMediaError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  switch (name) {
    case 'NotAllowedError':
      return '화면 공유 권한이 거부되었거나 공유 선택이 취소되었습니다. 다시 시도하고 공유할 화면을 선택해 주세요.';
    case 'NotFoundError':
      return '공유할 수 있는 화면을 찾지 못했습니다.';
    case 'NotReadableError':
      return '화면을 읽을 수 없습니다. 다른 프로그램이 화면을 점유 중이거나 운영체제의 화면 기록 권한(macOS: 시스템 설정 > 개인정보 보호 > 화면 기록)이 꺼져 있을 수 있습니다.';
    case 'AbortError':
      return '화면 공유를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.';
    case 'SecurityError':
      return '보안 정책 때문에 화면 공유를 사용할 수 없습니다. HTTPS 또는 localhost 주소로 접속해 주세요.';
    default:
      return `화면 공유를 시작하지 못했습니다. (${(e as Error)?.message ?? '알 수 없는 오류'})`;
  }
}
