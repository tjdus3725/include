// InChat 종단 간 검증 스크립트
//   사용법: npm run build && npm run e2e
//   - 임시 DB/포트/인증서로 서버를 직접 띄우고 Chromium(Playwright) 과 socket.io-client 로 시나리오를 검증합니다.
//   - Chrome 경로는 E2E_CHROME_PATH 로 지정할 수 있습니다. (기본: /opt/pw-browsers 의 Chromium → 없으면 설치된 Google Chrome)
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { chromium } from 'playwright-core';
import { io } from 'socket.io-client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'e2e', 'output');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const PORT = 3391;
const HPORT = 3392;
const ADMIN_CODE = 'e2e-admin-code';
const LAN_IP = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
const HTTP = `http://localhost:${PORT}`;
const HTTPS_LAN = LAN_IP ? `https://${LAN_IP}:${HPORT}` : null;
const HTTP_LAN = LAN_IP ? `http://${LAN_IP}:${PORT}` : null;
const dbPath = path.join(out, 'e2e.sqlite');
const certDir = path.join(out, 'certs');

// ---------- 미니 테스트 러너 ----------
const results = [];
const skipped = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, note });
    console.log(`  ✔ ${name}${note ? ` — ${note}` : ''} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false, note: e.message });
    console.log(`  ✘ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 서버 ----------
console.log('인증서 생성(scripts/gen-cert.mjs)…');
execFileSync('node', ['scripts/gen-cert.mjs'], { cwd: root, env: { ...process.env, CERT_DIR: certDir }, stdio: 'ignore' });
const spki = (() => {
  const c = new crypto.X509Certificate(fs.readFileSync(path.join(certDir, 'server.crt')));
  return crypto.createHash('sha256').update(c.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
})();

const serverLog = [];
const server = spawn('node', ['server/dist/index.js'], {
  cwd: root,
  env: {
    ...process.env, PORT: String(PORT), HTTPS: 'true', HTTPS_PORT: String(HPORT), DB_PATH: dbPath, CERT_DIR: certDir,
    ADMIN_CODE, LEAVE_GRACE_MS: '1500', SESSION_TTL_DAYS: '30',
    LOGIN_RATE_PER_10MIN: '1000', ADMIN_CLAIM_RATE_PER_10MIN: '1000', // 한 IP 에서 다수 사용자·관리자를 만드는 테스트 전용 (기본값은 20회/5회, 10분)
  },
});
server.stdout.on('data', (d) => serverLog.push(d.toString()));
server.stderr.on('data', (d) => serverLog.push(d.toString()));
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${HTTP}/api/health`)).ok) break; } catch { /* 대기 */ }
  await sleep(200);
}

// 서비스는 기본 방을 만들지 않는다. 먼저 "방이 하나도 없는 상태"를 확인한 뒤, 테스트가 쓸 방 4개를 테스트 전용으로 준비한다.
const emptyCheck = await (async () => {
  const r = await fetch(`${HTTP}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: '빈서버확인' }) });
  const cookie = r.headers.getSetCookie()[0].split(';')[0];
  const list = await (await fetch(`${HTTP}/api/channels`, { headers: { cookie } })).json();
  return list.channels.length;
})();
{
  const db = new Database(dbPath);
  const ins = db.prepare("INSERT INTO channels (id, name, name_key, description, is_default, sort_order, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)");
  [['all', '전체 채팅'], ['free', '자유 대화'], ['study', '코딩 스터디'], ['demo', '프로젝트 발표']].forEach(([id, n], i) => ins.run(id, n, n.toLowerCase(), `${n} (테스트용)`, i + 1, Date.now()));
  db.close();
}

// ---------- 헬퍼 ----------
async function apiLogin(nick) {
  const r = await fetch(`${HTTP}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: nick }) });
  const body = await r.json();
  if (!r.ok) throw new Error(`login ${nick}: ${body.error?.message}`);
  return { cookie: r.headers.getSetCookie()[0].split(';')[0], user: body.user };
}
const rawSocket = (cookie, origin) => new Promise((resolve, reject) => {
  const s = io(HTTP, { extraHeaders: { cookie, ...(origin ? { origin } : {}) }, transports: ['websocket'], reconnection: false });
  s.once('connect', () => resolve(s));
  s.once('connect_error', (e) => reject(e));
});
const emit = (s, ev, data) => new Promise((res) => s.timeout(6000).emit(ev, data, (e, r) => res(e ? { ok: false, error: { code: 'TIMEOUT' } } : r)));
const code = (r) => (r.ok ? 'ok' : r.error.code);
const api = async (cookie, method, p, body) => {
  const r = await fetch(`${HTTP}${p}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const cid = () => crypto.randomUUID().replace(/-/g, '');

const chromePath = process.env.E2E_CHROME_PATH
  || (fs.existsSync('/opt/pw-browsers') ? fs.readdirSync('/opt/pw-browsers').filter((d) => /^chromium-\d+$/.test(d)).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find((p) => fs.existsSync(p)) : undefined);
const browser = await chromium.launch({
  ...(chromePath ? { executablePath: chromePath } : { channel: 'chrome' }),
  args: [
    '--no-sandbox', '--no-proxy-server', // 샌드박스의 프록시 환경변수를 무시하고 내부 IP 로 직접 접속
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--auto-accept-this-tab-capture', '--auto-select-desktop-capture-source=Entire screen',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    `--ignore-certificate-errors-spki-list=${spki}`, // 테스트용 로컬 CA 로 만든 서버 인증서만 신뢰
  ],
});

const contexts = [];
const pageErrors = [];
async function newUser(nick, { base = HTTP, channel = 'all', viewport = { width: 1440, height: 860 }, mobile = false, init, wsControl = false } = {}) {
  const ctx = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}), locale: 'ko-KR' });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const net = { blocked: false, sockets: [] };
  if (wsControl) {
    await page.routeWebSocket(/socket\.io/, (ws) => {
      if (net.blocked) { ws.close(); return; }
      ws.connectToServer();
      net.sockets.push(ws);
    });
  }
  // 네트워크 단절/복구: 열려 있던 WebSocket 을 끊고 새 연결(WS/HTTP)을 모두 막았다가 풀어준다
  net.partition = async () => { net.blocked = true; await ctx.setOffline(true); for (const w of net.sockets.splice(0)) await w.close().catch(() => {}); };
  net.heal = async () => { net.blocked = false; await ctx.setOffline(false); };
  page.on('pageerror', (e) => pageErrors.push(`${nick}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${base}/#/c/${channel}`);
  await page.fill('#nick', nick);
  await page.getByRole('button', { name: '입장하기' }).click();
  await confirmEntry(page); // 로그인 후 로비/입장 방식 선택 (내 닉네임으로 입장)
  await ready(page);
  contexts.push(ctx);
  return { ctx, page, nick, net };
}
const confirmEntry = async (p) => { await p.getByRole('dialog').getByRole('button', { name: '입장하기' }).click({ timeout: 2500 }).catch(() => {}); }; // 채널 개설자는 팝업 없이 입장하므로 없어도 통과 // 입장 방식(내 닉네임) 팝업 확인
const composer = (p) => p.locator('textarea[aria-label="메시지 입력"]');
const ready = async (p) => {
  await p.waitForFunction(() => { const t = document.querySelector('textarea[aria-label="메시지 입력"]'); return t && !t.placeholder.startsWith('연결'); }, null, { timeout: 15000 });
};
const say = async (p, text) => { await composer(p).fill(text); await composer(p).press('Enter'); };
const log = (p) => p.locator('[role=log]');
const expectText = async (p, text, timeout = 8000) => { await log(p).getByText(text, { exact: false }).first().waitFor({ timeout }); };
const count = async (p, text) => (await log(p).innerText()).split(text).length - 1;
const createChannelUI = async (p, name, desc) => {
  await p.getByRole('button', { name: '채널 만들기' }).click();
  await p.fill('#ch-name', name);
  if (desc) await p.fill('#ch-desc', desc);
  await p.getByRole('button', { name: '만들기', exact: true }).click();
  await p.getByRole('heading', { name }).waitFor();
  await ready(p);
};

console.log(`\nInChat e2e  (HTTP ${HTTP}${HTTPS_LAN ? `, HTTPS ${HTTPS_LAN}` : ''})\n`);

// =====================================================================
console.log('[1] 입장·채팅');
let A, B, C;
const NO_PERM = '방송 권한이 존재하지 않습니다. 관리자에게 문의해 주세요';
async function expectNoPerm(page, why) {
  await page.getByRole('button', { name: '방송 시작', exact: true }).click();
  await page.getByText(NO_PERM).first().waitFor({ timeout: 3000 }).catch(() => { throw new Error(why + ': 권한 없음 안내가 뜨지 않음'); });
}
await test('기본 방이 없음: 새 서버에는 방이 하나도 없다', async () => {
  assert(emptyCheck === 0, `새 서버에 방이 ${emptyCheck}개 있음 (기본 방이 생성되면 안 됨)`);
  return '방 0개 (기본 방 자동 생성 없음)';
});

