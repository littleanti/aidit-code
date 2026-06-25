// src/components/FileTree.tsx
// FE-FILETREE (M6, WIREFRAME workspace panel): collapse/expand sandbox file tree.
// - Lazy-loads directory children via getFiles(postId, path) on expand.
// - Line-style SVG folder/file icons drawn with currentColor (term-* via text-*).
// - A term-amber dot marks a path that just changed (from the workspace store).
// Uses ONLY term-* tokens; all strings via i18n t().
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import { getFiles, ApiError } from '../api/rest';
import { useWorkspaceStore } from '../stores/workspaceStore';
import type { FileEntry } from '../api/types';

interface FileTreeProps {
  postId: string;
  /** Selected file path (root-relative) for highlight. */
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

// ── Line-style SVG icons (currentColor; no new colors, no emoji) ──

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {open ? (
        <path d="M1.5 4.5 A1 1 0 0 1 2.5 3.5 H6 l1.5 1.5 H13 a1 1 0 0 1 1 1 v.5 H3.2 a1 1 0 0 0-.97.76 L1.5 11 Z M1.5 11 l1-4.2" />
      ) : (
        <path d="M1.5 4 a1 1 0 0 1 1-1 H6 l1.5 1.5 H13 a1 1 0 0 1 1 1 V12 a1 1 0 0 1-1 1 H2.5 a1 1 0 0 1-1-1 Z" />
      )}
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M4 1.5 H9.5 L12.5 4.5 V14 a0.5 0.5 0 0 1-.5.5 H4 a0.5 0.5 0 0 1-.5-.5 V2 a0.5 0.5 0 0 1 .5-.5 Z" />
      <path d="M9.5 1.5 V4.5 H12.5" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="M4.5 3 L8 6 L4.5 9" />
    </svg>
  );
}

// ── A single tree node (directory recurses; file is a leaf) ──

interface NodeProps {
  postId: string;
  entry: FileEntry;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Rev counter from the workspace store — re-render trigger for refreshes. */
  changedRev: number;
  changedKind: (path: string) => 'CREATED' | 'MODIFIED' | 'DELETED' | undefined;
}

function TreeNode({
  postId,
  entry,
  depth,
  selectedPath,
  onSelect,
  changedRev,
  changedKind,
}: NodeProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const isDir = entry.type === 'dir';
  const selected = !isDir && selectedPath === entry.path;
  const changed = changedKind(entry.path);

  const loadChildren = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const items = await getFiles(postId, entry.path);
      setChildren(items);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error);
      setChildren(null);
    } finally {
      setLoading(false);
    }
  }, [postId, entry.path]);

  const toggle = useCallback(() => {
    if (!isDir) {
      onSelect(entry.path);
      return;
    }
    const next = !open;
    setOpen(next);
    if (next && children === null && !loading) void loadChildren();
  }, [isDir, open, children, loading, loadChildren, onSelect, entry.path]);

  // Refresh an open directory's children when a descendant path changes.
  useEffect(() => {
    if (isDir && open && children !== null) {
      void loadChildren();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedRev]);

  const indent = { paddingLeft: `${depth * 14 + 6}px` };

  return (
    <li>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isDir ? open : undefined}
        className={`flex w-full items-center gap-1.5 py-1 pr-2 text-left font-mono text-xs ${
          selected
            ? 'bg-term-line text-term-fg-bright'
            : 'text-term-fg hover:text-term-fg-bright'
        }`}
        style={indent}
      >
        {isDir ? (
          <Chevron open={open} />
        ) : (
          <span className="inline-block w-[10px] shrink-0" aria-hidden="true" />
        )}
        <span className={isDir ? 'text-term-dim' : 'text-term-dim-2'}>
          {isDir ? <FolderIcon open={open} /> : <FileIcon />}
        </span>
        <span className="truncate">{entry.name}</span>
        {changed && (
          <span
            className="ml-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-term-amber"
            title={t('workspace.modified')}
            aria-label={t('workspace.modified')}
          />
        )}
      </button>

      {isDir && open && (
        <>
          {loading && (
            <p
              className="py-1 font-mono text-[10px] text-term-dim"
              style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}
            >
              {t('workspace.loading')}
            </p>
          )}
          {error && !loading && (
            <p
              className="py-1 font-mono text-[10px] text-term-red"
              style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}
            >
              {t('workspace.error')}
            </p>
          )}
          {children && children.length === 0 && !loading && (
            <p
              className="py-1 font-mono text-[10px] text-term-dim"
              style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}
            >
              {t('workspace.empty')}
            </p>
          )}
          {children && children.length > 0 && (
            <ul>
              {children.map((c) => (
                <TreeNode
                  key={c.path}
                  postId={postId}
                  entry={c}
                  depth={depth + 1}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  changedRev={changedRev}
                  changedKind={changedKind}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

export default function FileTree({ postId, selectedPath, onSelect }: FileTreeProps) {
  const t = useT();
  const [roots, setRoots] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const changed = useWorkspaceStore((s) => s.changed);
  const changedRev = useWorkspaceStore((s) => s.rev);
  const changedKind = useCallback(
    (path: string) => changed[path]?.change,
    [changed]
  );

  const loadRoot = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const items = await getFiles(postId);
      setRoots(items);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error);
      setRoots(null);
    } finally {
      setLoading(false);
    }
  }, [postId]);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  // Refresh the root listing when files change (created/deleted at the top level).
  useEffect(() => {
    if (changedRev > 0 && roots !== null) void loadRoot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedRev]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[3px] border border-term-border bg-term-panel">
      <div className="border-b border-term-line px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-term-faint">
        {t('workspace.title')}
      </div>
      <div className="flex-1 overflow-auto py-1">
        {loading && (
          <p className="px-3 py-2 font-mono text-xs text-term-dim">
            {t('workspace.loading')}
          </p>
        )}
        {error && !loading && (
          <div className="px-3 py-2">
            <p className="font-mono text-xs text-term-red" role="alert">
              {t('workspace.error')}
            </p>
            <button
              type="button"
              onClick={() => void loadRoot()}
              className="mt-1 min-h-[44px] font-mono text-xs text-term-amber hover:text-term-fg-bright"
            >
              {t('workspace.retry')}
            </button>
          </div>
        )}
        {roots && roots.length === 0 && !loading && (
          <p className="px-3 py-2 font-mono text-xs text-term-dim">
            {t('workspace.empty')}
          </p>
        )}
        {roots && roots.length > 0 && (
          <ul>
            {roots.map((e) => (
              <TreeNode
                key={e.path}
                postId={postId}
                entry={e}
                depth={0}
                selectedPath={selectedPath}
                onSelect={onSelect}
                changedRev={changedRev}
                changedKind={changedKind}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
