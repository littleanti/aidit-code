// src/stores/authStore.ts
// Persisted auth state — token + identity ONLY.
// HARD RULE: NO LLM key fields (apiKey / baseURL / model) anywhere here.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthIdentity {
  userId: string;
  username: string;
  token: string;
}

interface AuthState {
  userId: string | null;
  username: string | null;
  token: string | null;
  setAuth: (a: AuthIdentity) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      userId: null,
      username: null,
      token: null,
      setAuth: ({ userId, username, token }) => set({ userId, username, token }),
      logout: () => set({ userId: null, username: null, token: null }),
    }),
    {
      name: 'aidit-auth',
      // Persist only identity fields — never anything key-shaped.
      partialize: (s) => ({ userId: s.userId, username: s.username, token: s.token }),
    }
  )
);

/** Non-React read of the current bearer token (used by the REST client). */
export function getAuthToken(): string | null {
  return useAuthStore.getState().token;
}