await test('첫 접속: 닉네임 서버 검증 및 입장, 로그인 화면', async () => {
  for (const nick of ['a', '<script>', 'a b c', '관리자', 'x'.repeat(13), '이모지😀']) {
    const r = await fetch(`${HTTP}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: nick }) });
    assert(r.status === 400, `"${nick}" 가 거부되지 않음 (${r.status})`);
  }
  A = await newUser('앨리스');
  B = await newUser('밥_Bob', { wsControl: true });
  const shotCtx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
  const shot = await shotCtx.newPage();
  await shot.goto(HTTP);
  await shot.waitForSelector('#nick');
  await shot.waitForFunction(() => document.querySelector('img[alt="InChat"]')?.complete);
  await shot.screenshot({ path: path.join(out, 'login-desktop.png') });
  await shotCtx.close();
  return '잘못된 닉네임 6종 거부, 정상 닉네임 입장';
});

await test('브라우저 두 개에서 같은 채널 메시지 송수신 + 내/상대 메시지 구분', async () => {
  await say(A.page, '안녕 밥! 앨리스야');
  await expectText(B.page, '안녕 밥! 앨리스야');
  await say(B.page, '반가워 앨리스 👋');
  await expectText(A.page, '반가워 앨리스');
  const mineA = await A.page.locator('[role=log] .justify-end', { hasText: '안녕 밥!' }).count();
  const mineB = await B.page.locator('[role=log] .justify-end', { hasText: '안녕 밥!' }).count();
  assert(mineA === 1 && mineB === 0, `내 메시지 구분 실패 (A:${mineA}, B:${mineB})`);
  const logs = (await log(A.page).innerText()) + (await log(B.page).innerText());
  assert(logs.includes('님이 입장했습니다'), '입장 시스템 메시지 없음');
  const time = await A.page.locator('[role=log] time').first().innerText();
  assert(/^\d{2}:\d{2}$/.test(time), `시간 표시 형식 이상: ${time}`);
  await A.page.screenshot({ path: path.join(out, 'desktop-chat.png') });
});

await test('다른 채널로 메시지가 전달되지 않음', async () => {
  C = await newUser('찰리', { channel: 'free' });
  const raw = await rawSocket((await apiLogin('로우유저')).cookie);
  const seen = [];
  raw.on('message:new', (m) => seen.push(m));
  await emit(raw, 'channel:join', { channelId: 'free' });
  await say(A.page, '전체채팅 전용 메시지-XYZ');
  await expectText(B.page, '전체채팅 전용 메시지-XYZ');
  await sleep(800);
  assert(!(await log(C.page).innerText()).includes('XYZ'), '자유 대화 화면에 전체 채팅 메시지가 표시됨');
  assert(!seen.some((m) => m.body?.includes('XYZ')), '다른 채널 소켓이 메시지를 수신함');
  await say(C.page, '자유대화 전용-QRS');
  await expectText(C.page, '자유대화 전용-QRS');
  await sleep(600);
  assert(!(await log(A.page).innerText()).includes('QRS'), '전체 채팅 화면에 자유 대화 메시지가 표시됨');
  assert(seen.some((m) => m.body?.includes('QRS')), '같은 채널 소켓은 수신해야 함');
  raw.close();
});

await test('새로고침 후 세션 유지 및 저장된 메시지 표시', async () => {
  const before = await A.page.evaluate(() => fetch('/api/me').then((r) => r.json()));
  await A.page.reload();
  await ready(A.page);
  await expectText(A.page, '안녕 밥! 앨리스야');
  const after = await A.page.evaluate(() => fetch('/api/me').then((r) => r.json()));
  assert(before.user.id === after.user.id && after.user.nickname === '앨리스', '세션(사용자 ID)이 유지되지 않음');
  assert(A.page.url().endsWith('#/c/all'), '채널 위치가 유지되지 않음');
  const sid = (await A.ctx.cookies()).find((c) => c.name === 'inchat_sid');
  assert(sid?.httpOnly && sid.sameSite === 'Lax', '세션 쿠키가 HttpOnly/SameSite=Lax 가 아님');
  const ro = new Database(dbPath, { readonly: true });
  const raw = ro.prepare('SELECT COUNT(*) n FROM sessions WHERE token_hash = ?').get(sid.value);
  ro.close();
  assert(raw.n === 0, 'DB 에 토큰 원문이 저장됨');
  return '새로고침 후 같은 사용자 ID·메시지 복원, 쿠키 HttpOnly, DB 에는 해시만 저장';
});

await test('XSS: 메시지는 일반 텍스트로만 렌더링', async () => {
  await say(A.page, '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>');
  await expectText(B.page, '<img src=x');
  await sleep(300);
  const r = await B.page.evaluate(() => ({ xss: window.__xss ?? null, imgs: document.querySelectorAll('[role=log] img, [role=log] script').length }));
  assert(r.xss === null && r.imgs === 0, `스크립트/이미지가 렌더링됨 ${JSON.stringify(r)}`);
});

await test('한글 입력: 조합 중 Enter 는 전송하지 않고, 확정 후 Enter 로 전송 / Shift+Enter 줄바꿈', async () => {
  const ta = composer(A.page);
  await ta.fill('');
  const cdp = await A.ctx.newCDPSession(A.page);
  await ta.focus();
  // 실제 IME 조합 상태 재현: CDP 로 조합 시작 → 조합 중 Enter
  await cdp.send('Input.imeSetComposition', { text: '안녕하세', selectionStart: 4, selectionEnd: 4 });
  await A.page.keyboard.press('Enter');
  await sleep(500);
  assert(!(await log(A.page).innerText()).includes('안녕하세'), '조합 중 Enter 로 메시지가 전송됨');
  await cdp.send('Input.insertText', { text: '요 한글 입력' });
  await sleep(100);
  const val = await ta.inputValue();
  assert(val.includes('한글 입력'), `조합 확정 후 입력값이 이상함: "${val}"`);
  await sleep(1200); // 메시지 속도 제한(버스트 5, 초당 1)과 겹치지 않게 간격 확보
  await ta.press('Enter');
  await expectText(B.page, '한글 입력');
  await ta.fill('첫줄');
  await ta.press('Shift+Enter');
  await ta.pressSequentially('둘째줄');
  assert((await ta.inputValue()) === '첫줄\n둘째줄', 'Shift+Enter 줄바꿈 실패');
  await sleep(1200);
  await ta.press('Enter');
  await expectText(B.page, '둘째줄');
  // Safari 유형(keyCode 229 / isComposing) 합성 이벤트
  await ta.fill('합성테스트');
  const prevented = await A.page.evaluate(() => {
    const t = document.querySelector('textarea[aria-label="메시지 입력"]');
    t.dispatchEvent(new CompositionEvent('compositionstart'));
    const ev = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true, isComposing: true });
    t.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  assert(prevented === false, '조합 이벤트의 Enter 를 가로채 전송함');
  return 'CDP IME 조합 중 Enter 무시 → 확정 후 전송, Shift+Enter 줄바꿈 (실제 한글 IME 키보드/모바일 IME 는 미확인)';
});

await test('입력 검증: 빈/긴 메시지 차단, 연속 전송·중복 제한, 재전송 idempotent', async () => {
  const s = await rawSocket((await apiLogin('제한테스터')).cookie);
  await emit(s, 'channel:join', { channelId: 'free' });
  const send = (body, clientId = cid()) => emit(s, 'message:send', { channelId: 'free', clientId, body });
  assert((await send('   ')).error?.code === 'EMPTY_MESSAGE', '빈 메시지가 차단되지 않음');
  assert((await send('가'.repeat(501))).error?.code === 'MESSAGE_TOO_LONG', '긴 메시지가 차단되지 않음');
  assert((await send('가'.repeat(500))).ok === true, '500자 메시지는 허용되어야 함');
  await sleep(400);
  const dupId = `dedupe_${cid()}`;
  const first = await send('중복 테스트 메시지', dupId);
  const again = await send('중복 테스트 메시지', dupId);
  assert(first.ok && again.ok && again.duplicate && again.message.id === first.message.id, '같은 clientId 재전송이 동일 메시지로 처리되지 않음');
  await sleep(400);
  assert((await send('중복 테스트 메시지')).error?.code === 'DUPLICATE_MESSAGE', '같은 내용 연속 전송이 차단되지 않음');
  await sleep(400);
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => send(`버스트 ${i}`)));
  const limited = burst.filter((r) => r.error?.code === 'RATE_LIMITED').length;
  assert(limited >= 5, `연속 전송 제한이 동작하지 않음 (제한된 요청 ${limited}/12)`);
  const ro = new Database(dbPath, { readonly: true });
  const rows = ro.prepare("SELECT COUNT(*) n FROM messages WHERE body = '중복 테스트 메시지'").get();
  ro.close();
  assert(rows.n === 1, `DB 에 중복 저장됨 (${rows.n})`);
  s.close();
  return `연속 전송 12건 중 ${limited}건 제한, 재전송은 같은 메시지 ID 반환`;
});

await test('이전 메시지 페이지 조회 + "새 메시지" 버튼 / 아래에서만 자동 스크롤', async () => {
  const db = new Database(dbPath);
  const ins = db.prepare("INSERT INTO messages (channel_id, user_id, kind, body, created_at) VALUES ('study', NULL, 'system', ?, ?)");
  const t0 = Date.now() - 200_000;
  db.transaction(() => { for (let i = 1; i <= 130; i++) ins.run(`과거 메시지 #${i}`, t0 + i * 1000); })();
  db.close();
  const D = await newUser('페이지테스터', { channel: 'study' });
  await expectText(D.page, '과거 메시지 #130');
  const sysCount = () => log(D.page).locator('.rounded-full.bg-ink-700').count();
  const initial = await sysCount();
  assert(initial <= 52, `첫 로드 개수가 페이지 크기(50)를 넘음: ${initial}`);
  await D.page.getByRole('button', { name: /이전 메시지 불러오기/ }).click();
  await expectText(D.page, '과거 메시지 #60');
  const second = await sysCount();
  assert(second > initial + 40, `이전 메시지가 추가되지 않음 (${initial} → ${second})`);
  const E = await newUser('새메시지발신', { channel: 'study' });
  await log(D.page).evaluate((el) => { el.scrollTop = 0; });
  await sleep(300);
  await say(E.page, '새 메시지 도착 테스트');
  await D.page.getByRole('button', { name: /새 메시지 1개/ }).waitFor({ timeout: 6000 });
  assert(await log(D.page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight > 100), '위를 보고 있는데 강제로 스크롤됨');
  await D.page.getByRole('button', { name: /새 메시지 1개/ }).click();
  await sleep(300);
  assert(await log(D.page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60), '버튼을 눌러도 맨 아래로 이동하지 않음');
  await sleep(1100);
  await say(E.page, '아래에서 자동 스크롤 확인');
  await expectText(D.page, '아래에서 자동 스크롤 확인');
  await sleep(300);
  assert(await log(D.page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60), '아래를 보고 있는데 자동 스크롤되지 않음');
  return `첫 로드 ${initial}개 → 이전 페이지 로드 후 ${second}개`;
});

// =====================================================================
console.log('\n[2] 접속 인원 · 재연결');
await test('여러 탭은 한 명으로 계산, 탭/연결 종료 시 인원 감소', async () => {
  const cookie = (await apiLogin('멀티탭')).cookie;
  const watcher = await rawSocket((await apiLogin('관찰자')).cookie);
  let latest = [];
  watcher.on('presence:update', (d) => { if (d.channelId === 'free') latest = d.participants; });
  await emit(watcher, 'channel:join', { channelId: 'free' });
  const sockets = [];
  for (let i = 0; i < 3; i++) { const s = await rawSocket(cookie); await emit(s, 'channel:join', { channelId: 'free' }); sockets.push(s); }
  await sleep(600);
  assert(latest.filter((u) => u.nickname === '멀티탭').length === 1, '같은 사용자 3개 탭이 여러 명으로 계산됨');
  sockets[0].close(); sockets[1].close();
  await sleep(600);
  assert(latest.some((u) => u.nickname === '멀티탭'), '아직 탭이 남아 있는데 접속 인원에서 빠짐');
  sockets[2].io.engine.close(); // 비정상 종료: 전송 계층을 그대로 끊음
  await sleep(1000);
  assert(!latest.some((u) => u.nickname === '멀티탭'), '모든 탭이 끊겼는데 접속 인원에 남아 있음');
  watcher.close();
});

await test('채널 퇴장: 나가기 버튼 → 퇴장 메시지·접속 인원 감소·로비 화면, 로그아웃 시 세션 무효화', async () => {
  const stay = await newUser('남는사람', { channel: 'demo' });
  const goer = await newUser('나가는사람', { channel: 'demo' });
  await stay.page.getByLabel('2명 접속 중').first().waitFor({ timeout: 6000 });
  await goer.page.getByRole('button', { name: '채널 나가기' }).click();
  await goer.page.getByRole('heading', { name: '방송 로비' }).waitFor();
  await expectText(stay.page, '나가는사람님이 퇴장했습니다');
  await stay.page.getByLabel('1명 접속 중').first().waitFor({ timeout: 6000 });
  // 다시 입장
  await goer.page.getByRole('button', { name: /전체 채팅/ }).first().click();
  await confirmEntry(goer.page);
  await ready(goer.page);
  // 로그아웃: 세션 삭제 후 같은 쿠키로 API/소켓 모두 거부
  const cookie = (await goer.ctx.cookies()).find((c) => c.name === 'inchat_sid');
  await goer.page.getByRole('button', { name: '내 프로필' }).click();
  await goer.page.getByRole('menuitem', { name: /나가기\(로그아웃\)/ }).click();
  await goer.page.locator('#nick').waitFor();
  const me = await api(`inchat_sid=${cookie.value}`, 'GET', '/api/me');
  assert(me.body.user === null, '로그아웃 후에도 세션이 유효함');
  const st = await new Promise((res) => { const sk = io(HTTP, { extraHeaders: { cookie: `inchat_sid=${cookie.value}` }, transports: ['websocket'], reconnection: false }); sk.once('connect', () => { sk.close(); res('connected'); }); sk.once('connect_error', (e) => res(e.message)); });
  assert(st === 'AUTH_REQUIRED', '로그아웃 후에도 소켓 연결이 가능함');
});

await test('연결 해제 후 재연결: 안내 배너, 누락 메시지 복구, 중복 없음', async () => {
  const sender = await rawSocket((await apiLogin('오프라인중발신')).cookie);
  await emit(sender, 'channel:join', { channelId: 'all' });
  await B.net.partition(); // 기존 WebSocket 을 끊고 재연결 시도를 모두 막는다
  await B.page.getByText(/연결이 끊|다시 연결하는 중/).first().waitFor({ timeout: 30000 });
  const msgs = ['오프라인 중 메시지 1', '오프라인 중 메시지 2', '오프라인 중 메시지 3'];
  for (const t of msgs) { await emit(sender, 'message:send', { channelId: 'all', clientId: cid(), body: t }); await sleep(350); }
  await sleep(1500);
  assert((await log(B.page).innerText()).includes('오프라인 중 메시지') === false, '끊긴 상태인데 메시지가 도착함');
  await B.page.screenshot({ path: path.join(out, 'desktop-disconnected.png') });
  const sendDisabled = await B.page.getByRole('button', { name: '메시지 전송' }).isDisabled();
  assert(sendDisabled, '연결이 끊긴 동안 전송 버튼이 비활성화되지 않음');
  // 접속 인원: 끊긴 사용자는 서버에서 빠져야 함
  const before = await A.page.getByLabel(/명 접속 중/).first().getAttribute('aria-label');
  await B.net.heal();
  await B.page.getByText('다시 연결되었습니다').waitFor({ timeout: 30000 });
  await expectText(B.page, msgs[2], 10000);
  for (const t of msgs) assert((await count(B.page, t)) === 1, `"${t}" 가 ${await count(B.page, t)}번 표시됨 (누락/중복)`);
  await sleep(1100);
  await say(B.page, '재연결 후 전송 성공');
  await expectText(A.page, '재연결 후 전송 성공');
  const dupJoin = await count(A.page, '밥_Bob님이 입장했습니다');
  sender.close();
  return `끊김 배너·전송 버튼 비활성, 복구 후 누락 3건 회복·중복 0, 재전송 성공 (접속 표시 ${before}, 입장 메시지 ${dupJoin}회)`;
});

await test('재연결 동기화 프로토콜: lastId 이후 메시지만 반환', async () => {
  const c1 = await apiLogin('싱크A');
  const c2 = await apiLogin('싱크B');
  const s1 = await rawSocket(c1.cookie);
  const j = await emit(s1, 'channel:join', { channelId: 'demo' });
  const last = j.messages.at(-1)?.id ?? 0;
  s1.close();
  const s2 = await rawSocket(c2.cookie);
  await emit(s2, 'channel:join', { channelId: 'demo' });
  const ids = [];
  for (let i = 0; i < 3; i++) { const r = await emit(s2, 'message:send', { channelId: 'demo', clientId: cid(), body: `sync ${i}` }); ids.push(r.message.id); await sleep(350); }
  const s1b = await rawSocket(c1.cookie);
  const j2 = await emit(s1b, 'channel:join', { channelId: 'demo', lastId: last });
  const got = j2.messages.filter((m) => m.kind === 'user').map((m) => m.id);
  assert(j2.reset === false && ids.every((i) => got.includes(i)), `누락 메시지가 복구되지 않음 ${JSON.stringify({ ids, got, reset: j2.reset })}`);
  assert(new Set(j2.messages.map((m) => m.id)).size === j2.messages.length, '동기화 응답에 중복 ID');
  s1b.close(); s2.close();
});

// =====================================================================
console.log('\n[3] 권한 · 보안');
let ownerCookie, otherCookie, ownerUser, chId;
await test('채널 생성/목록/검색 + 생성자 권한', async () => {
  ({ cookie: ownerCookie, user: ownerUser } = await apiLogin('방장님'));
  ({ cookie: otherCookie } = await apiLogin('평범한유저'));
  const created = await api(ownerCookie, 'POST', '/api/channels', { name: 'e2e 테스트 채널', description: '권한 검증용' });
  assert(created.status === 201, `채널 생성 실패 ${JSON.stringify(created.body)}`);
  chId = created.body.channel.id;
  assert(created.body.channel.ownerId === ownerUser.id, '생성자가 소유자가 아님');
  assert((await api(ownerCookie, 'POST', '/api/channels', { name: 'E2E 테스트 채널' })).status === 409, '중복 채널명이 허용됨');
  assert((await api(ownerCookie, 'POST', '/api/channels', { name: '<b>x</b>' })).status === 400, '허용되지 않는 문자가 통과됨');
  const search = await api(otherCookie, 'GET', `/api/channels?q=${encodeURIComponent('e2e')}`);
  assert(search.body.channels.length === 1 && search.body.channels[0].id === chId, '검색 결과 이상');
  const names = (await api(otherCookie, 'GET', '/api/channels')).body.channels.map((c) => c.name);
  for (const n of ['전체 채팅', '자유 대화', '코딩 스터디', '프로젝트 발표']) assert(names.includes(n), `테스트용 방 누락: ${n}`);
  return '테스트용 방 4개 + 생성 채널, 검색 1건, 중복/불허 문자 거부';
});

await test('비관리자의 관리 기능 호출 차단 (소켓 11종 + REST 채널 삭제 + 닉네임 탈취)', async () => {
  const owner = await rawSocket(ownerCookie);
  const other = await rawSocket(otherCookie);
  await emit(owner, 'channel:join', { channelId: chId });
  await emit(other, 'channel:join', { channelId: chId });
  const m = await emit(other, 'message:send', { channelId: chId, clientId: cid(), body: '삭제 대상 메시지' });
  const target = m.message.id;
  const attempts = {
    'message:delete': { channelId: chId, messageId: target },
    'notice:set': { channelId: chId, body: '가짜 공지' },
    'notice:clear': { channelId: chId },
    'user:kick': { channelId: chId, userId: ownerUser.id },
    'user:unban': { channelId: chId, userId: ownerUser.id },
    'ban:list': { channelId: chId },
    'broadcast:start': { channelId: chId, hasAudio: false },
    'broadcast:stop': { channelId: chId },
    'broadcaster:grant': { channelId: chId, userId: ownerUser.id },
    'broadcaster:revoke': { channelId: chId, userId: ownerUser.id },
    'broadcaster:list': { channelId: chId },
  };
  for (const [ev, data] of Object.entries(attempts)) {
    const r = await emit(other, ev, data);
    assert(r.ok === false && r.error.code === 'FORBIDDEN', `${ev} 가 차단되지 않음: ${JSON.stringify(r)}`);
  }
  assert((await api(otherCookie, 'DELETE', `/api/channels/${chId}`)).status === 403, '채널 삭제가 차단되지 않음');
  await emit(other, 'channel:join', { channelId: 'demo' });
  assert((await emit(other, 'broadcast:start', { channelId: 'demo', hasAudio: false })).error?.code === 'FORBIDDEN', '기본 채널 방송이 일반 사용자에게 허용됨');
  assert((await emit(other, 'webrtc:signal', { channelId: 'demo', to: owner.id, data: { type: 'offer', sdp: 'x' } })).ok === false, '방송이 없는데 시그널링이 중계됨');
  // 닉네임 탈취: 소유자 닉네임으로 변경 불가, 다른 이름으로 바꿔도 권한 이동 없음
  assert((await api(otherCookie, 'PATCH', '/api/me', { nickname: '방장님' })).status === 409, '소유자 닉네임으로 변경 가능');
  assert((await api(otherCookie, 'PATCH', '/api/me', { nickname: '방장님2' })).status === 200, '닉네임 변경 실패');
  assert((await emit(other, 'notice:set', { channelId: chId, body: '이름만 비슷' })).error?.code === 'FORBIDDEN', '닉네임 변경으로 권한이 생김');
  assert((await api(otherCookie, 'POST', '/api/admin/claim', { code: 'wrong' })).status === 403, '잘못된 관리자 코드가 통과됨');
  // 소유자는 성공
  assert((await emit(owner, 'notice:set', { channelId: chId, body: '정식 공지입니다' })).ok, '소유자의 공지 등록 실패');
  assert((await emit(owner, 'message:delete', { channelId: chId, messageId: target })).ok, '소유자의 메시지 삭제 실패');
  const hist = await emit(other, 'channel:join', { channelId: chId });
  const deleted = hist.messages.find((x) => x.id === target);
  assert(deleted.deleted && deleted.body === '', '삭제된 메시지 본문이 여전히 전달됨');
  assert(hist.notice?.body === '정식 공지입니다', '공지가 조회되지 않음');
  owner.close(); other.close();
  return '차단 확인 + 소유자만 성공, 삭제 메시지 본문은 서버가 전송하지 않음';
});

await test('개설자 익명 입장 불가 · 방송 권한 정보는 관리자에게만 · 개설자는 요청 없이 방송', async () => {
  const third = await apiLogin('일반참여자');
  const otherMe = (await api(otherCookie, 'GET', '/api/me')).body.user;
  const owner = await rawSocket(ownerCookie);
  const other = await rawSocket(otherCookie);
  const guest = await rawSocket(third.cookie);
  let ownerView = [], guestView = [];
  owner.on('presence:update', (d) => { if (d.channelId === chId) ownerView = d.participants; });
  guest.on('presence:update', (d) => { if (d.channelId === chId) guestView = d.participants; });
  // 1) 개설자가 anonymous:true 로 입장해도 서버가 무시하고 본인 닉네임으로 입장시킨다
  const j = await emit(owner, 'channel:join', { channelId: chId, anonymous: true });
  const me = j.participants.find((u) => u.id === ownerUser.id);
  assert(me && me.nickname === '방장님' && me.role === 'owner', `개설자가 익명으로 입장됨: ${JSON.stringify(me)}`);
  await emit(other, 'channel:join', { channelId: chId });
  await emit(guest, 'channel:join', { channelId: chId });
  // 2) 개설자(관리자)는 요청 없이 바로 방송할 수 있다
  assert((await emit(owner, 'broadcast:start', { channelId: chId, hasAudio: false })).ok, '개설자가 요청 없이 방송하지 못함');
  assert((await emit(owner, 'broadcast:stop', { channelId: chId })).ok, '방송 종료 실패');
  // 3) 개설자는 방송 권한을 부여/조회/회수할 수 있고, 일반 참여자는 볼 수도 바꿀 수도 없다
  const granted = await emit(owner, 'broadcaster:grant', { channelId: chId, userId: otherMe.id });
  assert(granted.ok && granted.broadcasters.some((b) => b.userId === otherMe.id), `개설자의 권한 부여 실패 ${JSON.stringify(granted)}`);
  await sleep(500);
  assert(ownerView.find((u) => u.id === otherMe.id)?.role === 'broadcaster', '개설자에게 방송 권한 보유자가 표시되지 않음');
  assert(guestView.find((u) => u.id === otherMe.id)?.role === 'member', `일반 참여자에게 방송 권한 보유자가 노출됨: ${JSON.stringify(guestView.find((u) => u.id === otherMe.id))}`);
  for (const [ev, data] of [['broadcaster:list', { channelId: chId }], ['broadcaster:grant', { channelId: chId, userId: otherMe.id }], ['broadcaster:revoke', { channelId: chId, userId: otherMe.id }]]) {
    assert((await emit(guest, ev, data)).error?.code === 'FORBIDDEN', `일반 참여자의 ${ev} 가 차단되지 않음`);
  }
  assert(code(await emit(owner, 'broadcaster:revoke', { channelId: chId, userId: otherMe.id })) === 'FORBIDDEN', '개설자가 방송 권한을 회수할 수 있음(서버 관리자만 가능해야 함)');
  // 4) 시스템 메시지로도 보유자가 드러나지 않는다
  const hist = await emit(guest, 'channel:join', { channelId: chId });
  assert(!hist.messages.some((m) => m.kind === 'system' && m.body.includes('방송 권한')), '채팅에 방송 권한 부여/회수 메시지가 공개됨');
  owner.close(); other.close(); guest.close();
  return '개설자 익명 입장 무시, 요청 없이 방송, 보유자 표시는 관리자에게만, 일반 참여자의 조회·부여·회수 차단';
});

await test('개설자는 입장 방식 팝업 없이 본인 닉네임으로 바로 입장 (화면)', async () => {
  const O = await newUser('화면개설자', { channel: 'all' });
  await createChannelUI(O.page, '개설자 전용방');
  await O.page.getByRole('button', { name: '채널 나가기' }).click();
  await O.page.getByRole('heading', { name: '방송 로비' }).waitFor();
  await O.page.getByRole('button', { name: /개설자 전용방/ }).first().click();
  await ready(O.page); // 팝업이 떴다면 여기서 막힌다
  assert((await O.page.getByRole('dialog').count()) === 0, '개설자에게 입장 방식 팝업이 표시됨');
  const txt = await O.page.locator('body').innerText();
  assert(txt.includes('화면개설자') && !/익명\d{4}/.test(txt), '개설자가 익명으로 표시됨');
});

await test('권한 위계 전수 검증: 서버 관리자 > 채널 관리자 > 매니저 > 일반 (차단·매니저·방송 권한)', async () => {
  const mk = async (n) => { const l = await apiLogin(n); return { ...l, sock: await rawSocket(l.cookie) }; };
  const A = await mk('위계서버관리자'), O = await mk('위계개설자'), M = await mk('위계매니저'), M2 = await mk('위계매니저2'), U = await mk('위계일반'), U2 = await mk('위계일반2');
  assert((await api(A.cookie, 'POST', '/api/admin/claim', { code: ADMIN_CODE })).status === 200, '서버 관리자 인증 실패');
  const cid = (await api(O.cookie, 'POST', '/api/channels', { name: '위계 검증방' })).body.channel.id;
  for (const x of [A, O, M, M2, U, U2]) await emit(x.sock, 'channel:join', { channelId: cid });
  const code = (r) => (r.ok ? 'ok' : r.error.code);
  const kick = (x, t, minutes = 10) => emit(x.sock, 'user:kick', { channelId: cid, userId: t.user.id, minutes });
  assert(code(await emit(U.sock, 'manager:appoint', { channelId: cid, userId: M.user.id })) === 'FORBIDDEN', '일반 사용자가 매니저 임명');
  assert((await emit(O.sock, 'manager:appoint', { channelId: cid, userId: M.user.id })).ok && (await emit(O.sock, 'manager:appoint', { channelId: cid, userId: M2.user.id })).ok, '개설자의 매니저 임명 실패');
  assert(code(await emit(A.sock, 'manager:appoint', { channelId: cid, userId: O.user.id })) === 'INVALID_TARGET', '개설자를 매니저로 임명할 수 있음');
  for (const [ev, d] of [['manager:appoint', { userId: U.user.id }], ['manager:revoke', { userId: M2.user.id }], ['broadcaster:grant', { userId: U.user.id }], ['broadcaster:list', {}], ['notice:set', { body: 'x' }], ['broadcast:start', { hasAudio: false }]]) {
    assert(code(await emit(M.sock, ev, { channelId: cid, ...d })) === 'FORBIDDEN', `매니저가 ${ev} 실행 가능`);
  }
  assert((await emit(M.sock, 'ban:list', { channelId: cid })).ok, '매니저의 차단 목록 조회 실패');
  for (const [name, t] of [['개설자', O], ['서버 관리자', A], ['다른 매니저', M2], ['자기 자신', M]]) assert(code(await kick(M, t)) === 'INVALID_TARGET', `매니저가 ${name} 를 차단할 수 있음`);
  assert((await kick(M, U)).ok, '매니저가 일반 사용자를 차단하지 못함');
  assert(code(await emit(U.sock, 'channel:join', { channelId: cid })) === 'BANNED', '차단된 사용자가 재입장');
  assert((await emit(M.sock, 'user:unban', { channelId: cid, userId: U.user.id })).ok, '매니저의 차단 해제 실패');
  assert(code(await emit(U2.sock, 'user:kick', { channelId: cid, userId: U.user.id })) === 'FORBIDDEN', '일반 사용자가 차단 실행');
  assert(code(await kick(O, A)) === 'INVALID_TARGET', '개설자가 서버 관리자를 차단');
  assert((await kick(O, M2)).ok, '개설자가 매니저를 차단하지 못함');
  assert((await emit(O.sock, 'user:unban', { channelId: cid, userId: M2.user.id })).ok, '개설자의 차단 해제 실패');
  assert((await kick(A, O)).ok, '서버 관리자가 개설자를 차단하지 못함');
  assert(code(await emit(O.sock, 'channel:join', { channelId: cid })) === 'BANNED', '차단된 개설자가 재입장');
  assert((await emit(A.sock, 'user:unban', { channelId: cid, userId: O.user.id })).ok, '서버 관리자의 차단 해제 실패');
  assert(code(await kick(A, A)) === 'INVALID_TARGET', '서버 관리자 자기 차단');
  assert((await emit(A.sock, 'broadcaster:grant', { channelId: cid, userId: U2.user.id })).ok, '서버 관리자가 남의 채널에서 방송 권한 부여 실패');
  for (const x of [A, O, M, M2, U, U2]) x.sock.close();
  return '매니저는 차단·해제만, 서버/채널 관리자·다른 매니저 차단 불가, 개설자↔서버 관리자 위계 확인';
});

await test('채널 관리자의 방송 요청: 서버 관리자에게만 전달·서버 관리자만 처리, 그 외 이미 방송 가능한 사용자는 요청 불가', async () => {
  const mk = async (n) => { const l = await apiLogin(n); return { ...l, sock: await rawSocket(l.cookie), notes: [] }; };
  const A = await mk('요청서버관리자'), O = await mk('요청개설자'), U = await mk('요청일반'), H = await mk('요청권한자');
  await api(A.cookie, 'POST', '/api/admin/claim', { code: ADMIN_CODE });
  for (const x of [A, O, U, H]) x.sock.on('notification:new', (d) => x.notes.push(d.notification));
  const cid = (await api(O.cookie, 'POST', '/api/channels', { name: '요청 검증방' })).body.channel.id;
  for (const x of [A, O, U, H]) await emit(x.sock, 'channel:join', { channelId: cid });
  const code = (r) => (r.ok ? 'ok' : r.error.code);
  assert((await emit(O.sock, 'broadcaster:grant', { channelId: cid, userId: H.user.id })).ok, '방송 권한 부여 실패');
  assert(code(await emit(H.sock, 'broadcast:request', { channelId: cid })) === 'ALREADY_GRANTED', '방송 권한 보유자가 요청할 수 있음');
  assert(code(await emit(A.sock, 'broadcast:request', { channelId: cid })) === 'ALREADY_GRANTED', '서버 관리자가 요청할 수 있음');
  // 개설자 → 서버 관리자에게 요청
  assert((await emit(O.sock, 'broadcast:request', { channelId: cid })).ok, '채널 관리자의 방송 요청 실패');
  assert(code(await emit(O.sock, 'broadcast:request', { channelId: cid })) === 'ALREADY_REQUESTED', '중복 요청이 허용됨');
  const adminReqs = (await emit(A.sock, 'request:list', {})).requests;
  const mine = adminReqs.find((r) => r.userId === O.user.id);
  assert(mine, '서버 관리자에게 개설자의 요청이 전달되지 않음');
  assert(!(await emit(O.sock, 'request:list', {})).requests.some((r) => r.userId === O.user.id), '개설자 본인 알림함에 자기 요청이 보임');
  assert(code(await emit(O.sock, 'request:dismiss', { requestId: mine.id })) === 'FORBIDDEN', '개설자가 자기 요청을 스스로 처리함');
  assert(code(await emit(U.sock, 'request:dismiss', { requestId: mine.id })) === 'FORBIDDEN', '일반 사용자가 요청을 처리함');
  assert((await emit(A.sock, 'broadcaster:grant', { channelId: cid, userId: O.user.id })).ok, '서버 관리자의 승인 실패');
  await sleep(300);
  assert(O.notes.some((n) => n.kind === 'broadcaster_granted'), '개설자에게 승인 알림이 없음');
  assert(!(await emit(A.sock, 'request:list', {})).requests.some((r) => r.userId === O.user.id), '승인 후에도 요청이 남음');
  assert((await emit(O.sock, 'broadcaster:list', { channelId: cid })).broadcasters.some((b) => b.userId === O.user.id), '서버 관리자가 승인한 개설자가 보유자 목록에 없음');
  // 다시 요청 → 거절
  assert((await emit(O.sock, 'broadcast:request', { channelId: cid })).ok, '재요청 실패');
  const again = (await emit(A.sock, 'request:list', {})).requests.find((r) => r.userId === O.user.id);
  assert((await emit(A.sock, 'request:dismiss', { requestId: again.id })).ok, '서버 관리자의 거절 실패');
  await sleep(300);
  assert(O.notes.some((n) => n.kind === 'request_declined'), '개설자에게 거절 알림이 없음');
  // 개설자는 요청 여부와 상관없이 계속 방송할 수 있다
  assert((await emit(O.sock, 'broadcast:start', { channelId: cid, hasAudio: false })).ok, '개설자가 방송하지 못함');
  await emit(O.sock, 'broadcast:stop', { channelId: cid });
  for (const x of [A, O, U, H]) x.sock.close();
});

await test('서버 관리자: 새 채널 개설 알림, 채널 관리자에게 직접 방송 권한 부여', async () => {
  const mk = async (n) => { const l = await apiLogin(n); return { ...l, sock: await rawSocket(l.cookie), notes: [] }; };
  const A = await mk('개설알림관리자'), A2 = await mk('개설알림관리자2'), O = await mk('개설알림개설자'), U = await mk('개설알림일반');
  for (const x of [A, A2]) await api(x.cookie, 'POST', '/api/admin/claim', { code: ADMIN_CODE });
  for (const x of [A, A2, O, U]) x.sock.on('notification:new', (d) => x.notes.push(d.notification));
  const created = (await api(O.cookie, 'POST', '/api/channels', { name: '개설알림 검증방' })).body.channel;
  await sleep(400);
  const isNew = (x) => x.notes.filter((n) => n.kind === 'channel_created' && n.channelId === created.id);
  assert(isNew(A).length === 1 && isNew(A2).length === 1, `서버 관리자가 새 채널 알림을 받지 못함 (${isNew(A).length}, ${isNew(A2).length})`);
  assert(isNew(A)[0].data.channelName === '개설알림 검증방' && isNew(A)[0].data.creator === '개설알림개설자', `알림 내용 이상: ${JSON.stringify(isNew(A)[0].data)}`);
  assert(isNew(O).length === 0 && isNew(U).length === 0, '개설자 또는 일반 사용자가 새 채널 알림을 받음');
  assert((await emit(A.sock, 'notification:list', {})).notifications.some((n) => n.kind === 'channel_created'), '새 채널 알림이 저장되지 않음(나중에 접속하면 안 보임)');
  // 서버 관리자가 자기 채널을 만들면 본인에게는 알림이 없고, 다른 서버 관리자에게만 간다
  const before = isNew(A2).length;
  const mine = (await api(A.cookie, 'POST', '/api/channels', { name: '관리자가만든방' })).body.channel;
  await sleep(300);
  assert(A.notes.filter((n) => n.channelId === mine.id).length === 0 && A2.notes.filter((n) => n.channelId === mine.id).length === 1, '서버 관리자끼리의 새 채널 알림이 이상함');
  assert(before === 1, 'ok');
  // 서버 관리자가 채널 관리자에게 직접 방송 권한 부여
  for (const x of [A, O, U]) await emit(x.sock, 'channel:join', { channelId: created.id });
  assert((await emit(A.sock, 'broadcaster:grant', { channelId: created.id, userId: O.user.id })).ok, '서버 관리자의 개설자 직접 부여 실패');
  await sleep(300);
  assert(O.notes.some((n) => n.kind === 'broadcaster_granted'), '개설자에게 부여 알림이 없음');
  const listed = await emit(A.sock, 'broadcaster:list', { channelId: created.id });
  assert(listed.broadcasters?.some((b) => b.userId === O.user.id), '서버 관리자가 부여한 개설자가 방송 권한 보유자 목록에 없음');
  const ov = await emit(A.sock, 'broadcaster:overview', {});
  assert((ov.broadcasters ?? []).some((b) => b.userId === O.user.id && b.channelId === created.id), '방송 권한 관리 탭(overview)에 개설자가 없음');
  assert((await emit(O.sock, 'broadcast:start', { channelId: created.id, hasAudio: false })).ok, '부여받은 개설자가 방송을 시작하지 못함');
  const noPerm = await emit(U.sock, 'broadcast:start', { channelId: created.id, hasAudio: false });
  assert(noPerm.error?.message === '방송 권한이 존재하지 않습니다. 관리자에게 문의해 주세요', `권한 없음 문구가 다름: ${noPerm.error?.message}`);
  await emit(O.sock, 'broadcast:stop', { channelId: created.id });
  assert((await emit(U.sock, 'broadcaster:grant', { channelId: created.id, userId: O.user.id })).error?.code === 'FORBIDDEN', '일반 사용자가 개설자에게 부여');
  assert((await emit(O.sock, 'broadcaster:grant', { channelId: created.id, userId: A.user.id })).error?.code === 'INVALID_TARGET', '개설자가 서버 관리자에게 부여');
  for (const x of [A, A2, O, U]) x.sock.close();
});

await test('알림: 입장해 본 채널의 방송 시작(과거 방문자 포함)·요청 거절·권한 변경 알림, 저장·읽음', async () => {
  const mk = async (n) => { const l = await apiLogin(n); return { ...l, sock: await rawSocket(l.cookie), notes: [] }; };
  const O = await mk('알림개설자'), P = await mk('알림접속자'), V = await mk('알림과거방문'), N = await mk('알림무관');
  for (const x of [O, P, V, N]) x.sock.on('notification:new', (d) => x.notes.push(d.notification));
  const cid = (await api(O.cookie, 'POST', '/api/channels', { name: '통지 검증방' })).body.channel.id;
  for (const x of [O, P, V]) await emit(x.sock, 'channel:join', { channelId: cid });
  await emit(V.sock, 'channel:leave', { channelId: cid }); // 입장해 본 뒤 나감
  assert((await emit(O.sock, 'broadcast:start', { channelId: cid, hasAudio: false })).ok, '방송 시작 실패');
  await sleep(400);
  const started = (x) => x.notes.filter((n) => n.kind === 'broadcast_started').length;
  assert(started(P) === 1 && started(V) === 1, `방문 이력이 있는 사용자가 방송 알림을 못 받음 (접속자 ${started(P)}, 과거 방문자 ${started(V)})`);
  assert(started(O) === 0 && started(N) === 0, '방송자 본인 또는 방문 이력 없는 사용자가 알림을 받음');
  const list = await emit(V.sock, 'notification:list', {});
  assert(list.notifications.some((n) => n.kind === 'broadcast_started' && n.data.channelName === '통지 검증방' && !n.read), '알림이 저장되지 않음');
  await emit(V.sock, 'notification:read', {});
  assert((await emit(V.sock, 'notification:list', {})).notifications.every((n) => n.read), '읽음 처리 실패');
  await emit(V.sock, 'notification:clear', {});
  assert((await emit(V.sock, 'notification:list', {})).notifications.length === 0, '알림 삭제 실패');
  // 요청 → 거절 알림, 부여/회수 알림
  await emit(P.sock, 'channel:join', { channelId: cid });
  assert((await emit(P.sock, 'broadcast:request', { channelId: cid })).ok, '방송 요청 실패');
  const req = (await emit(O.sock, 'request:list', {})).requests[0];
  assert((await emit(O.sock, 'request:dismiss', { requestId: req.id })).ok, '요청 거절 실패');
  assert((await emit(O.sock, 'broadcaster:grant', { channelId: cid, userId: P.user.id })).ok && code(await emit(O.sock, 'broadcaster:revoke', { channelId: cid, userId: P.user.id })) === 'FORBIDDEN', '부여 실패 또는 개설자의 회수가 허용됨');
  await sleep(400);
  const kinds = P.notes.map((n) => n.kind);
  assert(kinds.includes('request_declined') && kinds.includes('broadcaster_granted'), `요청자 알림 누락: ${kinds}`);
  // 차단된 사용자에게는 방송 시작 알림을 보내지 않는다
  assert((await emit(O.sock, 'broadcast:stop', { channelId: cid })).ok, '방송 종료 실패');
  await emit(O.sock, 'user:kick', { channelId: cid, userId: V.user.id, minutes: 10 });
  const before = started(V);
  await emit(O.sock, 'broadcast:start', { channelId: cid, hasAudio: false });
  await sleep(300);
  assert(started(V) === before, '차단된 사용자가 방송 시작 알림을 받음');
  for (const x of [O, P, V, N]) x.sock.close();
});

await test('인증·Origin·입력 보안 (세션 없음/위조/외부 Origin/SQL 주입/로그 민감정보)', async () => {
  const tryConnect = (opts) => new Promise((res) => { const s = io(HTTP, { transports: ['websocket'], reconnection: false, ...opts }); s.once('connect', () => { s.close(); res('connected'); }); s.once('connect_error', (e) => res(e.message)); });
  assert((await tryConnect({})) === 'AUTH_REQUIRED', '세션 없이 소켓 연결됨');
  assert((await tryConnect({ extraHeaders: { cookie: 'inchat_sid=forged' } })) === 'AUTH_REQUIRED', '위조 쿠키로 연결됨');
  assert((await tryConnect({ extraHeaders: { cookie: otherCookie, origin: 'http://evil.example' } })) !== 'connected', '외부 Origin 의 소켓 연결이 허용됨');
  const post = await fetch(`${HTTP}/api/channels`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: otherCookie, origin: 'http://evil.example' }, body: JSON.stringify({ name: '악성채널' }) });
  assert(post.status === 403, `외부 Origin POST 허용 (${post.status})`);
  const big = await fetch(`${HTTP}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'x'.repeat(10000) }) });
  assert(big.status === 413 || big.status === 400, '과대 요청이 거부되지 않음');
  const sql = await api(otherCookie, 'GET', `/api/channels?q=${encodeURIComponent("' OR 1=1; DROP TABLE users;--")}`);
  assert(sql.status === 200 && sql.body.channels.length === 0, 'SQL 주입 문자열 처리 이상');
  assert((await api(otherCookie, 'GET', '/api/me')).body.user, 'SQL 주입 후 users 테이블 손상');
  const leaked = serverLog.join('');
  assert(![ownerCookie, otherCookie].some((c) => leaked.includes(c.split('=')[1])), '서버 로그에 세션 토큰이 남음');
  assert(!leaked.includes(ADMIN_CODE), '서버 로그에 관리자 코드가 남음');
  for (const p of ['/certs/server.key', '/inchat-local-ca.key', '/server.key', '/.env']) {
    const t = await (await fetch(`${HTTP}${p}`)).text();
    assert(!t.includes('PRIVATE KEY') && !t.includes('ADMIN_CODE'), `${p} 로 비밀 파일이 노출됨`);
  }
  const ca = await fetch(`${HTTP}/inchat-ca.crt`);
  assert(ca.status === 200 && (await ca.text()).includes('BEGIN CERTIFICATE'), 'CA 인증서 다운로드 실패');
  return '소켓 인증 3종, 외부 Origin 차단, SQL 주입 무해, 로그에 토큰/관리자코드 없음, 개인키 비노출·CA 공개 인증서만 제공';
});

await test('UI 관리 기능: 공지 고정·메시지 삭제·강퇴·재입장 제한·해제', async () => {
  const O = await newUser('화면방장', { channel: 'all' });
  await createChannelUI(O.page, '관리 UI 채널', 'UI 로 관리 기능 검증');
  const V = await newUser('문제유저', { channel: 'all' });
  await V.page.getByRole('button', { name: /관리 UI 채널/ }).click(); await confirmEntry(V.page);
  await ready(V.page);
  await expectNoPerm(V.page, '일반 사용자');
  assert((await V.page.getByRole('button', { name: '공지 등록' }).count()) === 0, '일반 사용자에게 공지 등록 UI 가 보임');
  await O.page.getByLabel('공지 내용').fill('📌 오늘 발표는 7시입니다');
  await O.page.getByRole('button', { name: '공지 등록' }).click();
  await V.page.getByRole('note').getByText('오늘 발표는 7시입니다').waitFor({ timeout: 6000 });
  await say(V.page, '부적절한 메시지 예시');
  await expectText(O.page, '부적절한 메시지 예시');
  await O.page.locator('div.group', { hasText: '부적절한 메시지 예시' }).getByLabel('메시지 삭제').click();
  await V.page.getByText('관리자가 삭제한 메시지입니다.').first().waitFor({ timeout: 6000 });
  assert(!(await log(V.page).innerText()).includes('부적절한 메시지 예시'), '삭제된 내용이 남아 있음');
  await O.page.getByRole('button', { name: '문제유저 관리 메뉴' }).first().click();
  await O.page.getByRole('menuitem', { name: '강퇴' }).click();
  await O.page.getByRole('button', { name: '강퇴하기' }).click();
  await V.page.getByText(/강퇴되었습니다/).first().waitFor({ timeout: 8000 });
  await V.page.screenshot({ path: path.join(out, 'desktop-kicked.png') });
  await V.page.reload();
  await V.page.getByText(/이용이 제한되었습니다/).first().waitFor({ timeout: 8000 });
  await O.page.getByRole('button', { name: '해제', exact: true }).click();
  await O.page.getByText('이용 제한을 해제했습니다.').waitFor();
  await V.page.reload();
  await ready(V.page);
  await say(V.page, '해제 후 다시 참여');
  await expectText(O.page, '해제 후 다시 참여');
  await O.page.screenshot({ path: path.join(out, 'desktop-admin-panel.png') });
  return '공지 고정, 삭제 표시, 강퇴 → 재입장 차단 → 해제 → 재입장';
});

await test('서버 관리자 인증: 입장한 뒤 인증해도 즉시 관리·방송 권한 반영', async () => {
  const U = await newUser('인증후보', { channel: 'demo' });
  await expectNoPerm(U.page, '인증 전');
  await U.page.getByRole('button', { name: '내 프로필' }).click();
  await U.page.getByRole('menuitem', { name: /서버 관리자 인증/ }).click();
  await U.page.fill('input[type=password]', ADMIN_CODE);
  await U.page.getByRole('button', { name: '인증', exact: true }).click();
  await U.page.getByRole('button', { name: '방송 시작', exact: true }).waitFor({ timeout: 5000 });
});

await test('요청 빈도 제한(기본 설정): 로그인 연타 차단', async () => {
  const p2 = 3393;
  const dir = path.join(out, 'rl');
  fs.mkdirSync(dir, { recursive: true });
  const srv = spawn('node', ['server/dist/index.js'], { cwd: root, env: { ...process.env, PORT: String(p2), HTTPS: 'false', DB_PATH: path.join(dir, 'rl.sqlite'), LOGIN_RATE_PER_10MIN: '20' } });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${p2}/api/health`)).ok) break; } catch { /* 대기 */ } await sleep(200); }
    const codes = [];
    for (let i = 0; i < 25; i++) {
      const r = await fetch(`http://localhost:${p2}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: `rl유저${i}` }) });
      codes.push(r.status);
    }
    const ok = codes.filter((c) => c === 201).length;
    const blocked = codes.filter((c) => c === 429).length;
    assert(ok === 20 && blocked === 5, `로그인 제한이 기대와 다름 (201: ${ok}, 429: ${blocked})`);
    return `25회 연속 로그인 중 ${ok}회 허용, ${blocked}회 429 차단`;
  } finally { srv.kill('SIGTERM'); }
});

await test('로비 → 입장 방식(익명) 선택 → 익명 별칭만 노출 → 방송 요청 → 관리자 알림에서 부여', async () => {
  const raw = async (nick) => {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 }, locale: 'ko-KR' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(`${nick}: ${e.message}`));
    page.on('dialog', (d) => d.accept());
    await page.goto(`${HTTP}/`);
    await page.fill('#nick', nick);
    await page.getByRole('button', { name: '입장하기' }).click();
    contexts.push(ctx);
    return { ctx, page };
  };
  // 방장: 채널을 만들고 방송을 시작
  const A = await raw('로비방장');
  await A.page.getByRole('heading', { name: '방송 로비' }).waitFor();
  assert((await A.page.locator('textarea[aria-label="메시지 입력"]').count()) === 0, '로그인 직후 방에 바로 입장됨(로비가 아님)');
  await A.page.getByRole('button', { name: '방 만들기' }).click();
  await A.page.fill('#ch-name', '로비 검증방');
  await A.page.getByRole('button', { name: '만들기', exact: true }).click();
  await ready(A.page);
  await A.page.getByRole('button', { name: '방송 시작', exact: true }).first().click();
  await A.page.getByText('LIVE', { exact: true }).first().waitFor();
  // 구경꾼: 로비에서 진행 중인 방송을 골라 익명으로 입장
  const B = await raw('로비구경꾼');
  await B.page.getByRole('heading', { name: '방송 로비' }).waitFor();
  const card = B.page.getByRole('button', { name: /로비 검증방/ }).filter({ hasText: '방송' }).first();
  await card.waitFor();
  assert((await card.innerText()).includes('LIVE'), '로비에 진행 중인 방송이 LIVE 로 표시되지 않음');
  await card.click();
  const dlg = B.page.getByRole('dialog');
  assert((await dlg.innerText()).includes('내 닉네임으로 입장') && (await dlg.innerText()).includes('로비구경꾼'), '입장 방식 선택 팝업이 아님');
  await dlg.getByText('익명으로 입장').click();
  await dlg.getByRole('button', { name: '입장하기' }).click();
  await ready(B.page);
  const alias = (await B.page.getByText(/익명\d{4}님이 입장했습니다/).first().innerText()).match(/익명\d{4}/)[0];
  await say(B.page, '익명으로 남기는 메시지');
  await expectText(A.page, '익명으로 남기는 메시지');
  const seen = await A.page.locator('[role=log]').innerText();
  assert(seen.includes(alias) && !seen.includes('로비구경꾼'), `익명 사용자의 실제 닉네임이 노출됨: ${seen.replace(/\s+/g, ' ')}`);
  const hist = await B.page.evaluate(async (id) => (await fetch(`/api/channels/${id}/messages?before=999999&limit=50`)).json(), A.page.url().match(/#\/c\/([\w-]+)/)[1]);
  assert(!JSON.stringify(hist).includes('로비구경꾼'), '이전 메시지 조회에 실제 닉네임이 노출됨');
  assert((await B.page.getByRole('navigation', { name: '채널 목록' }).getByText('현재 위치').count()) === 1, '현재 위치 표시가 없음');
  // 알림 아이콘은 모든 사용자에게 있고, 일반 사용자에게는 "방송 권한 관리" 탭이 없다
  await B.page.getByRole('button', { name: /^알림 \d+건$/ }).click();
  assert((await B.page.getByRole('dialog', { name: '알림' }).count()) === 1 && (await B.page.getByRole('tab', { name: /방송 권한 관리/ }).count()) === 0, '일반 사용자 알림창 구성이 이상함');
  await B.page.keyboard.press('Escape');
  // 관리자 계정 표시를 눌러 방송 요청
  await B.page.getByRole('button', { name: /로비방장 관리자에게 방송 요청 보내기/ }).click();
  await B.page.getByRole('dialog', { name: '방송 요청 보내기' }).getByRole('button', { name: '전송', exact: true }).click();
  await B.page.getByText('방송 요청을 보냈습니다').waitFor();
  await B.page.getByRole('button', { name: /로비방장 관리자에게 방송 요청 보내기/ }).click();
  await B.page.getByRole('button', { name: '전송', exact: true }).click();
  await B.page.getByText('이미 방송 요청을 보냈습니다').first().waitFor({ timeout: 5000 });
  await B.page.getByRole('button', { name: '취소' }).click();
  // 관리자 알림: 누가·언제·어느 채널
  await A.page.getByRole('button', { name: /알림 1건/ }).click();
  const txt = await A.page.getByRole('dialog', { name: '알림' }).innerText();
  assert(txt.includes(alias) && txt.includes('로비 검증방') && /오늘 \d{2}:\d{2}/.test(txt), `알림 내용 이상: ${txt.replace(/\s+/g, ' ')}`);
  await A.page.screenshot({ path: path.join(out, 'desktop-bell.png') });
  // 서버가 권한을 보장하는지: 요청만으로는 방송 불가, 승인 후에만 가능
  const cookieB = (await B.ctx.cookies()).find((c) => c.name === 'inchat_sid');
  await expectNoPerm(B.page, '요청만으로');
  await A.page.reload();
  await A.page.getByRole('button', { name: /알림 1건/ }).waitFor({ timeout: 6000 }); // 나중에 접속해도 남아 있음
  await A.page.getByRole('button', { name: /알림 1건/ }).click();
  await A.page.getByRole('button', { name: '부여', exact: true }).click();
  await A.page.getByRole('button', { name: /알림 0건/ }).waitFor({ timeout: 6000 });
  await B.page.getByText('방송 권한이 부여되었습니다').first().waitFor({ timeout: 6000 });
  assert(cookieB, 'ok');
  return `익명 별칭 ${alias} 로만 노출, 요청 → 알림(누가/언제/채널) → 부여`;
});

// =====================================================================
console.log('\n[4] 화면 공유 · 시청');
await test('보안 컨텍스트: http://내부IP 는 안내, localhost·https://내부IP 는 허용', async () => {
  assert(LAN_IP, '내부 IP 를 찾지 못해 검증 불가');
  const L = await newUser('내부IP방장', { base: HTTP_LAN, channel: 'all' });
  await createChannelUI(L.page, '보안컨텍스트 채널');
  assert((await L.page.evaluate(() => window.isSecureContext)) === false, 'http://내부IP 가 보안 컨텍스트로 인식됨');
  await L.page.getByRole('button', { name: '방송 시작', exact: true }).click();
  await L.page.getByRole('alert').filter({ hasText: 'HTTPS' }).first().waitFor({ timeout: 5000 });
  await L.page.screenshot({ path: path.join(out, 'desktop-insecure-context.png') });
  const local = await newUser('로컬호스트방장', { channel: 'all' });
  assert(await local.page.evaluate(() => window.isSecureContext), 'localhost 가 보안 컨텍스트가 아님');
  const h = await newUser('HTTPS방장', { base: HTTPS_LAN, channel: 'all' });
  assert(await h.page.evaluate(() => window.isSecureContext), 'HTTPS(내부IP)가 보안 컨텍스트가 아님');
  return `http://${LAN_IP} → 차단 안내, localhost·https://${LAN_IP} → 보안 컨텍스트`;
});

