// backend/src/realtime/pubsub.ts
// 인메모리 pub/sub 버스(TRD §1·§7: post 단위 fan-out).
//   - 채널 키 = postId. 한 채널에 여러 핸들러가 attach 되고, publish 시 전원에게 fan-out.
//   - 이것은 "seam(시임)"이다: L10에서 Redis pub/sub 로 교체될 자리이므로
//     반드시 interface(PubSub) 우선으로 두고, 구현(InMemoryPubSub)은 갈아끼울 수 있게 한다.
//   - 무상태 서버 원칙상 이벤트는 SoT(DB) 의 보조 알림 채널일 뿐, 영속 저장소가 아니다.

import type { RealtimeEvent } from './events.js';

/** post 채널을 구독한 핸들러. 동기 처리만 가정(예외는 격리되어 다른 핸들러로 전파되지 않음). */
export type EventHandler = (event: RealtimeEvent) => void;

/** 구독 해제 함수. 멱등(여러 번 호출해도 무해)해야 한다. */
export type Unsubscribe = () => void;

/**
 * pub/sub 추상. Redis 교체를 위해 인터페이스를 먼저 고정한다.
 * channel 은 postId 다.
 */
export interface PubSub {
  /** 채널의 모든 구독자에게 이벤트를 fan-out 한다. */
  publish(channel: string, event: RealtimeEvent): void;
  /** 채널을 구독하고 해제 함수를 돌려준다. */
  subscribe(channel: string, handler: EventHandler): Unsubscribe;
}

/**
 * 단일 인스턴스용 인메모리 구현.
 * 채널별 핸들러 Set 을 유지하고, publish 시 스냅샷을 떠 순회하며(순회 중 구독 변경 안전)
 * 각 핸들러를 호출한다. 한 핸들러가 throw 해도 나머지 fan-out 은 계속된다.
 */
export class InMemoryPubSub implements PubSub {
  private readonly channels = new Map<string, Set<EventHandler>>();

  publish(channel: string, event: RealtimeEvent): void {
    const handlers = this.channels.get(channel);
    if (!handlers || handlers.size === 0) return;
    // 스냅샷: 핸들러가 구독 해제/추가를 일으켜도 이번 fan-out 은 안정적.
    for (const handler of [...handlers]) {
      try {
        handler(event);
      } catch {
        // 한 구독자의 오류가 다른 구독자에게 전파되지 않도록 격리한다.
      }
    }
  }

  subscribe(channel: string, handler: EventHandler): Unsubscribe {
    let handlers = this.channels.get(channel);
    if (!handlers) {
      handlers = new Set<EventHandler>();
      this.channels.set(channel, handlers);
    }
    handlers.add(handler);

    let active = true;
    return () => {
      if (!active) return; // 멱등 해제
      active = false;
      const set = this.channels.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) this.channels.delete(channel);
    };
  }
}

/**
 * 프로세스 전역 단일 버스(싱글턴).
 * provisioning/service 가 여기로 publish 하고, M4의 /posts/:id/stream 가 여기서 subscribe 한다.
 */
export const bus: PubSub = new InMemoryPubSub();
