const { EventEmitter } = require('events');

// tables.js가 쓰기 성공 후 emit('change', table)만 호출하고, WebSocket 연결 관리는
// realtime.js가 전담한다 — 두 모듈이 서로 직접 참조하지 않도록 이 이벤트버스로만 연결한다.
module.exports = new EventEmitter();
