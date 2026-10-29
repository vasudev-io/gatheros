import React, { useEffect } from 'react';
import ReactDOM from 'react-dom';
import styles from './PrivacyModal.module.css';

// Plain-language privacy summary mirrored from PRIVACY.md. Kept short
// enough to scan in one sitting; for the full long-form text the
// "View full policy" link opens the GitHub copy.

const POLICY_URL = 'https://github.com/vasudev-io/gatheros/blob/main/PRIVACY.md';
const SUPPORT_EMAIL = 'hey@gatheros.co';

const SECTIONS = [
  {
    title: 'Your library stays on this Mac',
    body:
      'Saves, collections, tags, and notes live in ' +
      '~/Library/Application Support/GatherOS/. The app does not upload that folder. ' +
      'You can turn on an optional inbox, described below, which is the exception.',
  },
  {
    title: 'Account, licensing, and AI',
    body:
      'Sign-in, subscription status, and AI features use a GatherOS server. ' +
      'Magic-link email goes out through our email provider. AI indexing sends ' +
      'the image to OpenAI through that server when AI is on. There is no separate API key to paste.',
  },
  {
    title: 'Inbox',
    body:
      'Off by default. If you create a token, an assistant can send images, titles, notes, tags, and source links into your account. ' +
      'Your Mac pulls them into the library. Copies on the server are deleted after delivery, and unpulled items expire after 30 days. Revoke the token anytime in Settings.',
  },
  {
    title: 'No tracking',
    body:
      'We don’t collect analytics, telemetry, or crash reports, and we don’t show ads.',
  },
  {
    title: 'Auto-updates',
    body:
      'GatherOS checks GitHub Releases for new builds over HTTPS. ' +
      'GitHub logs standard request info; nothing app-specific is added.',
  },
];

export default function PrivacyModal({ open, onClose }) {
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  function openExternal(e, url) {
    e.preventDefault();
    window.moodmark.shell.openUrl(url);
  }

  return ReactDOM.createPortal(
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Privacy"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Privacy</h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          <p className={styles.lede}>
            The short version: almost nothing leaves your machine, and what does
            is sent on your direct instruction.
          </p>

          {SECTIONS.map(({ title, body }) => (
            <section key={title} className={styles.section}>
              <div className={styles.sectionTitle}>{title}</div>
              <p className={styles.sectionBody}>{body}</p>
            </section>
          ))}

          <div className={styles.footerLinks}>
            <a
              href={POLICY_URL}
              onClick={(e) => openExternal(e, POLICY_URL)}
              className={styles.link}
            >
              View full policy
            </a>
            <span className={styles.dot}>·</span>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              onClick={(e) => openExternal(e, `mailto:${SUPPORT_EMAIL}`)}
              className={styles.link}
            >
              Email support
            </a>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
