# InChat API · 소켓 이벤트 명세

- 모든 시각은 Unix epoch **밀리초**, ID 는 문자열(메시지 ID 만 정수).
- 인증: `POST /api/session` 이 내려주는 `inchat_sid` 쿠키(HttpOnly). 소켓도 같은 쿠키로 핸드셰이크를 인증합니다.
- Origin: 요청 `Host` 와 같은 Origin 또는 `ALLOWED_ORIGINS` 만 허용 (HTTP 변경 요청 + 소켓 핸드셰이크). 위반 시 `403 ORIGIN_FORBIDDEN`.
- 오류 형식(HTTP): `{ "error": { "code": "…", "message": "사용자에게 보여줄 한국어 메시지" } }`
- 오류 형식(소켓 ack): `{ "ok": false, "error": { "code": "…", "message": "…", "retryAfterMs"?: number } }`, 성공은 `{ "ok": true, …결과 }`

## REST

| 메서드 · 경로 | 인증 | 요청 | 응답 |
| --- | :-: | --- | --- |
| `GET /api/health` | - | - | `{ ok: true }` |
| `GET /api/config` | - | - | `{ limits, colors[], adminEnabled, iceServers[], https: {port,url,caUrl}\|null, lanUrls[], maxViewers, onlineUsers }` |
| `GET /api/me` | - | - | `{ user: User\|null }` |
| `POST /api/session` | - | `{ nickname }` | `201 { user }` + `Set-Cookie`. 이미 세션이 있으면 `200 { user }` (새 사용자를 만들지 않음) |
| `DELETE /api/session` | ✔ | - | `{ ok: true }` (세션 삭제, 해당 세션의 소켓 종료) |
| `PATCH /api/me` | ✔ | `{ nickname?, color? }` | `{ user }` |
| `POST /api/admin/claim` | ✔ | `{ code }` | `{ user }` (`isAdmin: true`) |
| `GET /api/channels?q=` | ✔ | 검색어(이름·설명, 선택) | `{ channels: Channel[] }` (방송 중 채널이 먼저) |
| `POST /api/channels` | ✔ | `{ name, description? }` | `201 { channel }` (생성자는 owner) |
| `GET /api/channels/:id` | ✔ | - | `{ channel }` |
| `DELETE /api/channels/:id` | ✔(소유자/서버 관리자) | - | `{ ok: true }` (기본 채널은 `400 DEFAULT_CHANNEL`) |
| `GET /api/channels/:id/messages?before=<id>&limit=50` | ✔ | `before`: 이 ID 보다 오래된 메시지 | `{ messages: Message[](오래된→최신), hasMore }` |
| `GET /inchat-ca.crt` | - | - | 로컬 CA **공개 인증서** 다운로드 (`npm run cert` 이후) |

### 주요 오류 코드
`INVALID_NICKNAME`(400) · `NICKNAME_TAKEN`(409) · `AUTH_REQUIRED`(401) · `FORBIDDEN`(403) · `BANNED`(403) · `CHANNEL_NOT_FOUND`(404) ·
`CHANNEL_EXISTS`/`CHANNEL_LIMIT`(409) · `INVALID_CHANNEL`(400) · `INVALID_CODE`/`ADMIN_DISABLED`(403) · `RATE_LIMITED`(429) · `ORIGIN_FORBIDDEN`(403) · `BAD_REQUEST`(400)

## 데이터 형식

```ts
User     { id, nickname, color, isAdmin, createdAt }
Channel  { id, name, description, isDefault, ownerId|null, ownerNickname|null, createdAt, onlineCount,
           live, broadcaster?, startedAt?, hasAudio?, viewerCount? }
Message  { id:number, channelId, kind:'user'|'system', userId|null, nickname|null, color|null,
           body, createdAt, deleted:boolean, clientId|null }   // deleted 이면 body 는 빈 문자열
Participant { id, nickname, color, role:'owner'|'admin'|'broadcaster'|'member', broadcasting }
Broadcaster { userId, nickname }
BroadcastRequest { id, channelId, channelName, userId, displayName, anonymous, createdAt }
Notice   { body, updatedAt, authorNickname|null }
Ban      { userId, nickname, reason, createdAt, expiresAt|null }
```

## 소켓 이벤트

