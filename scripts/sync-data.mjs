#!/usr/bin/env node
// Rebuilds the site's static game data from its upstream sources, checks it, and
// decides whether it is safe to publish. See "data sources" in the README.
//
//   node scripts/sync-data.mjs             write the data files
//   node scripts/sync-data.mjs --dry-run   build and validate only, write nothing
//   node scripts/sync-data.mjs --report <file>   also write a summary to <file>
//
// Status (also written to $GITHUB_OUTPUT): publish, review (safe to look at, but
// suspicious enough that a human should approve it) or skip. Exits 1 if the data is
// broken, which leaves the last good files in place.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEU_REPO = 'https://github.com/NotEnoughUpdates/NotEnoughUpdates-REPO';
const PARSER_REPO = 'https://github.com/Campionnn/SkyShards-Parser';
const ICONS_URL = 'https://raw.githubusercontent.com/Campionnn/SkyShards/master/public/shardIcons';
const HYPIXEL_API = 'https://api.hypixel.net/v2';

// How much may disappear in one sync before a human has to approve it.
const MAX_FUSION_LOSS = 0.1;
const MAX_CRAFT_LOSS = 0.05;
const MAX_CRAFT_CHANGED = 0.05;
const MAX_ESSENCE_LOSS = 0.25;
const MAX_ENCHANT_LOSS = 0.05;
const MAX_FUSE_AMOUNT_CHANGES = 10;
// Publish at least this often even with no changes, so the site can tell that
// syncing is still alive and GitHub doesn't pause the schedule for inactivity.
const HEARTBEAT_HOURS = 23;

const SLOTS = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3'];
const SLAYER_TYPES = { Zombie: 'zombie', Spider: 'spider', Wolf: 'wolf', Enderman: 'enderman', Blaze: 'blaze', Vampire: 'vampire' };
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };
// Slayer unlocks that no source publishes. Only used when NEU says nothing about the item.
const SLAYER_FALLBACKS = {
    GOLDEN_TOOTH: ['wolf', 2],
    MASTIFF_BOOTS: ['wolf', 4],
    MASTIFF_CHESTPLATE: ['wolf', 4],
    MASTIFF_HELMET: ['wolf', 4],
    MASTIFF_LEGGINGS: ['wolf', 4],
    NULL_OVOID: ['enderman', 3],
    REAPER_SCYTHE: ['zombie', 7],
    REVENANT_VISCERA: ['zombie', 2],
    SOULFLOW_ENGINE: ['enderman', 4],
    TARANTULA_BOOTS: ['spider', 4],
    TARANTULA_SILK: ['spider', 2],
};

const stripColor = s => String(s || '').replace(/§./g, '').trim();
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);
const romanOf = n => Object.keys(ROMAN).find(k => ROMAN[k] === n) || String(n);
const stable = v => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : x));

/** NEU writes "INK_SACK-3" and "EXPERIENCE;5" where the Bazaar says "INK_SACK:3" and "ENCHANTMENT_EXPERIENCE_5". */
export function toBazaarId(neuId) {
    const enchant = neuId.match(/^(.+);(\d+)$/);
    if (enchant) return `ENCHANTMENT_${enchant[1]}_${enchant[2]}`;
    return neuId.replace(/-(\d+)$/, ':$1');
}

/** Every book's display name is just "Enchanted Book", so spell the enchant out from its id instead. */
function itemName(neuId, item) {
    const displayName = stripColor(item?.displayname);
    const book = neuId.match(/^(.+);(\d+)$/);
    if (!book || displayName !== 'Enchanted Book') return displayName;
    const words = book[1].split('_').map(w => capitalize(w.toLowerCase())).join(' ');
    return `${words} ${romanOf(parseInt(book[2], 10))}`;
}

function parseIngredient(entry) {
    const i = entry.lastIndexOf(':');
    return i < 0 ? [toBazaarId(entry), 1] : [toBazaarId(entry.slice(0, i)), parseFloat(entry.slice(i + 1))];
}

function gridMaterials(recipe) {
    const materials = {};
    for (const slot of SLOTS) {
        if (!recipe[slot]) continue;
        const [id, qty] = parseIngredient(recipe[slot]);
        materials[id] = (materials[id] || 0) + qty;
    }
    return materials;
}

