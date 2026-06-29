// backend/vitest.config.ts
// vitest 설정. 소스가 NodeNext 스타일(`./x.js`)로 상대 import 하므로,
// 테스트 실행 시 확장자 없는 TS 원본으로 해석되도록 resolve.extensions 에 .ts 를 우선 둔다.
// 테스트는 backend/test/ 에 둔다(소스 tsconfig rootDir=src 와 분리 → tsc --noEmit 영향 없음).

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // M7 XC-RATE: 테스트 환경에서는 레이트리밋을 끈다(M1-M6 스위트 무영향).
    //   config.ts 의 dotenv 는 이미 설정된 env 를 덮어쓰지 않으므로 여기서 1로 고정하면 항상 비활성.
    env: {
      RATE_LIMIT_DISABLED: '1',
      // 기능 테스트가 프로비저닝 동시성 cap(sandboxLimiter)에 우발적으로 걸리지 않게 충분히 높인다.
      //   M8 AR-PAR 의 동시성 테스트(piWorkerConcurrency, 워커 child spawn + busy polling)가 maxForks=2
      //   병렬 실행에서 이벤트루프를 굶겨, 다른 fork 의 xcMode 가 fire-and-forget 프로비저닝 슬롯 반납을
      //   기다리다 cap(기본 4)에 걸려 429 를 받는 cross-file 플레이크가 있었다. cap 자체의 오버플로
      //   동작은 limiter.test.ts 가 자체 ConcurrencyLimiter 인스턴스로 검증하므로(전역 limiter 무관),
      //   여기서 전역 cap 만 높여도 커버리지 손실이 없다(테스트 로직 불변).
      SANDBOX_MAX_CONCURRENT: '64',
    },
    // 실시간(SSE)·에이전트 스위트는 실제 소켓/자식 프로세스에 의존해 이벤트루프 타이밍에 민감하다.
    // 파일 수가 늘면서(M7) 과도한 병렬 fork 가 이벤트루프를 굶겨 간헐 타임아웃 실패를 유발했다.
    // fork 병렬도를 보수적으로 제한해 타이밍 결정성을 확보한다(테스트 로직 불변, M1-M6 무영향).
    pool: 'forks',
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
  },
  resolve: {
    // `import './x.js'` 를 ./x.ts 로도 풀 수 있게 한다(vite 기본 동작 보강).
    extensions: ['.ts', '.js', '.json'],
  },
});
