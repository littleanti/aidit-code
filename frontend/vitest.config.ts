// vitest.config.ts — FE-MULTI(M8) 순수 셀렉터 단위 테스트 전용 설정.
// 컴포넌트 렌더가 아니라 store/React/DOM 비의존 순수 함수만 검증하므로 node 환경.
// vitest 전역(globals)은 끄고 명시적 import 를 쓴다(빌드 tsconfig 가 globals 타입에
// 의존하지 않게 — *.test.ts 는 빌드 tsconfig 에서 제외됨).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
