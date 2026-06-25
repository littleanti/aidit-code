// backend/src/agent/piWorker.mjs
// AR-PI PoC stub worker — 실제 pi 바이너리 대용. 에이전트 세션 프로세스를 표상한다.
//
// 동작:
//   - 부팅 시 stdout 에 'ready' 한 줄을 출력한다(STARTING -> IDLE 신호).
//   - 이후 IDLE 로 살아있는다(타이머로 이벤트 루프 유지).
//   - SIGTERM 수신 시 깨끗하게 종료(exit 0).
//
// 보안: 주입된 OPENAI_API_KEY/PI_API_KEY 등 키는 절대 출력/로그하지 않는다.
//   (여기서는 어떤 env 도 stdout 으로 echo 하지 않음으로써 구조적으로 차단.)

// IDLE 유지를 위한 keepalive 타이머(언급된 모든 신호에서 정리됨).
const keepAlive = setInterval(() => {}, 1 << 30);

function shutdown() {
  clearInterval(keepAlive);
  // 깨끗한 종료. 추가 출력 없음(키 누출 방지).
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// STARTING -> IDLE: ready 신호를 한 줄 출력. 부모 adapter 가 이 줄을 보고 resolve 한다.
process.stdout.write('ready\n');
