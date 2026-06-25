// backend/src/realtime/publish.ts
// publish 헬퍼: 도메인 코드가 버스 구현을 직접 알지 않도록 얇게 감싼다.
//   - 채널 = postId. 이벤트는 events.ts 의 RealtimeEvent 타입만 허용.
//   - 호출부(provision/service)는 publishToPost(postId, event) 한 줄만 쓰면 된다.

import { bus } from './pubsub.js';
import type { RealtimeEvent } from './events.js';

/** postId 채널의 모든 구독자에게 이벤트를 fan-out 한다. */
export function publishToPost(postId: string, event: RealtimeEvent): void {
  bus.publish(postId, event);
}
