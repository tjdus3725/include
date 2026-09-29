import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'socket.io';
import { config } from './config.js';
import { migrate } from './db.js';
import { log } from './log.js';
import { createApp } from './app.js';
import { initRealtime } from './realtime.js';
import { isOriginAllowed } from './auth.js';
import { purgeStale } from './repo.js';

migrate();
purgeStale();
setInterval(purgeStale, 6 * 3600 * 1000).unref();

const app = createApp();
const httpServer = http.createServer(app);
const servers: { server: http.Server | https.Server; port: number; scheme: 'http' | 'https' }[] = [
  { server: httpServer, port: config.port, scheme: 'http' },
];

if (config.httpsEnabled) {
  const keyPath = path.join(config.certDir, 'server.key');
  const certPath = path.join(config.certDir, 'server.crt');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    log.error(`HTTPS=true 이지만 인증서를 찾을 수 없습니다 (${config.certDir}). 먼저 "npm run cert" 를 실행하세요.`);
    process.exit(1);
  }
  const httpsServer = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app);
  servers.push({ server: httpsServer, port: config.httpsPort, scheme: 'https' });
}

const io = new Server({
  // 비정상 종료(전원/Wi-Fi 끊김)를 빠르게 감지해 접속 인원이 오래 남지 않게 한다
  pingInterval: 8000,
  pingTimeout: 6000,
  maxHttpBufferSize: 200_000,
  serveClient: false,
  allowRequest: (req, cb) => {
    const ok = isOriginAllowed(req.headers.origin, req.headers.host);
    cb(ok ? null : 'ORIGIN_FORBIDDEN', ok);
  },
});
for (const s of servers) io.attach(s.server);
initRealtime(io);

function lanIps(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

let listening = 0;
for (const s of servers) {
  s.server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') log.error(`포트 ${s.port} 가 이미 사용 중입니다. .env 의 ${s.scheme === 'https' ? 'HTTPS_PORT' : 'PORT'} 를 바꾸거나 다른 프로그램을 종료하세요.`);
    else if (e.code === 'EACCES') log.error(`포트 ${s.port} 에 바인딩할 권한이 없습니다. 1024 이상의 포트를 사용하세요.`);
    else log.error('서버 시작 실패:', e.message);
    process.exit(1);
  });
  s.server.listen(s.port, config.host, () => {
    if (++listening < servers.length) return;
    const ips = lanIps();
    log.info('InChat 서버가 시작되었습니다.');
    for (const sv of servers) {
      log.info(`  ${sv.scheme.toUpperCase()}  이 컴퓨터:  ${sv.scheme}://localhost:${sv.port}`);
      for (const ip of ips) log.info(`  ${sv.scheme.toUpperCase()}  같은 네트워크: ${sv.scheme}://${ip}:${sv.port}`);
    }
    if (!config.httpsEnabled) log.info('  ※ 다른 기기에서 화면 공유(방송)를 하려면 HTTPS 가 필요합니다. README 의 "HTTPS 설정"을 참고하세요.');
    if (config.host === '127.0.0.1' || config.host === 'localhost') log.warn('HOST 가 로컬 전용입니다. 다른 기기에서 접속하려면 HOST=0.0.0.0 으로 설정하세요.');
    if (!fs.existsSync(path.join(config.clientDist, 'index.html'))) log.warn('client/dist 가 없습니다. 개발 모드(npm run dev)이거나 npm run build 가 필요합니다.');
  });
}

function shutdown(sig: string) {
  log.info(`${sig} 수신 - 서버를 종료합니다.`);
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