/** Every crafting grid NEU lists for an item. Recipes can be in .recipe, .recipes[], or both. */
function craftingVariants(neuId, item) {
    const grids = [...(item.recipe ? [item.recipe] : []), ...(item.recipes || []).filter(r => r.type === 'crafting' || !r.type)];
    const id = toBazaarId(neuId);
    return grids
        .filter(r => !r.overrideOutputId || r.overrideOutputId === neuId)
        .map(r => ({ materials: gridMaterials(r), count: r.count || 1 }))
        .filter(v => Object.keys(v.materials).length && !v.materials[id]);
}

/** Collection unlocks by lowercased item name, from Hypixel's own "<Item> Recipe" unlock text. */
export function buildUnlockMap(collections) {
    const unlocks = {};
    for (const category of Object.values(collections.collections)) {
        for (const [collectionId, entry] of Object.entries(category.items)) {
            for (const tier of entry.tiers) {
                for (const text of tier.unlocks || []) {
                    if (!/Recipes?$/i.test(text)) continue;
                    unlocks[text.replace(/\s+Recipes?$/i, '').trim().toLowerCase()] ??= collectionRequirement(collectionId, entry, tier);
                }
            }
        }
    }
    return unlocks;
}

function collectionRequirement(collectionId, entry, tier) {
    return {
        type: 'collection',
        collection_id: collectionId,
        collection_name: entry.name,
        tier: tier.tier,
        tier_code: `${collectionId}_${tier.tier}`,
        amount_required: tier.amountRequired,
    };
}

function slayerRequirement(type, level) {
    return { type: 'slayer', slayer_type: type, level, name: `${capitalize(type)} Slayer ${level}` };
}

/** Hypixel's unlock list wins, because NEU's "Requires:" text is often a tier off. */
export function buildRequirement(id, name, item, unlocks, collections) {
    const official = unlocks[name.toLowerCase()];
    if (official) return official;

    const text = stripColor(item.crafttext).replace(/^Requires:?\s*/, '');
    const slayer = text.match(/^(\w+) Slayer (\d+|[IVX]+)$/);
    if (slayer && SLAYER_TYPES[slayer[1]]) return slayerRequirement(SLAYER_TYPES[slayer[1]], ROMAN[slayer[2]] || parseInt(slayer[2], 10));

    const tiered = text.match(/^(.+?) ([IVX]+)$/);
    if (tiered && ROMAN[tiered[2]]) {
        for (const category of Object.values(collections.collections)) {
            for (const [collectionId, entry] of Object.entries(category.items)) {
                const tier = entry.tiers.find(t => t.tier === ROMAN[tiered[2]]);
                if (entry.name === tiered[1] && tier) return collectionRequirement(collectionId, entry, tier);
            }
        }
    }

    if (text) return { type: 'other', name: text };
    if (SLAYER_FALLBACKS[id]) return slayerRequirement(...SLAYER_FALLBACKS[id]);
    return null;
}

/** Hypixel leaves the tier off common items, and doesn't list some vanilla ones at all. */
function itemTier(id, item, hypixelItems) {
    if (hypixelItems[id]) return hypixelItems[id].tier || 'COMMON';
    const lastLore = stripColor((item.lore || []).at(-1));
    const match = lastLore.match(/^(?:a )?(VERY SPECIAL|SPECIAL|SUPREME|DIVINE|MYTHIC|LEGENDARY|EPIC|RARE|UNCOMMON|COMMON)\b/);
    return match ? match[1].replace(' ', '_') : 'COMMON';
}

export function buildCraftRecipes(neuItems, { collections, hypixelItems, bazaar }) {
    const unlocks = buildUnlockMap(collections);
    const crafts = {};
    for (const neuId of Object.keys(neuItems).sort()) {
        const item = neuItems[neuId];
        // "NAME;n" is either a book or a pet. Pets never reach the Bazaar and their ids could clash with a book's.
        if (neuId.includes(';') && stripColor(item.displayname) !== 'Enchanted Book') continue;
        const variants = craftingVariants(neuId, item);
        if (!variants.length) continue;
        // Wood types and the like give several valid recipes. Prefer one you can buy all of.
        const chosen = variants.find(v => Object.keys(v.materials).every(m => bazaar[m])) || variants[0];
        const id = toBazaarId(neuId);
        const name = itemName(neuId, item);
        crafts[id] = {
            item_id: id,
            name,
            count: chosen.count,
            tier: itemTier(id, item, hypixelItems),
            materials: chosen.materials,
            requirement: buildRequirement(neuId, name, item, unlocks, collections),
        };
    }
    return crafts;
}

