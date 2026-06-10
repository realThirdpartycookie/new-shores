'use strict';
/* Headless smoke test: boots the game with a stubbed DOM and runs the sim.
 * Usage: node dev/smoke.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- black-hole object: absorbs any property access / call ----
function makeBlackhole() {
  const fn = function () { return bh; };
  const bh = new Proxy(fn, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === 'toString') return () => '';
      if (p === Symbol.iterator) return function* () {};
      return bh;
    },
    set() { return true; },
    apply() { return bh; },
    construct() { return bh; },
    has() { return true; },
  });
  return bh;
}
const bh = makeBlackhole();

const storage = new Map();
const sandbox = {
  console,
  Math, JSON, Array, Object, Number, String, Boolean, Date, Symbol,
  Infinity, NaN, undefined: undefined,
  Uint8Array, Float32Array, Set, Map: global.Map, Promise, Proxy, Reflect,
  parseInt, parseFloat, isNaN, isFinite,
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0,
  setInterval: () => 0,
  setTimeout: () => 0,
  clearTimeout: () => 0,
  confirm: () => false,
  devicePixelRatio: 1,
  localStorage: {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
  },
  document: {
    getElementById: () => makeBlackhole(),
    createElement: () => makeBlackhole(),
    querySelectorAll: () => [],
    body: bh,
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {};
sandbox.removeEventListener = () => {};
vm.createContext(sandbox);

const files = ['config.js', 'nn.js', 'ai-weights.js', 'sprites.js', 'map.js', 'game.js', 'ai.js', 'render.js', 'ui.js', 'main.js'];
let src = '';
for (const f of files) {
  src += fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8') + '\n';
}

// ---- test driver, appended so it shares the scripts' scope ----
src += `
(function test() {
  let pass = 0, fail = 0;
  function assert(cond, msg) {
    if (cond) { pass++; console.log('  ok  ' + msg); }
    else { fail++; console.log('  FAIL ' + msg); }
  }

  console.log('-- boot --');
  assert(G.buildings.length === 1 && G.buildings[0].key === 'warehouse', 'boot places exactly the warehouse');
  assert(G.stock.gold === 2500, 'starting gold is 2500');

  // deterministic island for the rest of the test
  newGame(12345);
  const wh = G.buildings[0];

  console.log('-- placement rejections --');
  assert(!canPlace('house', -5, -5).ok, 'rejects out of bounds');
  let waterTile = null;
  for (let i = 0; i < MAPW * MAPH; i++) if (G.tiles[i] === TILE.DEEP) { waterTile = i; break; }
  assert(!canPlace('house', waterTile % MAPW, Math.floor(waterTile / MAPW)).ok, 'rejects water');
  assert(!canPlace('house', wh.x, wh.y).ok, 'rejects occupied tiles');
  assert(!canPlace('sheep', wh.x + 3, wh.y).ok, 'rejects locked tier-2 building');

  console.log('-- roads --');
  const dirs = [[1, 0, wh.x + 2, wh.y], [0, 1, wh.x, wh.y + 2], [-1, 0, wh.x - 1, wh.y], [0, -1, wh.x, wh.y - 1]];
  const roadTiles = [];
  for (const [dx, dy, sx, sy] of dirs) {
    let cx = sx, cy = sy;
    for (let i = 0; i < 8; i++) {
      if (placeRoad(cx, cy)) roadTiles.push([cx, cy]);
      cx += dx; cy += dy;
    }
  }
  assert(roadTiles.length >= 6, 'placed roads around warehouse (' + roadTiles.length + ')');
  assert(roadTiles.some(([x, y]) => G.roadOk[idx(x, y)] === 1), 'road network connects to warehouse');

  console.log('-- market & houses --');
  let mpos = null;
  outer:
  for (let y = 0; y < MAPH; y++) for (let x = 0; x < MAPW; x++) {
    if (!canPlace('market', x, y).ok) continue;
    if (footprintNeighbors(x, y, 2).some(([nx, ny]) => inBounds(nx, ny) && G.roadOk[idx(nx, ny)])) { mpos = { x, y }; break outer; }
  }
  assert(!!mpos, 'found a connected market spot');
  const goldBefore = G.stock.gold;
  placeBuilding('market', mpos.x, mpos.y);
  assert(G.stock.gold < goldBefore, 'market cost was charged');

  for (let i = 0; i < 40; i++) simTick(0.5); // 20s: market finishes building
  const market = G.buildings.find(b => b.key === 'market');
  assert(market.done && market.connected, 'market is built and connected');

  let housesPlaced = 0;
  for (let y = 0; y < MAPH && housesPlaced < 4; y++) for (let x = 0; x < MAPW && housesPlaced < 4; x++) {
    const dx = x - (mpos.x + 0.5), dy = y - (mpos.y + 0.5);
    if (dx * dx + dy * dy > 8 * 8) continue;
    if (canPlace('house', x, y).ok) { placeBuilding('house', x, y); housesPlaced++; }
  }
  assert(housesPlaced === 4, 'placed 4 houses near the market');
  for (let i = 0; i < 20; i++) simTick(0.5);
  const houses = G.buildings.filter(b => b.key === 'house');
  assert(houses.every(h => h.svc.market), 'houses have market coverage');

  console.log('-- quests --');
  assert(G.quest >= 1, 'first quest (build a marketplace) completed, now at #' + G.quest);
  assert(G.stock.gold > 0, 'quest reward credited');

  console.log('-- growth & taxes --');
  G.stock.food = 290;
  const g0 = G.stock.gold;
  for (let i = 0; i < 600; i++) simTick(0.5); // 5 minutes
  assert(popOf(0) >= 20, 'pioneers grew to ' + popOf(0) + ' (>= 20)');
  assert(G.stock.gold > g0, 'taxes were collected');
  assert(G.stock.food < 290, 'food was consumed');

  console.log('-- production chain (weaver: wool -> cloth) --');
  G.unlocked = 2;
  let wpos = null;
  outer2:
  for (let y = 0; y < MAPH; y++) for (let x = 0; x < MAPW; x++) {
    if (!canPlace('weaver', x, y).ok) continue;
    if (footprintNeighbors(x, y, 1).some(([nx, ny]) => inBounds(nx, ny) && G.roadOk[idx(nx, ny)])) { wpos = { x, y }; break outer2; }
  }
  assert(!!wpos, 'found a connected weaver spot');
  placeBuilding('weaver', wpos.x, wpos.y);
  G.stock.wool = 10;
  const cloth0 = G.stock.cloth;
  for (let i = 0; i < 80; i++) simTick(0.5); // 40s incl. 5s build
  assert(G.stock.cloth > cloth0, 'weaver produced cloth (' + G.stock.cloth.toFixed(1) + ')');
  assert(G.stock.wool < 10, 'weaver consumed wool');

  console.log('-- bakery chain (grain -> bread/food) --');
  let bpos = null;
  outer3:
  for (let y = 0; y < MAPH; y++) for (let x = 0; x < MAPW; x++) {
    if (!canPlace('bakery', x, y).ok) continue;
    if (footprintNeighbors(x, y, 1).some(([nx, ny]) => inBounds(nx, ny) && G.roadOk[idx(nx, ny)])) { bpos = { x, y }; break outer3; }
  }
  assert(!!bpos, 'found a connected bakery spot');
  placeBuilding('bakery', bpos.x, bpos.y);
  G.stock.grain = 20;
  G.stock.food = 10;
  // quiet the houses so the measurement isolates the bakery's output
  const savedRes = houses.map(h => h.res);
  for (const h of houses) h.res = 1;
  const food0 = G.stock.food;
  let foodPeak = 0;
  for (let i = 0; i < 80; i++) { simTick(0.5); foodPeak = Math.max(foodPeak, G.stock.food); }
  houses.forEach((h, i) => { h.res = savedRes[i]; });
  assert(foodPeak > food0, 'bakery baked bread into the food stock (peak ' + foodPeak.toFixed(1) + ')');
  assert(G.stock.grain < 20, 'bakery consumed grain');

  console.log('-- walkers --');
  let sawCarrier = false, sawVillager = false, carrierMoved = false, carrierReturned = false;
  let lastPos = null;
  G.stock.wool = 50; // keep the weaver busy so carriers keep spawning
  for (let i = 0; i < 600; i++) {
    simTick(0.5);
    for (const w of G.walkers) {
      if (w.kind === 'carrier') {
        sawCarrier = true;
        if (w.phase === 'back') carrierReturned = true;
        if (lastPos && lastPos.id === w.id && (w.fx !== lastPos.fx || w.fy !== lastPos.fy)) carrierMoved = true;
        lastPos = { id: w.id, fx: w.fx, fy: w.fy };
      }
      if (w.kind === 'villager') sawVillager = true;
    }
  }
  assert(sawCarrier, 'carriers haul goods from production buildings');
  assert(carrierMoved, 'carriers move along the road network');
  assert(carrierReturned, 'carriers walk back after delivering');
  assert(sawVillager, 'villagers stroll around their houses');
  assert(G.walkers.length <= 48, 'walker count stays capped (' + G.walkers.length + ')');

  console.log('-- trade --');
  G.stock.food = 50; // the walker sim above let houses eat the stock
  const gold1 = Math.floor(G.stock.gold), tools1 = G.stock.tools;
  buyGood('tools', 5);
  assert(G.stock.tools === tools1 + 5, 'bought 5 tools');
  assert(Math.floor(G.stock.gold) === gold1 - 5 * TRADE.tools.buy, 'paid the buy price');
  sellGood('food', 5);
  assert(Math.floor(G.stock.gold) === gold1 - 5 * TRADE.tools.buy + 5 * TRADE.food.sell, 'sell price credited');

  console.log('-- events --');
  for (const b of G.buildings) if (b.key === 'house') b.res = 8; // the walker sim starved the town
  G.stock.food = 100;
  G.stormT = 3;
  simTick(1);
  assert(G.stormT < 3 && G.stormT > 0, 'storm timer counts down');
  G.eventT = 0.01;
  const wealth = { gold: G.stock.gold, food: G.stock.food, wood: G.stock.wood, storm: G.stormT };
  simTick(1);
  const changed = G.stock.food > wealth.food || G.stock.wood > wealth.wood ||
    G.stock.gold > wealth.gold + 50 || G.stormT > wealth.storm;
  assert(changed, 'a random event fired');
  G.stormT = 0;

  console.log('-- demolish --');
  const h0 = houses[0], count0 = G.buildings.length;
  demolishAt(h0.x, h0.y);
  assert(G.buildings.length === count0 - 1, 'house demolished');

  console.log('-- neural net intelligence --');
  const feats = AI.features();
  assert(feats.length === AI.FEATURE_COUNT, 'feature vector has expected length (' + feats.length + ')');
  assert(feats.every(v => Number.isFinite(v)), 'all features are finite');
  assert(AI.hasNet(), 'trained weights loaded');
  const chosen = AI.chooseAction();
  assert(AI.ACTIONS.includes(chosen), 'net chooses a known action (' + chosen + ')');
  assert(AI.roughValid(chosen), 'chosen action passes the validity mask');

  // the real proof: the net governs a fresh island on its own
  newGame(424242);
  G.autopilot = true;
  for (let i = 0; i < 1200; i++) simTick(0.5); // 10 sim-minutes
  assert(totalPop() >= 25, 'autopilot grew the population to ' + totalPop() + ' (>= 25)');
  assert(G.buildings.length >= 8, 'autopilot constructed ' + G.buildings.length + ' buildings (>= 8)');
  assert(G.buildings.some(b => BUILDINGS[b.key].prod && b.status === 'ok'), 'autopilot has working production');
  G.autopilot = false;

  console.log('-- stats history --');
  assert(G.popHist.length > 5, 'population history sampled (' + G.popHist.length + ' points)');
  const lastEntry = G.popHist[G.popHist.length - 1];
  assert(Array.isArray(lastEntry) && lastEntry.length === 4, 'history entries are [t,p0,p1,p2]');

  console.log('-- victory --');
  G.flourished = true;
  UI.updateHUD();
  assert(G.victoryShown === true, 'victory screen triggers once on flourish');
  G.flourished = false; G.victoryShown = false;

  console.log('-- save / load --');
  assert(saveGame(), 'saved');
  const popBefore = popOf(0), bCount = G.buildings.length, goldSaved = Math.floor(G.stock.gold);
  newGame(999); // wipe
  assert(loadGame(), 'loaded');
  assert(G.buildings.length === bCount, 'building count restored');
  assert(Math.floor(G.stock.gold) === goldSaved, 'gold restored');
  assert(popOf(0) === popBefore, 'population restored');
  assert(G.popHist.length > 5, 'population history survives save/load');
  for (let i = 0; i < 40; i++) simTick(0.5); // sim keeps running after load
  assert(true, 'sim runs after load without throwing');

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail > 0) throw new Error('SMOKE TEST FAILED');
})();
`;

try {
  vm.runInContext(src, sandbox, { filename: 'bundle.js' });
  console.log('\\nSMOKE TEST PASSED');
} catch (e) {
  console.error(e.stack || e);
  process.exit(1);
}
