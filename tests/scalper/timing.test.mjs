import test from 'node:test';
import assert from 'node:assert/strict';
import { abortableDelay } from '../../src/scalper/timing.mjs';

test('abortable delay rejects immediately when active polling is stopped', async () => {
  const controller = new AbortController();
  const pending = abortableDelay(60_000, { signal: controller.signal });
  controller.abort(new Error('shutdown'));
  await assert.rejects(pending, /shutdown/);
});