await test('권한 거부 시 명확한 안내(LIVE 로 넘어가지 않음)', async () => {
  const D = await newUser('거부테스트', {
    channel: 'all',
    init: () => { navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); },
  });
  await createChannelUI(D.page, '거부 채널');
  await D.page.getByRole('button', { name: '방송 시작', exact: true }).click();
  await D.page.getByRole('alert').filter({ hasText: '권한이 거부' }).first().waitFor({ timeout: 5000 });
  assert((await D.page.getByText('LIVE').count()) === 0, '거부됐는데 LIVE 표시');
});

let streamer, viewer, mobileViewer;
await test('방송 시작 → 다른 브라우저에서 시청(영상 수신) → 채팅 병행', async () => {
  // 방송자: HTTPS 내부IP(LAN 기기 시나리오) / 시청자: HTTP 내부IP(보안 컨텍스트 아님 → 시청·채팅만)
  streamer = await newUser('방송자', { base: HTTPS_LAN, channel: 'all' });
  const S = streamer;
  await createChannelUI(S.page, '방송 검증 채널');
  viewer = await newUser('시청자', { base: HTTP_LAN, channel: 'all' });
  const V = viewer;
  await V.page.getByRole('button', { name: /방송 검증 채널/ }).click(); await confirmEntry(V.page);
  await ready(V.page);
  await S.page.getByRole('button', { name: '방송 시작', exact: true }).first().click();
  await S.page.getByText('LIVE').first().waitFor({ timeout: 10000 });
  await V.page.getByText('LIVE').first().waitFor({ timeout: 10000 });
  await V.page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0 && v.readyState >= 2; }, null, { timeout: 25000 });
  const t1 = await V.page.evaluate(() => document.querySelector('video').currentTime);
  await sleep(1500);
  const t2 = await V.page.evaluate(() => document.querySelector('video').currentTime);
  const dims = await V.page.evaluate(() => { const v = document.querySelector('video'); return `${v.videoWidth}x${v.videoHeight}`; });
  assert(t2 > t1, `영상이 재생되지 않음 (${t1} → ${t2})`);
  await say(V.page, '방송 잘 보여요!');
  await expectText(S.page, '방송 잘 보여요!');
  await V.page.screenshot({ path: path.join(out, 'desktop-viewer-live.png') });
  await S.page.screenshot({ path: path.join(out, 'desktop-streamer-live.png') });
  return `시청자 영상 ${dims}, 재생시간 ${t1.toFixed(1)}→${t2.toFixed(1)}s`;
});

