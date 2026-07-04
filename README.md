# New Shores

A browser island city-builder in the spirit of the classic 18th-century
colony-building games. Pure HTML5 canvas + vanilla JavaScript — no dependencies,
no build step. The sprites and terrain textures are **AI-generated raster art**
(FLUX.1-schnell, generated locally — see below), with the original procedural
art kept as an automatic fallback for any missing image.

## Run it

Just open `index.html` in any modern browser (double-click works — no server needed).

## How to play

You start with a Warehouse on a procedurally generated island, 2,500 gold and a
small stock of wood, tools and food.

1. **Build roads** from your Warehouse — production buildings only deliver goods
   when they have a road connection back to the Warehouse (or a Depot).
2. **Build a Marketplace** and put **Houses** in its radius. Houses grow while their
   needs are met, and pay taxes.
3. **Feed your people**: Fisher's Hut (at the waterline), Hunting Lodge (near woods).
4. **Climb the tiers**:
   - **Pioneers** need food + a market. At 24 pioneers, **Settlers** unlock.
   - **Settlers** need cloth (🐑 Sheep Farm → 🧵 Weaver) and a Chapel. At 30
     settlers, **Citizens** unlock.
   - **Citizens** need liquor (🥔 Potato Farm → 🥃 Distillery) and a Tavern.
   - **⚜️ Merchants** demand 🌶️ **spice** — and spice *never grows on your home
     island*. Found a colony, plant a Spice Garden, and the top tier is yours.
5. Full houses **upgrade automatically** when the next tier is unlocked, its services
   are covered, and the upgrade good (cloth / liquor / spice) is in stock — hover a
   house to see exactly what is holding it back.
6. **Tools** come from the trader (🚢) early on; later build an ⛏️ Iron Mine (against
   a mountain) + 🔨 Toolmaker. Feed big towns with 🌾 Grain Farms → 🥖 Bakeries.
7. Follow the **📜 quest line** in the goal bar — each quest pays a reward.
8. Reach **60 Citizens** to make your island flourish 👑 — then house 25 Merchants
   to earn the **Imperial Charter**.

## ⚖️ Trade with a pulse

Prices **drift with your own trading**: dump 50 cloth and the price crashes for a
few minutes; buy tools in bulk and they get dearer. Watch for the **merchant
ship** — she sails in every few minutes, docks by your Warehouse, and offers
three limited deals (30% off, or a 40% premium on what she wants) for 45 seconds.

## ⛵ Expeditions

Outfit a ship (300 🪙, 20 🐟, 10 🪵, 5 🔨) and send it beyond the map's edge. Two
to three minutes later it returns with a random fortune: a cargo haul, sunken
treasure, **sea charts** (next voyage swift & rich) — or **exotic seeds** that
teach your home island a crop it couldn't grow. Sometimes only tales of sea
monsters.

## 🏆 Achievements

Fourteen milestones — from *Hamlet* to *Metropolis*, *Corsair's Bane* to
*Spice Trader* — are chronicled under the **Honours** button and persist in
your save.

## 🧠 Neural-net intelligence

The **Advisor** (bottom-left widget) is a real multi-layer perceptron — written
from scratch in [js/nn.js](js/nn.js), no libraries — that reads 57 features of
your economy (stocks, production rates, population, coverage gaps, chain
imbalances) and picks the next action out of 20 (what to build, or a trade).
Placement and road routing are deterministic search on top of the net's choice.

- **Advisor mode**: it explains its suggestion; click *Do it* to follow.
- **🤖 Autopilot**: the net governs the island — builds, paves roads, trades.

The weights in [js/ai-weights.js](js/ai-weights.js) were trained by **behavior
cloning with DAgger** in a headless harness ([dev/train.js](dev/train.js)):
the net learns from a rule-based teacher across dozens of self-played islands,
then re-trains on the states its own policy visits. Benchmark (12 sim-minutes,
held-out islands, score = tier-weighted population):

| policy  | avg score | houses satisfied |
|---------|-----------|------------------|
| random  | 283       | 86%              |
| teacher | 443       | 93%              |
| **net** | **337**   | **56%**          |

Training is noisy, so `dev/train.js` trains several candidate nets and ships
the one that scores best on held-out islands (validation-based model
selection). Retrain any time with `node dev/train.js`. The headless test suite
includes a full autonomy check: the net must grow a fresh island to 25+
population on its own (it reaches ~260 with ~60 buildings).

## ⛵ Archipelago & colonies

Each map is an archipelago: a home island plus 2–3 smaller ones, each with its
own **fertilities** — maybe yours can't grow potatoes, but the southern island
can (check the Warehouse/Kontor panel). Build a **Kontor** at a foreign
waterline (an expedition costing gold, wood, tools and provisions) to found a
colony: it opens a building zone there, anchors roads, adds storage, and cargo
ships shuttle between your harbours automatically.

