// Committed coverage for the pure bundle→ingest-wire transform in sync.mjs (transformForIngest + resolveDocKey).
//
// Uses Node's built-in test runner (`node --test`) — zero new dependencies, matching sync.mjs's own
// "Node built-ins only, no @actions/* install" ethos. sync.mjs guards its main() behind an entrypoint check,
// so importing it here is side-effect-free (main() does NOT run).
//
// Run:  node --test __tests__/transform.test.mjs   (from the repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { transformForIngest, resolveDocKey, DOCUMENTATION_KEY_PREFIX } from '../sync.mjs';

test('wire.manifest is the JSON-stringified external manifest, passed through verbatim (not mutated)', () => {
  const manifest = {
    schemaVersion: '1.0.0',
    applications: [
      // documentation:{file} object stays IN the manifest — ingest handles it; the Action does NOT mutate.
      { id: 'orders', name: 'Orders', description: 'Short.', documentation: { file: './docs/orders.md' } },
    ],
    dependencies: [{ from: 'orders-api', to: 'orders-db', type: 'readsWrites' }],
  };
  const bundle = { manifest, docs: {}, hashes: {} };

  const wire = transformForIngest(bundle, 'acme/orders', 'sha-abc');

  // (a) manifest is a STRING, and it round-trips to the ORIGINAL object (verbatim — the {file} object survives).
  assert.equal(typeof wire.manifest, 'string');
  assert.deepEqual(JSON.parse(wire.manifest), manifest);
  // The source object was not mutated in place.
  assert.deepEqual(bundle.manifest, manifest);
});

test('documentation docs are re-keyed by technicalName ?? id — the id-fallback path keys under the prefixed id', () => {
  // An entity with an `id` but NO `technicalName`: the golden example always sets both, so this exercises the
  // id-fallback branch the golden round-trip does NOT cover. documentation is the ONLY re-keyed field now.
  const bundle = {
    manifest: {
      applications: [
        { id: 'orders', name: 'Orders', documentation: { file: './docs/orders.md' } },
      ],
    },
    docs: { 'docs/orders.md': '# Orders\nThe orders platform.' },
    hashes: { docs: { 'docs/orders.md': 'deadbeef' } },
  };

  const wire = transformForIngest(bundle, 'acme/orders', 'sha-abc');

  // Doc content re-keyed under the "documentation:"-prefixed entity id (technicalName absent → id fallback).
  assert.equal(wire.docs[`${DOCUMENTATION_KEY_PREFIX}orders`], '# Orders\nThe orders platform.');
  assert.equal(wire.hashes[`${DOCUMENTATION_KEY_PREFIX}orders`], 'deadbeef');
  // Nothing keyed under the repo path or the bare technicalName anymore.
  assert.equal(wire.docs['docs/orders.md'], undefined);
  assert.equal(wire.docs.orders, undefined);
});

test('explicit technicalName wins over id when re-keying documentation content', () => {
  const bundle = {
    manifest: {
      components: [
        { id: 'friendly', technicalName: 'orders-api', name: 'API', documentation: { file: './README.md' } },
      ],
    },
    docs: { 'orders-api/README.md': 'API docs' },
    hashes: { docs: { 'orders-api/README.md': 'cafe' } },
  };

  const wire = transformForIngest(bundle, 'acme/orders', 'sha');

  assert.equal(wire.docs[`${DOCUMENTATION_KEY_PREFIX}orders-api`], 'API docs');
  assert.equal(wire.docs[`${DOCUMENTATION_KEY_PREFIX}friendly`], undefined);
});

test('a description string is NOT re-keyed (description carries no file ref)', () => {
  // description is inline string only — even if a stray {file} object slipped in, the Action must NOT
  // re-key it (only documentation is re-keyed). An inline-string description produces no doc entry at all.
  const bundle = {
    manifest: {
      applications: [
        { id: 'orders', name: 'Orders', description: 'Short inline summary.' },
      ],
    },
    docs: { 'docs/orders.md': 'unused' },
    hashes: { docs: { 'docs/orders.md': 'h' } },
  };

  const wire = transformForIngest(bundle, 'acme/orders', 'sha');

  assert.equal(wire.docs.orders, undefined);
  assert.equal(wire.docs[`${DOCUMENTATION_KEY_PREFIX}orders`], undefined);
  assert.deepEqual(wire.docs, {});
});