await test('시청자 음소거·전체 화면 버튼, 오디오 미포함 안내', async () => {
  const V = viewer;
  await V.page.locator('[aria-label="방송 화면"]').hover();
  await V.page.getByRole('button', { name: '음소거', exact: true }).click();
  const muted = await V.page.evaluate(() => document.querySelector('video').muted);
  assert(muted === true, '음소거 버튼이 동작하지 않음');
  await V.page.getByRole('button', { name: '음소거 해제' }).click();
  assert((await V.page.evaluate(() => document.querySelector('video').muted)) === false, '음소거 해제가 동작하지 않음');
  await V.page.getByRole('button', { name: '전체 화면' }).click();
  await sleep(600);
  const entered = await V.page.evaluate(() => !!document.fullscreenElement);
  if (entered) await V.page.getByRole('button', { name: '전체 화면 종료' }).click();
  else skipped.push('전체 화면 진입(헤드리스 환경에서 requestFullscreen 결과 미확인)');
  const note = await V.page.getByText('이 방송에는 소리가 포함되어 있지 않습니다').count();
  return `음소거 토글 확인, 전체 화면 ${entered ? '진입/종료 확인' : '진입 미확인'}, 오디오 없음 안내 ${note ? '표시' : '미표시(오디오 트랙 포함)'}`;
});

