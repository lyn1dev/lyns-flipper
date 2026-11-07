// Run with: node --test scripts/sync-data.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    buildCraftRecipes,
    buildEssenceRecipes,
    buildItemNames,
    buildRequirement,
    buildUnlockMap,
    findErrors,
    findReviewReasons,
    toBazaarId,
    uniqueFusions,
} from './sync-data.mjs';

const collections = {
    collections: {
        MINING: {
            items: {
                MITHRIL_ORE: {
                    name: 'Mithril',
                    tiers: [
                        { tier: 3, amountRequired: 500, unlocks: ['Enchanted Mithril Recipe'] },
                        { tier: 4, amountRequired: 1000, unlocks: ['+4 SkyBlock XP'] },
                    ],
                },
            },
        },
    },
};
const unlocks = buildUnlockMap(collections);
const build = (items, bazaar = {}, hypixelItems = {}) => buildCraftRecipes(items, { collections, hypixelItems, bazaar });

// Two shards plus padding, so findErrors' minimum size checks pass.
function validData() {
    const shards = {};
    for (let i = 0; i < 120; i++) shards[`C${i}`] = { name: `Shard ${i}`, rarity: 'common', fuse_amount: 2, internal_id: `SHARD_${i}` };
    const crafts = {};
    for (let i = 0; i < 600; i++) crafts[`ITEM_${i}`] = { name: `Item ${i}`, count: 1, tier: 'COMMON', materials: { STICK: 2 }, requirement: null };
    const itemNames = {};
    for (let i = 0; i < 120; i++) itemNames[`ITEM_${i}`] = `Item ${i}`;
    const xp = [1, 2];
    return {
        fusion: { shards, recipes: { C0: { 2: [['C1', 'C2'], ['C3', 'C4']] } } },
        crafts,
        essence: { WOODEN_BAIT: { category: 'forest', count: 1, materials: { ESSENCE_FOREST: 100 } } },
        enchants: { enchants: {}, enchant_pools: [], enchants_xp_cost: { sharpness: [] }, max_xp_table_levels: {} },
        slayerXp: { zombie: xp, spider: xp, wolf: xp, enderman: xp, blaze: xp, vampire: xp },
        itemNames,
    };
}

test('toBazaarId converts NEU ids to Bazaar ids', () => {
    assert.equal(toBazaarId('INK_SACK-3'), 'INK_SACK:3');
    assert.equal(toBazaarId('EXPERIENCE;5'), 'ENCHANTMENT_EXPERIENCE_5');
    assert.equal(toBazaarId('ENCHANTED_DIAMOND'), 'ENCHANTED_DIAMOND');
});

test('crafts add up ingredients across slots and keep the output count', () => {
    const { HOTSPOT_BAIT } = build({ HOTSPOT_BAIT: { displayname: '§fHotspot Bait', recipe: { A1: 'CRAB:2', A2: 'CRAB:3', B1: 'INK_SACK-3:1', count: 32 } } });
    assert.deepEqual(HOTSPOT_BAIT.materials, { CRAB: 5, 'INK_SACK:3': 1 });
    assert.equal(HOTSPOT_BAIT.count, 32);
    assert.equal(HOTSPOT_BAIT.name, 'Hotspot Bait');
});

test('crafts read recipes that only exist in .recipes[], and ignore other recipe types', () => {
    const crafts = build({
        A: { displayname: 'A', recipes: [{ type: 'crafting', A1: 'STICK:1' }] },
        B: { displayname: 'B', recipes: [{ type: 'forge', inputs: ['STICK:1'] }, { type: 'npc_shop', cost: ['STICK:1'] }] },
    });
    assert.deepEqual(crafts.A.materials, { STICK: 1 });
    assert.equal(crafts.B, undefined);
});

test('crafts prefer the recipe variant you can actually buy', () => {
    const items = { CHARCOAL: { displayname: 'Charcoal', recipes: [{ type: 'crafting', A1: 'LOG-9:1' }, { type: 'crafting', A1: 'LOG:1' }] } };
    assert.deepEqual(build(items, { LOG: {} }).CHARCOAL.materials, { LOG: 1 });
    assert.deepEqual(build(items, {}).CHARCOAL.materials, { 'LOG:9': 1 });
});

test('crafts skip recipes for a different output and recipes that consume their own output', () => {
    const crafts = build({
        A: { displayname: 'A', recipes: [{ type: 'crafting', A1: 'STICK:1', overrideOutputId: 'OTHER' }] },
        B: { displayname: 'B', recipe: { A1: 'B:1', A2: 'STICK:1' } },
    });
    assert.deepEqual(crafts, {});
});

test('crafts use Hypixel rarity, treating a missing tier as common', () => {
    const crafts = build(
        {
            A: { displayname: 'A', recipe: { A1: 'STICK:1' } },
            B: { displayname: 'B', recipe: { A1: 'STICK:1' } },
            C: { displayname: 'C', lore: ['§9§lRARE'], recipe: { A1: 'STICK:1' } },
        },
        {},
        { A: { tier: 'LEGENDARY' }, B: {} },
    );
    assert.deepEqual([crafts.A.tier, crafts.B.tier, crafts.C.tier], ['LEGENDARY', 'COMMON', 'RARE']);
});

