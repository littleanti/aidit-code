// backend/src/domain/seq.ts
// SEQ SoT — post 내 메시지 순서의 단일 출처. 서버가 트랜잭션 안에서 max(seq)+1 로 부여한다.
//
// 원칙(M4 TASK · TRD §3):
//   - seq 는 post 단위 단조 증가 정렬키. message.created/agent.token/message.updated 가
//     모두 같은 seq 로 정렬되어야 SSE 재생/멱등이 성립한다.
//   - 반드시 Prisma 트랜잭션(tx) 안에서 계산해 같은 post 의 동시 생성을 직렬화한다.
//   - @@unique([postId, seq]) 가 backstop: 경합으로 같은 seq 가 두 번 시도되면 DB 가 거부한다.

import type { Prisma } from '@prisma/client';

/** 트랜잭션 클라이언트 타입(prisma.$transaction 콜백 인자). */
export type Tx = Prisma.TransactionClient;

/**
 * 해당 post 의 다음 seq(=현재 max(seq)+1, 비어 있으면 1)를 계산한다.
 * 반드시 tx 안에서 호출해 동시 INSERT 를 직렬화할 것(@@unique 가 최종 backstop).
 */
export async function nextSeq(tx: Tx, postId: string): Promise<number> {
  const top = await tx.message.findFirst({
    where: { postId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  return (top?.seq ?? 0) + 1;
}