await test('모바일 레이아웃: 방송 위/채팅 아래 세로 배치, 채널 목록 접이식', async () => {
  mobileViewer = await newUser('모바일시청', { channel: 'all', viewport: { width: 390, height: 844 }, mobile: true });
  const M = mobileViewer;
  await M.page.getByRole('button', { name: '채널 목록 열기/닫기' }).click();
  await M.page.getByRole('navigation', { name: '채널 목록' }).waitFor();
  await M.page.screenshot({ path: path.join(out, 'mobile-drawer.png') });
  await M.page.getByRole('button', { name: /방송 검증 채널/ }).click(); await confirmEntry(M.page);
  await ready(M.page);
  assert((await M.page.getByRole('navigation', { name: '채널 목록' }).count()) === 0, '채널 선택 후 메뉴가 접히지 않음');
  await M.page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0; }, null, { timeout: 25000 });
  await sleep(600);
  const vb = await M.page.locator('video').boundingBox();
  const tb = await composer(M.page).boundingBox();
  assert(vb.y + vb.height <= tb.y, `방송이 채팅 위에 있지 않음 (video bottom ${vb.y + vb.height}, composer ${tb.y})`);
  assert(tb.y + tb.height <= 845, '입력창이 화면 밖으로 밀림');
  const overflow = await M.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, `가로 스크롤 발생 (${overflow}px)`);
  await M.page.screenshot({ path: path.join(out, 'mobile-live.png') });
  return `video ${Math.round(vb.width)}x${Math.round(vb.height)} 위, 입력창 아래, 가로 스크롤 없음`;
});

