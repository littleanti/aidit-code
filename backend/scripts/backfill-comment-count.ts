// backend/scripts/backfill-comment-count.ts
// 1회성 백필: 댓글 수(Post.commentCount) 정의 변경에 맞춰 기존 게시글을 재계산한다.
//
//   새 정의(사용자 확정): commentCount = COMPLETE 상태의 HUMAN + AGENT_REPLY 메시지 수.
//   (쉘/도구 출력 TOOL_CALL/TOOL_RESULT·SYSTEM·실패(FAILED/PENDING/STREAMING) 제외.)
//
// 기존 데이터는 HUMAN 만 카운트되어 있어 AGENT_REPLY 분이 빠져 있다 → 전 게시글을 재계산.
// 멱등: 여러 번 실행해도 같은 결과. 실행: `npm run backfill:comment-count` (tsx).
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const posts = await prisma.post.findMany({ select: { id: true, commentCount: true } });
  let changed = 0;
  for (const post of posts) {
    const count = await prisma.message.count({
      where: {
        postId: post.id,
        status: 'COMPLETE',
        type: { in: ['HUMAN', 'AGENT_REPLY'] },
      },
    });
    if (count !== post.commentCount) {
      await prisma.post.update({ where: { id: post.id }, data: { commentCount: count } });
      changed += 1;
      // eslint-disable-next-line no-console
      console.log(`post ${post.id}: ${post.commentCount} -> ${count}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`done — ${changed}/${posts.length} posts updated.`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