test('book names come from the enchant id', () => {
    const crafts = build({ 'ULTIMATE_WISE;5': { displayname: '§fEnchanted Book', recipe: { A1: 'STICK:1' } } });
    assert.equal(crafts.ENCHANTMENT_ULTIMATE_WISE_5.name, 'Ultimate Wise V');
});

test('pets are left out rather than treated as books', () => {
    assert.deepEqual(build({ 'BAT;0': { displayname: '§7[Lvl 1] Bat', recipe: { A1: 'STICK:1' } } }), {});
});

test('requirements prefer the Hypixel unlock list over NEU text', () => {
    const req = buildRequirement('X', 'Enchanted Mithril', { crafttext: 'Requires: Mithril IV' }, unlocks, collections);
    assert.equal(req.tier, 3);
    assert.equal(req.tier_code, 'MITHRIL_ORE_3');
    assert.equal(req.amount_required, 500);
});

test('requirements fall back to NEU text in all its spellings', () => {
    const fromText = crafttext => buildRequirement('X', 'Thing', { crafttext }, unlocks, collections);
    assert.equal(fromText('Requires: Mithril IV').tier_code, 'MITHRIL_ORE_4');
    assert.equal(fromText('Requires Mithril IV').tier_code, 'MITHRIL_ORE_4');
    assert.deepEqual(fromText('Requires: Vampire Slayer 2'), { type: 'slayer', slayer_type: 'vampire', level: 2, name: 'Vampire Slayer 2' });
    assert.equal(fromText('Blaze Slayer III').level, 3);
    assert.deepEqual(fromText('§aRequires: HotM 5'), { type: 'other', name: 'HotM 5' });
    assert.equal(fromText(''), null);
});

test('hand-written slayer requirements only apply when NEU says nothing', () => {
    assert.equal(buildRequirement('GOLDEN_TOOTH', 'Golden Tooth', { crafttext: '' }, unlocks, collections).name, 'Wolf Slayer 2');
    assert.equal(buildRequirement('GOLDEN_TOOTH', 'Golden Tooth', { crafttext: 'Requires: Wolf Slayer 3' }, unlocks, collections).level, 3);
});

test('essence recipes come from NPC shops that take essence', () => {
    const recipes = buildEssenceRecipes({
        ROSEMARY_NPC: {
            displayname: '§fRosemary (NPC)',
            recipes: [
                { type: 'npc_shop', cost: ['ESSENCE_FOREST:100'], result: 'WOODEN_BAIT:4' },
                { type: 'npc_shop', cost: ['ESSENCE_ICE:15000', 'REFINED_DIAMOND:2'], result: 'EXPERIENCE;5' },
                { type: 'npc_shop', cost: ['SKYBLOCK_COIN:100'], result: 'STICK:1' },
            ],
        },
        WOODEN_BAIT: { displayname: '§fWooden Bait' },
        'EXPERIENCE;5': { displayname: 'Enchanted Book', lore: ['Combinable in Anvil'] },
    });
    assert.deepEqual(Object.keys(recipes).sort(), ['ENCHANTMENT_EXPERIENCE_5', 'WOODEN_BAIT']);
    assert.deepEqual(recipes.WOODEN_BAIT, { name: 'Wooden Bait', category: 'forest', shop: 'Rosemary', count: 4, materials: { ESSENCE_FOREST: 100 } });
    assert.equal(recipes.ENCHANTMENT_EXPERIENCE_5.name, 'Experience V');
    assert.deepEqual(recipes.ENCHANTMENT_EXPERIENCE_5.materials, { ESSENCE_ICE: 15000, REFINED_DIAMOND: 2 });
});

test('item names prefer Hypixel and leave books to the site', () => {
    const names = buildItemNames(
        { 'INK_SACK:3': {}, STICK: {}, ENCHANTMENT_LUCK_1: {}, MYSTERY: {} },
        { STICK: { name: 'Stick' } },
        { 'INK_SACK-3': { displayname: '§fCocoa Beans' }, STICK: { displayname: 'Wrong' } },
    );
    assert.deepEqual(names, { 'INK_SACK:3': 'Cocoa Beans', STICK: 'Stick' });
});

test('uniqueFusions treats A+B and B+A as one recipe', () => {
    assert.equal(uniqueFusions({ recipes: { O: { 2: [['A', 'B'], ['B', 'A'], ['A', 'C']] } } }).size, 2);
});

test('valid data has no errors', () => {
    assert.deepEqual(findErrors(validData()), []);
});