await test('모바일: 방송 없는 채널에서 채팅 중심 + 한글 전송 + 참여자·관리 시트', async () => {
  const M = mobileViewer;
  await M.page.getByRole('button', { name: '채널 목록 열기/닫기' }).click();
  await M.page.getByRole('button', { name: /자유 대화/ }).click(); await confirmEntry(M.page);
  await ready(M.page);
  await say(M.page, '모바일에서 한글 메시지 보내기 ㅎㅎ');
  await expectText(M.page, '모바일에서 한글 메시지 보내기');
  assert((await M.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, '가로 스크롤 발생');
  const lb = await log(M.page).boundingBox();
  assert(lb.height > 300, `채팅 영역이 너무 작음 (${lb.height}px)`);
  await M.page.screenshot({ path: path.join(out, 'mobile-chat.png') });
  await M.page.getByRole('button', { name: '채널 정보와 참여자' }).click();
  await M.page.getByRole('dialog').waitFor();
  await M.page.screenshot({ path: path.join(out, 'mobile-info-sheet.png') });
  await M.page.keyboard.press('Escape');
  return `채팅 영역 높이 ${Math.round(lb.height)}px (실제 스마트폰 기기/가상 키보드는 미확인)`;
});

await test('방송 종료: 시청 화면 정리, 브라우저 "공유 중지" 처리', async () => {
  await streamer.page.getByRole('button', { name: '방송 종료' }).first().click();
  await viewer.page.locator('video').waitFor({ state: 'detached', timeout: 8000 });
  await expectText(viewer.page, '방송을 종료했습니다');
  await viewer.page.getByText('LIVE', { exact: true }).first().waitFor({ state: 'detached', timeout: 5000 }).catch(async () => { throw new Error('방송 종료 후에도 LIVE 표시가 남음: ' + JSON.stringify(await viewer.page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim() === 'LIVE').map((e) => e.parentElement?.outerHTML.slice(0, 160))))); });
  assert((await streamer.page.locator('video').count()) === 0, '방송자 화면에 video 가 남음');
  // 다시 방송한 뒤 브라우저의 공유 중지(트랙 종료)를 재현
  await streamer.page.getByRole('button', { name: '방송 시작', exact: true }).first().click();
  await viewer.page.getByText('LIVE').first().waitFor({ timeout: 10000 });
  await viewer.page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, null, { timeout: 25000 });
  await streamer.page.evaluate(() => { const t = document.querySelector('video').srcObject.getVideoTracks()[0]; t.stop(); t.onended?.(new Event('ended')); });
  await viewer.page.locator('video').waitFor({ state: 'detached', timeout: 8000 });
  await streamer.page.getByText('화면 공유가 중지되어 방송을 마쳤습니다').waitFor({ timeout: 5000 });
  return '종료 버튼 / 공유 중지 모두 시청자·방송자 화면 정리';
});