/** What essence buys, from the NPC shop listings in NEU. */
export function buildEssenceRecipes(neuItems) {
    const recipes = {};
    for (const npcId of Object.keys(neuItems).sort()) {
        const npc = neuItems[npcId];
        for (const row of npc.recipes || []) {
            if (row.type !== 'npc_shop' || !(row.cost || []).some(c => c.startsWith('ESSENCE_'))) continue;
            const [neuOutput, count] = String(row.result || '').split(':');
            if (!neuOutput) continue;
            const id = toBazaarId(neuOutput);
            if (recipes[id]) continue;
            const essence = row.cost.find(c => c.startsWith('ESSENCE_')).split(':')[0];
            recipes[id] = {
                name: itemName(neuOutput, neuItems[neuOutput]) || id,
                category: essence.replace('ESSENCE_', '').toLowerCase(),
                shop: stripColor(npc.displayname).replace(/\s*\((Rift )?NPC\)$/, ''),
                count: parseInt(count, 10) || 1,
                materials: Object.fromEntries(row.cost.map(parseIngredient)),
            };
        }
    }
    return recipes;
}

/** Real names for Bazaar products, so "INK_SACK:3" shows as Cocoa Beans. Books keep the site's own formatting. */
export function buildItemNames(bazaar, hypixelItems, neuItems) {
    const byBazaarId = Object.fromEntries(Object.entries(neuItems).map(([id, item]) => [toBazaarId(id), item]));
    const names = {};
    for (const id of Object.keys(bazaar).sort()) {
        if (id.startsWith('ENCHANTMENT_')) continue;
        const name = hypixelItems[id]?.name || stripColor(byBazaarId[id]?.displayname);
        if (name) names[id] = stripColor(name);
    }
    return names;
}

/** Fusions ignoring input order, since A+B and B+A are the same recipe. */
export function uniqueFusions(fusion) {
    const unique = new Set();
    for (const [output, byQty] of Object.entries(fusion.recipes)) {
        for (const [qty, pairs] of Object.entries(byQty)) {
            for (const [a, b] of pairs) unique.add(`${output}|${qty}|${[a, b].sort().join('|')}`);
        }
    }
    return unique;
}

/**
 * Third-party text ends up in the page, and that page's localStorage holds people's
 * API keys. No real game name needs these characters. Double quotes are allowed in
 * values because real names use them ("Fragranced" Brown Mushroom "Paste").
 */
export function findUnsafeText(value, where = 'data') {
    const found = [];
    const visit = (v, label) => {
        if (typeof v === 'string') {
            if (/[<>`]/.test(v)) found.push(`${label} has unsafe text: ${v.slice(0, 80)}`);
        } else if (v && typeof v === 'object') {
            for (const [k, child] of Object.entries(v)) {
                if (/[<>"`]/.test(k)) found.push(`${label} has an unsafe key: ${k.slice(0, 80)}`);
                visit(child, `${label}.${k}`);
            }
        }
    };
    visit(value, where);
    return found;
}

/** Problems that make data unusable. Any of these stops the sync. */
export function findErrors({ fusion, crafts, essence, enchants, slayerXp, itemNames }) {
    const errors = [
        ...findUnsafeText(fusion, 'fusion'),
        ...findUnsafeText(crafts, 'crafts'),
        ...findUnsafeText(essence, 'essence'),
        ...findUnsafeText(enchants, 'enchants'),
        ...findUnsafeText(itemNames, 'itemNames'),
    ];
    const shardEntries = Object.entries(fusion?.shards || {});
    if (shardEntries.length < 100) errors.push(`only ${shardEntries.length} shards in fusion data`);
    // Codes, rarities, tiers and categories go straight into HTML attributes, so they get a strict format.
    for (const [code, s] of shardEntries) {
        if (!/^[A-Z]\d+$/.test(code) || !s.name || !/^[a-z]+$/i.test(s.rarity || '') || !(s.fuse_amount > 0) || !/^SHARD_/.test(s.internal_id || '')) errors.push(`malformed shard ${code}: ${JSON.stringify(s)}`);
    }
    for (const [output, byQty] of Object.entries(fusion?.recipes || {})) {
        if (!fusion.shards?.[output]) errors.push(`fusion output ${output} is not a known shard`);
        for (const [qty, pairs] of Object.entries(byQty)) {
            if (!(parseInt(qty, 10) > 0)) errors.push(`fusion ${output} has bad quantity ${qty}`);
            for (const pair of pairs) {
                if (pair.length !== 2 || !pair.every(code => fusion.shards?.[code])) errors.push(`fusion ${output} has unknown inputs ${JSON.stringify(pair)}`);
            }
        }
    }
    if (Object.keys(crafts || {}).length < 500) errors.push(`only ${Object.keys(crafts || {}).length} craft recipes`);
    for (const [id, c] of Object.entries(crafts || {})) {
        const quantities = Object.values(c.materials || {});
        if (!c.name || !/^[A-Z_]+$/.test(c.tier || '') || !(c.count > 0) || !quantities.length || !quantities.every(q => q > 0)) errors.push(`malformed craft ${id}: ${JSON.stringify(c)}`);
    }
    if (!Object.keys(essence || {}).length) errors.push('no essence shop recipes');
    for (const [id, e] of Object.entries(essence || {})) {
        const quantities = Object.values(e.materials || {});
        if (!/^[a-z_]+$/.test(e.category || '') || !(e.count > 0) || !quantities.length || !quantities.every(q => q > 0)) errors.push(`malformed essence recipe ${id}: ${JSON.stringify(e)}`);
    }
    for (const key of ['enchants', 'enchant_pools', 'enchants_xp_cost', 'max_xp_table_levels']) {
        if (!enchants?.[key]) errors.push(`enchants.json has no ${key}`);
    }
    for (const type of Object.values(SLAYER_TYPES)) {
        if (!slayerXp?.[type]?.length) errors.push(`no slayer XP table for ${type}`);
    }
    if (Object.keys(itemNames || {}).length < 100) errors.push('item name table looks empty');
    return errors;
}

