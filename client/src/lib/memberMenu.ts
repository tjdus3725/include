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
  if (canModerate && targetRole && !protectedTarget) {
    if (targetRole !== 'manager') {
      items.push(targetRole === 'broadcaster'
        ? { label: '방송 권한 회수', icon: 'stop' as IconName, onClick: () => handlers.setBroadcaster(false) }
        : { label: '방송 권한 부여', icon: 'radio' as IconName, onClick: () => handlers.setBroadcaster(true) });
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