await test('방송 중 다른 채널로 이동해도 방송 유지 → 방송 종료 버튼으로만 종료', async () => {
  const S = streamer, V = viewer;
  await S.page.getByRole('button', { name: '방송 시작', exact: true }).first().click();
  await V.page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, null, { timeout: 25000 });
  // 방송자가 다른 채널(자유 대화)로 이동
  await S.page.getByRole('button', { name: /자유 대화/ }).click(); await confirmEntry(S.page);
  await ready(S.page);
  const banner = S.page.getByRole('status').filter({ hasText: '에서 방송 중입니다' });
  await banner.waitFor({ timeout: 5000 });
  await S.page.screenshot({ path: path.join(out, 'desktop-streaming-elsewhere.png') });
  await sleep(1500);
  const t1 = await V.page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
  await sleep(2000);
  const t2 = await V.page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
  assert(t1 >= 0 && t2 > t1, `방송자가 채널을 옮긴 뒤 시청자 영상이 멈춤 (${t1} → ${t2})`);
  const live = (await api(otherCookie, 'GET', '/api/channels')).body.channels.filter((c) => c.live).map((c) => c.name);
  assert(live.includes('방송 검증 채널'), `서버에서 방송이 종료됨 (live: ${live})`);
  // 채널 나가기(빈 화면)로 가도 유지
  await S.page.getByRole('button', { name: '채널 나가기' }).click();
  await S.page.getByRole('heading', { name: '방송 로비' }).waitFor();
  await banner.waitFor({ timeout: 3000 });
  assert((await V.page.locator('video').count()) === 1, '채널 나가기 후 방송이 종료됨');
  // 방송 채널로 돌아오면 송출 화면(미리보기)이 다시 보인다
  await banner.getByRole('button', { name: '방송 채널로 이동' }).click();
  await S.page.locator('video').first().waitFor({ timeout: 8000 });
  await S.page.getByRole('button', { name: '방송 종료' }).first().waitFor();
  // 다시 이동한 뒤 배너의 종료 버튼으로 종료
  await S.page.getByRole('button', { name: /자유 대화/ }).click(); await confirmEntry(S.page);
  await banner.waitFor();
  await banner.getByRole('button', { name: '방송 종료' }).click();
  await V.page.locator('video').waitFor({ state: 'detached', timeout: 8000 });
  await banner.waitFor({ state: 'detached', timeout: 5000 });
  return `채널 이동/나가기 후에도 영상 재생 유지(${t1.toFixed(1)}→${t2.toFixed(1)}s), 배너의 방송 종료 버튼으로만 종료`;
});

