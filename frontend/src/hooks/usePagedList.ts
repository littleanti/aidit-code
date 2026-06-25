// src/hooks/usePagedList.ts
// Cursor-paginated infinite list with an IntersectionObserver sentinel.
// Shared by Home feed and (future) profile tabs. Exposes the shape WIREFRAME §9 requires:
// { items, cursor, loading, done, error, sentinelRef, loadMore, reset }.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/rest';
import type { PostsPage } from '../api/types';

type Fetcher<T> = (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>;

export interface PagedList<T> {
  items: T[];
  cursor: string | null;
  loading: boolean;
  done: boolean;
  error: ApiError | null;
  sentinelRef: (node: HTMLElement | null) => void;
  loadMore: () => void;
  reset: () => void;
  setItems: React.Dispatch<React.SetStateAction<T[]>>;
}

export function usePagedList<T>(fetcher: Fetcher<T>, deps: unknown[] = []): PagedList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // Keep latest fetcher without forcing observer churn.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Guard against overlapping/duplicate requests for the same cursor.
  const inFlight = useRef(false);
  const cursorRef = useRef<string | null>(null);
  const doneRef = useRef(false);

  const loadMore = useCallback(() => {
    if (inFlight.current || doneRef.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    const c = cursorRef.current ?? undefined;
    fetcherRef
      .current(c)
      .then((page: { items: T[]; nextCursor: string | null }) => {
        setItems((prev) => [...prev, ...page.items]);
        cursorRef.current = page.nextCursor;
        setCursor(page.nextCursor);
        if (!page.nextCursor) {
          doneRef.current = true;
          setDone(true);
        }
      })
      .catch((e) => {
        setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
      })
      .finally(() => {
        inFlight.current = false;
        setLoading(false);
      });
  }, []);

  const reset = useCallback(() => {
    inFlight.current = false;
    cursorRef.current = null;
    doneRef.current = false;
    setItems([]);
    setCursor(null);
    setDone(false);
    setError(null);
    setLoading(false);
  }, []);

  // Reset + initial load whenever deps change (e.g. sort tab toggle).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    reset();
    // Defer first load to next tick so cursorRef/doneRef are cleared.
    const id = setTimeout(() => loadMore(), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // IntersectionObserver attached via a ref callback so it survives re-renders.
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback(
    (node: HTMLElement | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      if (!node) return;
      observerRef.current = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) loadMore();
        },
        { rootMargin: '200px' }
      );
      observerRef.current.observe(node);
    },
    [loadMore]
  );

  useEffect(() => {
    return () => observerRef.current?.disconnect();
  }, []);

  return { items, cursor, loading, done, error, sentinelRef, loadMore, reset, setItems };
}

// Re-export for callers that build feed fetchers around the page envelope type.
export type { PostsPage };
