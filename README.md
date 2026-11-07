# lyns-flipper

hypixel skyblock bazaar flipping calculation suite. includes recursive shard fusion optimizer, dynamic anvil enchanted book combiner, multi-slot capital portfolio optimizer, slayer / collection craft flipper, and essence shop arbitrage. live bazaar order book depth checks, fulfillment timers, and anti-crash filters.

## modules

- **⚡ shard flipper**: every attribute shard and fusion recipe. calculates optimal fusion paths (e.g. when fusing galaxy fish / sun fish is cheaper than buying them raw), accounts for minimum recipe yields, order book depth, fulfillment timers, and total fusion machine cycles.
- **📖 book flipper**: 155 enchanted book types. calculates optimal anvil combination paths (e.g. if buying and combining 2x level 2 books to make a level 3 book is cheaper than buying 4x level 1 books, it does that). reverse-engineers combinable limits from enchants.json and table limits, tracks dedication 3 caps, base level 3/4/2 enchants, shortened arrays, and counts total anvil combines.
- **💼 portfolio flipper**: multi-order capital allocation optimizer (`bazaar_gui.py` / `bazaar_flipper.py`). allocates your total budget (e.g. 220m) across up to 12-24 bazaar slots, enforces in-game hard caps (128 / 71,680), penalizes queue friction, and calculates exact check-back fill timers. optional goldilocks anti-bot volume filter.
- **🔨 craft flipper**: slayer and collection craft optimizer (`craft_flipper.py`). calculates exact profits for revenant viscera, tarantula silk, golden tooth, null ovoid, super compactor 3000, enchanted lava / magma / plasma buckets, hot potato books, refined titanium/mithril, and fermento.
- **🔮 essence flipper**: essence shop arbitrage (`essence_flipper.py`). finds profit on converting wither, undead, ice, diamond, and forest essence from bazaar into infinileap, infinityboom tnt, experience v books, perfectly cut diamonds, and wooden bait.

## how to run

literally just host the repo folder with any static server:

```bash
python -m http.server 8000
```

open `http://localhost:8000` in your browser.

## api key

bazaar prices work without a key. you only need a free hypixel api key from https://developer.hypixel.net to look up player profiles in the craft flipper.
the first time you do a lookup it asks for the key once, saves it in your browser localstorage (not shared anywhere), and leaves you alone. you can add or change it any time with the `🔑 API KEY` button.

## data sources

prices are live. everything else updates by itself: a github action runs `scripts/sync-data.mjs` every 6 hours and commits new data to `main`, which deploys the site.

| data | file | source |
|---|---|---|
| fusion recipes, shards | `fusion-data.json` | [SkyShards-Parser](https://github.com/Campionnn/SkyShards-Parser) |
| shard icons | `shardIcons/` | [SkyShards](https://github.com/Campionnn/SkyShards) |
| craft recipes | `craft-recipes.json` | [NotEnoughUpdates-REPO](https://github.com/NotEnoughUpdates/NotEnoughUpdates-REPO) |
| craft rarity, collection unlocks | `craft-recipes.json` | hypixel api |
| enchants | `enchants.json` | NotEnoughUpdates-REPO |
| essence shops, slayer xp | `game-data.json` | NotEnoughUpdates-REPO |
| item names | `game-data.json` | hypixel api, then NotEnoughUpdates-REPO |

the sync checks the data before it goes live:

- **broken data** (bad format, missing values, html in names) stops the sync and opens an issue. the site keeps the last good data.
- **suspicious changes** (over 10% of fusions gone, shards removed, over 5% of crafts gone or changed) go to a `data-sync-review` branch and a pr or issue instead of the live site.

to run it yourself: `node scripts/sync-data.mjs --dry-run` shows what would change without writing anything. drop `--dry-run` to write the files. no dependencies, just node 22 and `git`. tests: `node --test scripts/sync-data.test.mjs`.

**this can still be wrong.** hypixel doesn't publish recipes or fusion rules, so they come from community projects that can lag behind a game update. the site shows when data last synced and warns if syncing stops or the bazaar lists shards it doesn't know, but check anything expensive in-game before buying.

these are still maintained by hand in `index.html`, because no source publishes them: anvil combine limits (`EXPLICIT_LIMITS`, `EXPLICIT_BASE_LEVELS`) and bazaar order caps (`ITEM_LIMITS`). the same goes for the slayer unlocks in `SLAYER_FALLBACKS` in the sync script.

data licenses and credits are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## star this thing

if this saved you coins or braincells star the repo:
https://github.com/lyn1dev/lyns-flipper
