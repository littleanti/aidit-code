// backend/vitest.config.ts
// vitest 설정. 소스가 NodeNext 스타일(`./x.js`)로 상대 import 하므로,
// 테스트 실행 시 확장자 없는 TS 원본으로 해석되도록 resolve.extensions 에 .ts 를 우선 둔다.
// 테스트는 backend/test/ 에 둔다(소스 tsconfig rootDir=src 와 분리 → tsc --noEmit 영향 없음).

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    // `import './x.js'` 를 ./x.ts 로도 풀 수 있게 한다(vite 기본 동작 보강).
    extensions: ['.ts', '.js', '.json'],
  },
});