await test('방송 권한 부여·회수 (⋮ 메뉴): 부여 → 방송 가능 → 회수 시 방송 종료', async () => {
  const O = await newUser('권한관리자', { channel: 'all' });
  await createChannelUI(O.page, '권한 채널');
  const T = await newUser('권한대상', { channel: 'all' });
  await T.page.getByRole('button', { name: /권한 채널/ }).click(); await confirmEntry(T.page);
  await ready(T.page);
  await expectNoPerm(T.page, '권한 없는 사용자');
  // 금지 아이콘 대신 ⋮ 메뉴, 메뉴 항목 확인
  await O.page.getByRole('button', { name: '권한대상 관리 메뉴' }).first().click();
  const items = await O.page.getByRole('menuitem').allInnerTexts();
  assert(items.some((t) => t.includes('방송 권한 부여')) && items.some((t) => t.includes('강퇴')), `메뉴 항목 이상: ${items}`);
  await O.page.screenshot({ path: path.join(out, 'desktop-more-menu.png') });
  await O.page.getByRole('menuitem', { name: /방송 권한 부여/ }).click();
  await T.page.getByRole('button', { name: '방송 시작', exact: true }).waitFor({ timeout: 6000 });
  await O.page.getByText('방송 권한 보유자 · 1').waitFor({ timeout: 6000 });
  // 권한을 받은 사용자는 방송할 수 있지만 관리 기능은 여전히 없다
  assert((await T.page.getByRole('button', { name: '공지 등록' }).count()) === 0, '방송 권한만으로 관리 기능이 열림');
  await T.page.getByRole('button', { name: '방송 시작', exact: true }).first().click();
  await O.page.locator('video').first().waitFor({ timeout: 10000 });
  await O.page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, null, { timeout: 25000 });
  // 방송 중 우측: 위 참여자(인원수) / 아래 채팅(절반), 분할선을 끌어 크기 조절
  {
    const sep = O.page.getByRole('separator');
    await sep.waitFor({ timeout: 5000 });
    assert(await O.page.getByText(/현재 \d+명 접속 중/).first().isVisible(), '참여자 창에 접속 인원수가 없음');
    const hs = async () => O.page.evaluate(() => {
      const sp = document.querySelector('[role=separator]');
      return { top: sp.previousElementSibling.getBoundingClientRect().height, bottom: sp.nextElementSibling.getBoundingClientRect().height };
    });
    const h0 = await hs();
    assert(Math.abs(h0.top - h0.bottom) < 24, `기본 분할이 절반이 아님 ${JSON.stringify(h0)}`);
    const box = await sep.boundingBox();
    await O.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await O.page.mouse.down();
    await O.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 150, { steps: 6 });
    await O.page.mouse.up();
    const h1 = await hs();
    assert(h1.bottom > h0.bottom + 100 && h1.top < h0.top - 100, `드래그로 크기가 바뀌지 않음 ${JSON.stringify([h0, h1])}`);
    await O.page.screenshot({ path: path.join(out, 'desktop-live-split.png') });
    await sep.dblclick();
  }
  // 회수: 방송 중이면 방송도 종료
  // 채널 개설자에게는 회수 메뉴가 없고, 보유자 목록의 회수 버튼은 비활성화
  await O.page.getByRole('button', { name: '권한대상 관리 메뉴' }).first().click();
  assert((await O.page.getByRole('menuitem').allInnerTexts()).every((t) => !t.includes('방송 권한 회수')), '채널 개설자에게 회수 메뉴가 보임');
  await O.page.keyboard.press('Escape');
  assert(await O.page.getByRole('button', { name: '회수', exact: true }).first().isDisabled(), '개설자 화면의 회수 버튼이 활성화됨');
  // 서버 관리자만 회수 (소켓)
  const AD = await apiLogin('회수관리자');
  await api(AD.cookie, 'POST', '/api/admin/claim', { code: ADMIN_CODE });
  const adSock = await rawSocket(AD.cookie);
  const chs = (await api(AD.cookie, 'GET', '/api/channels')).body.channels;
  const cid2 = chs.find((c) => c.name === '권한 채널').id;
  await emit(adSock, 'channel:join', { channelId: cid2 });
  const tid = (await api(await T.page.context().cookies().then((c) => c.map((x) => `${x.name}=${x.value}`).join('; ')), 'GET', '/api/me')).body.user.id;
  assert((await emit(adSock, 'broadcaster:revoke', { channelId: cid2, userId: tid })).ok, '서버 관리자의 회수 실패');
  adSock.close();
  await T.page.getByText('방송 권한이 회수되어 방송이 종료되었습니다.').first().waitFor({ timeout: 8000 });
  await O.page.locator('video').waitFor({ state: 'detached', timeout: 8000 });
  await T.page.getByRole('button', { name: '방송 시작', exact: true }).click();
  await T.page.getByText('방송 권한이 존재하지 않습니다. 관리자에게 문의해 주세요').first().waitFor({ timeout: 6000 });
  await T.page.screenshot({ path: path.join(out, 'desktop-revoked.png') });
  return '부여 → 방송 시작·시청 → 회수 시 방송 종료 및 방송 버튼 제거';
});

await test('방송자 이탈(탭 닫기) 시 방송 자동 종료·서버 상태 정리', async () => {
  await streamer.page.getByRole('button', { name: /방송 검증 채널/ }).click(); await confirmEntry(streamer.page); // 이전 테스트에서 다른 채널로 이동해 있음
  await ready(streamer.page);
  await streamer.page.getByRole('button', { name: '방송 시작', exact: true }).first().click();
  await viewer.page.getByText('LIVE').first().waitFor({ timeout: 10000 });
  await viewer.page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, null, { timeout: 25000 });
  await streamer.ctx.close();
  await viewer.page.locator('video').waitFor({ state: 'detached', timeout: 20000 });
  const list = await api(otherCookie, 'GET', '/api/channels');
  assert(list.body.channels.every((c) => !c.live), '서버에 방송 상태가 남음');
});

// =====================================================================
console.log('\n[5] 기타');
await test('브라우저 예외(pageerror) 없음', async () => {
  assert(pageErrors.length === 0, `브라우저 예외: ${pageErrors.slice(0, 3).join(' | ')}`);
});

await browser.close();
server.kill('SIGTERM');

const failed = results.filter((r) => !r.ok);
console.log(`\n결과: ${results.length - failed.length}/${results.length} 통과${failed.length ? `, 실패 ${failed.length}` : ''}`);
if (failed.length) console.log('\n--- 서버 로그(마지막 40줄) ---\n' + serverLog.join('').split('\n').slice(-40).join('\n'));
if (skipped.length) console.log(`확인하지 못한 항목: ${skipped.join('; ')}`);
console.log(`스크린샷/결과: ${out}`);
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, skipped }, null, 2));
process.exit(failed.length ? 1 : 0);
