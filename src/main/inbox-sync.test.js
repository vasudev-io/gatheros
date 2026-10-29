const test = require('node:test');
const assert = require('node:assert/strict');
const { syncInbox } = require('./inbox-sync');

test('sync is a no-op when inbox is off or signed out', async () => {
  const off = await syncInbox({ isEnabled: () => false, hasSession: () => true });
  assert.equal(off.skipped, 'disabled');
  const signedOut = await syncInbox({ isEnabled: () => true, hasSession: () => false });
  assert.equal(signedOut.skipped, 'signed_out');
});

test('sync publishes collection names, pages, and stops when blocked', async () => {
  const imported = [];
  let published = null;
  const pages = [
    { items: [{ id: 'a' }, { id: 'b' }], next_cursor: 'c2', pending_count: 3 },
    { items: [{ id: 'c' }], next_cursor: null, pending_count: 1 },
  ];
  const result = await syncInbox({
    isEnabled: () => true,
    hasSession: () => true,
    listCatalog: () => [
      { id: 'col', name: 'Type', kind: 'collection', save_count: 99 },
      { id: 'board', name: 'Wall', kind: 'board' },
    ],
    api: {
      putCollections: async (rows) => { published = rows; },
      listPending: async (cursor) => pages[cursor ? 1 : 0],
      status: async () => ({ pending_count: 0 }),
    },
    importItem: async (item) => {
      imported.push(item.id);
      if (item.id === 'b') return { action: 'blocked' };
      return { action: 'imported' };
    },
  });
  assert.deepEqual(published, [
    { id: 'col', name: 'Type', kind: 'collection' },
    { id: 'board', name: 'Wall', kind: 'board' },
  ]);
  assert.equal(JSON.stringify(published).includes('save_count'), false);
  assert.deepEqual(imported, ['a', 'b']);
  assert.equal(result.blocked, true);
  assert.equal(result.imported, 1);
});

test('a finished sync reports the server pending count', async () => {
  const result = await syncInbox({
    isEnabled: () => true,
    hasSession: () => true,
    listCatalog: () => [],
    api: {
      putCollections: async () => {},
      listPending: async () => ({ items: [{ id: 'a' }], next_cursor: null, pending_count: 1 }),
      status: async () => ({ pending_count: 0 }),
    },
    importItem: async () => ({ action: 'duplicate' }),
  });
  assert.equal(result.duplicate, 1);
  assert.equal(result.pending, 0);
  assert.equal(result.blocked, false);
});
