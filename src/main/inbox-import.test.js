const test = require('node:test');
const assert = require('node:assert/strict');
const { importInboxItem, pickTarget, tagsForItem } = require('./inbox-import');
const { createBudget } = require('./inbox-organize');

function memoryDeps(overrides = {}) {
  const receipts = new Map();
  const acks = [];
  const deps = {
    receipts,
    acks,
    saves: [],
    tags: [],
    placed: [],
    created: [],
    duplicates: [],
    getReceipt: (id) => receipts.get(id) || null,
    saveReceipt: (row) => receipts.set(row.item_id, { ...row }),
    ack: async (item, body) => { acks.push({ id: item.id, ...body }); },
    canCreateSave: () => true,
    fetchAsset: async () => Buffer.from('png-bytes'),
    saveImageFromBuffer: async () => ({
      id: 'save-1',
      filePath: '/tmp/save-1.webp',
      thumbPath: '/tmp/save-1.jpg',
      width: 10,
      height: 10,
      fileSize: 20,
      palette: ['#fff'],
      contentHash: 'abc',
    }),
    saveImageFromUrl: async () => { throw new Error('unexpected url'); },
    captureUrl: async () => { throw new Error('unexpected capture'); },
    listCollections: () => [{ id: 'col-inbox', name: 'Inbox' }],
    listBoards: () => [{ id: 'board-1', name: 'Wall' }],
    getDefaultTarget: () => null,
    createCollection: ({ name }) => ({ id: 'col-new', name }),
    getSave: (id) => ({ id, notes: '', file_path: '/tmp/old.webp', width: 4, height: 4 }),
    updateSave: () => {},
    insertSave: (fields) => {
      deps.saves.push(fields);
      return { id: fields.id, file_path: fields.filePath, width: fields.width, height: fields.height };
    },
    addTagToSave: ({ saveId, name }) => deps.tags.push({ saveId, name }),
    place: (target, record) => deps.placed.push({ target, id: record.id }),
    onSaveCreated: (record) => deps.created.push(record.id),
    onDuplicate: (existing) => deps.duplicates.push(existing.id),
    maxBytes: 1000,
    ...overrides,
  };
  return deps;
}

const item = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'image',
  title: 'Ramp home',
  note: 'One input, three chips.',
  source_name: 'mobbin',
  source_url: 'https://mobbin.com/screens/ramp',
  tags: ['Empty-State'],
  has_asset: true,
  mime: 'image/png',
  token_label: 'assistant',
  received_at: 10,
};

test('tags include the inbox marker and the source', () => {
  assert.deepEqual(tagsForItem(item), ['empty-state', 'inbox', 'src:mobbin']);
});

test('pickTarget prefers the item, then settings, then Inbox', () => {
  const collections = [{ id: 'c1', name: 'Inbox' }, { id: 'c2', name: 'Type' }];
  const boards = [{ id: 'b1', name: 'Wall' }];
  assert.deepEqual(
    pickTarget({ item: { collection_id: 'b1', collection_kind: 'board' }, collections, boards, defaultTarget: { id: 'c2', kind: 'collection' } }),
    { kind: 'board', id: 'b1' },
  );
  assert.deepEqual(
    pickTarget({ item: {}, collections, boards, defaultTarget: { id: 'c2', kind: 'collection' } }),
    { kind: 'collection', id: 'c2' },
  );
  assert.deepEqual(
    pickTarget({ item: { collection_id: 'missing' }, collections, boards, defaultTarget: null }),
    { kind: 'collection', id: 'c1' },
  );
  assert.deepEqual(
    pickTarget({ item: {}, collections: [], boards: [], defaultTarget: null }),
    { createInbox: true },
  );
});

test('pickTarget uses collection_name when there is no valid collection_id', () => {
  const collections = [{ id: 'c1', name: 'Inbox' }, { id: 'c2', name: 'Type' }];
  const boards = [{ id: 'b1', name: 'Wall' }];
  assert.deepEqual(
    pickTarget({ item: { collection_id: 'b1', collection_kind: 'board', collection_name: 'Type' }, collections, boards, defaultTarget: null }),
    { kind: 'board', id: 'b1' },
  );
  assert.deepEqual(
    pickTarget({ item: { collection_name: ' TYPE ' }, collections, boards, defaultTarget: null }),
    { kind: 'collection', id: 'c2' },
  );
  assert.deepEqual(
    pickTarget({ item: { collection_name: 'wall' }, collections, boards, defaultTarget: null }),
    { kind: 'board', id: 'b1' },
  );
  assert.deepEqual(
    pickTarget({ item: { collection_name: 'Empty states' }, collections, boards, defaultTarget: null }),
    { createName: 'Empty states' },
  );
});

