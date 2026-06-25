// src/components/FileView.tsx
// FE-FILEVIEW (M6, WIREFRAME workspace panel): fixed-width simple display of the
// selected file's content inside an overflow scroll container (bg-term-sunken).
// - binary  -> 'binary file (N bytes)' notice (no content rendered).
// - truncated -> content + a 'truncated' notice.
// - No syntax highlighting. Re-fetches on file.changed for the open file.
// Uses ONLY term-* tokens; all strings via i18n t().
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import { getFileContent, ApiError } from '../api/rest';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { FileContent } from '../api/types';

interface FileViewProps {
  postId: string;
  /** Selected file path (root-relative), or null when nothing is open. */
  path: string | null;
}

export default function FileView({ postId, path }: FileViewProps) {
  const t = useT();
  const [data, setData] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Re-fetch trigger: the change record for the open path (rev bumps per event).
  const changeRev = useWorkspaceStore((s) => (path ? s.changed[path]?.rev : undefined));

  const load = useCallback(async () => {
    if (!path) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const res = await getFileContent(postId, path);
      setData(res);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [postId, path]);

  // Fetch on selection change and whenever the open file changes on disk.
  useEffect(() => {
    void load();
  }, [load, changeRev]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[3px] border border-term-border bg-term-sunken">
      <div className="flex items-center gap-2 border-b border-term-line px-3 py-2 font-mono text-[10px] text-term-faint">
        {path ? (
          <span className="truncate text-term-dim" title={path}>
            {path}
          </span>
        ) : (
          <span className="uppercase tracking-wider">{t('workspace.tabFiles')}</span>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {!path && (
          <p className="px-3 py-4 font-mono text-xs text-term-dim">
            {t('workspace.selectPrompt')}
          </p>
        )}

        {path && loading && (
          <p className="px-3 py-4 font-mono text-xs text-term-dim">
            {t('workspace.loading')}
          </p>
        )}

        {path && error && !loading && (
          <div className="px-3 py-4">
            <p className="font-mono text-xs text-term-red" role="alert">
              {t('workspace.error')}
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-1 min-h-[44px] font-mono text-xs text-term-amber hover:text-term-fg-bright"
            >
              {t('workspace.retry')}
            </button>
          </div>
        )}

        {path && data && !loading && !error && (
          <>
            {data.binary ? (
              <p className="px-3 py-4 font-mono text-xs text-term-dim">
                {t('workspace.binary', { size: data.size })}
              </p>
            ) : (
              <>
                <pre className="whitespace-pre px-3 py-3 font-mono text-xs leading-relaxed text-term-fg">
                  {data.content && data.content.length > 0
                    ? data.content
                    : t('workspace.fileEmpty')}
                </pre>
                {data.truncated && (
                  <p className="border-t border-term-line px-3 py-2 font-mono text-[10px] text-term-amber">
                    {t('workspace.truncated')}
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