연결: `io()` (같은 Origin, 경로 `/socket.io`). 세션이 없으면 `connect_error` 의 `message === 'AUTH_REQUIRED'`.
연결되면 자동으로 `lobby` 룸에 참가해 채널 목록 갱신 이벤트를 받습니다. 채널 룸(`ch:<id>`)에는 `channel:join` 으로 참가하며, **한 소켓은 한 번에 한 채널**에만 있습니다.
**익명 입장**: `channel:join` 에 `anonymous: true` 를 주면 그 채널에서는 서버가 정한 별칭(`익명1234`, 같은 사용자·같은 채널이면 항상 동일)으로만 표시됩니다.
메시지의 `nickname`·`color`, 참여자 목록, 입퇴장/강퇴/권한 시스템 메시지, 이전 메시지 조회(`GET …/messages`)와 방송 시청자 이름 모두 별칭이 나가며 실제 닉네임은 전달되지 않습니다.
메시지에 `anonymous: true` 가 붙습니다. 강퇴·권한 부여 같은 관리 작업은 `userId` 로 이루어집니다.
접속 인원은 채널별 **고유 사용자 수**입니다(같은 사용자의 여러 탭은 1명, 연결이 끊기면 즉시 감소).
소켓 이벤트도 요청당 속도 제한(기본 10초 60건)이 있습니다.

### 클라이언트 → 서버 (모두 ack 콜백으로 응답)

| 이벤트 | 페이로드 | 성공 응답 | 권한 |
| --- | --- | --- | --- |
| `channel:join` | `{ channelId, lastId?, anonymous? }` | `{ channel, me:{role,canModerate,canBroadcast}, messages, hasMore, reset, notice, participants, broadcast }` | 로그인, 이용 제한 없음 |
| `channel:leave` | `{ channelId }` | `{}` | - |
| `message:send` | `{ channelId, clientId, body }` | `{ message, duplicate? }` | 채널 참가자 |
| `message:delete` | `{ channelId, messageId }` | `{}` | 채널 관리자 |
| `notice:set` | `{ channelId, body }` | `{ notice }` | 채널 관리자 |
| `notice:clear` | `{ channelId }` | `{}` | 채널 관리자 |
| `user:kick` | `{ channelId, userId, minutes?: number\|null, reason? }` (`minutes` 없음/null = 영구) | `{ bans }` | 채널 관리자 |
| `user:unban` | `{ channelId, userId }` | `{ bans }` | 채널 관리자 |
| `ban:list` | `{ channelId }` | `{ bans }` | 채널 관리자 |
| `broadcast:start` | `{ channelId, hasAudio }` | `{}` | 채널 관리자 또는 **방송 권한 보유자** |
| `broadcast:stop` | `{ channelId }` | `{}` | 방송 중인 본인 또는 채널 관리자 (방송자가 다른 채널에 있어도 가능) |
| `broadcast:request` | `{ channelId }` | `{}` | 채널 참가자(방송 권한 없는 사용자). 관리자에게 방송 권한을 요청. 이미 대기 중이면 `ALREADY_REQUESTED`, 이미 권한이 있으면 `ALREADY_GRANTED` |
| `request:list` | `{}` | `{ requests: BroadcastRequest[] }` | 서버 관리자는 전체, 채널 소유자는 자기 채널의 대기 중 요청 (그 외에는 빈 배열) |
| `request:dismiss` | `{ requestId }` | `{}` | 해당 채널의 관리자 |
| `broadcaster:grant` | `{ channelId, userId }` | `{ broadcasters }` | 채널 관리자 |
| `broadcaster:revoke` | `{ channelId, userId }` | `{ broadcasters }` | 채널 관리자 (대상이 방송 중이면 방송도 종료) |
| `broadcaster:list` | `{ channelId }` | `{ broadcasters }` | 채널 관리자 |
| `broadcast:watch` | `{ channelId }` | `{ broadcasterId, hasAudio }` | 채널 참가자 |
| `broadcast:unwatch` | `{ channelId }` | `{}` | - |
| `webrtc:signal` | `{ channelId, to, data }` | `{}` | 방송자↔시청자 사이만 |

