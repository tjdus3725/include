import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 프로젝트 루트의 .env 를 읽어 API 서버 포트와 HTTPS 여부를 결정합니다.
export default defineConfig(({ mode }) => {
  const root = path.resolve(__dirname, '..');
  const env = loadEnv(mode, root, '');
  const apiPort = env.PORT || '3000';
  const target = `http://127.0.0.1:${apiPort}`;
  const certDir = env.CERT_DIR ? path.resolve(root, env.CERT_DIR) : path.join(root, 'certs');
  const wantHttps = ['1', 'true', 'yes', 'on'].includes((env.HTTPS || '').toLowerCase());
  const keyPath = path.join(certDir, 'server.key');
  const certPath = path.join(certDir, 'server.crt');
  const https = wantHttps && fs.existsSync(keyPath) && fs.existsSync(certPath)
    ? { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
    : undefined;
  if (wantHttps && !https) console.warn('[InChat] HTTPS=true 이지만 인증서가 없어 HTTP 로 실행합니다. `npm run cert` 를 먼저 실행하세요.');

  // changeOrigin 을 켜지 않아 Host 헤더가 브라우저 주소 그대로 전달되므로 서버의 Origin 검사를 통과합니다.
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: true, // 0.0.0.0 — 같은 네트워크의 다른 기기에서 개발 서버 접속 가능
      port: 5173,
      https,
      proxy: {
        '/api': { target },
        '/inchat-ca.crt': { target },
        '/socket.io': { target, ws: true },
      },
    },
    preview: { host: true, port: 4173 },
    build: { outDir: 'dist', sourcemap: false },
  };
});
