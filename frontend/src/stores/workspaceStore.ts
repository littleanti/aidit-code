// src/stores/workspaceStore.ts
// FE-WORKSPACE (M6): live workspace state for a single post's sandbox.
// Tracks the selected file and the set of paths that just changed (from
// file.changed SSE events) so FileTree can refresh and FileView can re-fetch.
//
// HARD RULE: no LLM key fields are ever stored here. Paths are root-relative.
import { create } from 'zustand';
import type { FileChangedPayload } from '../api/types';

/** A path that recently changed, with its change kind (TRD §7 file.changed). */
export interface ChangedPath {
  change: FileChangedPayload['change']; // 'CREATED' | 'MODIFIED' | 'DELETED'
  /** Monotonic counter bump per event — lets subscribers detect re-fires. */
  rev: number;
}

interface WorkspaceState {
  /** Currently selected (open) file path, root-relative. Null = nothing open. */
  selectedPath: string | null;
  /** Map of root-relative path → most recent change record. */
  changed: Record<string, ChangedPath>;
  /** Monotonic counter incremented on every file.changed event. */
  rev: number;

  selectFile: (path: string | null) => void;
  /** Apply a file.changed SSE event: record the path + change kind. */
  applyFileChanged: (path: string, change: FileChangedPayload['change']) => void;
  /** Clear a single path's "changed" marker (e.g. after a tree refresh consumes it). */
  clearChanged: (path: string) => void;
  reset: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  selectedPath: null,
  changed: {},
  rev: 0,

  selectFile: (path) => set({ selectedPath: path }),

  applyFileChanged: (path, change) =>
    set((state) => {
      const rev = state.rev + 1;
      return {
        rev,
        changed: { ...state.changed, [path]: { change, rev } },
      };
    }),

  clearChanged: (path) =>
    set((state) => {
      if (!(path in state.changed)) return state;
      const changed = { ...state.changed };
      delete changed[path];
      return { changed };
    }),

  reset: () => set({ selectedPath: null, changed: {}, rev: 0 }),
}));
