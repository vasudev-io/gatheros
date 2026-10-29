// Pure decisions for rating sync and filing. No Electron, filesystem,
// or network. inbox.js supplies the real database and API, the tests
// supply fakes.
//
// Rules this module enforces:
//   - Only saves whose meta.inbox.item_id equals the filed item are
//     touched. A save that merely deduped against an inbox item is the
//     user's own and is never moved.
//   - Filing adds the save to the target, then removes it from the
//     default Inbox collection. It never deletes a save.
//   - Names match collections first, then boards, ignoring case and
//     extra spaces. A missing name is created once per pull, up to a
//     per-pull budget.

const DEFAULT_CREATE_BUDGET = 20;
const RATINGS = new Set(['like', 'dislike']);

function collectionNameKey(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

function cleanRating(value) {
  return RATINGS.has(value) ? value : null;
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// The inbox item id a save came from, or null for every other save.
function inboxItemIdOf(save) {
  if (!save || save.source !== 'inbox') return null;
  const meta = parseMeta(save.meta);
  const id = meta.inbox && typeof meta.inbox.item_id === 'string' ? meta.inbox.item_id : null;
  return id || null;
}

// New meta with the rating set or cleared. Returns null when the save
// is not an inbox save.
function withRating(save, rating, ratedAt) {
  if (!inboxItemIdOf(save)) return null;
  const meta = parseMeta(save.meta);
  const inbox = { ...(meta.inbox || {}) };
  const value = cleanRating(rating);
  if (value) inbox.rating = value;
  else delete inbox.rating;
  inbox.rated_at = ratedAt;
  return { ...meta, inbox };
}

// A shared per-pull budget for collections created on the user's
// behalf, by imports with collection_name and by filings.
function createBudget(limit = DEFAULT_CREATE_BUDGET) {
  let left = limit;
  return {
    take() {
      if (left <= 0) return false;
      left -= 1;
      return true;
    },
    get left() { return left; },
  };
}

// Find a collection or board by id or name. Returns {kind, id},
// {createName} when nothing matches a name, or null.
function resolveTarget({ id, kind, name, collections, boards }) {
  const collectionRows = Array.isArray(collections) ? collections : [];
  const boardRows = Array.isArray(boards) ? boards : [];
  if (id) {
    if (kind === 'board' && boardRows.some((row) => row.id === id)) return { kind: 'board', id };
    if (kind !== 'board' && collectionRows.some((row) => row.id === id)) return { kind: 'collection', id };
    if (!kind && boardRows.some((row) => row.id === id)) return { kind: 'board', id };
  }
  const key = collectionNameKey(name);
  if (!key) return null;
  const collection = collectionRows.find((row) => collectionNameKey(row.name) === key);
  if (collection) return { kind: 'collection', id: collection.id };
  const board = boardRows.find((row) => collectionNameKey(row.name) === key);
  if (board) return { kind: 'board', id: board.id };
  return { createName: String(name).replace(/\s+/g, ' ').trim() };
}

// Make a named collection, or reuse one created earlier in this pull.
function ensureCollection(name, deps) {
  const again = resolveTarget({ name, collections: deps.listCollections(), boards: [] });
  if (again && again.id) return again;
  if (deps.budget && !deps.budget.take()) return null;
  const created = deps.createCollection({ name });
  if (!created || !created.id) return null;
  return { kind: 'collection', id: created.id, created: true };
}

// The collections an inbox save sits in by default: any collection
// named Inbox, plus the Settings default when it is a collection.
function inboxCollectionIds(deps) {
  const ids = new Set();
  for (const row of deps.listCollections() || []) {
    if (collectionNameKey(row.name) === 'inbox') ids.add(row.id);
  }
  const fallback = deps.getDefaultTarget ? deps.getDefaultTarget() : null;
  if (fallback && fallback.kind !== 'board' && fallback.id) ids.add(fallback.id);
  return ids;
}

// One filing. Returns {result: 'applied'|'skipped'|'failed'|'wait'}.
// 'wait' is not acked: the item has not reached this desktop yet.
function applyFiling(filing, deps) {
  if (!filing || !filing.item_id) return { result: 'skipped', error: 'invalid_filing' };
  const receipt = deps.getReceipt(filing.item_id);
  if (!receipt || !receipt.result || receipt.result === 'retry') return { result: 'wait' };
  if (receipt.result !== 'imported' || !receipt.save_id) return { result: 'skipped', error: 'not_inbox_save' };
  const save = deps.getSave(receipt.save_id);
  if (!save || save.deleted_at) return { result: 'skipped', error: 'save_missing' };
  if (inboxItemIdOf(save) !== filing.item_id) return { result: 'skipped', error: 'not_inbox_save' };

  let target = resolveTarget({
    id: filing.collection_id,
    kind: filing.collection_kind,
    name: filing.collection_name,
    collections: deps.listCollections(),
    boards: deps.listBoards(),
  });
  if (!target) return { result: 'failed', error: 'unknown_collection' };
  let created = false;
  if (target.createName) {
    const made = ensureCollection(target.createName, deps);
    if (!made) return { result: 'failed', error: 'collection_create_limit' };
    created = !!made.created;
    target = { kind: made.kind, id: made.id };
  }

  deps.place(target, save);
  const removed = [];
  for (const id of inboxCollectionIds(deps)) {
    if (target.kind === 'collection' && id === target.id) continue;
    deps.removeFromCollection({ collectionId: id, saveId: save.id });
    removed.push(id);
  }
  return { result: 'applied', target, created, removed };
}

// Push changed ratings, then apply queued filings and ack them.
async function organizeInbox(deps) {
  const summary = { ratingsSynced: 0, ratingsRejected: 0, filed: 0, skipped: 0, failed: 0, waiting: 0, created: 0 };
  await pushRatings(deps, summary);

  const page = await deps.api.listFilings();
  const filings = Array.isArray(page && page.filings) ? page.filings : [];
  const results = [];
  for (const filing of filings) {
    let outcome;
    try {
      outcome = applyFiling(filing, deps);
    } catch (err) {
      outcome = { result: 'failed', error: String(err && err.message || err).slice(0, 200) };
    }
    if (outcome.result === 'wait') {
      summary.waiting += 1;
      continue;
    }
    if (outcome.result === 'applied') summary.filed += 1;
    else if (outcome.result === 'skipped') summary.skipped += 1;
    else summary.failed += 1;
    if (outcome.created) summary.created += 1;
    results.push({ id: filing.id, result: outcome.result, error: outcome.error || undefined });
  }
  if (results.length) await deps.api.ackFilings(results);
  return summary;
}

async function pushRatings(deps, summary = { ratingsSynced: 0, ratingsRejected: 0 }) {
  const rows = deps.listUnsyncedRatings() || [];
  if (!rows.length) return summary;
  const payload = rows.map((row) => ({
    item_id: row.item_id,
    rating: cleanRating(row.rating),
    rated_at: row.rated_at,
  }));
  const res = await deps.api.putRatings(payload);
  const accepted = new Set(Array.isArray(res && res.accepted) ? res.accepted : []);
  const rejected = new Set((Array.isArray(res && res.rejected) ? res.rejected : []).map((r) => r && r.item_id));
  for (const row of rows) {
    // A rejected id (not on the server, another account) is marked too,
    // so it is not resent on every pull.
    if (accepted.has(row.item_id) || rejected.has(row.item_id)) {
      deps.markRatingSynced({ itemId: row.item_id, ratedAt: row.rated_at });
    }
    if (accepted.has(row.item_id)) summary.ratingsSynced += 1;
    else if (rejected.has(row.item_id)) summary.ratingsRejected += 1;
  }
  return summary;
}

module.exports = {
  DEFAULT_CREATE_BUDGET,
  collectionNameKey,
  parseMeta,
  inboxItemIdOf,
  withRating,
  createBudget,
  resolveTarget,
  ensureCollection,
  inboxCollectionIds,
  applyFiling,
  organizeInbox,
  pushRatings,
};
