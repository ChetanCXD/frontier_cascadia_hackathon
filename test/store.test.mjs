import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonSessionStore } from '../src/domain/store.mjs';

const url = 'https://example.com/report?utm_source=test';

test('session store persists partial structured state and canonicalizes source updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claimlens-store-'));
  try {
    const store = await new JsonSessionStore(root).init();
    const state = await store.create('Does the fixture work?');
    await store.appendEvent(state.session.id, { type: 'stage.started', actor: 'planner', payload: { message: 'Planning' } });
    await store.upsertSource(state.session.id, { id: randomUUID(), url, title: 'Fixture', publisher: 'Example', sourceType: 'official' });
    await store.upsertSource(state.session.id, { id: randomUUID(), url: 'https://EXAMPLE.com/report#section', title: 'Fixture updated', publisher: 'Example', sourceType: 'official' });
    const loaded = await store.load(state.session.id);
    assert.equal(loaded.events.length, 1);
    assert.equal(loaded.sources.length, 1);
    assert.equal(loaded.sources[0].canonicalUrl, 'https://example.com/report');
    assert.equal(loaded.sources[0].title, 'Fixture updated');
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
