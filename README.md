# lyns-flipper

hypixel skyblock bazaar flipping calculation suite. includes recursive shard fusion optimizer, dynamic anvil enchanted book combiner, multi-slot capital portfolio optimizer, slayer / collection craft flipper, and essence shop arbitrage. live bazaar order book depth checks, fulfillment timers, and anti-crash filters.

## modules

- **⚡ shard flipper**: 321 shards, 257k recipes. calculates optimal fusion paths (e.g. when fusing galaxy fish / sun fish is cheaper than buying them raw), accounts for minimum recipe yields, order book depth, fulfillment timers, and total fusion machine cycles.
- **📖 book flipper**: 155 enchanted book types. calculates optimal anvil combination paths (e.g. if buying and combining 2x level 2 books to make a level 3 book is cheaper than buying 4x level 1 books, it does that). reverse-engineers combinable limits from enchants.json and table limits, tracks dedication 3 caps, base level 3/4/2 enchants, shortened arrays, and counts total anvil combines.
- **💼 portfolio flipper**: multi-order capital allocation optimizer (`bazaar_gui.py` / `bazaar_flipper.py`). allocates your total budget (e.g. 220m) across up to 12-24 bazaar slots, enforces in-game hard caps (128 / 71,680), penalizes queue friction, and calculates exact check-back fill timers. optional goldilocks anti-bot volume filter.
- **🔨 craft flipper**: slayer and collection craft optimizer (`craft_flipper.py`). calculates exact profits for revenant viscera, tarantula silk, golden tooth, null ovoid, super compactor 3000, enchanted lava / magma / plasma buckets, hot potato books, refined titanium/mithril, and fermento.
- **🔮 essence flipper**: essence shop arbitrage (`essence_flipper.py`). finds profit on converting wither, undead, ice, diamond, and forest essence from bazaar into infinileap, infinityboom tnt, experience v books, perfectly cut diamonds, and wooden bait.

## how to run

literally just host `index.html`, `fusion-data.json`, and `enchants.json` with any static server:

```bash
python -m http.server 8000
```

open `http://localhost:8000` in your browser.

## api key

bazaar prices work without a key. you only need a free hypixel api key from https://developer.hypixel.net to look up player profiles in the craft flipper.
the first time you do a lookup it asks for the key once, saves it in your browser localstorage (not shared anywhere), and leaves you alone. you can add or change it any time with the `🔑 API KEY` button.

## star this thing

if this saved you coins or braincells star the repo:
https://github.com/lyn1dev/lyns-flipper