## 🏴‍☠️ Warfare & disasters

- **Pirates** raid prosperous towns: a warning sounds, the black sail crosses
  the sea, and if it reaches your coast it steals from your stores and may
  torch a building. **Watchtowers** fire cannonballs at ships in range — sink
  the raider for salvage gold.
- **Fires** break out randomly (or are set by pirates). Without a **Fire
  Station** nearby, the building burns to the ground.
- **Plague** strikes large towns; sick houses pay no taxes and lose residents
  until it passes — chapel coverage speeds recovery.

## Living island

- **Day & night**: a full cycle every five minutes. Windows light up at dusk,
  stars glint on the open sea, fireflies drift through forest glades — and at
  dawn the butterflies return.
- **Weather**: storms bring sheeting rain, lightning and thunder, darker clouds
  and grounded fishers; the wind bends the trees and carries the chimney smoke.
- **Carriers** haul finished goods along your roads to the Warehouse; **workers**
  chop, hammer and harvest at their buildings; **villagers** stroll the streets;
  rowboats bob and fish jump along the shoreline. The people are AI-generated
  raster figures too, animated in-engine (bob, lean, swing) since diffusion
  can't draw consistent walk cycles.
- **Juice**: placement dust, demolition rubble, completion pops, floating
  rewards, screen shake under cannon fire, and a HUD that flinches when stocks
  move.
- **Trend arrows** in the top bar (and rich hover tooltips everywhere) show the
  net production rate of every good — green ▴ surplus, red ▾ deficit.
- **Random events**: rich shoals, driftwood, generous nobles — and storms.
- **Procedural soundtrack** ([js/music.js](js/music.js)): a lookahead scheduler
  composes lute-and-pad music bar by bar and follows the game's mood — calm by
  day, sparse at night, muted in storms, driving when pirates close in. Toggle
  with 🎵. Surf, gulls, rain and positional (stereo-panned) effects round it
  out; audio starts after your first click — browsers require a gesture.

## Controls

| Input | Action |
|---|---|
| Left-click | Build / select |
| Left-drag | Pan — flick to glide (no tool) · paint roads/buildings (tool active) |
| Right-click | Cancel tool / deselect |
| Right-drag | Pan |
| Mouse wheel | Smooth zoom |
| Hover | Rich tooltips on buildings, goods and toolbar |
| WASD / arrows | Pan |
| Space | Pause |
| 1 / 2 / 3 | Game speed |
| T / H | Trade / Help |
| Esc | Cancel / close |

The game autosaves to your browser every 30 seconds.

## Status icons

- 🔴 **!** — no road connection to the Warehouse
- 🟠 **!** — nature requirement missing (trees / water / mountain / pasture)
- 🟡 **!** — waiting for an input good
- 🔵 **!** — storage full

## Development

- `js/config.js` — all tuning: tiers, needs, buildings, prices, quests, achievements
- `js/map.js` — seeded archipelago generation & fertilities
- `js/game.js` — simulation (no DOM access)
- `js/assets.js` + `assets/` — AI-generated raster sprites & seamless land
  textures (see *AI art pipeline* below; the sea stays procedural — a
  repeating texture reads as an obvious grid on open water)
- `js/sprites.js` / `js/render.js` — procedural fallback art & isometric renderer
  (day/night, weather, particles, wildlife)
- `js/music.js` — procedural soundtrack
- `js/ui.js` / `js/main.js` — HUD, tooltips, input, game loop

### AI art pipeline (`dev/imagegen/`)

The raster art is generated **fully locally** with
[FLUX.1-schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell)
(4-bit MLX build, ~9 GB) running on Apple Silicon via
[mflux](https://github.com/filipstrand/mflux) — no cloud APIs.

- `manifest.py` — every asset with its prompt, seed and target sprite metrics
- `generate.py` — batch generation (4 steps, 768² objects / 512² textures)
- `postprocess.py` — background removal (border flood-fill + edge
  decontamination), trim, downscale to 2× logical sprite size; makes the
  terrain textures seamless; writes `assets/*.png` + `assets/manifest.js`
- `contactsheet.py` — grid overview of the raw generations

Regenerate everything with:

```
cd dev/imagegen
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python mflux numpy pillow
.venv/bin/python generate.py && .venv/bin/python postprocess.py
```

`js/assets.js` loads the manifest at boot; any sprite without a PNG (or a
headless run) falls back to the procedural drawing in `js/sprites.js`.

Headless test suite: `node dev/smoke.js` (105 assertions — boots the game against
a stubbed DOM and exercises placement, roads, services, growth, production, trade,
price drift, the merchant ship, expeditions, achievements, pirates, fire, plague
and save/load). `dev/visual.html` builds out a town deterministically for visual
checks — append `#night` or `#storm` to preview those moods.
