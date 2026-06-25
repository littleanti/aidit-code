// backend/test/sandboxStatus.test.ts
// RT-PS + RT-SBXEV 배선 검증: post 채널을 in-memory 버스로 구독하고 setSandboxStatus 를 호출하면
// 올바른 payload 의 'sandbox.status' 이벤트가 수신되어야 한다.
//
// 실제 Sandbox 행이 필요하므로 prisma 로 User→Post→Sandbox 를 만들고, 검증 후 정리한다.

import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../src/db.js';
import { bus } from '../src/realtime/pubsub.js';
import type { RealtimeEvent } from '../src/realtime/events.js';
import { setSandboxStatus } from '../src/sandbox/service.js';

const created = { userId: '', postId: '', sandboxId: '' };

afterAll(async () => {
  // 역순 정리(외래키 안전).
  if (created.sandboxId) {
    await prisma.sandbox.deleteMany({ where: { id: created.sandboxId } });
  }
  if (created.postId) {
    await prisma.post.deleteMany({ where: { id: created.postId } });
  }
  if (created.userId) {
    await prisma.user.deleteMany({ where: { id: created.userId } });
  }
  await prisma.$disconnect();
});

describe('setSandboxStatus publishes sandbox.status', () => {
  it('fans out a sandbox.status event to the post channel with the right payload', async () => {
    const user = await prisma.user.create({
      data: { username: `t-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` },
    });
    created.userId = user.id;

    const post = await prisma.post.create({
      data: { authorId: user.id, title: 'rt wiring test', body: '' },
    });
    created.postId = post.id;

    const sandbox = await prisma.sandbox.create({
      data: { postId: post.id, path: `/tmp/sbx/${post.id}`, status: 'CREATING', runtime: 'pi' },
    });
    created.sandboxId = sandbox.id;

    // post 채널 구독.
    const received: RealtimeEvent[] = [];
    const unsubscribe = bus.subscribe(post.id, (ev) => received.push(ev));

    try {
      const before = Date.now();
      const updated = await setSandboxStatus(sandbox.id, 'READY');
      const after = Date.now();

      expect(received).toHaveLength(1);
      const ev = received[0];
      expect(ev.type).toBe('sandbox.status');
      if (ev.type !== 'sandbox.status') throw new Error('unreachable');

      expect(ev.sandboxId).toBe(sandbox.id);
      expect(ev.status).toBe('READY');
      // lastActiveAt 은 ISO 문자열이고 갱신 시각 범위 안.
      expect(typeof ev.lastActiveAt).toBe('string');
      const ts = Date.parse(ev.lastActiveAt);
      expect(ts).toBeGreaterThanOrEqual(before - 1000);
      expect(ts).toBeLessThanOrEqual(after + 1000);

      // DB 도 전이됨.
      expect(updated.status).toBe('READY');

      // payload 에 키 누출 없음(구조적 검증).
      expect(JSON.stringify(ev)).not.toMatch(/apiKey|baseURL|API_KEY|BASE_URL/i);
    } finally {
      unsubscribe();
    }

    // 해제 후엔 더 이상 수신 안 됨(멱등 해제 검증).
    const countBefore = received.length;
    await setSandboxStatus(sandbox.id, 'RUNNING');
    expect(received.length).toBe(countBefore);
  });
});
