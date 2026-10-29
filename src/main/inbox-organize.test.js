const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyFiling,
  createBudget,
  ensureCollection,
  inboxItemIdOf,
  organizeInbox,
  pushRatings,
  resolveTarget,
  withRating,
} = require('./inbox-organize');

const ITEM = '11111111-1111-4111-8111-111111111111';
const OTHER_ITEM = '22222222-2222-4222-8222-222222222222';

function inboxSave(id, itemId, extra = {}) {
  return { id, source: 'inbox', meta: JSON.stringify({ inbox: { item_id: itemId } }), ...extra };
}

function library(overrides = {}) {
  const collections = [
    { id: 'col-inbox', name: 'Inbox' },
    { id: 'col-onb', name: 'Onboarding' },
  ];
  const boards = [{ id: 'board-1', name: 'Moodboard' }];
  const saves = new Map([
    ['save-1', inboxSave('save-1', ITEM)],
    ['save-own', { id: 'save-own', source: 'upload', meta: null }],
  ]);
  const receipts = new Map([[ITEM, { item_id: ITEM, result: 'imported', save_id: 'save-1' }]]);
  const calls = { placed: [], removed: [], created: [], acked: [], ratings: [], synced: [] };
  const deps = {
    calls,
    collections,
    boards,
    saves,
    receipts,
    listCollections: () => collections,
    listBoards: () => boards,
    getReceipt: (id) => receipts.get(id) || null,
    getSave: (id) => saves.get(id) || null,
    getDefaultTarget: () => ({ kind: 'collection', id: 'col-inbox' }),
    place: (target, save) => calls.placed.push({ target, saveId: save.id }),
    removeFromCollection: (row) => calls.removed.push(row),
    createCollection: ({ name }) => {
      const row = { id: `col-new-${collections.length}`, name };
      collections.push(row);
      calls.created.push(name);
      return row;
    },
    budget: createBudget(20),
    listUnsyncedRatings: () => [],
    markRatingSynced: (row) => calls.synced.push(row),
    api: {
      putRatings: async (rows) => { calls.ratings.push(...rows); return { accepted: rows.map((r) => r.item_id), rejected: [] }; },
      listFilings: async () => ({ filings: [] }),
      ackFilings: async (rows) => { calls.acked.push(...rows); },
    },
    ...overrides,
  };
  return deps;
}

test('only saves made by an inbox item count as inbox saves', () => {
  assert.equal(inboxItemIdOf(inboxSave('s', ITEM)), ITEM);
  assert.equal(inboxItemIdOf({ id: 's', source: 'upload', meta: JSON.stringify({ inbox: { item_id: ITEM } }) }), null);
  assert.equal(inboxItemIdOf({ id: 's', source: 'inbox', meta: '{bad json' }), null);
  assert.equal(inboxItemIdOf(null), null);
});

test('withRating sets and clears the rating on inbox saves only', () => {
  const liked = withRating(inboxSave('s', ITEM), 'like', 5);
  assert.deepEqual(liked.inbox, { item_id: ITEM, rating: 'like', rated_at: 5 });
  const cleared = withRating({ ...inboxSave('s', ITEM), meta: JSON.stringify(liked) }, null, 6);
  assert.deepEqual(cleared.inbox, { item_id: ITEM, rated_at: 6 });
  assert.equal(withRating({ id: 's', source: 'upload' }, 'like', 1), null);
  assert.equal(withRating(inboxSave('s', ITEM), 'love', 1).inbox.rating, undefined);
});

test('resolveTarget matches ids, then names ignoring case, collections before boards', () => {
  const collections = [{ id: 'c1', name: 'Pricing' }];
  const boards = [{ id: 'b1', name: 'pricing' }, { id: 'b2', name: 'Maps' }];
  assert.deepEqual(resolveTarget({ id: 'b1', kind: 'board', collections, boards }), { kind: 'board', id: 'b1' });
  assert.deepEqual(resolveTarget({ id: 'c1', collections, boards }), { kind: 'collection', id: 'c1' });
  assert.deepEqual(resolveTarget({ name: '  PRICING ', collections, boards }), { kind: 'collection', id: 'c1' });
  assert.deepEqual(resolveTarget({ name: 'maps', collections, boards }), { kind: 'board', id: 'b2' });
  assert.deepEqual(resolveTarget({ name: 'Empty   states', collections, boards }), { createName: 'Empty states' });
  assert.equal(resolveTarget({ id: 'gone', collections, boards }), null);
});

test('ensureCollection creates a name once and respects the budget', () => {
  const deps = library({ budget: createBudget(1) });
  const a = ensureCollection('Charts', deps);
  const b = ensureCollection('charts', deps);
  assert.equal(a.created, true);
  assert.equal(b.id, a.id);
  assert.equal(b.created, undefined);
  assert.deepEqual(deps.calls.created, ['Charts']);
  assert.equal(ensureCollection('Maps', deps), null);
});

test('applyFiling moves an inbox save out of Inbox and never deletes', () => {
  const deps = library();
  const out = applyFiling({ id: 'f1', item_id: ITEM, collection_id: 'col-onb', collection_kind: 'collection' }, deps);
  assert.equal(out.result, 'applied');
  assert.deepEqual(deps.calls.placed, [{ target: { kind: 'collection', id: 'col-onb' }, saveId: 'save-1' }]);
  assert.deepEqual(deps.calls.removed, [{ collectionId: 'col-inbox', saveId: 'save-1' }]);
});