/** Changes that are possible but unusual enough that a person should look before they go live. */
export function findReviewReasons(previous, next) {
    const reasons = [];
    const lostShare = (before, after) => (before ? (before - after) / before : 0);

    if (previous.fusion) {
        const before = uniqueFusions(previous.fusion);
        const after = uniqueFusions(next.fusion);
        const lost = [...before].filter(f => !after.has(f)).length;
        if (before.size && lost / before.size > MAX_FUSION_LOSS) reasons.push(`${lost.toLocaleString('en')} of ${before.size.toLocaleString('en')} fusions would disappear`);
        const removed = Object.keys(previous.fusion.shards).filter(code => !next.fusion.shards[code]);
        if (removed.length) reasons.push(`shards removed: ${removed.map(code => previous.fusion.shards[code].name).join(', ')}`);
        const fuseChanges = Object.keys(previous.fusion.shards).filter(code => next.fusion.shards[code] && next.fusion.shards[code].fuse_amount !== previous.fusion.shards[code].fuse_amount);
        if (fuseChanges.length > MAX_FUSE_AMOUNT_CHANGES) reasons.push(`${fuseChanges.length} shards changed fuse amount`);
    }
    if (previous.crafts) {
        const ids = Object.keys(previous.crafts);
        const gone = ids.filter(id => !next.crafts[id]);
        if (gone.length / ids.length > MAX_CRAFT_LOSS) reasons.push(`${gone.length} of ${ids.length} craft recipes would disappear`);
        const changed = ids.filter(id => next.crafts[id] && (stable(next.crafts[id].materials) !== stable(previous.crafts[id].materials) || next.crafts[id].count !== previous.crafts[id].count));
        if (changed.length / ids.length > MAX_CRAFT_CHANGED) reasons.push(`${changed.length} of ${ids.length} craft recipes changed ingredients`);
    }
    if (previous.essence && lostShare(Object.keys(previous.essence).length, Object.keys(next.essence).filter(id => previous.essence[id]).length) > MAX_ESSENCE_LOSS) {
        reasons.push('many essence shop recipes would disappear');
    }
    if (previous.enchants?.enchants_xp_cost) {
        const before = Object.keys(previous.enchants.enchants_xp_cost);
        const kept = before.filter(k => next.enchants.enchants_xp_cost?.[k] !== undefined);
        if (lostShare(before.length, kept.length) > MAX_ENCHANT_LOSS) reasons.push(`${before.length - kept.length} enchants would disappear`);
    }
    return reasons;
}

