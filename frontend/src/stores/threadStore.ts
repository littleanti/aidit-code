// src/stores/threadStore.ts
// FE-THREAD (M4): live collaborative thread state for a single post.
// seq is the single source of truth for ordering/replay (TRD §3/§6/§7).
//
// HARD RULE: no LLM key fields are ever stored here. agent.token deltas
// accumulated into a message body carry agent TEXT only — never a key.
import { create } from 'zustand';
import type {
  AgentSession,
  AgentSessionStatus,
  Message,
  MessageStatus,
  SandboxStatus,
  ToolCall,
  ToolCallStatus,
  ToolKind,
} from '../api/types';

/**
 * Derive the seq-ordered message list from the byId map. seq is the single
 * source of truth; ties (and optimistic seq<0 rows) fall back to createdAt.
 */
function orderBySeq(byId: Record<string, Message>): Message[] {
  return Object.values(byId).sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

interface ThreadState {
  messages: Message[]; // sorted by seq ascending
  byId: Record<string, Message>;
  activeSession: AgentSession | null;
  sandboxStatus: SandboxStatus | null;

  /** RT-MULTI(M8): session.status가 싣는 권위 동시 활성 턴 수. FE-MULTI 소비. */
  activeSessionTurns: number;
  /** 권위 활성 턴 수 설정(없음/레거시 이벤트면 0). */
  setActiveSessionTurns: (n: number) => void;

  /** Replace all state from an initial REST load (messages seq-ascending). */
  hydrate: (initial: {
    messages: Message[];
    session?: AgentSession | null;
    sandboxStatus?: SandboxStatus | null;
  }) => void;

  /**
   * Insert or update a message. Dedupe by id AND by seq:
   * - if a message with the same id already exists, merge (body/status/etc.).
   * - if a message with the same seq (but different id) exists, treat as the
   *   authoritative server row and replace it (handles replay of optimistic rows).
   * Otherwise insert. Ordering by seq is always preserved.
   */
  upsertMessage: (msg: Message) => void;

  /** Accumulate a streaming token delta into an AGENT_REPLY body. */
  appendToken: (messageId: string, delta: string) => void;

  /** Set a message's lifecycle status (and optionally its finalized body). */
  setMessageStatus: (id: string, status: MessageStatus, body?: string) => void;

  /** Optimistically insert a locally-sent HUMAN message (temp id = clientId). */
  optimisticInsert: (msg: Message) => void;

  /**
   * Reconcile a server message.created with a pending optimistic row matched by
   * clientId: drop the temp row and adopt the server row (real id + seq).
   */
  reconcileByClientId: (serverMsg: Message) => void;

  setActiveSession: (s: AgentSession | null) => void;
  setSessionStatus: (status: AgentSessionStatus) => void;
  setSandboxStatus: (status: SandboxStatus) => void;

  /**
   * M5 tool/terminal events (TRD §7). All keyed by toolCallId, which is the
   * @unique link from a Message to its ToolCall. tool.call/output/result events
   * mutate the linked Message's `toolCall` summary; the bubble rows themselves
   * arrive via message.created and keep their seq ordering untouched.
   */

  /** tool.call — initialize/locate the ToolCall on every message sharing toolCallId (status RUNNING). */
  upsertToolCall: (tc: {
    toolCallId: string;
    kind: ToolKind;
    name: string;
    args: string;
    startedAt: string;
  }) => void;

  /** tool.output — append a raw output chunk to the linked ToolCall's result. */
  appendToolOutput: (toolCallId: string, chunk: string) => void;

  /** tool.result — finalize the ToolCall status + exitCode + result. */
  finalizeToolCall: (fin: {
    toolCallId: string;
    status: ToolCallStatus;
    exitCode: number | null;
    result: string;
  }) => void;

  reset: () => void;
}

/**
 * Merge a partial ToolCall onto every Message that links the given toolCallId
 * (TOOL_CALL and TOOL_RESULT bubbles share it 1:1 per row). Seq ordering is
 * preserved — only the `toolCall` summary changes. Existing summary fields are
 * kept unless overridden, so out-of-order events never lose data.
 */
function patchToolCall(
  byId: Record<string, Message>,
  toolCallId: string,
  patch: Partial<ToolCall>
): Record<string, Message> {
  let changed = false;
  const next = { ...byId };
  for (const m of Object.values(byId)) {
    if (m.toolCallId !== toolCallId) continue;
    const base: ToolCall =
      m.toolCall ??
      ({
        id: toolCallId,
        kind: 'OTHER',
        name: '',
        args: '',
        result: null,
        exitCode: null,
        status: 'RUNNING',
        startedAt: '',
        endedAt: null,
      } as ToolCall);
    next[m.id] = { ...m, toolCall: { ...base, ...patch } };
    changed = true;
  }
  return changed ? next : byId;
}

export const useThreadStore = create<ThreadState>((set) => ({
  messages: [],
  byId: {},
  activeSession: null,
  sandboxStatus: null,
  activeSessionTurns: 0,

  hydrate: ({ messages, session, sandboxStatus }) =>
    set(() => {
      const byId: Record<string, Message> = {};
      for (const m of messages) byId[m.id] = m;
      return {
        byId,
        messages: orderBySeq(byId),
        activeSession: session ?? null,
        sandboxStatus: sandboxStatus ?? null,
      };
    }),

  upsertMessage: (msg) =>
    set((state) => {
      const byId = { ...state.byId };

      // If a row with the same id exists, merge new fields onto it.
      const existingById = byId[msg.id];
      if (existingById) {
        byId[msg.id] = { ...existingById, ...msg };
        return { byId, messages: orderBySeq(byId) };
      }

      // Else if a DIFFERENT row already occupies this real seq, replace it
      // (server row supersedes any stale/optimistic occupant). Optimistic rows
      // use seq < 0, so a real seq collision only happens on duplicate delivery.
      const seqOwner =
        msg.seq >= 0
          ? Object.values(byId).find((m) => m.seq === msg.seq && m.id !== msg.id)
          : undefined;
      if (seqOwner) {
        delete byId[seqOwner.id];
      }

      byId[msg.id] = msg;
      return { byId, messages: orderBySeq(byId) };
    }),

  appendToken: (messageId, delta) =>
    set((state) => {
      const existing = state.byId[messageId];
      if (!existing) return state; // token before its message.created — ignore safely.
      const byId = {
        ...state.byId,
        [messageId]: {
          ...existing,
          body: existing.body + delta,
          status: existing.status === 'PENDING' ? 'STREAMING' : existing.status,
        } as Message,
      };
      return { byId, messages: orderBySeq(byId) };
    }),

  setMessageStatus: (id, status, body) =>
    set((state) => {
      const existing = state.byId[id];
      if (!existing) return state;
      const byId = {
        ...state.byId,
        [id]: { ...existing, status, ...(body !== undefined ? { body } : {}) },
      };
      return { byId, messages: orderBySeq(byId) };
    }),

  optimisticInsert: (msg) =>
    set((state) => {
      // Dedupe optimistic re-sends by clientId.
      if (msg.clientId) {
        const dup = Object.values(state.byId).find(
          (m) => m.clientId === msg.clientId
        );
        if (dup) return state;
      }
      const byId = { ...state.byId, [msg.id]: msg };
      return { byId, messages: orderBySeq(byId) };
    }),

  reconcileByClientId: (serverMsg) =>
    set((state) => {
      const byId = { ...state.byId };
      if (serverMsg.clientId) {
        // Drop any optimistic temp row that matches by clientId but has a different id.
        const optimistic = Object.values(byId).find(
          (m) => m.clientId === serverMsg.clientId && m.id !== serverMsg.id
        );
        if (optimistic) delete byId[optimistic.id];
      }
      // Adopt the server row (idempotent on duplicate delivery).
      byId[serverMsg.id] = { ...byId[serverMsg.id], ...serverMsg };
      return { byId, messages: orderBySeq(byId) };
    }),

  setActiveSession: (s) => set({ activeSession: s }),

  setSessionStatus: (status) =>
    set((state) =>
      state.activeSession
        ? { activeSession: { ...state.activeSession, status } }
        : state
    ),

  setSandboxStatus: (status) => set({ sandboxStatus: status }),

  setActiveSessionTurns: (n) => set({ activeSessionTurns: n }),

  upsertToolCall: ({ toolCallId, kind, name, args, startedAt }) =>
    set((state) => {
      const byId = patchToolCall(state.byId, toolCallId, {
        id: toolCallId,
        kind,
        name,
        args,
        status: 'RUNNING',
        startedAt,
      });
      if (byId === state.byId) return state; // bubble not yet created — ignore safely.
      return { byId, messages: orderBySeq(byId) };
    }),

  appendToolOutput: (toolCallId, chunk) =>
    set((state) => {
      let changed = false;
      const byId = { ...state.byId };
      for (const m of Object.values(state.byId)) {
        if (m.toolCallId !== toolCallId || !m.toolCall) continue;
        byId[m.id] = {
          ...m,
          toolCall: {
            ...m.toolCall,
            // Preserve raw machine output verbatim — pure append, no transform.
            result: (m.toolCall.result ?? '') + chunk,
          },
        };
        changed = true;
      }
      if (!changed) return state;
      return { byId, messages: orderBySeq(byId) };
    }),

  finalizeToolCall: ({ toolCallId, status, exitCode, result }) =>
    set((state) => {
      const byId = patchToolCall(state.byId, toolCallId, {
        status,
        exitCode,
        result,
      });
      if (byId === state.byId) return state;
      return { byId, messages: orderBySeq(byId) };
    }),

  reset: () =>
    set({
      messages: [],
      byId: {},
      activeSession: null,
      sandboxStatus: null,
      activeSessionTurns: 0,
    }),
}));
