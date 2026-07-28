// vitest.config.ts — 프론트 단위 테스트 설정(순수 함수 · 스토어 · REST 클라이언트).
//
// 환경이 node → jsdom 으로 바뀐 이유(2026-07-28):
//   - `lib/sanitize.ts` 는 DOMPurify 를 쓰므로 DOM 없이는 동작조차 하지 않는다.
//     XSS 초크포인트를 테스트하려면 jsdom 이 필수다.
//   - `stores/langStore.ts`·`authStore.ts` 는 zustand persist + `navigator.language` +
//     `document.documentElement` 에 접근한다(import 시점에 평가됨).
//   기존 순수 셀렉터 테스트는 jsdom 에서도 그대로 통과한다(상위 환경일 뿐 의미 변화 없음).
//
// 컴포넌트 렌더 테스트(*.tsx)는 아직 비범위 — include 가 *.test.ts 만 잡는다.
// vitest 전역(globals)은 끄고 명시적 import 를 쓴다(빌드 tsconfig 가 globals 타입에
// 의존하지 않게 — *.test.ts 는 빌드 tsconfig 에서 제외됨).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