function summarize(previous, next) {
    const lines = [];
    const count = o => Object.keys(o || {}).length;
    if (previous.fusion) {
        const before = uniqueFusions(previous.fusion), after = uniqueFusions(next.fusion);
        const added = [...after].filter(f => !before.has(f)).length, removed = [...before].filter(f => !after.has(f)).length;
        if (added || removed) lines.push(`- fusions: ${after.size.toLocaleString('en')} total, ${added.toLocaleString('en')} added, ${removed.toLocaleString('en')} removed`);
        const newShards = Object.keys(next.fusion.shards).filter(code => !previous.fusion.shards[code]);
        if (newShards.length) lines.push(`- new shards: ${newShards.map(code => next.fusion.shards[code].name).join(', ')}`);
        const fuse = Object.keys(next.fusion.shards).filter(code => previous.fusion.shards[code] && previous.fusion.shards[code].fuse_amount !== next.fusion.shards[code].fuse_amount);
        if (fuse.length) lines.push(`- fuse amount changed: ${fuse.map(code => `${next.fusion.shards[code].name} ${previous.fusion.shards[code].fuse_amount} -> ${next.fusion.shards[code].fuse_amount}`).join(', ')}`);
    }
    if (stable(previous.crafts) !== stable(next.crafts)) {
        const ids = Object.keys(previous.crafts || {});
        const gone = ids.filter(id => !next.crafts[id]);
        const added = Object.keys(next.crafts).filter(id => !previous.crafts?.[id]);
        const changed = ids.filter(id => next.crafts[id] && stable(next.crafts[id]) !== stable(previous.crafts[id]));
        const sample = list => list.slice(0, 10).join(', ') + (list.length > 10 ? ', ...' : '');
        lines.push(`- crafts: ${count(next.crafts)} total, ${added.length} added, ${changed.length} changed, ${gone.length} removed`);
        if (changed.length) lines.push(`  - changed: ${sample(changed)}`);
        if (added.length) lines.push(`  - added: ${sample(added)}`);
        if (gone.length) lines.push(`  - removed: ${sample(gone)}`);
    }
    if (stable(previous.gameData) !== stable(next.gameData)) lines.push('- essence shop, item names or slayer XP changed');
    if (stable(previous.enchants) !== stable(next.enchants)) lines.push('- enchant data changed');
    return lines;
}

async function fetchRetry(url) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const resp = await fetch(url, { headers: { 'User-Agent': 'lyns-flipper-data-sync' } });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp;
        } catch (e) {
            lastError = e;
            if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 5000));
        }
    }
    throw new Error(`${url}: ${lastError.message}`);
}
const fetchJson = async url => (await fetchRetry(url)).json();

function latestCommit(repo) {
    return execFileSync('git', ['ls-remote', repo, 'HEAD'], { encoding: 'utf8' }).split(/\s/)[0];
}

async function downloadNeu(commit) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neu-'));
    const resp = await fetchRetry(`https://codeload.github.com/NotEnoughUpdates/NotEnoughUpdates-REPO/tar.gz/${commit}`);
    fs.writeFileSync(path.join(dir, 'neu.tar.gz'), Buffer.from(await resp.arrayBuffer()));
    execFileSync('tar', ['-xzf', 'neu.tar.gz'], { cwd: dir });
    const root = path.join(dir, `NotEnoughUpdates-REPO-${commit}`);
    const items = {};
    for (const file of fs.readdirSync(path.join(root, 'items'))) {
        if (file.endsWith('.json')) items[file.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(root, 'items', file), 'utf8'));
    }
    const readConstant = name => fs.readFileSync(path.join(root, 'constants', name), 'utf8');
    return { dir, items, enchantsText: readConstant('enchants.json'), leveling: JSON.parse(readConstant('leveling.json')) };
}

const readExisting = file => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); } catch { return undefined; }
};

