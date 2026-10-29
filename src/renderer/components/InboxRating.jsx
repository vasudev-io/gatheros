import React, { useEffect, useMemo, useState } from 'react';
import styles from './InboxRating.module.css';

// Like / dislike for saves that came from the inbox. The rating lives
// on the save's meta.inbox and syncs to the user's own server so the
// assistant that sent the pick can read it back.
//
// variant="panel": real <button>s for the detail panel.
// variant="card": role="button" spans, because the grid card itself is
// a <button> and cannot hold nested buttons.

function inboxInfo(record) {
  if (!record || record.source !== 'inbox' || !record.meta) return null;
  try {
    const meta = typeof record.meta === 'string' ? JSON.parse(record.meta) : record.meta;
    const inbox = meta && meta.inbox;
    if (!inbox || typeof inbox.item_id !== 'string' || !inbox.item_id) return null;
    const rating = inbox.rating === 'like' || inbox.rating === 'dislike' ? inbox.rating : null;
    return { itemId: inbox.item_id, rating };
  } catch {
    return null;
  }
}

export function isRateableInboxSave(record) {
  return !!inboxInfo(record);
}

function useInboxRating(record) {
  const info = useMemo(() => inboxInfo(record), [record?.source, record?.meta]);
  const [optimistic, setOptimistic] = useState(undefined);
  // Drop the optimistic value once the record catches up (or changes).
  useEffect(() => { setOptimistic(undefined); }, [record?.id, record?.meta]);
  const rating = optimistic !== undefined ? optimistic : (info ? info.rating : null);

  async function choose(next) {
    if (!info || !record?.id) return;
    const value = rating === next ? null : next;
    setOptimistic(value);
    try {
      const res = await window.moodmark?.inbox?.rate?.(record.id, value);
      if (!res || res.ok === false) setOptimistic(undefined);
    } catch {
      setOptimistic(undefined);
    }
  }
  return { info, rating, choose };
}

function ThumbUpIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 7v7H2.5A.5.5 0 0 1 2 13.5v-6a.5.5 0 0 1 .5-.5H5Z" />
      <path d="M5 7l2.6-4.6a1.2 1.2 0 0 1 2.2.8L9.3 6h3.4a1.3 1.3 0 0 1 1.3 1.5l-.9 5.3A1.5 1.5 0 0 1 11.6 14H5" />
    </svg>
  );
}

function ThumbDownIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M11 9V2h2.5a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5H11Z" />
      <path d="M11 9l-2.6 4.6a1.2 1.2 0 0 1-2.2-.8L6.7 10H3.3A1.3 1.3 0 0 1 2 8.5l.9-5.3A1.5 1.5 0 0 1 4.4 2H11" />
    </svg>
  );
}

const OPTIONS = [
  { value: 'like', label: 'Like', clear: 'Remove like', Icon: ThumbUpIcon },
  { value: 'dislike', label: 'Dislike', clear: 'Remove dislike', Icon: ThumbDownIcon },
];

export function InboxRatingPanel({ record }) {
  const { info, rating, choose } = useInboxRating(record);
  if (!info) return null;
  return (
    <div className={styles.panelSection}>
      <div className={styles.panelLabel} id={`inbox-rating-${record.id}`}>Your rating</div>
      <div className={styles.panelRow} role="group" aria-labelledby={`inbox-rating-${record.id}`}>
        {OPTIONS.map(({ value, label, clear, Icon }) => {
          const pressed = rating === value;
          return (
            <button
              key={value}
              type="button"
              className={`${styles.panelBtn} ${pressed ? styles.on : ''}`}
              aria-pressed={pressed}
              title={pressed ? clear : label}
              onClick={() => choose(value)}
            >
              <span className={styles.icon}><Icon /></span>
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function InboxRatingCard({ record }) {
  const { info, rating, choose } = useInboxRating(record);
  if (!info) return null;
  const stop = (e) => { e.stopPropagation(); };
  return (
    <span
      className={`${styles.cardGroup} ${rating ? styles.cardGroupRated : ''}`}
      role="group"
      aria-label="Rate this inbox pick"
      onMouseDown={stop}
      onPointerDown={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
    >
      {OPTIONS.map(({ value, label, clear, Icon }) => {
        const pressed = rating === value;
        const act = (e) => {
          e.stopPropagation();
          e.preventDefault();
          choose(value);
        };
        return (
          <span
            key={value}
            role="button"
            tabIndex={0}
            aria-pressed={pressed}
            aria-label={pressed ? clear : label}
            title={pressed ? clear : label}
            className={`${styles.cardBtn} ${pressed ? styles.on : ''}`}
            onClick={act}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') act(e);
              else if (e.key !== 'Tab') e.stopPropagation();
            }}
            onKeyUp={(e) => { if (e.key === ' ') { e.stopPropagation(); e.preventDefault(); } }}
          >
            <Icon />
          </span>
        );
      })}
    </span>
  );
}
