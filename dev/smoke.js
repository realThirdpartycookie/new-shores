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

const files = ['config.js', 'assets.js', 'nn.js', 'ai-weights.js', 'sprites.js', 'map.js', 'game.js', 'ai.js', 'render.js', 'music.js', 'ui.js', 'main.js'];
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
  G.eventT = 1e9;  // keep random events out of the economy tests
  G.pirateT = 1e9; // pirates get their own section
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
    G.stock.gold > wealth.gold + 50 || G.stormT > wealth.storm ||
    G.buildings.some(b => b.fire != null || b.sick != null);
  assert(changed, 'a random event fired');
  G.stormT = 0;
  G.eventT = 1e9; // back to determinism
  for (const b of G.buildings) { b.fire = null; b.sick = null; } // clean up event fallout

  console.log('-- demolish --');
  const h0 = G.buildings.find(b => b.key === 'house'), count0 = G.buildings.length;
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
  assert(Array.isArray(lastEntry) && lastEntry.length === 5, 'history entries are [t,p0,p1,p2,p3]');

  console.log('-- archipelago & fertility --');
  const bigIslands = [];
  for (let id = 1; id <= G.islands.count; id++) {
    if (G.islands.sizes[id] >= 30) bigIslands.push(id);
  }
  assert(bigIslands.length >= 2, 'map has ' + bigIslands.length + ' settleable islands (>= 2)');
  for (const crop of FERTILITY_CROPS) {
    assert(bigIslands.some(id => G.fertility[id] && G.fertility[id][crop]), crop + ' grows somewhere');
  }
  const wh2 = G.buildings.find(b => b.key === 'warehouse');
  const homeIsl = islandAt(wh2.x, wh2.y);
  let lackIsl = null, lackCrop = null;
  for (const id of bigIslands) {
    for (const crop of FERTILITY_CROPS) {
      if (!G.fertility[id][crop]) { lackIsl = id; lackCrop = crop; }
    }
  }
  if (lackIsl) {
    G.unlocked = 3; // so the tier gate doesn't mask the fertility reason
    let denied = null;
    for (let i = 0; i < MAPW * MAPH && !denied; i++) {
      if (G.islands.ids[i] !== lackIsl) continue;
      const x = i % MAPW, y = Math.floor(i / MAPW);
      const r = canPlace(lackCrop, x, y, true);
      if (!r.ok && /island cannot/.test(r.why)) denied = r.why;
    }
    assert(!!denied, 'fertility blocks ' + lackCrop + ' on island ' + lackIsl);
  } else {
    assert(true, 'no infertile island on this seed (skip fertility-denial check)');
  }

  console.log('-- kontor colony --');
  let kpos = null;
  for (let y = 0; y < MAPH && !kpos; y++) {
    for (let x = 0; x < MAPW && !kpos; x++) {
      if (islandAt(x, y) === homeIsl || islandAt(x, y) === 0) continue;
      if (canPlace('kontor', x, y, true).ok) kpos = { x, y };
    }
  }
  assert(!!kpos, 'found a kontor spot on a foreign island');
  const capBefore = storageCap();
  placeBuilding('kontor', kpos.x, kpos.y, true);
  assert(storageCap() === capBefore + 150, 'kontor adds 150 storage');
  assert(G.zone[idx(kpos.x + 3, kpos.y)] === 1 || G.zone[idx(kpos.x - 3, kpos.y)] === 1,
    'kontor opens a building zone on the new island');
  const farRoad = placeRoad(kpos.x - 1, kpos.y);
  assert(!farRoad || G.roadOk[idx(kpos.x - 1, kpos.y)] === 1, 'roads connect to the kontor as a base');

  console.log('-- fire --');
  const victim = G.buildings.find(b => b.done && BUILDINGS[b.key].prod);
  assert(!!victim, 'found a building to torch');
  ignite(victim);
  assert(victim.fire != null, 'building caught fire');
  for (let i = 0; i < 40; i++) simTick(0.5);
  assert(!G.buildings.includes(victim), 'uncovered building burned down');

  let fhSpot = null;
  for (const [nx, ny] of footprintNeighbors(wh2.x - 1, wh2.y - 1, 4)) {
    if (canPlace('firehouse', nx, ny, true).ok) { fhSpot = { x: nx, y: ny }; break; }
  }
  if (!fhSpot) {
    outer4:
    for (let y = wh2.y - 8; y < wh2.y + 8; y++) for (let x = wh2.x - 8; x < wh2.x + 8; x++) {
      if (canPlace('firehouse', x, y, true).ok) { fhSpot = { x, y }; break outer4; }
    }
  }
  assert(!!fhSpot, 'found a fire station spot');
  const fhRes = placeBuilding('firehouse', fhSpot.x, fhSpot.y, true);
  fhRes.b.connected = true; // test shim: pretend the road is laid
  const victim2 = G.buildings.find(b => b.done && b.key === 'house' &&
    (b.x - fhSpot.x) ** 2 + (b.y - fhSpot.y) ** 2 < 81);
  if (victim2) {
    ignite(victim2);
    for (let i = 0; i < 30; i++) simTick(0.5);
    assert(G.buildings.includes(victim2) && victim2.fire == null, 'fire brigade saved the covered house');
  } else {
    assert(true, 'no house near station on this seed (skip brigade check)');
  }

  console.log('-- plague --');
  const sickHouse = G.buildings.find(b => b.key === 'house' && b.done);
  sickHouse.res = 8;
  sicken(sickHouse);
  assert(sickHouse.sick != null, 'house fell ill');
  let minRes = 8;
  for (let i = 0; i < 70; i++) { simTick(0.5); minRes = Math.min(minRes, sickHouse.res); }
  assert(sickHouse.sick == null, 'plague passed');
  assert(minRes < 8, 'plague cost residents (dipped to ' + minRes + ')');

  console.log('-- pirates & watchtowers --');
  for (const b of G.buildings) if (b.key === 'house') b.res = 8;
  // retry spawns until the anchorage has defensible ground nearby
  let anchor = null;
  for (let attempt = 0; attempt < 8 && !anchor; attempt++) {
    G.pirate = null;
    G.pirateT = 0.01;
    simTick(1);
    if (!G.pirate) continue;
    const a = G.pirate.path[G.pirate.path.length - 1];
    outer5:
    for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
      if (dx * dx + dy * dy > 49) continue;
      if (canPlace('watchtower', a[0] + dx, a[1] + dy, true).ok) { anchor = a; break outer5; }
    }
  }
  assert(!!G.pirate, 'pirate ship spawned');
  assert(G.pirateSeen, 'pirate warning raised');
  assert(!!anchor, 'found an anchorage with defensible ground');
  let towers = 0;
  for (let r = 1; r <= 7 && towers < 2; r++) {
    for (let dy = -r; dy <= r && towers < 2; dy++) {
      for (let dx = -r; dx <= r && towers < 2; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (dx * dx + dy * dy > 49) continue; // stay well inside cannon range 9
        const x = anchor[0] + dx, y = anchor[1] + dy;
        if (canPlace('watchtower', x, y, true).ok) {
          placeBuilding('watchtower', x, y, true);
          towers++;
        }
      }
    }
  }
  assert(towers >= 1, 'placed ' + towers + ' watchtower(s) at the anchorage');
  const goldBeforePirate = G.stock.gold;
  for (let i = 0; i < 300 && G.pirate; i++) simTick(0.5);
  assert(!G.pirate, 'pirate encounter resolved');
  assert(G.pirateSunk >= 1, 'watchtowers sank the pirate (' + G.pirateSunk + ')');
  assert(G.shots.length === 0, 'cannonball animations cleaned up');

  console.log('-- merchants & spice --');
  assert(TIERS.length === 4 && TIERS[3].key === 'merchant', 'fourth tier (Merchants) defined');
  assert(TIERS[2].upgrade && TIERS[2].upgrade.needsGood === 'spice', 'citizens upgrade needs spice');
  assert(GOODS.includes('spice') && BUILDINGS.spice.prod.out === 'spice', 'spice good and Spice Garden exist');
  const homeFert = G.fertility[islandAt(wh2.x, wh2.y)];
  assert(homeFert && homeFert.spice === false, 'spice never grows on the home island');
  assert(bigIslands.some(id => G.fertility[id] && G.fertility[id].spice), 'spice grows on a colony island');
  const diagHouse = G.buildings.find(b => b.key === 'house' && b.done);
  const diag = whyNoUpgrade(diagHouse);
  assert(diag === null || typeof diag === 'string', 'whyNoUpgrade yields a diagnosis (' + diag + ')');

  console.log('-- price drift --');
  G.priceDrift = {};
  G.stock.wood = 200;
  const gold2 = Math.floor(G.stock.gold);
  sellGood('wood', 5);
  assert(Math.floor(G.stock.gold) === gold2 + 5 * TRADE.wood.sell, 'first sale settles at the base price');
  assert(priceOf('wood').drift < 0, 'selling pushes the price down');
  assert(priceOf('wood').sell <= TRADE.wood.sell, 'drifted sell price does not exceed base after dumping');
  for (let i = 0; i < 30; i++) tickRates(1);
  assert(Math.abs(priceOf('wood').drift) < 0.005, 'price drift relaxes back to base');

  console.log('-- merchant ship --');
  for (const b of G.buildings) if (b.key === 'house') b.res = 8;
  G.trader = null;
  G.traderT = 0.01;
  simTick(1);
  assert(!!G.trader, 'merchant ship spawned');
  for (let i = 0; i < 800 && G.trader && G.trader.state === 'approach'; i++) simTick(0.5);
  assert(G.trader && G.trader.state === 'docked', 'merchant ship docked at the harbour');
  assert(G.trader.deals.length === 3 && G.trader.deals.every(d => d.left === 20), 'docked merchant offers 3 deals');
  G.trader.deals[0] = { good: 'wood', mode: 'sell', left: 20, price: 10 }; // deterministic deal
  G.stock.wood = 50;
  const gold3 = Math.floor(G.stock.gold);
  assert(dealTrade(0, 5), 'deal accepted');
  assert(Math.floor(G.stock.gold) === gold3 + 50 && G.stock.wood === 45, 'deal paid the premium price');
  assert(G.trader.deals[0].left === 15, 'deal volume is limited');
  for (let i = 0; i < 400 && G.trader; i++) simTick(0.5);
  assert(!G.trader, 'merchant ship sailed away');

  console.log('-- expeditions --');
  G.stock.gold = 5000; G.stock.food = 100; G.stock.wood = 100; G.stock.tools = 50;
  const exp1 = startExpedition();
  assert(exp1.ok, 'expedition launched');
  assert(!startExpedition().ok, 'only one expedition at a time');
  assert(Math.floor(G.stock.gold) === 5000 - EXPEDITION_COST.gold, 'outfitting cost charged');
  G.expedition.dur = 4; // shorten the voyage for the test
  for (let i = 0; i < 20; i++) simTick(0.5);
  assert(!G.expedition, 'expedition resolved on return');
  assert(G.expeditionsDone === 1, 'expedition voyage counted');

  console.log('-- achievements --');
  G.stock.gold = 20000;
  checkAchievements();
  assert(G.achievements.tycoon != null, 'tycoon achievement awarded at 10k gold');
  const achCount = Object.keys(G.achievements).length;
  award('tycoon');
  assert(Object.keys(G.achievements).length === achCount, 'awards are idempotent');
  assert(G.achievements.roadbuilder == null || true, 'achievement table evaluates without throwing');

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
  assert(G.expeditionsDone === 1, 'expedition count survives save/load');
  assert(G.achievements.tycoon != null, 'achievements survive save/load');
  for (let i = 0; i < 40; i++) simTick(0.5); // sim keeps running after load
  assert(true, 'sim runs after load without throwing');

  console.log('-- legacy (pre-spice) save migration --');
  const legacy = JSON.parse(localStorage.getItem(SAVE_KEY));
  for (const id in legacy.fertility) delete legacy.fertility[id].spice;
  delete legacy.priceDrift; delete legacy.achievements; delete legacy.expedition;
  delete legacy.expeditionsDone; delete legacy.expBonus; delete legacy.spiceMade;
  legacy.popHist = legacy.popHist.map(e => e.slice(0, 4));
  delete legacy.stock.spice;
  localStorage.setItem(SAVE_KEY, JSON.stringify(legacy));
  assert(loadGame(), 'legacy save loads');
  assert(G.stock.spice === 0, 'spice stock defaults to 0');
  assert(Object.values(G.fertility).some(f => f && f.spice), 'spice fertility derived for old saves');
  const wh4 = G.buildings.find(b => b.key === 'warehouse');
  assert(G.fertility[islandAt(wh4.x, wh4.y)].spice === false, 'home island still cannot grow spice');
  assert(G.expeditionsDone === 0 && Object.keys(G.achievements).length === 0, 'new counters default cleanly');
  for (let i = 0; i < 20; i++) simTick(0.5);
  assert(true, 'sim runs after legacy load without throwing');

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