test('applyFiling into Inbox itself does not remove it again', () => {
  const deps = library();
  const out = applyFiling({ id: 'f1', item_id: ITEM, collection_name: 'inbox' }, deps);
  assert.equal(out.result, 'applied');
  assert.deepEqual(deps.calls.removed, []);
});

test('applyFiling creates a named collection and files into a board', () => {
  const deps = library();
  const made = applyFiling({ id: 'f1', item_id: ITEM, collection_name: 'Empty states' }, deps);
  assert.equal(made.result, 'applied');
  assert.equal(made.created, true);
  assert.deepEqual(deps.calls.created, ['Empty states']);
  const board = applyFiling({ id: 'f2', item_id: ITEM, collection_id: 'board-1', collection_kind: 'board' }, deps);
  assert.equal(board.result, 'applied');
  assert.deepEqual(board.target, { kind: 'board', id: 'board-1' });
});

test('applyFiling waits, skips, or fails without touching other saves', () => {
  const deps = library();
  assert.equal(applyFiling({ id: 'f', item_id: OTHER_ITEM, collection_id: 'col-onb' }, deps).result, 'wait');
  deps.receipts.set(OTHER_ITEM, { item_id: OTHER_ITEM, result: 'retry' });
  assert.equal(applyFiling({ id: 'f', item_id: OTHER_ITEM, collection_id: 'col-onb' }, deps).result, 'wait');
  // Deduped against the user's own save: never moved.
  deps.receipts.set(OTHER_ITEM, { item_id: OTHER_ITEM, result: 'duplicate', save_id: 'save-own' });
  assert.deepEqual(applyFiling({ id: 'f', item_id: OTHER_ITEM, collection_id: 'col-onb' }, deps), { result: 'skipped', error: 'not_inbox_save' });
  // A receipt that points at a save from another item.
  deps.receipts.set(OTHER_ITEM, { item_id: OTHER_ITEM, result: 'imported', save_id: 'save-1' });
  assert.equal(applyFiling({ id: 'f', item_id: OTHER_ITEM, collection_id: 'col-onb' }, deps).error, 'not_inbox_save');
  deps.receipts.set(OTHER_ITEM, { item_id: OTHER_ITEM, result: 'imported', save_id: 'save-own' });
  assert.equal(applyFiling({ id: 'f', item_id: OTHER_ITEM, collection_id: 'col-onb' }, deps).error, 'not_inbox_save');
  deps.saves.get('save-1').deleted_at = 1;
  assert.equal(applyFiling({ id: 'f', item_id: ITEM, collection_id: 'col-onb' }, deps).error, 'save_missing');
  delete deps.saves.get('save-1').deleted_at;
  assert.deepEqual(applyFiling({ id: 'f', item_id: ITEM, collection_id: 'gone' }, deps), { result: 'failed', error: 'unknown_collection' });
  const broke = library({ budget: createBudget(0) });
  assert.deepEqual(applyFiling({ id: 'f', item_id: ITEM, collection_name: 'New one' }, broke), { result: 'failed', error: 'collection_create_limit' });
  assert.deepEqual(deps.calls.placed, []);
  assert.deepEqual(deps.calls.removed, []);
});

test('organizeInbox pushes ratings, applies filings, and acks all but waiting ones', async () => {
  const deps = library({
    listUnsyncedRatings: () => [
      { item_id: ITEM, rating: 'like', rated_at: 10 },
      { item_id: OTHER_ITEM, rating: null, rated_at: 11 },
    ],
  });
  deps.api.putRatings = async (rows) => {
    deps.calls.ratings.push(...rows);
    return { accepted: [ITEM], rejected: [{ item_id: OTHER_ITEM, error: 'not_found' }] };
  };
  deps.api.listFilings = async () => ({
    filings: [
      { id: 'f1', item_id: ITEM, collection_name: 'Charts' },
      { id: 'f2', item_id: OTHER_ITEM, collection_id: 'col-onb' },
      { id: 'f3', item_id: ITEM, collection_id: 'missing' },
    ],
  });
  const summary = await organizeInbox(deps);
  assert.deepEqual(deps.calls.ratings, [
    { item_id: ITEM, rating: 'like', rated_at: 10 },
    { item_id: OTHER_ITEM, rating: null, rated_at: 11 },
  ]);
  assert.deepEqual(deps.calls.synced, [{ itemId: ITEM, ratedAt: 10 }, { itemId: OTHER_ITEM, ratedAt: 11 }]);
  assert.deepEqual(summary, { ratingsSynced: 1, ratingsRejected: 1, filed: 1, skipped: 0, failed: 1, waiting: 1, created: 1 });
  assert.deepEqual(deps.calls.acked, [
    { id: 'f1', result: 'applied', error: undefined },
    { id: 'f3', result: 'failed', error: 'unknown_collection' },
  ]);
});

test('pushRatings sends nothing when nothing changed', async () => {
  const deps = library();
  let called = false;
  deps.api.putRatings = async () => { called = true; return {}; };
  await pushRatings(deps);
  assert.equal(called, false);
});
