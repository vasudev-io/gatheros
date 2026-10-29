import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Eclipse } from 'lucide-react';
import styles from './CommandPalette.module.css';
import { CollectionIcon } from './Sidebar.jsx';
import { resolveAsset } from '../lib/asset.js';

function HashIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <line x1="3"  y1="6"  x2="13.5" y2="6" />
      <line x1="2.5" y1="10" x2="13"   y2="10" />
      <line x1="6.5" y1="2.5" x2="5"   y2="13.5" />
      <line x1="11"  y1="2.5" x2="9.5" y2="13.5" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.4" y1="10.4" x2="13.5" y2="13.5" />
    </svg>
  );
}

// Terminal-style chevron — the "this row is an action" glyph.
function CommandIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 4.5 7 8l-3.5 3.5" />
      <line x1="8.5" y1="11.5" x2="13" y2="11.5" />
    </svg>
  );
}

// Spaces glyph — the same Eclipse mark the Spaces tab uses, so the
// two surfaces read as the same thing.
function SpaceIcon() {
  return <Eclipse size={14} strokeWidth={1.6} aria-hidden="true" />;
}

// Source marks — the same X and Instagram glyphs the Saved-view toggle
// uses, so a captured post reads as a post rather than a plain save.
function XMark({ size = 11 }) {
  return (
    <svg viewBox="0 0 1200 1227" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M714 519L1161 0h-106L667 451 357 0H0l469 682L0 1226h106l410-476 327 476h357L714 519zM569 688l-47-68L144 80h163l305 436 48 68 396 567H892L569 688z" />
    </svg>
  );
}
function InstagramMark({ size = 12 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="20" height="20" x="2" y="2" rx="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}
// The cosmos.so mark: six dots in a hexagonal ring, tinted via currentColor.
function CosmosMark({ size = 12 }) {
  return (
    <svg viewBox="0 0 38 42" width={size} height={size} fill="currentColor" aria-hidden="true">
      <circle cx="19.02" cy="5.95" r="5.95" />
      <circle cx="19.02" cy="35.99" r="5.95" />
      <circle cx="5.97" cy="13.46" r="5.95" />
      <circle cx="32.08" cy="13.46" r="5.95" />
      <circle cx="5.97" cy="28.48" r="5.95" />
      <circle cx="32.08" cy="28.48" r="5.95" />
    </svg>
  );
}

// A captured social post carries tweet_meta (or an x/instagram source).
// Returns the source-aware kind label + glyph, or a plain "Save".
function saveKind(s) {
  let hasMeta = false;
  try { hasMeta = !!(s.tweet_meta && JSON.parse(s.tweet_meta)); } catch { /* malformed → treat as none */ }
  const url = s.source_url || '';
  const isSocial = hasMeta
    || s.source === 'instagram'
    || s.source === 'cosmos'
    || /(?:x\.com|twitter\.com|instagram\.com|cosmos\.so)/i.test(url);
  if (!isSocial) return { label: 'Save', glyph: null };
  if (s.source === 'cosmos' || /cosmos\.so/i.test(url)) {
    return { label: 'Cosmos', glyph: <CosmosMark /> };
  }
  if (s.source === 'instagram' || /instagram\.com/i.test(url)) {
    return { label: 'Instagram', glyph: <InstagramMark /> };
  }
  return { label: 'Post', glyph: <XMark /> };
}

const SEARCH_DEBOUNCE = 80;
const PER_GROUP = 6;

function matchScore(label, keywords, q) {
  const l = String(label).toLowerCase();
  if (l.startsWith(q)) return 0;
  if (l.includes(q)) return 1;
  if (keywords && String(keywords).toLowerCase().includes(q)) return 2;
  return -1;
}

// The one ⌘K surface: type to search everything — saves, collections,
// tags, spaces and app commands — grouped by type; `>` scopes to
// commands only (the Raycast convention). Replaces the old
// QuickSwitcher, which could only jump to collections/tags/saves.
export default function CommandPalette({
  open,
  onClose,
  collections = [],
  allTags = [],
  boards = [],
  commands = [],
  onPickBucket,
  onPickTag,
  onPickSave,
  onPickBoard,
}) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [saveResults, setSaveResults] = useState([]);
  const [recentSaves, setRecentSaves] = useState([]);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const pickedRef = useRef(false);

  // `>` scopes to commands; everything else searches all groups.
  const commandsOnly = query.startsWith('>');
  const q = (commandsOnly ? query.slice(1) : query).trim().toLowerCase();

  // Reset state on open / close, and pull the recently-viewed strip
  // shown on the empty (home) state.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setSaveResults([]);
      pickedRef.current = false;
      requestAnimationFrame(() => inputRef.current?.focus());
      window.moodmark.saves.recentlyViewed?.(12)
        .then((rows) => setRecentSaves(rows || []))
        .catch(() => setRecentSaves([]));
    }
  }, [open]);

  // Debounced backend search for saves. Returns top N. The backend
  // parses filter tokens too, so `tag:serif` narrows properly here.
  useEffect(() => {
    if (!open) return;
    if (!q || commandsOnly) {
      setSaveResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const data = await window.moodmark.saves.getAll({ search: q });
        if (!cancelled) setSaveResults((data || []).slice(0, PER_GROUP));
      } catch { /* ignore */ }
    }, SEARCH_DEBOUNCE);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, commandsOnly, open]);

  const commandResults = useMemo(() => {
    if (!q) {
      // Empty query: the palette opens as a full command menu. The
      // results area is height-capped in CSS, so the whole list is
      // present but scrolls within the default panel height.
      return commands;
    }
    return commands
      .map((c) => ({ c, score: matchScore(c.label, c.keywords, q) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.c)
      .slice(0, commandsOnly ? 20 : PER_GROUP);
  }, [q, commandsOnly, commands]);

  const bucketResults = useMemo(() => {
    if (!q || commandsOnly) return [];
    return collections
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, PER_GROUP);
  }, [q, commandsOnly, collections]);

  // Parent name for a child collection, so results can read "in ⟨Parent⟩"
  // instead of a bare "Collection" and children aren't mistaken for
  // top-level ones.
  const parentNameOf = useMemo(() => {
    const byId = new Map(collections.map((c) => [c.id, c.name]));
    return (c) => (c.parent_id ? byId.get(c.parent_id) : null);
  }, [collections]);

  const tagResults = useMemo(() => {
    if (!q || commandsOnly) return [];
    return allTags
      .filter((t) => t.name.toLowerCase().includes(q))
      .slice(0, PER_GROUP);
  }, [q, commandsOnly, allTags]);

  const boardResults = useMemo(() => {
    if (!q || commandsOnly) return [];
    return boards
      .filter((b) => (b.name || '').toLowerCase().includes(q))
      .slice(0, PER_GROUP);
  }, [q, commandsOnly, boards]);

  // Flat ordered list — drives keyboard nav. Commands lead: they're
  // the group whose position muscle memory learns.
  const items = useMemo(() => {
    const out = [];
    for (const c of commandResults) out.push({ type: 'command', record: c, key: `c:${c.id}` });
    for (const b of bucketResults) out.push({ type: 'bucket', record: b, key: `b:${b.id}` });
    for (const t of tagResults) out.push({ type: 'tag', record: t, key: `t:${t.id}` });
    for (const b of boardResults) out.push({ type: 'board', record: b, key: `bd:${b.id}` });
    for (const s of saveResults) out.push({ type: 'save', record: s, key: `s:${s.id}` });
    return out;
  }, [commandResults, bucketResults, tagResults, boardResults, saveResults]);

  // Reset highlight when results change.
  useEffect(() => { setActiveIdx(0); }, [items.length]);

  // Keep active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-qs-idx="${activeIdx}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIdx]);

  function pick(item) {
    if (!item || pickedRef.current) return;
    pickedRef.current = true;
    if (item.type === 'command') item.record.run?.();
    else if (item.type === 'bucket') onPickBucket?.(item.record.id);
    else if (item.type === 'tag') onPickTag?.(item.record.name);
    else if (item.type === 'board') onPickBoard?.(item.record.id);
    else if (item.type === 'save') onPickSave?.(item.record.id);
    onClose?.();
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose?.();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (items.length === 0 ? 0 : Math.min(items.length - 1, i + 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(items[activeIdx]);
    }
  }

  if (!open) return null;

  let runningIdx = -1;
  function nextIdx() { runningIdx += 1; return runningIdx; }

  // Shared row wiring so every group gets identical interaction:
  // commit on pointerdown (before any global mousedown listener can
  // steal the gesture), click kept as an assistive-tech fallback —
  // pickedRef makes a double fire a no-op.
  const rowProps = (idx, item) => ({
    'data-qs-idx': idx,
    type: 'button',
    className: [styles.row, activeIdx === idx && styles.rowActive].filter(Boolean).join(' '),
    onMouseEnter: () => setActiveIdx(idx),
    onPointerDown: (e) => { e.preventDefault(); pick(item); },
    onClick: () => pick(item),
  });

  return ReactDOM.createPortal(
    <div className={styles.scrim} onMouseDown={onClose}>
      <div className={styles.panel} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.searchRow}>
          <span className={styles.searchIcon}><SearchIcon /></span>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            placeholder="Search or run a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className={styles.kbd}>esc</span>
        </div>

        {(items.length > 0) ? (
          <div className={styles.results} ref={listRef}>
            {/* Recently viewed — a visual jump-back strip on the empty
                (home) state only. Mouse-clickable; not part of the
                arrow-key flow (which stays on the command/result list). */}
            {!q && recentSaves.length > 0 && (
              <div className={styles.group}>
                <div className={styles.groupLabel}>Recently viewed</div>
                <div className={styles.recentStrip}>
                  {recentSaves.map((s) => {
                    const src = resolveAsset(s, 'thumb');
                    return (
                      <button
                        key={`r:${s.id}`}
                        type="button"
                        className={styles.recentTile}
                        title={s.title || 'Untitled'}
                        onPointerDown={(e) => { e.preventDefault(); pick({ type: 'save', record: s }); }}
                        onClick={() => pick({ type: 'save', record: s })}
                      >
                        {src && <img src={src} alt={s.title || ''} draggable={false} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {commandResults.length > 0 && (
              <div className={styles.group}>
                <div className={styles.groupLabel}>Commands</div>
                {commandResults.map((c) => {
                  const idx = nextIdx();
                  return (
                    <button key={`c:${c.id}`} {...rowProps(idx, { type: 'command', record: c })}>
                      <span className={styles.rowIcon}>{c.Icon ? <c.Icon /> : <CommandIcon />}</span>
                      <span className={styles.rowLabel}>{c.label}</span>
                      {c.hint && <span className={styles.rowHint}>{c.hint}</span>}
                    </button>
                  );
                })}
              </div>
            )}

            {bucketResults.length > 0 && (
              <div className={styles.group}>
                <div className={styles.groupLabel}>Collections</div>
                {bucketResults.map((b) => {
                  const idx = nextIdx();
                  const parent = parentNameOf(b);
                  return (
                    <button key={`b:${b.id}`} {...rowProps(idx, { type: 'bucket', record: b })}>
                      <span className={styles.rowIcon}><CollectionIcon /></span>
                      <span className={styles.rowLabel}>{b.name}</span>
                      <span className={styles.rowKind}>{parent ? `in ${parent}` : 'Collection'}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {tagResults.length > 0 && (
              <div className={styles.group}>
                <div className={styles.groupLabel}>Tags</div>
                {tagResults.map((t) => {
                  const idx = nextIdx();
                  return (
                    <button key={`t:${t.id}`} {...rowProps(idx, { type: 'tag', record: t })}>
                      <span className={styles.rowIcon}><HashIcon /></span>
                      <span className={styles.rowLabel}>{t.name}</span>
                      <span className={styles.rowKind}>Tag</span>
                    </button>
                  );
                })}
              </div>
            )}

            {boardResults.length > 0 && (
              <div className={styles.group}>
                <div className={styles.groupLabel}>Spaces</div>
                {boardResults.map((b) => {
                  const idx = nextIdx();
                  return (
                    <button key={`bd:${b.id}`} {...rowProps(idx, { type: 'board', record: b })}>
                      <span className={styles.rowIcon}><SpaceIcon /></span>
                      <span className={styles.rowLabel}>{b.name || <span className={styles.rowUntitled}>Untitled board</span>}</span>
                      <span className={styles.rowKind}>Space</span>
                    </button>
                  );
                })}
              </div>
            )}

            {saveResults.length > 0 && (
              <div className={styles.group}>
                <div className={styles.groupLabel}>Saves</div>
                {saveResults.map((s) => {
                  const idx = nextIdx();
                  const src = resolveAsset(s, 'thumb');
                  return (
                    <button key={`s:${s.id}`} {...rowProps(idx, { type: 'save', record: s })}>
                      <span className={styles.rowThumb}>
                        {src && <img src={src} alt="" draggable={false} />}
                      </span>
                      <span className={styles.rowLabel}>
                        {s.title || <span className={styles.rowUntitled}>Untitled</span>}
                      </span>
                      {(() => {
                        const kind = saveKind(s);
                        return (
                          <span className={styles.rowKind}>
                            {kind.glyph && <span className={styles.rowKindGlyph}>{kind.glyph}</span>}
                            {kind.label}
                          </span>
                        );
                      })()}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className={styles.empty}>
            {q ? `No matches for "${q}"` : 'Start typing to search…'}
          </div>
        )}

        <div className={styles.footer}>
          <span><span className={styles.kbd}>↑↓</span> navigate</span>
          <span><span className={styles.kbd}>↵</span> select</span>
          <span><span className={styles.kbd}>&gt;</span> commands only</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
