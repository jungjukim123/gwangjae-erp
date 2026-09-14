const { WebSocketServer } = require('ws');
const bus = require('./realtimeBus');
const { isIpAllowed, getClientIp } = require('./middleware/ipAllowlist');

// Supabase Realtime이 구독하던 것과 정확히 같은 3개 테이블만 브로드캐스트 대상으로 유지한다
// (1단계 분석 기준: att_data, slack_data, hr_saved — 그 외 테이블은 실시간 알림 대상이 아니었음).
const BROADCAST_TABLES = new Set(['att_data', 'slack_data', 'hr_saved']);

// server.on('upgrade')에서 세션 미들웨어를 수동으로 한 번 더 실행해 로그인 여부를 검증한다.
// (express 세션 미들웨어는 일반 HTTP 요청에만 자동 적용되고, WebSocket 업그레이드 요청에는
//  별도로 실행해줘야 한다 — app.use(session(...))와 같은 인스턴스를 그대로 재사용한다.)
function attachRealtime(server, sessionMiddleware) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws')) { socket.destroy(); return; }
    // express 미들웨어(ipAllowlist)는 upgrade 요청엔 자동 적용 안 되므로 여기서 직접 한 번 더 검사.
    if (!isIpAllowed(getClientIp(req), req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    sessionMiddleware(req, {}, () => {
      if (!req.session || !req.session.user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.on('message', () => { /* 클라이언트 heartbeat는 연결 유지 목적일 뿐, 응답 불필요 */ });
  });

  bus.on('change', (table) => {
    if (!BROADCAST_TABLES.has(table)) return;
    const payload = JSON.stringify({ type: 'change', table });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  });

  return wss;
}

module.exports = { attachRealtime, BROADCAST_TABLES };
