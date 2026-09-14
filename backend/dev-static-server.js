#!/usr/bin/env node
/**
 * 로컬 브라우저 테스트용 - gwangjae_v222.html이 있는 저장소 루트를 정적 파일로 서비스한다.
 * (file:// 로 직접 열면 Origin이 "null"이 되어 CORS가 애매해지므로, http://localhost:5500
 * 로 열도록 하기 위한 임시 서버 - 외부 라이브러리 없이 Node 내장 http만 사용)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 5500;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/gwangjae_v222.html';
  // ★ backend/(.env 등 비밀정보 포함) 와 숨김파일(.으로 시작)은 절대 웹으로 노출하지 않는다.
  if (reqPath.split('/').some((seg) => seg === 'backend' || seg.startsWith('.'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const filePath = path.join(ROOT, reqPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + reqPath); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// 127.0.0.1로만 바인딩 — 이 서버는 로컬 브라우저 테스트 전용이라 같은 네트워크의 다른 PC에서
// 이 PC의 IP로 접속해 들어오는 건 애초에 막는다(포트 4000의 IP 대역 검사와 별개 방어선).
server.listen(PORT, '127.0.0.1', () => {
  console.log(`정적 서버: http://localhost:${PORT}/gwangjae_v222.html`);
});
