// src/stores/uiStore.ts
// Transient UI state (not persisted). Holds the login-modal open flag (WIREFRAME §1).
import { create } from 'zustand';

interface UiState {
  loginOpen: boolean;
  openLogin: () => void;
  closeLogin: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  loginOpen: false,
  openLogin: () => set({ loginOpen: true }),
  closeLogin: () => set({ loginOpen: false }),
}));
