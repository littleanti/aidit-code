// backend/src/domain/hotScore.ts
// 인기(Hot) 정렬 점수 — TRD §9 공식(Reddit hot 변형, 부모 계승).
//
//   hotScore = log10(max(score, 1)) + (commentCount * 0.5) / 1.0 + ageDecay(createdAt)
//   ageDecay = -(epochHours(now - createdAt)) / 12   // 12h 반감 느낌
//
// 순수 함수: 동일 입력 → 동일 출력(now 는 호출 시점 기준이라 시간 의존이지만 부수효과는 없음).

const HALF_LIFE_HOURS = 12;
const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * 게시글 인기 점수를 계산한다.
 * @param score        Vote 행 수(추천 수)
 * @param commentCount 사람/에이전트 답변(버블) 수
 * @param createdAt    게시글 생성 시각
 * @param now          기준 시각(테스트 주입용, 기본 현재)
 */
export function hotScore(
  score: number,
  commentCount: number,
  createdAt: Date,
  now: Date = new Date(),
): number {
  const base = Math.log10(Math.max(score, 1));
  const commentBoost = (commentCount * 0.5) / 1.0;
  const ageHours = (now.getTime() - createdAt.getTime()) / MS_PER_HOUR;
  const ageDecay = -ageHours / HALF_LIFE_HOURS;
  return base + commentBoost + ageDecay;
}