async function downloadMissingIcons(fusion, dryRun) {
    const missing = Object.keys(fusion.shards).filter(code => !fs.existsSync(path.join(ROOT, 'shardIcons', `${code}.png`)));
    if (dryRun) return missing;
    const downloaded = [];
    for (const code of missing) {
        try {
            const resp = await fetchRetry(`${ICONS_URL}/${code}.png`);
            fs.writeFileSync(path.join(ROOT, 'shardIcons', `${code}.png`), Buffer.from(await resp.arrayBuffer()));
            downloaded.push(code);
        } catch (e) {
            console.warn(`no icon for ${code} (the site just hides it): ${e.message}`);
        }
    }
    return downloaded;
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const reportFile = args.includes('--report') ? args[args.indexOf('--report') + 1] : null;

    const neuCommit = latestCommit(NEU_REPO), parserCommit = latestCommit(PARSER_REPO);
    console.log(`NEU ${neuCommit}\nparser ${parserCommit}`);
    const neu = await downloadNeu(neuCommit);
    const [fusionResp, collections, itemsResource, bazaarResource] = await Promise.all([
        fetchRetry(`https://raw.githubusercontent.com/Campionnn/SkyShards-Parser/${parserCommit}/dist/fusion-data.json`),
        fetchJson(`${HYPIXEL_API}/resources/skyblock/collections`),
        fetchJson(`${HYPIXEL_API}/resources/skyblock/items`),
        fetchJson(`${HYPIXEL_API}/skyblock/bazaar`),
    ]);
    const fusionText = await fusionResp.text();
    const hypixelItems = Object.fromEntries(itemsResource.items.map(i => [i.id, i]));
    const bazaar = bazaarResource.products;

    const next = {
        fusion: JSON.parse(fusionText),
        crafts: buildCraftRecipes(neu.items, { collections, hypixelItems, bazaar }),
        enchants: JSON.parse(neu.enchantsText),
    };
    next.gameData = {
        essenceRecipes: buildEssenceRecipes(neu.items),
        itemNames: buildItemNames(bazaar, hypixelItems, neu.items),
        slayerXp: neu.leveling.slayer_xp,
    };
    const previous = {
        fusion: readExisting('fusion-data.json'),
        crafts: readExisting('craft-recipes.json'),
        enchants: readExisting('enchants.json'),
        gameData: readExisting('game-data.json'),
    };
    previous.essence = previous.gameData?.essenceRecipes;
    next.essence = next.gameData.essenceRecipes;
    const manifest = readExisting('data-manifest.json');

    const report = reportLines => {
        const text = reportLines.join('\n') + '\n';
        console.log(`\n${text}`);
        if (reportFile) fs.writeFileSync(reportFile, text);
    };
    const finish = status => {
        console.log(`status: ${status}`);
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\n`);
        fs.rmSync(neu.dir, { recursive: true, force: true });
    };

    const errors = findErrors({ ...next, slayerXp: next.gameData.slayerXp, itemNames: next.gameData.itemNames });
    if (errors.length) {
        report(['sync game data: failed validation', '', ...errors.slice(0, 50).map(e => `- ${e}`)]);
        finish('failed');
        process.exitCode = 1;
        return;
    }

    const reasons = findReviewReasons(previous, next);
    const changes = summarize(previous, next);
    const missingIcons = await downloadMissingIcons(next.fusion, dryRun);
    const dataChanged = ['fusion', 'crafts', 'enchants', 'gameData'].some(k => stable(previous[k]) !== stable(next[k])) || missingIcons.length > 0;
    const syncAgeHours = manifest?.syncedAt ? (Date.now() - new Date(manifest.syncedAt).getTime()) / 3600000 : Infinity;

    const knownShardIds = new Set(Object.values(next.fusion.shards).map(s => s.internal_id));
    const unknownShards = Object.keys(bazaar).filter(id => id.startsWith('SHARD_') && !knownShardIds.has(id));

    let status = 'skip';
    if (dataChanged) status = reasons.length ? 'review' : 'publish';
    else if (syncAgeHours >= HEARTBEAT_HOURS) status = 'publish';

    const lines = [dataChanged ? 'sync game data' : 'sync game data: no changes', ''];
    if (reasons.length) lines.push('Needs review because:', ...reasons.map(r => `- ${r}`), '');
    lines.push(...(changes.length ? changes : ['No data changed.']));
    if (unknownShards.length) lines.push('', `On the Bazaar but not in the fusion data yet: ${unknownShards.join(', ')}`);
    lines.push('', `NEU ${neuCommit.slice(0, 7)}, SkyShards-Parser ${parserCommit.slice(0, 7)}, SkyBlock ${collections.version}`);
    report(lines);

    if (!dryRun && status !== 'skip') {
        const writeJson = (file, value) => fs.writeFileSync(path.join(ROOT, file), `${JSON.stringify(value, null, 2)}\n`);
        fs.writeFileSync(path.join(ROOT, 'fusion-data.json'), fusionText);
        fs.writeFileSync(path.join(ROOT, 'enchants.json'), neu.enchantsText);
        writeJson('craft-recipes.json', next.crafts);
        writeJson('game-data.json', next.gameData);
        writeJson('data-manifest.json', {
            syncedAt: new Date().toISOString(),
            gameVersion: collections.version,
            sources: {
                fusions: `${PARSER_REPO}/tree/${parserCommit}`,
                recipes: `${NEU_REPO}/tree/${neuCommit}`,
            },
        });
    }
    finish(status);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(e => {
        console.error(e);
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'status=failed\n');
        process.exitCode = 1;
    });
}