test('broken data is rejected', () => {
    const broken = mutate => {
        const data = validData();
        mutate(data);
        return findErrors(data).length > 0;
    };
    assert.ok(broken(d => { d.fusion.shards = {}; }));
    assert.ok(broken(d => { d.fusion.shards.C5.fuse_amount = 0; }));
    assert.ok(broken(d => { d.fusion.shards.C5.internal_id = 'NOT_A_SHARD'; }));
    assert.ok(broken(d => { d.fusion.recipes.C0[2].push(['C1', 'NOPE']); }));
    assert.ok(broken(d => { d.fusion.recipes.NOPE = { 2: [] }; }));
    assert.ok(broken(d => { d.crafts = { ONLY: d.crafts.ITEM_0 }; }));
    assert.ok(broken(d => { d.crafts.ITEM_0.materials = {}; }));
    assert.ok(broken(d => { d.crafts.ITEM_0.materials.STICK = NaN; }));
    assert.ok(broken(d => { d.essence = {}; }));
    assert.ok(broken(d => { d.enchants = {}; }));
    assert.ok(broken(d => { delete d.slayerXp.vampire; }));
    assert.ok(broken(d => { d.itemNames = {}; }));
});

test('text that could inject HTML is rejected anywhere in the data', () => {
    const rejected = mutate => {
        const data = validData();
        mutate(data);
        return findErrors(data).some(e => e.includes('unsafe'));
    };
    assert.ok(rejected(d => { d.crafts.ITEM_0.name = '<img src=x onerror=alert(1)>'; }));
    assert.ok(rejected(d => { d.crafts.ITEM_0.requirement = { type: 'other', name: '<script>' }; }));
    assert.ok(rejected(d => { d.essence.WOODEN_BAIT.shop = '`evil`'; }));
    assert.ok(rejected(d => { d.itemNames['<b>'] = 'Key'; }));
    assert.ok(rejected(d => { d.itemNames['"key'] = 'Key'; }));
    assert.ok(!rejected(d => { d.crafts.ITEM_0.name = "Bachelor's Rose & InfiniPot™ (Rift)"; }));
    assert.ok(!rejected(d => { d.crafts.ITEM_0.name = '"Fragranced" Brown Mushroom "Paste"'; }));
});

test('values that go into HTML attributes must match a strict format', () => {
    const broken = mutate => {
        const data = validData();
        mutate(data);
        return findErrors(data).length > 0;
    };
    assert.ok(broken(d => { d.fusion.shards.C5.rarity = 'x" onclick="alert(1)'; }));
    assert.ok(broken(d => { d.fusion.shards['C5" onerror="x'] = d.fusion.shards.C5; }));
    assert.ok(broken(d => { d.crafts.ITEM_0.tier = 'RARE" onclick="x'; }));
    assert.ok(broken(d => { d.essence.WOODEN_BAIT.category = 'forest" onclick="x'; }));
});

test('dropping duplicate A+B / B+A fusions does not need review', () => {
    const previous = { fusion: { shards: { A: { name: 'A' }, B: { name: 'B' }, O: { name: 'O' } }, recipes: { O: { 1: [['A', 'B'], ['B', 'A']] } } } };
    const next = { fusion: { shards: previous.fusion.shards, recipes: { O: { 1: [['A', 'B']] } } } };
    assert.deepEqual(findReviewReasons(previous, next), []);
});

test('suspicious changes need review', () => {
    const shard = fuse_amount => ({ name: 'S', fuse_amount });
    const hasReason = (previous, next, text) => findReviewReasons(previous, next).some(r => r.includes(text));

    const manyFusions = { shards: { O: shard(2), A: shard(2) }, recipes: { O: { 1: Array.from({ length: 20 }, (_, i) => ['A', `I${i}`]) } } };
    const fewFusions = { shards: manyFusions.shards, recipes: { O: { 1: manyFusions.recipes.O[1].slice(0, 17) } } };
    assert.ok(hasReason({ fusion: manyFusions }, { fusion: fewFusions }, 'fusions would disappear'));
    assert.deepEqual(findReviewReasons({ fusion: manyFusions }, { fusion: { shards: manyFusions.shards, recipes: { O: { 1: manyFusions.recipes.O[1].slice(0, 19) } } } }), []);

    assert.ok(hasReason({ fusion: { shards: { A: shard(2), B: shard(2) }, recipes: {} } }, { fusion: { shards: { A: shard(2) }, recipes: {} } }, 'shards removed'));

    const shards = n => Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`S${i}`, shard(i < n ? 5 : 2)]));
    assert.ok(hasReason({ fusion: { shards: shards(0), recipes: {} } }, { fusion: { shards: shards(11), recipes: {} } }, 'fuse amount'));
    assert.deepEqual(findReviewReasons({ fusion: { shards: shards(0), recipes: {} } }, { fusion: { shards: shards(2), recipes: {} } }), []);

    const crafts = (n, stick = 1) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`I${i}`, { count: 1, materials: { STICK: stick } }]));
    assert.ok(hasReason({ crafts: crafts(100) }, { crafts: crafts(90) }, 'would disappear'));
    assert.ok(hasReason({ crafts: crafts(100) }, { crafts: crafts(100, 2) }, 'changed ingredients'));
    assert.deepEqual(findReviewReasons({ crafts: crafts(100) }, { crafts: crafts(98) }), []);
    assert.ok(hasReason({ enchants: { enchants_xp_cost: { a: 1, b: 1 } } }, { enchants: { enchants_xp_cost: { a: 1 } } }, 'enchants would disappear'));
    assert.ok(hasReason({ essence: { a: {}, b: {} } }, { essence: { a: {} } }, 'essence'));
});
