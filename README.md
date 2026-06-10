# New Shores

A browser island city-builder in the spirit of the classic 18th-century
colony-building games. Pure HTML5 canvas + vanilla JavaScript — no dependencies,
no build step, no external assets. All graphics are drawn procedurally in code.

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
5. Full houses **upgrade automatically** when the next tier is unlocked, its services
   are covered, and the upgrade good (cloth / liquor) is in stock.
6. **Tools** come from the trader (🚢) early on; later build an ⛏️ Iron Mine (against
   a mountain) + 🔨 Toolmaker. Feed big towns with 🌾 Grain Farms → 🥖 Bakeries.
7. Follow the **📜 quest line** in the goal bar — each quest pays a reward.
8. Reach **60 Citizens** to make your island flourish. 👑

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

## Living island

- **Carriers** haul finished goods along your roads to the Warehouse; **workers**
  chop, hammer and harvest at their buildings; **villagers** stroll the streets.
- **Trend arrows** in the top bar (and tooltips) show the net production rate of
  every good — green ▴ surplus, red ▾ deficit. The trade window shows the same.
- **Random events**: rich shoals, driftwood, generous nobles — and storms that keep
  the fishers ashore for a while.
- Gulls circle overhead, cloud shadows drift across the island, the trader's ship
  sails its rounds.
- Ambient sound: surf rolls softly and gulls cry now and then (toggle with 🔊;
  starts after your first click — browsers require a gesture for audio).

## Controls

| Input | Action |
|---|---|
| Left-click | Build / select |
| Left-drag | Pan (no tool) · paint roads/buildings (tool active) |
| Right-click | Cancel tool / deselect |
| Right-drag | Pan |
| Mouse wheel | Zoom |
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

- `js/config.js` — all tuning: tiers, needs, buildings, prices
- `js/map.js` — seeded island generation
- `js/game.js` — simulation (no DOM access)
- `js/sprites.js` / `js/render.js` — procedural art & isometric renderer
- `js/ui.js` / `js/main.js` — HUD, input, game loop

Headless test suite: `node dev/smoke.js` (boots the game against a stubbed DOM and
exercises placement, roads, services, growth, production, trade, save/load).
`dev/visual.html` builds out a town deterministically for visual checks.
