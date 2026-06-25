// src/stores/langStore.ts
// VERBATIM from docs/TRD.md §14.1. Follows authStore persist + onRehydrateStorage pattern.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Lang = 'ko' | 'en';

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
  toggle: () => void;
}

export const useLangStore = create<LangState>()(
  persist(
    (set, get) => ({
      lang: navigator.language.startsWith('ko') ? 'ko' : 'en',
      setLang: (l) => {
        set({ lang: l });
        document.documentElement.lang = l;
      },
      toggle: () => get().setLang(get().lang === 'ko' ? 'en' : 'ko'),
    }),
    {
      name: 'aidit-lang',
      onRehydrateStorage: () => (state) => {
        if (state) document.documentElement.lang = state.lang;
      },
    }
  )
);
