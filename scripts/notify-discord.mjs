#!/usr/bin/env node
// Pings a Discord webhook when a sync adds shard fusion recipes or new shards.
// Run by .github/workflows/sync-data.yml after publish-sync.sh.
//
//   node scripts/notify-discord.mjs <old fusion-data.json> <new fusion-data.json> [--status publish|review] [--dry-run]
//
// The webhook URL comes from $DISCORD_WEBHOOK_URL, and an optional @mention from
// $DISCORD_PING_ID (a user ID, or role:<role ID>). With --dry-run (or no URL) it
// prints the message instead of sending it. Sends nothing when no recipes were added.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { uniqueFusions } from './sync-data.mjs';

const MAX_OUTPUTS = 15;       // outputs listed before "and N more"
const MAX_PAIRS_SHOWN = 3;    // example input pairs per output
const MAX_DESCRIPTION = 4000; // Discord caps embed descriptions at 4096

/** New shards and added recipes grouped by output shard, newest data's names. */
export function diffFusions(before, after) {
    const old = before ? uniqueFusions(before) : new Set();
    const byOutput = new Map();
    for (const key of uniqueFusions(after)) {
        if (old.has(key)) continue;
        const [output, qty, a, b] = key.split('|');
        const group = byOutput.get(output) || { output, qty: new Set(), pairs: [] };
        group.qty.add(qty);
        group.pairs.push([a, b]);
        byOutput.set(output, group);
    }
    const newShards = Object.keys(after.shards).filter(code => !before?.shards?.[code]);
    const added = [...byOutput.values()].sort((x, y) => y.pairs.length - x.pairs.length);
    return { newShards, added, total: added.reduce((n, g) => n + g.pairs.length, 0) };
}

export function buildMessage(diff, shards, { status = 'publish', siteUrl, reviewUrl } = {}) {
    const name = code => shards[code]?.name || code;
    const lines = [];
    if (diff.newShards.length) lines.push(`**New shards:** ${diff.newShards.map(name).join(', ')}`, '');
    for (const g of diff.added.slice(0, MAX_OUTPUTS)) {
        const qty = [...g.qty].join('/');
        const examples = g.pairs.slice(0, MAX_PAIRS_SHOWN).map(([a, b]) => `${name(a)} + ${name(b)}`).join(', ');
        const more = g.pairs.length > MAX_PAIRS_SHOWN ? `, +${g.pairs.length - MAX_PAIRS_SHOWN} more` : '';
        lines.push(`**${name(g.output)}** x${qty}: ${examples}${more}`);
    }
    if (diff.added.length > MAX_OUTPUTS) lines.push(`…and ${diff.added.length - MAX_OUTPUTS} more shards with new recipes`);

    let description = lines.join('\n');
    if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION - 1)}…`;

    const review = status === 'review';
    const title = `${diff.total.toLocaleString('en')} new shard recipe${diff.total === 1 ? '' : 's'}`
        + (review ? ' (held for review)' : '');
    return {
        username: 'lyns-flipper',
        embeds: [{
            title,
            url: review ? reviewUrl : siteUrl,
            description,
            color: review ? 0xf1c40f : 0x2ecc71,
            footer: { text: review ? 'Not live yet: the sync flagged this change for review.' : 'Live on the site now.' },
            timestamp: new Date().toISOString(),
        }],
    };
}

async function main() {
    const args = process.argv.slice(2);
    const flag = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const dryRun = args.includes('--dry-run');
    const [beforeFile, afterFile] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--status'));
    if (!beforeFile || !afterFile) throw new Error('usage: notify-discord.mjs <old fusion-data.json> <new fusion-data.json> [--status publish|review] [--dry-run]');

    const read = file => {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
    };
    const before = read(beforeFile), after = read(afterFile);
    if (!after) throw new Error(`can't read ${afterFile}`);

    const diff = diffFusions(before, after);
    if (!diff.total && !diff.newShards.length) {
        console.log('No new shard recipes, nothing to send.');
        return;
    }

    const repo = process.env.GITHUB_REPOSITORY;
    const message = buildMessage(diff, after.shards, {
        status: flag('--status'),
        siteUrl: process.env.SITE_URL || (repo ? `https://github.com/${repo}` : undefined),
        reviewUrl: repo ? `https://github.com/${repo}/compare/main...data-sync-review` : undefined,
    });

    // Optional ping: a user ID (123...) or a role ID written as "role:123...".
    const ping = (process.env.DISCORD_PING_ID || '').trim();
    if (/^\d{17,20}$/.test(ping)) {
        message.content = `<@${ping}>`;
        message.allowed_mentions = { users: [ping] };
    } else if (/^role:\d{17,20}$/.test(ping)) {
        message.content = `<@&${ping.slice(5)}>`;
        message.allowed_mentions = { roles: [ping.slice(5)] };
    } else if (ping) {
        console.warn('DISCORD_PING_ID should be a user ID or role:<role ID>, ignoring it.');
    }

    const webhook = process.env.DISCORD_WEBHOOK_URL;
    if (dryRun || !webhook) {
        if (!webhook && !dryRun) console.log('DISCORD_WEBHOOK_URL is not set, printing instead of sending.');
        console.log(JSON.stringify(message, null, 2));
        return;
    }
    const resp = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
    });
    if (!resp.ok) throw new Error(`Discord returned ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    console.log(`Sent: ${message.embeds[0].title}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(e => {
        console.error(e.message);
        process.exitCode = 1;
    });
}