test('the same new collection_name in one pull creates one collection, then the budget falls back', async () => {
  const rows = [{ id: 'col-inbox', name: 'Inbox' }];
  const made = [];
  const deps = memoryDeps({
    listCollections: () => rows,
    createCollection: ({ name }) => {
      const row = { id: `col-${rows.length}`, name };
      rows.push(row);
      made.push(name);
      return row;
    },
    budget: createBudget(1),
  });
  let n = 0;
  deps.saveImageFromBuffer = async () => ({ id: `save-${++n}`, filePath: '/tmp/x.webp', thumbPath: '/tmp/x.jpg', width: 1, height: 1, fileSize: 1, palette: [], contentHash: `h${n}` });
  await importInboxItem({ ...item, id: '33333333-3333-4333-8333-333333333331', collection_name: 'Charts' }, deps);
  await importInboxItem({ ...item, id: '33333333-3333-4333-8333-333333333332', collection_name: 'charts' }, deps);
  await importInboxItem({ ...item, id: '33333333-3333-4333-8333-333333333333', collection_name: 'Maps' }, deps);
  assert.deepEqual(made, ['Charts']);
  assert.deepEqual(deps.placed.map((p) => p.target), [
    { kind: 'collection', id: 'col-1' },
    { kind: 'collection', id: 'col-1' },
    { kind: 'collection', id: 'col-inbox' },
  ]);
});

test('an asset import writes a save, tags, collection, and ack', async () => {
  const deps = memoryDeps();
  const result = await importInboxItem(item, deps);
  assert.equal(result.action, 'imported');
  assert.equal(deps.saves.length, 1);
  assert.equal(deps.saves[0].source, 'inbox');
  assert.equal(deps.saves[0].title, 'Ramp home');
  assert.equal(deps.saves[0].notes, 'One input, three chips.');
  assert.equal(deps.saves[0].contentHash, 'abc');
  assert.deepEqual(deps.saves[0].meta.inbox, {
    item_id: item.id,
    source_name: 'mobbin',
    sender: 'assistant',
  });
  assert.deepEqual(deps.tags.map((t) => t.name), ['empty-state', 'inbox', 'src:mobbin']);
  assert.equal(deps.placed[0].target.id, 'col-inbox');
  assert.deepEqual(deps.created, ['save-1']);
  assert.equal(deps.acks[0].result, 'imported');
  assert.equal(deps.acks[0].saveId, 'save-1');
});

test('duplicate bytes join Inbox and keep an empty note', async () => {
  const notes = [];
  const deps = memoryDeps({
    saveImageFromBuffer: async () => ({ duplicateOf: 'old-1', existing: { id: 'old-1', notes: '' } }),
    updateSave: (patch) => notes.push(patch),
  });
  const result = await importInboxItem(item, deps);
  assert.equal(result.action, 'duplicate');
  assert.equal(deps.saves.length, 0);
  assert.deepEqual(notes, [{ id: 'old-1', notes: item.note }]);
  assert.equal(deps.placed[0].id, 'old-1');
  assert.deepEqual(deps.duplicates, ['old-1']);
  assert.equal(deps.acks[0].result, 'duplicate');
  assert.deepEqual(deps.created, []);
});

test('a lost ack is resent without importing again', async () => {
  let fetched = 0;
  const deps = memoryDeps({
    fetchAsset: async () => { fetched += 1; return Buffer.from('x'); },
  });
  deps.receipts.set(item.id, {
    item_id: item.id,
    save_id: 'save-1',
    result: 'imported',
    attempts: 1,
    acked_at: null,
  });
  const result = await importInboxItem(item, deps);
  assert.equal(result.replay, true);
  assert.equal(fetched, 0);
  assert.equal(deps.acks.length, 1);
  assert.equal(deps.acks[0].result, 'imported');
  assert.ok(deps.receipts.get(item.id).acked_at);
});

test('a page url is captured and a blocked account stays pending', async () => {
  const deps = memoryDeps({
    captureUrl: async () => ({
      id: 'url-1',
      filePath: '/tmp/url.webp',
      thumbPath: '/tmp/url.jpg',
      width: 100,
      height: 80,
      fileSize: 50,
      contentHash: 'def',
      title: 'Page title',
    }),
  });
  const page = { ...item, has_asset: false, image_url: null, kind: 'url', title: null };
  const saved = await importInboxItem(page, deps);
  assert.equal(saved.action, 'imported');
  assert.equal(deps.saves[0].kind, 'url');
  assert.equal(deps.saves[0].title, 'Page title');

  const blocked = memoryDeps({ canCreateSave: () => false });
  const held = await importInboxItem(item, blocked);
  assert.equal(held.action, 'blocked');
  assert.equal(blocked.acks.length, 0);
});

test('the third local failure is acked failed and earlier ones stay pending', async () => {
  const deps = memoryDeps({
    saveImageFromBuffer: async () => { throw new Error('sharp exploded'); },
  });
  const first = await importInboxItem(item, deps);
  assert.equal(first.action, 'retry');
  assert.equal(deps.acks.length, 0);
  const second = await importInboxItem(item, deps);
  assert.equal(second.action, 'retry');
  const third = await importInboxItem(item, deps);
  assert.equal(third.action, 'failed');
  assert.equal(deps.acks.length, 1);
  assert.equal(deps.acks[0].result, 'failed');
  assert.match(deps.acks[0].error, /sharp exploded/);
});