test('repo / releaseSha / hashes are preserved', () => {
  const bundle = {
    manifest: {
      applications: [{ id: 'orders', name: 'Orders', documentation: { file: './docs/orders.md' } }],
    },
    docs: { 'docs/orders.md': 'content' },
    hashes: { docs: { 'docs/orders.md': 'h1' } },
  };

  const wire = transformForIngest(bundle, 'acme/orders', 'sha-xyz');

  assert.equal(wire.repo, 'acme/orders');
  assert.equal(wire.releaseSha, 'sha-xyz');
  assert.equal(wire.hashes[`${DOCUMENTATION_KEY_PREFIX}orders`], 'h1'); // hash re-keyed + preserved
});

test('a missing bundle.manifest degrades to an empty manifest string, never a throw', () => {
  const wire = transformForIngest({}, 'r', 's');
  assert.equal(wire.manifest, '{}');
  assert.deepEqual(wire.docs, {});
  assert.deepEqual(wire.hashes, {});
});

test('resolveDocKey matches a repo-path doc by basename tail', () => {
  const byPath = { 'nested/dir/orders.md': 'x' };
  assert.equal(resolveDocKey(byPath, { file: '../orders.md' }), 'nested/dir/orders.md');
});

test('documentation: {file} is re-keyed under the "documentation:"-prefixed key; a short inline description is NOT re-keyed', () => {
  // An entity carries a short inline description (string) + a documentation:{file} ref. Only the
  // documentation ref folds (under the prefixed key); the inline description produces NO doc entry.
  const bundle = {
    manifest: {
      applications: [
        {
          technicalName: 'orders',
          name: 'Orders',
          description: 'Short inline summary.',
          documentation: { file: './docs/orders-guide.md' },
        },
      ],
    },
    docs: {
      'docs/orders-guide.md': '# Orders Guide (long-form)',
    },
    hashes: { docs: { 'docs/orders-guide.md': 'h-doc' } },
  };

  const wire = transformForIngest(bundle, 'acme/orders', 'sha');

  // documentation under the prefixed key; nothing under the bare technicalName (description does not fold).
  assert.equal(wire.docs.orders, undefined);
  assert.equal(wire.docs[`${DOCUMENTATION_KEY_PREFIX}orders`], '# Orders Guide (long-form)');
  assert.equal(wire.hashes.orders, undefined);
  assert.equal(wire.hashes[`${DOCUMENTATION_KEY_PREFIX}orders`], 'h-doc');
});

test('documentation: {file} on a component re-keys under the prefixed key too', () => {
  const bundle = {
    manifest: {
      components: [
        { technicalName: 'orders-api', name: 'API', application: 'orders', documentation: { file: './GUIDE.md' } },
      ],
    },
    docs: { 'orders-api/GUIDE.md': 'component guide' },
    hashes: { docs: {} },
  };

  const wire = transformForIngest(bundle, 'acme/orders', 'sha');

  assert.equal(wire.docs[`${DOCUMENTATION_KEY_PREFIX}orders-api`], 'component guide');
  // description was not present → no bare-key entry.
  assert.equal(wire.docs['orders-api'], undefined);
});

test('documentation is NOT re-keyed for collections without a Documentation column (capabilities)', () => {
  // Capabilities have no Documentation column server-side — the Action must not emit a documentation doc for them.
  const bundle = {
    manifest: {
      capabilities: [
        { technicalName: 'order-capture', name: 'Order Capture', documentation: { file: './cap.md' } },
      ],
    },
    docs: { 'cap.md': 'ignored' },
    hashes: { docs: {} },
  };

  const wire = transformForIngest(bundle, 'acme/orders', 'sha');

  assert.equal(wire.docs[`${DOCUMENTATION_KEY_PREFIX}order-capture`], undefined);
  assert.equal(wire.docs['order-capture'], undefined);
});
