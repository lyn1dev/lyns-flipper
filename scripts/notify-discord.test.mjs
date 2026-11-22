import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMessage, diffFusions } from './notify-discord.mjs';

const shards = {
    A: { name: 'Grove' }, B: { name: 'Bezal' }, C: { name: 'Sun Fish' }, D: { name: 'Galaxy Fish' },
};
const before = { shards: { A: shards.A, B: shards.B, C: shards.C }, recipes: { C: { 2: [['A', 'B']] } } };

test('no added recipes means nothing to send', () => {
    const swapped = { shards: before.shards, recipes: { C: { 2: [['B', 'A']] } } };
    const diff = diffFusions(before, swapped);
    assert.equal(diff.total, 0);
    assert.deepEqual(diff.newShards, []);
});

test('finds new shards and new recipes grouped by output', () => {
    const after = { shards, recipes: { C: { 2: [['A', 'B'], ['A', 'D']] }, D: { 1: [['A', 'C'], ['B', 'C']] } } };
    const diff = diffFusions(before, after);
    assert.deepEqual(diff.newShards, ['D']);
    assert.equal(diff.total, 3);
    assert.deepEqual(diff.added.map(g => [g.output, g.pairs.length]), [['D', 2], ['C', 1]]);
});

test('message names shards and marks reviews', () => {
    const after = { shards, recipes: { C: { 2: [['A', 'B']] }, D: { 1: [['A', 'C']] } } };
    const live = buildMessage(diffFusions(before, after), shards, { status: 'publish' });
    assert.match(live.embeds[0].title, /^1 new shard recipe$/);
    assert.match(live.embeds[0].description, /New shards:\*\* Galaxy Fish/);
    assert.match(live.embeds[0].description, /\*\*Galaxy Fish\*\* x1: Grove \+ Sun Fish/);
    const held = buildMessage(diffFusions(before, after), shards, { status: 'review' });
    assert.match(held.embeds[0].title, /held for review/);
});

test('long messages stay under the Discord limit', () => {
    const many = { shards: { ...shards }, recipes: {} };
    for (let i = 0; i < 200; i++) {
        many.shards[`X${i}`] = { name: `Shard ${'x'.repeat(200)} ${i}` };
        many.recipes[`X${i}`] = { 1: [['A', 'B'], ['A', 'C'], ['B', 'C'], ['A', 'A']] };
    }
    const msg = buildMessage(diffFusions(before, many), many.shards);
    assert.ok(msg.embeds[0].description.length <= 4096);
});