- **채널 관리자** = 채널 소유자 또는 서버 관리자(`ADMIN_CODE` 인증). **방송 권한 보유자**는 채널 관리자가 채널별로 부여하며 방송만 할 수 있고 다른 관리 기능은 없습니다. 서버가 매 요청마다 DB 로 검증하며 클라이언트가 보낸 권한 정보는 신뢰하지 않습니다. 실패 시 `FORBIDDEN`.
- `message:send`: 서버가 검증(`EMPTY_MESSAGE`, `MESSAGE_TOO_LONG`, `RATE_LIMITED`(retryAfterMs), `DUPLICATE_MESSAGE`, `BANNED`)하고 고유 `id`·`createdAt` 을 부여합니다. **같은 `clientId` 로 다시 보내면 새로 저장하지 않고 기존 메시지를 `duplicate: true` 로 돌려줍니다** (재전송 안전).
- `channel:join` 재입장: `lastId`(마지막으로 받은 메시지 ID)를 보내면 그 이후 메시지를 최대 200개 돌려주고 `reset:false`. 한도를 넘으면 최신 50개와 `reset:true`(클라이언트가 목록을 교체).
- `user:kick`: 대상은 채널 관리자가 아니어야 하며 자기 자신은 불가(`INVALID_TARGET`). 대상 소켓은 채널에서 제거되고 `channel:kicked` 를 받습니다. 같은 `user_id`(옵션 `BAN_BY_IP=true` 면 IP 해시도)로 재입장하면 `BANNED`.
- `webrtc:signal.data`: `{type:'offer'|'answer', sdp}` 또는 `{type:'candidate', candidate:{candidate, sdpMid, sdpMLineIndex, usernameFragment}}`. `to` 는 상대 **소켓 ID**.

### 서버 → 클라이언트

| 이벤트 | 대상 | 페이로드 |
| --- | --- | --- |
| `message:new` | 채널 룸 | `Message` (시스템 메시지 포함) |
| `message:deleted` | 채널 룸 | `{ channelId, messageId }` |
| `notice:update` | 채널 룸 | `{ channelId, notice: Notice\|null }` |
| `presence:update` | 채널 룸 | `{ channelId, participants: Participant[] }` |
| `request:new` | 검토 권한이 있는 접속자(서버 관리자, 채널 소유자) | `{ request: BroadcastRequest }` |
| `request:resolved` | 검토 권한이 있는 접속자 | `{ id }` (부여·무시·회수로 처리됨) |
| `role:update` | 대상 사용자의 소켓(채널 룸) | `{ channelId, role, canBroadcast }` |
| `channel:kicked` | 대상 사용자의 소켓 | `{ channelId, reason, expiresAt\|null }` |
| `channel:deleted` | 채널 룸 | `{ channelId }` |
| `channels:stats` | lobby | `{ stats: [{ id, onlineCount, live, broadcaster?, startedAt?, hasAudio?, viewerCount? }] }` |
| `channels:changed` | lobby | `{}` (채널 생성/삭제 → 목록 재조회) |
| `broadcast:started` | 채널 룸 | `{ channelId, broadcaster, startedAt, hasAudio }` |
| `broadcast:ended` | 채널 룸 + 방송자 소켓 | `{ channelId, reason: 'stopped'\|'disconnected'\|'channel-deleted'\|'revoked'\|'kicked' }` |
| `broadcast:viewer-joined` | 방송자 소켓 | `{ viewerId, nickname }` → 방송자가 `viewerId` 로 offer 전송 |
| `broadcast:viewer-left` | 방송자 소켓 | `{ viewerId }` |
| `webrtc:signal` | 상대 소켓 | `{ channelId, from, data }` |
| `session:ended` | 해당 세션의 소켓 | `{}` (로그아웃) |

### 방송 협상 순서

```
방송자                         서버                          시청자
 │ broadcast:start ───────────▶│ ── broadcast:started ─────────▶│ (채널 룸 전체)
 │                             │◀────────── broadcast:watch ────│
 │◀── broadcast:viewer-joined ─│                                │
 │ webrtc:signal(offer,to=시청자)▶│ ────────── webrtc:signal ────▶│
 │◀───────── webrtc:signal(answer) ◀───────────────────────────│
 │◀──────────── webrtc:signal(candidate) 양방향 ────────────────▶│
 └───────────── WebRTC 영상 (브라우저 ↔ 브라우저 직접) ────────────┘
```
**방송은 방송자가 보고 있는 채널과 분리되어 있습니다.** 방송자가 다른 채널로 이동하거나 채널을 나가도 방송은 유지되고(시그널링도 계속 가능),
`broadcast:stop`(방송 종료 버튼)으로 끝나는 것이 기본입니다. 그 외에 서버가 방송을 끝내는 경우는 다음뿐입니다:
방송자 소켓 연결 끊김(탭 종료·네트워크 단절 — 화면 캡처도 함께 사라짐), 채널 관리자의 방송 권한 회수·강퇴·종료, 채널 삭제.
한 소켓(탭)은 동시에 하나의 방송만 할 수 있습니다(`ALREADY_LIVE`).
