// backend/src/realtime/stream.ts
// RT-STREAM + RT-REPLAY (TRD §7):
//   GET /posts/:id/stream (optionalAuth) — text/event-stream.
//   연결 시: afterSeq(쿼리) 또는 Last-Event-ID 헤더(=마지막 seq) 기준 스냅샷을
//     message.created 이벤트로 재생 → 이후 post 채널 라이브 구독.
//   SSE 프레임: 'id: <seq>\n' (seq 있는 이벤트) + 'event: <type>\n' + 'data: <json>\n\n'.
//   주기적 heartbeat 코멘트(':\n\n'). 연결 종료 시 구독 해제.
//
// 이 엔드포인트는 BE-MSG/AR-TURN 이 publish 하는 이벤트를 **소비**만 한다(writer 와 결합 금지).
// 보안: payload 는 events.ts 빌더가 보장한 안전 필드만(키 없음).

import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { bus } from './pubsub.js';
import {
  makeMessageCreatedEvent,
  type RealtimeEvent,
} from './events.js';

/** heartbeat 주기(ms). 프록시/브라우저 idle 타임아웃 방지. */
const HEARTBEAT_MS = Number(process.env.SSE_HEARTBEAT_MS) || 15000;

/** seq 를 갖는(=재연결 앵커가 되는) 이벤트의 SSE id 를 계산. 없으면 null. */
function eventSeqId(ev: RealtimeEvent): number | null {
  if (ev.type === 'message.created') return ev.message.seq;
  if (ev.type === 'agent.token') return ev.seq;
  return null;
}

/** 한 RealtimeEvent 를 SSE 프레임 문자열로 직렬화. */
function frameOf(ev: RealtimeEvent): string {
  const id = eventSeqId(ev);
  const idLine = id != null ? `id: ${id}\n` : '';
  return `${idLine}event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/posts/:id/stream', { preHandler: app.optionalAuth }, async (req, reply) => {
    const { id: postId } = req.params as { id: string };
    const query = (req.query ?? {}) as { afterSeq?: unknown };

    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) {
      return reply.code(404).send({ error: 'post not found' });
    }

    // 재연결 앵커: Last-Event-ID 헤더 우선, 없으면 ?afterSeq=.
    const lastEventId = req.headers['last-event-id'];
    const lastIdNum =
      typeof lastEventId === 'string' && Number.isFinite(Number(lastEventId))
        ? Number(lastEventId)
        : null;
    const afterSeqQuery =
      typeof query.afterSeq === 'string' && Number.isFinite(Number(query.afterSeq))
        ? Number(query.afterSeq)
        : null;
    const afterSeq = lastIdNum ?? afterSeqQuery ?? 0;

    const raw = reply.raw;
    // SSE 헤더. keep-alive 유지, 버퍼링/타임아웃 비활성.
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // keep-alive 소켓 타임아웃 해제(스트림이 idle 로 끊기지 않도록).
    raw.socket?.setTimeout?.(0);
    if (raw.socket) raw.socket.setNoDelay?.(true);
    // Fastify 가 이 요청에 자체 응답을 보내지 않도록 hijack.
    reply.hijack();

    // 초기 패딩 코멘트(일부 프록시가 첫 바이트를 기다림) + 즉시 flush.
    raw.write(': connected\n\n');

    // ── 스냅샷 재생(afterSeq 초과분을 message.created 로) ──
    const snapshot = await prisma.message.findMany({
      where: { postId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
    });
    for (const m of snapshot) {
      const ev = makeMessageCreatedEvent({
        id: m.id,
        type: m.type as never,
        status: m.status as never,
        body: m.body,
        authorId: m.authorId,
        seq: m.seq,
        replyToId: m.replyToId,
        toolCallId: m.toolCallId,
        createdAt: m.createdAt,
      });
      raw.write(frameOf(ev));
    }

    // ── 라이브 구독 ──
    const unsubscribe = bus.subscribe(postId, (ev) => {
      // 스냅샷에서 이미 보낸 message.created(스냅샷 seq 이하)는 라이브에서 다시 오지 않는다
      // (구독은 스냅샷 조회 이후 시작 — 사이에 들어온 이벤트는 라이브로 자연 수신).
      try {
        raw.write(frameOf(ev));
      } catch {
        // 소켓이 닫혔으면 정리(아래 close 핸들러가 보장).
      }
    });

    // ── heartbeat ──
    const heartbeat = setInterval(() => {
      try {
        raw.write(':\n\n');
      } catch {
        /* noop */
      }
    }, HEARTBEAT_MS);

    // ── 정리: 연결 종료/에러 시 구독 해제 + 타이머 정지 ──
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
    raw.on('error', cleanup);

    // hijack 했으므로 Fastify 는 이 핸들러의 반환을 무시한다(연결 유지).
    return reply;
  });
}
