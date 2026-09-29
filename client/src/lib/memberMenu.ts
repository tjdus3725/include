import type { IconName } from '../components/Icon';
import type { MenuItem } from '../components/MoreMenu';

export type Role = 'owner' | 'admin' | 'manager' | 'broadcaster' | 'member';

/**
 * 참여자/메시지 옆 ⋮ 메뉴 항목. 서버의 위계(서버 관리자 > 채널 관리자 > 매니저 > 일반)와 같은 규칙으로 계산하며,
 * 최종 판단은 항상 서버가 한다. (여기서는 불가능한 메뉴를 보여주지 않기 위한 용도)
 *  - 방송 권한 부여/회수, 매니저 임명/회수: 채널 관리자·서버 관리자
 *  - 차단(강퇴): 서버 관리자(서버 관리자 제외 모두), 채널 관리자(서버/채널 관리자 제외), 매니저(일반·방송 권한자만)
 */
export function buildMemberMenu(o: {
  actorRole: Role | undefined;
  canModerate: boolean;
  canBan: boolean;
  /** 대상의 역할 (접속 중이 아니면 알 수 없음) */
  targetRole: Role | undefined;
  handlers: { setBroadcaster: (grant: boolean) => void; setManager: (appoint: boolean) => void; kick: () => void };
}): MenuItem[] {
  const { actorRole, canModerate, canBan, targetRole, handlers } = o;
  const items: MenuItem[] = [];
  const protectedTarget = targetRole === 'admin' || targetRole === 'owner';
  // 서버 관리자는 채널 관리자(개설자)에게도 방송 권한을 부여할 수 있다 (개설자는 원래 방송 가능하므로 알림·기록용)
  if (actorRole === 'admin' && targetRole === 'owner') {
    items.push({ label: '방송 권한 부여', icon: 'radio' as IconName, onClick: () => handlers.setBroadcaster(true) });
  }
  if (canModerate && targetRole && !protectedTarget) {
    if (targetRole !== 'manager') {
      // 회수는 서버 관리자만 가능
      if (targetRole !== 'broadcaster') items.push({ label: '방송 권한 부여', icon: 'radio' as IconName, onClick: () => handlers.setBroadcaster(true) });
      else if (actorRole === 'admin') items.push({ label: '방송 권한 회수', icon: 'stop' as IconName, onClick: () => handlers.setBroadcaster(false) });
    }
    items.push(targetRole === 'manager'
      ? { label: '매니저 권한 회수', icon: 'shield' as IconName, onClick: () => handlers.setManager(false) }
      : { label: '매니저 임명', icon: 'shield' as IconName, onClick: () => handlers.setManager(true) });
  }
  const kickable =
    canBan && targetRole !== 'admin' &&
    (actorRole === 'admin' || (targetRole !== 'owner' && (actorRole === 'owner' || (actorRole === 'manager' && targetRole !== 'manager'))));
  if (kickable) items.push({ label: '차단(강퇴)', icon: 'ban' as IconName, danger: true, onClick: handlers.kick });
  return items;
}

/**
 * 프로필(참여자 이름)을 눌러 방송 요청을 보낼 수 있는가
 *  - 방송 권한이 없는 사용자(일반·매니저): 채널 관리자 또는 서버 관리자의 프로필
 *  - 채널 관리자(개설자): 서버 관리자의 프로필 (요청은 서버 관리자에게만 전달된다)
 *  - 서버 관리자·방송 권한 보유자: 요청할 필요 없음
 */
export function canRequestFrom(actorRole: Role | undefined, canBroadcast: boolean, targetRole: Role | undefined): boolean {
  if (actorRole === 'owner') return targetRole === 'admin';
  if (canBroadcast) return false;
  return targetRole === 'owner' || targetRole === 'admin';
}
