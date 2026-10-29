import React, { useEffect, useState } from 'react';
import styles from './SettingsModal.module.css';
import { confirm } from '../lib/confirm.js';

function ToggleSwitch({ on, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`${styles.toggleSwitch} ${on ? styles.toggleSwitchOn : ''}`}
      onClick={() => onChange?.(!on)}
    >
      <span className={styles.toggleSwitchThumb} aria-hidden="true" />
    </button>
  );
}

function formatWhen(ts) {
  if (!ts) return 'Not yet';
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return 'Not yet';
  }
}

function errorText(code) {
  if (!code) return null;
  if (code === 'upgrade') return 'New saves need an upgrade. Pending items stay on the server.';
  if (code === 'unauthenticated' || code === 'signed out') return 'Sign in to pull the inbox.';
  if (code === 'token_limit') return 'You can have up to 5 active tokens. Revoke one to create another.';
  return code;
}

export default function InboxSettings({ prefs, updatePref, signedIn }) {
  const [status, setStatus] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [collections, setCollections] = useState([]);
  const [boards, setBoards] = useState([]);
  const [label, setLabel] = useState('assistant');
  const [freshToken, setFreshToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [apiDraft, setApiDraft] = useState(prefs.apiBaseUrl || '');

  useEffect(() => { setApiDraft(prefs.apiBaseUrl || ''); }, [prefs.apiBaseUrl]);

  async function refresh() {
    if (!window.moodmark?.inbox) return;
    const [nextStatus, nextTokens, cols, boardRows] = await Promise.all([
      window.moodmark.inbox.status().catch(() => null),
      signedIn ? window.moodmark.inbox.listTokens().catch(() => null) : Promise.resolve(null),
      window.moodmark.collections.getAll().catch(() => []),
      window.moodmark.boards.list().catch(() => []),
    ]);
    if (nextStatus) setStatus(nextStatus);
    setTokens(Array.isArray(nextTokens?.tokens) ? nextTokens.tokens : []);
    setCollections(Array.isArray(cols) ? cols : []);
    setBoards(Array.isArray(boardRows) ? boardRows : []);
  }

  useEffect(() => { refresh(); }, [signedIn, prefs.inboxEnabled, prefs.apiBaseUrl]);

  const enabled = !!prefs.inboxEnabled;
  const mcpUrl = status?.mcpUrl || '';
  const target = prefs.inboxTarget && prefs.inboxTarget.id
    ? `${prefs.inboxTarget.kind || 'collection'}:${prefs.inboxTarget.id}`
    : '';

  async function onPull() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.moodmark.inbox.pull();
      if (result?.skipped === 'disabled') setMessage('Turn inbox on to pull items.');
      else if (result?.skipped === 'signed_out') setMessage('Sign in to pull the inbox.');
      else if (result?.ok === false) setMessage(errorText(result.error) || 'Pull failed.');
      else if (result?.blocked) setMessage('New saves need an upgrade. Pending items stay on the server.');
      else {
        const n = (result?.imported || 0) + (result?.duplicate || 0);
        setMessage(n ? `Imported ${n}.` : 'Inbox is up to date.');
      }
      await refresh();
    } catch (err) {
      setMessage(err.message || 'Pull failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onCreate() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.moodmark.inbox.createToken(label.trim() || 'assistant');
      if (!result?.ok) {
        setMessage(errorText(result?.error) || 'Could not create a token.');
      } else {
        setFreshToken(result.token);
        setMessage(null);
      }
      await refresh();
    } catch (err) {
      setMessage(err.message || 'Could not create a token.');
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(token) {
    const ok = await confirm({
      title: 'Revoke token',
      message: `Revoke “${token.label}”? Anything it queued that hasn’t been imported is deleted.`,
      confirmLabel: 'Revoke',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await window.moodmark.inbox.revokeToken(token.id);
      if (freshToken) setFreshToken(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); setMessage('Copied.'); }
    catch { setMessage('Could not copy. Select the text instead.'); }
  }

  function saveApiBase() {
    const next = apiDraft.trim();
    if (next && !/^https?:\/\//i.test(next)) {
      setMessage('Enter an http or https URL.');
      return;
    }
    updatePref('apiBaseUrl', next);
  }

  return (
    <div className={styles.page}>
      <p className={styles.sectionHint}>
        Let an assistant add images and links to the library you have open.
        This stays off until you turn it on. Imported items get thumbnails,
        a palette, and AI indexing when that’s already on.
      </p>

      <div className={styles.field}>
        <div className={styles.toggleRow}>
          <span className={styles.toggleLabel}>Pull inbox items</span>
          <ToggleSwitch
            on={enabled}
            label="Pull inbox items"
            onChange={(next) => updatePref('inboxEnabled', next)}
          />
        </div>
        <span className={styles.fieldHint}>
          Gather checks on launch, when you focus the window, every 15 minutes, and when you pull now.
        </span>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="inbox-api-base">API server</label>
        <input
          id="inbox-api-base"
          className={styles.textInput}
          value={apiDraft}
          placeholder="https://api.gatheros.co"
          spellCheck={false}
          onChange={(e) => setApiDraft(e.target.value)}
          onBlur={saveApiBase}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
        <span className={styles.fieldHint}>
          Blank uses the default server. Point this at your own Worker for auth, licensing, AI, and the inbox.
          {status?.resolvedApiBaseUrl ? ` Using ${status.resolvedApiBaseUrl}.` : ''}
        </span>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="inbox-target">Default collection</label>
        <select
          id="inbox-target"
          className={styles.select}
          value={target}
          onChange={(e) => {
            const value = e.target.value;
            if (!value) {
              updatePref('inboxTarget', null);
              return;
            }
            const split = value.indexOf(':');
            updatePref('inboxTarget', {
              kind: value.slice(0, split),
              id: value.slice(split + 1),
            });
          }}
        >
          <option value="">Inbox</option>
          {collections.map((col) => (
            <option key={col.id} value={`collection:${col.id}`}>{col.name}</option>
          ))}
          {boards.map((board) => (
            <option key={board.id} value={`board:${board.id}`}>Board · {board.name}</option>
          ))}
        </select>
        <span className={styles.fieldHint}>
          Used when an item doesn’t name a collection. An assistant can still target one from the list it sees.
        </span>
      </div>

      <div className={styles.field}>
        <div className={styles.toggleRow}>
          <span className={styles.toggleLabel}>
            {status?.pendingCount ? `${status.pendingCount} pending` : 'Nothing pending'}
          </span>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={onPull}
            disabled={busy || !enabled || !signedIn}
          >
            {busy ? 'Pulling…' : 'Pull now'}
          </button>
        </div>
        <span className={styles.fieldHint}>
          Last sync {formatWhen(status?.lastSyncAt || prefs.inboxLastSyncAt)}.
          {status?.lastError && status.lastError !== 'upgrade' ? ` ${errorText(status.lastError)}` : ''}
        </span>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>MCP server</label>
        <div className={styles.tokenRow}>
          <code className={styles.tokenValue}>{mcpUrl || '—'}</code>
          <button type="button" className={styles.btn} onClick={() => mcpUrl && copy(mcpUrl)} disabled={!mcpUrl}>
            Copy URL
          </button>
        </div>
        <span className={styles.fieldHint}>
          Paste this URL and an inbox token into your MCP client. The token can add items and list collection names. It cannot read your library.
        </span>
      </div>

      {!signedIn && (
        <p className={styles.sectionHint}>Sign in to create tokens and pull items.</p>
      )}

      {signedIn && (
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="inbox-token-label">New token</label>
          <div className={styles.tokenRow}>
            <input
              id="inbox-token-label"
              className={styles.textInput}
              value={label}
              maxLength={40}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="assistant"
            />
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onCreate} disabled={busy}>
              Create token
            </button>
          </div>
          {freshToken && (
            <div className={styles.tokenReveal}>
              <p className={styles.fieldHint}>Copy this token now. It is shown once.</p>
              <code className={styles.tokenValue}>{freshToken}</code>
              <div className={styles.tokenRow}>
                <button type="button" className={styles.btn} onClick={() => copy(freshToken)}>Copy token</button>
                <button type="button" className={styles.btn} onClick={() => setFreshToken(null)}>Done</button>
              </div>
            </div>
          )}
        </div>
      )}

      {signedIn && tokens.length > 0 && (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Active tokens</label>
          <ul className={styles.tokenList}>
            {tokens.map((token) => (
              <li key={token.id} className={styles.tokenListItem}>
                <span>
                  <strong>{token.label}</strong>
                  <span className={styles.fieldHint}> {token.prefix}… · {token.last_used_at ? `Last used ${formatWhen(token.last_used_at)}` : 'Not used yet'}</span>
                </span>
                <button type="button" className={styles.btn} onClick={() => onRevoke(token)} disabled={busy}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {message && <p className={styles.sectionHint}>{message}</p>}
    </div>
  );
}
