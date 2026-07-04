'use strict';
/* ============================================================
 * Core game state & simulation.
 * No DOM access in here (UI/SFX go through optional hooks).
 * ============================================================ */

const G = {
  tiles: null, shore: null,
  grid: null,           // building reference per tile (or null)
  roads: null,          // Uint8: 1 = road
  roadOk: null,         // Uint8: 1 = road connected to warehouse/depot
  zone: null,           // Uint8: 1 = inside buildable area
  buildings: [],
  nextId: 1,
  stock: {},
  time: 0,
  speed: 1,
  paused: false,
  unlocked: 1,          // number of unlocked tiers (1..3)
  seed: 0,
  selected: null,       // selected building id
  flourished: false,
  condT: 0,
  walkers: [],          // little people (visual only)
  vilT: 0,
  nextWalkerId: 1,
  rateHist: [],         // stock snapshots for net-rate display
  rateT: 0,
  quest: 0,             // index into QUESTS
  eventT: 120,          // countdown to the next random event
  stormT: 0,            // while > 0, fishers stay ashore
  victoryShown: false,
  popHist: [],          // [time, pioneers, settlers, citizens] every 5s
  popHistT: 0,
  autopilot: false,     // neural-net governor plays the game
  islands: null,        // { ids, count, sizes } from flood fill
  fertility: {},        // islandId -> { sheep, grain, potato }
  pirate: null,         // active pirate ship
  pirateT: 360,         // countdown to next raid
  pirateSeen: false,
  pirateSunk: 0,
  shots: [],            // cannonball animations
  trader: null,         // visiting merchant ship (better prices while docked)
  traderT: 150,         // countdown to the next visit
  priceDrift: {},       // per-good market pressure from player trades
  expedition: null,     // { t, dur, bonus } while a ship is at sea
  expeditionsDone: 0,
  expBonus: false,      // sea charts: next voyage swift & rich
  achievements: {},     // id -> floor(G.time) when earned
  achT: 0,
  spiceMade: 0,         // total spice harvested (achievement)
};

const Hooks = { toast: null, sfx: null, onChange: null, fx: null }; // wired up by UI

function idx(x, y) { return y * MAPW + x; }
function inBounds(x, y) { return x >= 0 && y >= 0 && x < MAPW && y < MAPH; }
function tileAt(x, y) { return inBounds(x, y) ? G.tiles[idx(x, y)] : TILE.DEEP; }
function isWaterTile(t) { return t === TILE.DEEP || t === TILE.WATER; }
function isLandTile(t) { return t === TILE.SAND || t === TILE.GRASS || t === TILE.TREE || t === TILE.ROCK; }

function toast(msg, big, kind) { if (Hooks.toast) Hooks.toast(msg, big, kind); }
function sfx(name, x, y) { if (Hooks.sfx) Hooks.sfx(name, x, y); }
// world-space particle/juice effects (dust, crumble, spark, splash, float, shake…)
function fx(kind, x, y, data) { if (Hooks.fx) Hooks.fx(kind, x, y, data); }

function storageCap() {
  let cap = STORAGE_BASE;
  for (const b of G.buildings) {
    if (b.done && BUILDINGS[b.key].storage) cap += BUILDINGS[b.key].storage;
  }
  return cap;
}

// Warehouse / finished depots & kontors anchor roads, zones and ships.
function isBase(b) {
  return b.key === 'warehouse' || ((b.key === 'depot' || b.key === 'kontor') && b.done);
}

function islandAt(x, y) {
  return G.islands && inBounds(x, y) ? G.islands.ids[idx(x, y)] : 0;
}

function popOf(tier) {
  let n = 0;
  for (const b of G.buildings) {
    if (b.key === 'house' && b.tier === tier) n += b.res;
  }
  return n;
}

function totalPop() {
  let n = 0;
  for (let t = 0; t < TIERS.length; t++) n += popOf(t);
  return n;
}

function canAfford(cost) {
  for (const k in cost) if ((G.stock[k] || 0) < cost[k]) return false;
  return true;
}

function payCost(cost) {
  for (const k in cost) G.stock[k] -= cost[k];
}

/* ---------------- placement ---------------- */

function footprintTiles(x, y, size) {
  const out = [];
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) out.push([x + dx, y + dy]);
  }
  return out;
}

// 4-neighbour tiles around the footprint perimeter
function footprintNeighbors(x, y, size) {
  const out = [];
  for (let i = 0; i < size; i++) {
    out.push([x + i, y - 1], [x + i, y + size], [x - 1, y + i], [x + size, y + i]);
  }
  return out;
}

function countTreesAround(x, y, size, r) {
  let n = 0;
  for (let ty = y - r; ty < y + size + r; ty++) {
    for (let tx = x - r; tx < x + size + r; tx++) {
      if (inBounds(tx, ty) && G.tiles[idx(tx, ty)] === TILE.TREE) n++;
    }
  }
  return n;
}

function countPastureAround(x, y, size, r) {
  let n = 0;
  for (let ty = y - r; ty < y + size + r; ty++) {
    for (let tx = x - r; tx < x + size + r; tx++) {
      if (!inBounds(tx, ty)) continue;
      if (tx >= x && tx < x + size && ty >= y && ty < y + size) continue;
      if (G.tiles[idx(tx, ty)] === TILE.GRASS && !G.grid[idx(tx, ty)] && !G.roads[idx(tx, ty)]) n++;
    }
  }
  return n;
}

function touchesTileType(x, y, size, pred) {
  for (let ty = y - 1; ty <= y + size; ty++) {
    for (let tx = x - 1; tx <= x + size; tx++) {
      if (tx >= x && tx < x + size && ty >= y && ty < y + size) continue;
      if (pred(tileAt(tx, ty))) return true;
    }
  }
  return false;
}

// Nature requirement of a building, evaluated in place.
function checkReq(def, x, y) {
  if (!def.req) return { ok: true };
  if (def.req.coast && !touchesTileType(x, y, def.size, isWaterTile)) {
    return { ok: false, why: 'Must be built at the waterline' };
  }
  if (def.req.rock && !touchesTileType(x, y, def.size, t => t === TILE.ROCK)) {
    return { ok: false, why: 'Must be built against a mountain' };
  }
  if (def.req.trees) {
    const n = countTreesAround(x, y, def.size, def.req.trees.r);
    if (n < def.req.trees.n) return { ok: false, why: `Needs ${def.req.trees.n} trees nearby (${n} found)` };
  }
  if (def.req.pasture) {
    const n = countPastureAround(x, y, def.size, def.req.pasture.r);
    if (n < def.req.pasture.n) return { ok: false, why: `Needs ${def.req.pasture.n} free grass tiles around (${n} found)` };
  }
  return { ok: true };
}

function canPlace(key, x, y, ignoreCost) {
  const def = BUILDINGS[key];
  if (!def) return { ok: false, why: 'Unknown building' };
  if (def.tier > G.unlocked) return { ok: false, why: 'Not yet unlocked' };
  if (FERTILITY_CROPS.includes(key)) { // explain infertile islands first
    const isl = islandAt(x, y);
    const fert = isl ? G.fertility[isl] : null;
    if (fert && !fert[key]) {
      const what = { sheep: 'raise sheep', grain: 'grow grain', potato: 'grow potatoes', spice: 'grow spice' }[key];
      return { ok: false, why: `This island cannot ${what} — found a colony on another island` };
    }
  }
  for (const [tx, ty] of footprintTiles(x, y, def.size)) {
    if (!inBounds(tx, ty)) return { ok: false, why: 'Out of bounds' };
    const t = G.tiles[idx(tx, ty)];
    const groundOk = t === TILE.GRASS || t === TILE.TREE || (def.allowSand && t === TILE.SAND);
    if (!groundOk) return { ok: false, why: 'Cannot build on this terrain' };
    if (G.grid[idx(tx, ty)]) return { ok: false, why: 'Space is occupied' };
    if (G.roads[idx(tx, ty)]) return { ok: false, why: 'A road is in the way' };
    if (!def.ignoreZone && !G.zone[idx(tx, ty)]) return { ok: false, why: 'Outside the building area — markets and depots extend it' };
  }
  if (def.coastal) { // kontor: must stand at the waterline
    let coast = false;
    for (let ty = y - 2; ty <= y + def.size + 1 && !coast; ty++) {
      for (let tx = x - 2; tx <= x + def.size + 1 && !coast; tx++) {
        if (isWaterTile(tileAt(tx, ty))) coast = true;
      }
    }
    if (!coast) return { ok: false, why: 'A Kontor must be founded at the waterline' };
  }
  const rq = checkReq(def, x, y);
  if (!rq.ok) return rq;
  if (!ignoreCost && !canAfford(def.cost)) return { ok: false, why: 'Not enough resources' };
  return { ok: true };
}

function placeBuilding(key, x, y, free) {
  const chk = canPlace(key, x, y, free);
  if (!chk.ok) return chk;
  const def = BUILDINGS[key];
  if (!free) payCost(def.cost);

  // clear trees under the footprint (+1 wood each)
  const cap = storageCap();
  for (const [tx, ty] of footprintTiles(x, y, def.size)) {
    if (G.tiles[idx(tx, ty)] === TILE.TREE) {
      G.tiles[idx(tx, ty)] = TILE.GRASS;
      G.stock.wood = Math.min(cap, G.stock.wood + 1);
    }
  }

  const b = {
    id: G.nextId++, key, x, y,
    progress: free ? def.buildTime : 0,
    done: free || def.buildTime === 0,
    tier: 0, res: key === 'house' ? 2 : 0,
    t: 0, acc: {}, sat: {}, svc: {},
    growT: 0, conT: 0, carrierOut: false,
    connected: false, cond: true, status: 'build', condWhy: '',
  };
  for (const [tx, ty] of footprintTiles(x, y, def.size)) G.grid[idx(tx, ty)] = b;
  G.buildings.push(b);
  recomputeAll();
  sfx('place', x, y);
  fx('dust', x + def.size / 2, y + def.size / 2);
  return { ok: true, b };
}

function placeRoad(x, y) {
  if (!inBounds(x, y)) return false;
  const i = idx(x, y);
  const t = G.tiles[i];
  if (G.roads[i] || G.grid[i]) return false;
  if (t !== TILE.GRASS && t !== TILE.TREE && t !== TILE.SAND) return false;
  if (!G.zone[i]) return false;
  if ((G.stock.gold || 0) < ROAD_COST) return false;
  G.stock.gold -= ROAD_COST;
  if (t === TILE.TREE) {
    G.tiles[i] = TILE.GRASS;
    G.stock.wood = Math.min(storageCap(), G.stock.wood + 1);
  }
  G.roads[i] = 1;
  recomputeRoads();
  return true;
}

function demolishAt(x, y) {
  if (!inBounds(x, y)) return false;
  const i = idx(x, y);
  if (G.roads[i]) {
    G.roads[i] = 0;
    recomputeRoads();
    sfx('demolish');
    return true;
  }
  const b = G.grid[i];
  if (!b) return false;
  if (b.key === 'warehouse') { toast('The Warehouse cannot be demolished!'); sfx('error'); return false; }
  removeBuilding(b);
  sfx('demolish');
  return true;
}

function removeBuilding(b, refund = true) {
  const def = BUILDINGS[b.key];
  fx('crumble', b.x + def.size / 2, b.y + def.size / 2);
  for (const [tx, ty] of footprintTiles(b.x, b.y, def.size)) G.grid[idx(tx, ty)] = null;
  G.buildings = G.buildings.filter(o => o !== b);
  if (G.selected === b.id) G.selected = null;
  if (refund) { // 50% back
    const cap50 = storageCap();
    G.stock.gold += Math.floor((def.cost.gold || 0) * 0.5);
    G.stock.wood = Math.min(cap50, G.stock.wood + Math.floor((def.cost.wood || 0) * 0.5));
    G.stock.tools = Math.min(cap50, G.stock.tools + Math.floor((def.cost.tools || 0) * 0.5));
  }
  recomputeAll();
}

/* ---------------- derived state ---------------- */

function recomputeAll() {
  recomputeZone();
  recomputeRoads(); // also refreshes services + conditions
}

function recomputeZone() {
  const zone = new Uint8Array(MAPW * MAPH);
  for (const b of G.buildings) {
    const def = BUILDINGS[b.key];
    if (!def.zone || (!b.done && b.key !== 'warehouse')) continue;
    const cx = b.x + (def.size - 1) / 2, cy = b.y + (def.size - 1) / 2;
    const r = def.zone;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(MAPH - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(MAPW - 1, Math.ceil(cx + r)); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r * r) zone[idx(x, y)] = 1;
      }
    }
  }
  G.zone = zone;
}

/* BFS over roads from warehouse/depot footprints. */
function recomputeRoads() {
  const ok = new Uint8Array(MAPW * MAPH);
  const queue = [];
  for (const b of G.buildings) {
    if (!isBase(b)) continue;
    const def = BUILDINGS[b.key];
    for (const [nx, ny] of footprintNeighbors(b.x, b.y, def.size)) {
      if (inBounds(nx, ny) && G.roads[idx(nx, ny)] && !ok[idx(nx, ny)]) {
        ok[idx(nx, ny)] = 1;
        queue.push([nx, ny]);
      }
    }
  }
  while (queue.length) {
    const [x, y] = queue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const i = idx(nx, ny);
      if (G.roads[i] && !ok[i]) { ok[i] = 1; queue.push([nx, ny]); }
    }
  }
  G.roadOk = ok;

  // building connectivity
  for (const b of G.buildings) {
    const def = BUILDINGS[b.key];
    if (!def.needsRoad) { b.connected = true; continue; }
    let conn = false;
    for (const [nx, ny] of footprintNeighbors(b.x, b.y, def.size)) {
      if (!inBounds(nx, ny)) continue;
      if (G.roadOk[idx(nx, ny)]) { conn = true; break; }
      const nb = G.grid[idx(nx, ny)];
      if (nb && isBase(nb)) { conn = true; break; }
    }
    b.connected = conn;
  }

  recomputeServices();
  recomputeConditions();
}

function recomputeServices() {
  const services = [];
  for (const b of G.buildings) {
    const def = BUILDINGS[b.key];
    if (def.service && b.done && b.connected) {
      services.push({
        type: def.service,
        cx: b.x + (def.size - 1) / 2,
        cy: b.y + (def.size - 1) / 2,
        r: def.radius,
      });
    }
  }
  for (const h of G.buildings) {
    if (h.key !== 'house') continue;
    h.svc = {};
    for (const s of services) {
      const dx = h.x - s.cx, dy = h.y - s.cy;
      if (dx * dx + dy * dy <= s.r * s.r) h.svc[s.type] = true;
    }
  }
}

function recomputeConditions() {
  for (const b of G.buildings) {
    const def = BUILDINGS[b.key];
    if (!def.req) { b.cond = true; continue; }
    const rq = checkReq(def, b.x, b.y);
    b.cond = rq.ok;
    b.condWhy = rq.why || '';
  }
}

/* ---------------- simulation tick ---------------- */

function simTick(dt) {
  G.time += dt;

  // periodic nature-condition recheck (trees grow scarce, pasture gets built over)
  G.condT += dt;
  if (G.condT >= COND_INTERVAL) {
    G.condT = 0;
    recomputeConditions();
  }

  const cap = storageCap();

  for (const b of G.buildings) {
    const def = BUILDINGS[b.key];

    // construction
    if (!b.done) {
      b.progress += dt;
      if (b.progress >= def.buildTime) {
        b.done = true;
        b.status = 'ok';
        b.bornT = G.time; // completion "pop" animation
        fx('complete', b.x + def.size / 2, b.y + def.size / 2);
        recomputeAll();
      } else {
        b.status = 'build';
        continue;
      }
    }

    if (b.fire != null) { tickFire(b, dt); continue; }

    if (def.prod) tickProduction(b, def, dt, cap);
    else if (b.key === 'house') tickHouse(b, dt);
    else if (b.key === 'watchtower') tickTower(b, dt);
    else b.status = b.connected ? 'ok' : 'noroad';
  }

  tickWalkers(dt);
  tickRates(dt);
  tickEvents(dt);
  tickPirate(dt);
  tickTrader(dt);
  tickExpedition(dt);
  tickShots(dt);
  tickPopHist(dt);
  if (typeof AI !== 'undefined') AI.tick(dt);
  checkUnlocks();
  checkQuests();

  G.achT += dt;
  if (G.achT >= 1) {
    G.achT = 0;
    checkAchievements();
  }
}

function tickPopHist(dt) {
  G.popHistT += dt;
  if (G.popHistT < 5) return;
  G.popHistT = 0;
  G.popHist.push([Math.floor(G.time), popOf(0), popOf(1), popOf(2), popOf(3)]);
  while (G.popHist.length > 400) G.popHist.shift();
}

/* ---------------- random events ---------------- */

const EVENTS = [
  { w: 3, run() {
    G.stock.food = Math.min(storageCap(), G.stock.food + 15);
    toast('🎣 A rich shoal passes the coast! +15 food');
  } },
  { w: 3, run() {
    G.stock.wood = Math.min(storageCap(), G.stock.wood + 12);
    toast('🌊 Driftwood washes ashore: +12 wood');
  } },
  { w: 2, run() {
    G.stock.gold += 120;
    toast('🎩 A travelling noble admires your town and donates 120 gold');
  } },
  { w: 2, run() {
    G.stormT = 35;
    toast('⛈ Stormy seas! Your fishers shelter in the harbour for a while');
  } },
  { w: 2, when: () => totalPop() >= 20, run() {
    const c = G.buildings.filter(b => b.done && b.fire == null && !isBase(b));
    if (c.length) ignite(c[Math.floor(Math.random() * c.length)]);
  } },
  { w: 2, when: () => totalPop() >= 60, run() {
    const houses = G.buildings.filter(b => b.key === 'house' && b.done && b.sick == null && b.res > 2);
    if (!houses.length) return;
    const h0 = houses[Math.floor(Math.random() * houses.length)];
    let infected = 0;
    for (const h of houses) {
      const d2 = (h.x - h0.x) ** 2 + (h.y - h0.y) ** 2;
      if (h === h0 || (d2 <= 36 && infected < 3)) { sicken(h); infected++; }
    }
    toast('🤒 Plague breaks out! ' + infected + ' household(s) fall ill — chapels speed recovery', true, 'danger');
    sfx('error');
  } },
];

function tickEvents(dt) {
  if (G.stormT > 0) G.stormT = Math.max(0, G.stormT - dt);
  if (totalPop() < 10) return; // let the early game breathe
  G.eventT -= dt;
  if (G.eventT > 0) return;
  G.eventT = 100 + Math.random() * 80;
  const eligible = EVENTS.filter(e => !e.when || e.when());
  const total = eligible.reduce((s, e) => s + e.w, 0);
  let pick = Math.random() * total;
  for (const e of eligible) {
    pick -= e.w;
    if (pick <= 0) { e.run(); break; }
  }
}

/* ---------------- fire ---------------- */

const FIRE_MAX = 12; // seconds until a building burns down

function ignite(b) {
  if (b.fire != null || !b.done || isBase(b)) return;
  b.fire = FIRE_MAX;
  toast(`🔥 Fire at the ${BUILDINGS[b.key].name}!`, true, 'danger');
  sfx('error', b.x, b.y);
  fx('spark', b.x + 0.5, b.y + 0.5);
}

function fireCovered(b) {
  for (const f of G.buildings) {
    if (f.key !== 'firehouse' || !f.done || !f.connected) continue;
    const fd = BUILDINGS.firehouse;
    const cx = f.x + (fd.size - 1) / 2, cy = f.y + (fd.size - 1) / 2;
    if ((b.x - cx) ** 2 + (b.y - cy) ** 2 <= fd.radius * fd.radius) return true;
  }
  return false;
}

function tickFire(b, dt) {
  b.status = 'fire';
  if (fireCovered(b)) {
    b.fire += dt * 3; // the brigade beats the flames back
    if (b.fire >= FIRE_MAX) {
      b.fire = null;
      toast(`🚒 The brigade saved the ${BUILDINGS[b.key].name}!`, false, 'good');
      award('firefighter');
    }
  } else {
    b.fire -= dt;
    if (b.fire <= 0) {
      toast(`🔥 The ${BUILDINGS[b.key].name} burned to the ground!`, true, 'danger');
      sfx('demolish', b.x, b.y);
      removeBuilding(b, false);
    }
  }
}

function sicken(h) {
  h.sick = h.svc.faith ? 18 : 30;
  h.sickT = 0;
}

/* ---------------- pirates & watchtowers ---------------- */

/* BFS over water from a start tile until goalTest hits; returns [[x,y],...]. */
function waterPath(startIdx, goalTest) {
  const parent = new Map();
  const queue = [startIdx];
  parent.set(startIdx, -1);
  let found = -1;
  for (let qi = 0; qi < queue.length && found < 0; qi++) {
    const cur = queue[qi];
    if (goalTest(cur)) { found = cur; break; }
    const x = cur % MAPW, y = (cur - x) / MAPW;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (!parent.has(ni) && isWaterTile(G.tiles[ni])) { parent.set(ni, cur); queue.push(ni); }
    }
  }
  if (found < 0) return null;
  const path = [];
  for (let cur = found; cur !== -1; cur = parent.get(cur)) {
    path.push([cur % MAPW, Math.floor(cur / MAPW)]);
  }
  return path;
}

function spawnPirate() {
  // anchor spot: shore water near the player's buildings
  const cands = [];
  for (const b of G.buildings) {
    if (!b.done) continue;
    for (let ty = b.y - 5; ty <= b.y + 5; ty++) {
      for (let tx = b.x - 5; tx <= b.x + 5; tx++) {
        if (!inBounds(tx, ty)) continue;
        const i = idx(tx, ty);
        if (isWaterTile(G.tiles[i]) && G.shore[i]) cands.push(i);
      }
    }
  }
  if (!cands.length) return;
  const target = cands[Math.floor(Math.random() * cands.length)];
  const path = waterPath(target, i => {
    const x = i % MAPW, y = (i - x) / MAPW;
    return x === 0 || y === 0 || x === MAPW - 1 || y === MAPH - 1;
  });
  if (!path || path.length < 3) return;
  // waterPath went target→edge; the ship sails edge→target
  const hp = 30 + Math.min(40, Math.floor(G.time / 60) * 2);
  G.pirate = {
    path, seg: 0, prog: 0,
    x: path[0][0], y: path[0][1],
    hp, maxHp: hp, state: 'approach', timer: 0,
  };
  G.pirateSeen = true;
  toast('🏴‍☠️ A pirate ship approaches! Watchtowers, to arms!', true);
  sfx('error');
}

function tickPirate(dt) {
  if (!G.pirate) {
    if (totalPop() < 50) return;
    G.pirateT -= dt;
    if (G.pirateT <= 0) {
      G.pirateT = 280 + Math.random() * 180;
      spawnPirate();
    }
    return;
  }
  const p = G.pirate;
  if (p.state === 'sinking') {
    p.timer -= dt;
    if (p.timer <= 0) G.pirate = null;
    return;
  }
  if (p.state === 'raid') {
    p.timer -= dt;
    if (p.timer <= 0) {
      doRaid(p);
      p.state = 'flee';
      p.path = p.path.slice().reverse();
      p.seg = 0; p.prog = 0;
    }
    return;
  }
  p.prog += dt * 2.2;
  while (p.prog >= 1 && p.seg < p.path.length - 1) { p.prog -= 1; p.seg++; }
  if (p.seg >= p.path.length - 1) {
    if (p.state === 'approach') {
      p.state = 'raid';
      p.timer = 12;
      toast('🏴‍☠️ Pirates anchor off your coast!');
    } else {
      G.pirate = null; // got away
    }
    return;
  }
  const a = p.path[p.seg], n = p.path[Math.min(p.seg + 1, p.path.length - 1)];
  p.x = a[0] + (n[0] - a[0]) * p.prog;
  p.y = a[1] + (n[1] - a[1]) * p.prog;
}

function doRaid(p) {
  const stolen = [];
  const goods = GOODS.filter(g => G.stock[g] > 10);
  for (let k = 0; k < 3 && goods.length; k++) {
    const g = goods.splice(Math.floor(Math.random() * goods.length), 1)[0];
    const amt = Math.max(3, Math.floor(G.stock[g] * (0.12 + Math.random() * 0.1)));
    G.stock[g] -= amt;
    stolen.push(`−${amt} ${RES_META[g].icon}`);
  }
  toast('🏴‍☠️ Pirates raided your stores! ' + (stolen.join('  ') || 'They found little.'), true, 'danger');
  fx('shake', p.x, p.y, { amp: 6 });
  if (Math.random() < 0.5) { // and sometimes they torch something
    const near = G.buildings.filter(b => b.done && b.fire == null && !isBase(b) &&
      (b.x - p.x) ** 2 + (b.y - p.y) ** 2 < 100);
    if (near.length) ignite(near[Math.floor(Math.random() * near.length)]);
  }
}

function hitPirate(dmg) {
  const p = G.pirate;
  if (!p || p.state === 'sinking') return;
  p.hp -= dmg;
  if (p.hp <= 0) {
    p.state = 'sinking';
    p.timer = 2.5;
    G.pirateSunk++;
    G.stock.gold += 150;
    toast('💥 Pirate ship sunk! Salvage: +150 🪙', true, 'good');
    sfx('unlock');
    fx('splash', p.x, p.y);
    fx('float', p.x, p.y, { txt: '+150 🪙', col: '#ffd75e' });
  }
}

function tickTower(b, dt) {
  b.status = 'ok';
  if (!b.done) return;
  b.t += dt;
  const p = G.pirate;
  if (!p || p.state === 'sinking') return;
  const range = BUILDINGS.watchtower.range;
  if ((b.x - p.x) ** 2 + (b.y - p.y) ** 2 > range * range) return;
  if (b.t < 2) return;
  b.t = 0;
  G.shots.push({ x0: b.x, y0: b.y, x1: p.x, y1: p.y, t: 0 });
  hitPirate(12);
  sfx('cannon', b.x, b.y);
  fx('spark', p.x, p.y);
  fx('shake', b.x, b.y, { amp: 2 });
}

function tickShots(dt) {
  for (let i = G.shots.length - 1; i >= 0; i--) {
    G.shots[i].t += dt;
    if (G.shots[i].t > 0.8) G.shots.splice(i, 1);
  }
}

function checkQuests() {
  if (G.quest >= QUESTS.length) return;
  const q = QUESTS[G.quest];
  if (!q.check()) return;
  const cap = storageCap();
  const parts = [];
  for (const k in q.reward) {
    if (k === 'gold') G.stock.gold += q.reward[k];
    else G.stock[k] = Math.min(cap, (G.stock[k] || 0) + q.reward[k]);
    parts.push(`+${q.reward[k]} ${RES_META[k].icon}`);
  }
  G.quest++;
  sfx('bell');
  toast(`📜 Quest complete! ${parts.join(' ')}`, true, 'good');
  const wh = G.buildings.find(b => b.key === 'warehouse');
  if (wh) fx('float', wh.x + 1, wh.y + 1, { txt: parts.join(' '), col: '#ffd75e' });
}

/* Rolling ~60s window of stock snapshots → net production rate per good. */
function tickRates(dt) {
  G.rateT += dt;
  if (G.rateT < 1) return;
  G.rateT = 0;
  const snap = { time: G.time, s: {} };
  for (const g of GOODS) snap.s[g] = G.stock[g] || 0;
  snap.s.gold = G.stock.gold;
  G.rateHist.push(snap);
  while (G.rateHist.length > 75) G.rateHist.shift();

  // market pressure from player trades relaxes back to base prices
  for (const g in G.priceDrift) {
    const d = G.priceDrift[g];
    if (d > 0) G.priceDrift[g] = Math.max(0, d - 0.01);
    else if (d < 0) G.priceDrift[g] = Math.min(0, d + 0.01);
  }
}

function ratePerMin(good) {
  const h = G.rateHist;
  if (h.length < 2) return 0;
  const a = h[0], b = h[h.length - 1];
  const span = b.time - a.time;
  if (span < 5) return 0;
  return (b.s[good] - a.s[good]) / span * 60;
}

function tickProduction(b, def, dt, cap) {
  if (!b.connected) { b.status = 'noroad'; return; }
  if (!b.cond) { b.status = 'nocond'; return; }
  if (b.key === 'fisher' && G.stormT > 0) { b.status = 'storm'; return; }
  if (G.stock[def.prod.out] >= cap) { b.status = 'full'; return; }

  b.t += dt;
  if (b.t >= def.prod.cycle) {
    if (def.prod.in) {
      for (const k in def.prod.in) {
        if (G.stock[k] < def.prod.in[k]) {
          b.t = def.prod.cycle; // ready, waiting for input
          b.status = 'noinput';
          return;
        }
      }
      for (const k in def.prod.in) G.stock[k] -= def.prod.in[k];
    }
    G.stock[def.prod.out] = Math.min(cap, G.stock[def.prod.out] + def.prod.n);
    if (def.prod.out === 'spice') G.spiceMade = (G.spiceMade || 0) + def.prod.n;
    b.t = 0;
    spawnCarrier(b, def.prod.out);
  }
  b.status = 'ok';
}

function tickHouse(h, dt) {
  const tier = TIERS[h.tier];

  // plague: no taxes, no growth, residents dwindle until it passes
  if (h.sick != null) {
    h.sick -= dt;
    h.sickT = (h.sickT || 0) + dt;
    if (h.sickT >= 6) {
      h.sickT = 0;
      if (h.res > 2) h.res--;
    }
    if (h.sick <= 0) {
      h.sick = null;
      award('survivor');
    }
    h.status = 'sick';
    return;
  }

  // taxes
  G.stock.gold += h.res * tier.tax * dt;

  // goods consumption (fractional accumulators, consume whole units)
  h.conT += dt;
  if (h.conT >= 1) {
    const step = h.conT;
    h.conT = 0;
    for (const good in tier.goods) {
      h.acc[good] = (h.acc[good] || 0) + h.res * tier.goods[good] / 60 * step;
      if (h.acc[good] >= 1) {
        const want = Math.floor(h.acc[good]);
        const got = Math.min(want, Math.floor(G.stock[good] || 0));
        G.stock[good] -= got;
        h.acc[good] -= got;
        h.sat[good] = got >= want;
        if (!h.sat[good]) h.acc[good] = Math.min(h.acc[good], 2); // don't bank infinite debt
      } else if (h.sat[good] === undefined) {
        h.sat[good] = true; // grace until first consumption
      }
    }
  }

  // satisfaction summary
  let allSat = true, foodBad = false;
  for (const good in tier.goods) {
    if (h.sat[good] === false) { allSat = false; if (good === 'food') foodBad = true; }
  }
  for (const s of tier.services) {
    if (!h.svc[s]) allSat = false;
  }

  h.status = allSat ? 'ok' : 'needs';

  // growth / shrink
  h.growT += dt;
  if (h.growT >= GROW_INTERVAL) {
    h.growT = 0;
    if (allSat && h.res < tier.resMax) h.res++;
    else if (foodBad && h.res > 1) h.res--;

    // automatic upgrade
    if (allSat && h.res >= tier.resMax && tier.upgrade && h.tier + 1 < G.unlocked) {
      tryUpgrade(h, tier);
    }
  }
}

function tryUpgrade(h, tier) {
  const next = TIERS[h.tier + 1];
  // next-tier services must already cover the house
  for (const s of next.services) if (!h.svc[s]) return;
  // the new tier's signature good must be in stock
  if ((G.stock[tier.upgrade.needsGood] || 0) < 1) return;
  if (!canAfford(tier.upgrade.cost)) return;
  payCost(tier.upgrade.cost);
  h.tier++;
  for (const k in h.sat) delete h.sat[k];
  for (const k in h.acc) delete h.acc[k];
  sfx('upgrade', h.x, h.y);
  fx('complete', h.x + 0.5, h.y + 0.5);
  fx('float', h.x + 0.5, h.y + 0.5, { txt: `⬆ ${next.name}!`, col: '#8ad06c' });
  toast(`A house advanced to ${next.name}! ${BUILDINGS.house.icon}`, false, 'good');
}

/* Why is this house not upgrading? Returns a human-readable reason, or
 * null when the house is at the top tier / about to upgrade. */
function whyNoUpgrade(h) {
  const tier = TIERS[h.tier];
  if (!tier.upgrade) return null;
  if (h.tier + 1 >= G.unlocked) {
    const u = UNLOCKS[h.tier + 1];
    return u ? `Locked — reach ${u.count} ${u.label}` : 'Locked';
  }
  for (const good in tier.goods) { // upgrades only fire while fully satisfied
    if (h.sat[good] === false) return `Needs are not met (${RES_META[good].name})`;
  }
  const next = TIERS[h.tier + 1];
  for (const s of next.services) {
    if (!h.svc[s]) return `Missing: ${SERVICE_NAMES[s]} coverage`;
  }
  if (h.res < tier.resMax) return `Not full yet (${h.res}/${tier.resMax})`;
  const need = tier.upgrade.needsGood;
  if ((G.stock[need] || 0) < 1) return `Needs 1 ${RES_META[need].name} in stock`;
  if (!canAfford(tier.upgrade.cost)) return 'Cannot afford the upgrade cost yet';
  return null;
}

function checkUnlocks() {
  for (let t = 1; t < UNLOCKS.length; t++) {
    if (G.unlocked > t) continue;
    const u = UNLOCKS[t];
    if (popOf(u.tier) >= u.count) {
      G.unlocked = t + 1;
      sfx('unlock');
      toast(`${TIERS[t].name} unlocked! New buildings are available.`, true);
      if (Hooks.onChange) Hooks.onChange();
    }
  }
  if (!G.flourished && popOf(2) >= 60) {
    G.flourished = true;
    sfx('unlock');
    toast('👑 Your island flourishes! The Queen sends her regards.', true, 'good');
  }
}

/* ---------------- achievements ---------------- */

function award(id) {
  if (G.achievements[id] != null) return;
  const a = ACHIEVEMENTS.find(o => o.id === id);
  if (!a) return;
  G.achievements[id] = Math.floor(G.time);
  sfx('unlock');
  toast(`🏆 Achievement: ${a.name} — ${a.desc}`, true, 'good');
}

function checkAchievements() {
  for (const a of ACHIEVEMENTS) {
    if (a.check && G.achievements[a.id] == null && a.check()) award(a.id);
  }
}

/* ---------------- walkers: carriers & villagers (visual life) ---------------- */

const WALKER_MAX = 48;

function walkableTile(x, y) {
  if (!inBounds(x, y)) return false;
  const i = idx(x, y);
  if (G.grid[i]) return false;
  const t = G.tiles[i];
  return t === TILE.GRASS || t === TILE.SAND;
}

// Road tiles adjacent to the warehouse / finished depots.
function baseAdjacentRoads() {
  const s = new Set();
  for (const b of G.buildings) {
    if (b.key !== 'warehouse' && !(b.key === 'depot' && b.done)) continue;
    for (const [nx, ny] of footprintNeighbors(b.x, b.y, BUILDINGS[b.key].size)) {
      if (inBounds(nx, ny) && G.roads[idx(nx, ny)]) s.add(idx(nx, ny));
    }
  }
  return s;
}

/* Shortest road path from a building to the warehouse (BFS). */
function roadPathToBase(b) {
  const targets = baseAdjacentRoads();
  if (!targets.size) return null;
  const starts = [];
  for (const [nx, ny] of footprintNeighbors(b.x, b.y, BUILDINGS[b.key].size)) {
    if (inBounds(nx, ny) && G.roads[idx(nx, ny)] && G.roadOk[idx(nx, ny)]) starts.push(idx(nx, ny));
  }
  if (!starts.length) return null;
  const parent = new Map();
  const queue = [];
  for (const s of starts) { parent.set(s, -1); queue.push(s); }
  let found = -1;
  for (let qi = 0; qi < queue.length && found < 0; qi++) {
    const cur = queue[qi];
    if (targets.has(cur)) { found = cur; break; }
    const cx = cur % MAPW, cy = (cur - cx) / MAPW;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (G.roads[ni] && !parent.has(ni)) { parent.set(ni, cur); queue.push(ni); }
    }
  }
  if (found < 0) return null;
  const path = [];
  for (let cur = found; cur !== -1; cur = parent.get(cur)) {
    path.push([cur % MAPW, Math.floor(cur / MAPW)]);
  }
  path.reverse();
  return path;
}

function spawnCarrier(b, good) {
  if (b.carrierOut || G.walkers.length >= WALKER_MAX) return;
  const path = roadPathToBase(b);
  if (!path || path.length < 2) return;
  b.carrierOut = true;
  G.walkers.push({
    id: G.nextWalkerId++, kind: 'carrier', bId: b.id,
    path, seg: 0, prog: 0, speed: 1.6, phase: 'to', carry: good,
    fx: path[0][0], fy: path[0][1], tint: '#7a5c3a',
  });
}

/* Greedy walk towards a target over open ground & roads. */
function strollPath(sx, sy, tx, ty) {
  const path = [[sx, sy]];
  let cx = sx, cy = sy;
  for (let i = 0; i < 24 && (cx !== tx || cy !== ty); i++) {
    let best = null, bestD = Math.abs(cx - tx) + Math.abs(cy - ty);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (!walkableTile(nx, ny)) continue;
      const d = Math.abs(nx - tx) + Math.abs(ny - ty);
      if (d < bestD) { bestD = d; best = [nx, ny]; }
    }
    if (!best) break;
    path.push(best);
    cx = best[0]; cy = best[1];
  }
  return path;
}

function trySpawnVillager() {
  if (G.walkers.length >= WALKER_MAX) return;
  let vCount = 0;
  for (const w of G.walkers) if (w.kind === 'villager') vCount++;
  if (vCount >= Math.min(14, 2 + Math.floor(totalPop() / 6))) return;
  const houses = G.buildings.filter(b => b.key === 'house' && b.done && b.res > 0);
  if (!houses.length) return;
  const h = houses[Math.floor(Math.random() * houses.length)];
  const spots = [];
  for (const [nx, ny] of footprintNeighbors(h.x, h.y, 1)) {
    if (walkableTile(nx, ny)) spots.push([nx, ny]);
  }
  if (!spots.length) return;
  const [sx, sy] = spots[Math.floor(Math.random() * spots.length)];
  let target = null;
  for (let tries = 0; tries < 8 && !target; tries++) {
    const tx = sx + Math.floor(Math.random() * 11) - 5;
    const ty = sy + Math.floor(Math.random() * 11) - 5;
    if ((tx !== sx || ty !== sy) && walkableTile(tx, ty)) target = [tx, ty];
  }
  if (!target) return;
  const out = strollPath(sx, sy, target[0], target[1]);
  if (out.length < 2) return;
  const path = out.concat(out.slice(0, -1).reverse()); // there and back again
  const tints = ['#a84a3c', '#3a6ea8', '#5d7a36', '#8a4a78', '#b8862a', '#705a48'];
  G.walkers.push({
    id: G.nextWalkerId++, kind: 'villager', bId: h.id,
    path, seg: 0, prog: 0, speed: 0.9 + Math.random() * 0.4, phase: 'stroll', carry: null,
    fx: sx, fy: sy, tint: tints[(h.x * 3 + h.y * 5 + vCount) % tints.length],
  });
}

function tickWalkers(dt) {
  G.vilT += dt;
  if (G.vilT >= 2.5) { G.vilT = 0; trySpawnVillager(); }
  for (let i = G.walkers.length - 1; i >= 0; i--) {
    const w = G.walkers[i];
    w.prog += dt * w.speed;
    let dead = false;
    while (w.prog >= 1) {
      w.prog -= 1;
      w.seg++;
      if (w.seg >= w.path.length - 1) {
        if (w.kind === 'carrier' && w.phase === 'to') {
          w.phase = 'back';
          w.carry = null;
          w.path = w.path.slice().reverse();
          w.seg = 0;
        } else {
          if (w.kind === 'carrier') {
            const b = G.buildings.find(o => o.id === w.bId);
            if (b) b.carrierOut = false;
          }
          G.walkers.splice(i, 1);
          dead = true;
          break;
        }
      }
    }
    if (dead) continue;
    const a = w.path[w.seg];
    const n = w.path[Math.min(w.seg + 1, w.path.length - 1)];
    w.fx = a[0] + (n[0] - a[0]) * w.prog;
    w.fy = a[1] + (n[1] - a[1]) * w.prog;
  }
}

/* ---------------- trade ---------------- */

/* Current market prices: base price shifted by supply/demand pressure the
 * player creates. Buying pushes prices up, selling pushes them down; the
 * drift relaxes back to zero in tickRates. */
function priceOf(good) {
  const d = (G.priceDrift && G.priceDrift[good]) || 0;
  return {
    buy: Math.max(1, Math.round(TRADE[good].buy * (1 + d))),
    sell: Math.max(1, Math.round(TRADE[good].sell * (1 + d))),
    drift: d,
  };
}

function nudgePrice(good, delta) {
  const d = ((G.priceDrift[good] || 0) + delta);
  G.priceDrift[good] = Math.max(-0.35, Math.min(0.35, d));
}

function buyGood(good, n) {
  const price = priceOf(good).buy * n;
  const cap = storageCap();
  if (G.stock.gold < price) { sfx('error'); return false; }
  if (G.stock[good] + n > cap) { toast('Storage is full!'); sfx('error'); return false; }
  G.stock.gold -= price;
  G.stock[good] += n;
  nudgePrice(good, 0.004 * n);
  sfx('coin');
  return true;
}

function sellGood(good, n) {
  if (G.stock[good] < n) { sfx('error'); return false; }
  G.stock[good] -= n;
  G.stock.gold += priceOf(good).sell * n;
  nudgePrice(good, -0.004 * n);
  sfx('coin');
  return true;
}

/* ---------------- visiting merchant ship ---------------- */

/* While the merchant is docked her deals beat the market: she sells below
 * the base buy price and pays a premium over the base sell price. */
function makeDeals() {
  const cap = storageCap();
  const deals = [];
  const pool = GOODS.slice();
  for (let k = 0; k < 3 && pool.length; k++) {
    // prefer goods the player lacks (offer to sell) or hoards (offer to buy)
    let best = 0;
    for (let i = 1; i < pool.length; i++) {
      const si = G.stock[pool[i]] || 0, sb = G.stock[pool[best]] || 0;
      const wi = si < 10 || si > cap * 0.5 ? 1 : 0;
      const wb = sb < 10 || sb > cap * 0.5 ? 1 : 0;
      if (wi > wb || (wi === wb && Math.random() < 0.5)) best = i;
    }
    const g = pool.splice(best, 1)[0];
    const mode = (G.stock[g] || 0) < 10 ? 'buy' : 'sell'; // from the player's side
    const price = mode === 'buy'
      ? Math.max(1, Math.round(TRADE[g].buy * 0.7))
      : Math.round(TRADE[g].sell * 1.4);
    deals.push({ good: g, mode, left: 20, price });
  }
  return deals;
}

function spawnTrader() {
  const wh = G.buildings.find(b => b.key === 'warehouse');
  if (!wh) return;
  // anchor: the shore-water tile closest to the warehouse
  let target = null, bestD = Infinity;
  for (let ty = wh.y - 10; ty <= wh.y + 10; ty++) {
    for (let tx = wh.x - 10; tx <= wh.x + 10; tx++) {
      if (!inBounds(tx, ty)) continue;
      const i = idx(tx, ty);
      if (isWaterTile(G.tiles[i]) && G.shore[i]) {
        const d = (tx - wh.x) ** 2 + (ty - wh.y) ** 2;
        if (d < bestD) { bestD = d; target = i; }
      }
    }
  }
  if (target == null) return;
  const path = waterPath(target, i => {
    const x = i % MAPW, y = (i - x) / MAPW;
    return x === 0 || y === 0 || x === MAPW - 1 || y === MAPH - 1;
  });
  if (!path || path.length < 3) return;
  G.trader = {
    path, seg: 0, prog: 0,
    x: path[0][0], y: path[0][1],
    state: 'approach', timer: 0, deals: makeDeals(),
  };
  toast('⛵ A merchant ship approaches your harbour!');
}

function tickTrader(dt) {
  if (!G.trader) {
    if (totalPop() < 15) return;
    G.traderT -= dt;
    if (G.traderT <= 0) {
      G.traderT = 150 + Math.random() * 90;
      spawnTrader();
    }
    return;
  }
  const t = G.trader;
  if (t.state === 'docked') {
    t.timer -= dt;
    if (t.timer <= 0) {
      t.state = 'leave';
      t.path = t.path.slice().reverse();
      t.seg = 0; t.prog = 0;
      toast('⛵ The merchant ship sets sail again.');
    }
    return;
  }
  t.prog += dt * 2.4;
  while (t.prog >= 1 && t.seg < t.path.length - 1) { t.prog -= 1; t.seg++; }
  if (t.seg >= t.path.length - 1) {
    if (t.state === 'approach') {
      t.state = 'docked';
      t.timer = 45;
      sfx('bell');
      toast('⚓ A merchant ship has docked! Special offers — press T', true, 'good');
    } else {
      G.trader = null;
    }
    return;
  }
  const a = t.path[t.seg], n = t.path[Math.min(t.seg + 1, t.path.length - 1)];
  t.x = a[0] + (n[0] - a[0]) * t.prog;
  t.y = a[1] + (n[1] - a[1]) * t.prog;
}

/* Trade against a docked merchant's deal instead of the open market. */
function dealTrade(i, n) {
  const t = G.trader;
  if (!t || t.state !== 'docked' || !t.deals[i]) { sfx('error'); return false; }
  const d = t.deals[i];
  n = Math.min(n, d.left);
  if (n <= 0) { sfx('error'); return false; }
  if (d.mode === 'buy') { // player buys from her
    const price = d.price * n;
    if (G.stock.gold < price) { sfx('error'); return false; }
    if (G.stock[d.good] + n > storageCap()) { toast('Storage is full!'); sfx('error'); return false; }
    G.stock.gold -= price;
    G.stock[d.good] += n;
  } else { // player sells to her
    if (G.stock[d.good] < n) { sfx('error'); return false; }
    G.stock[d.good] -= n;
    G.stock.gold += d.price * n;
  }
  d.left -= n;
  sfx('coin');
  return true;
}

/* ---------------- naval expeditions ---------------- */

function homeIslandId() {
  const wh = G.buildings.find(b => b.key === 'warehouse');
  return wh ? islandAt(wh.x, wh.y) : 0;
}

function startExpedition() {
  if (G.expedition) return { ok: false, why: 'A ship is already at sea' };
  if (!canAfford(EXPEDITION_COST)) return { ok: false, why: 'Cannot afford to outfit the ship' };
  payCost(EXPEDITION_COST);
  let dur = EXPEDITION_TIME[0] + Math.random() * (EXPEDITION_TIME[1] - EXPEDITION_TIME[0]);
  const bonus = G.expBonus;
  if (bonus) dur *= 0.5;
  G.expBonus = false;
  G.expedition = { t: 0, dur, bonus };
  sfx('bell');
  toast('⛵ An expedition sets sail! May the winds be kind.', true);
  return { ok: true };
}

function tickExpedition(dt) {
  const e = G.expedition;
  if (!e) return;
  e.t += dt;
  if (e.t < e.dur) return;
  G.expedition = null;
  G.expeditionsDone = (G.expeditionsDone || 0) + 1;
  resolveExpedition(e);
}

function resolveExpedition(e) {
  const cap = storageCap();
  const mul = e.bonus ? 1.5 : 1;
  const roll = Math.random();
  if (roll < 0.35) {
    const g = GOODS[Math.floor(Math.random() * GOODS.length)];
    const amt = Math.round((25 + Math.floor(Math.random() * 35)) * mul);
    G.stock[g] = Math.min(cap, (G.stock[g] || 0) + amt);
    toast(`⛵ The expedition returns with a rich haul: +${amt} ${RES_META[g].icon}`, true, 'good');
  } else if (roll < 0.6) {
    const amt = Math.round((250 + Math.floor(Math.random() * 300)) * mul);
    G.stock.gold += amt;
    toast(`⛵ The expedition salvaged sunken treasure: +${amt} 🪙`, true, 'good');
  } else if (roll < 0.75) {
    G.expBonus = true;
    toast('⛵ The expedition charted new waters — the next voyage will be swift and rich!', true, 'good');
  } else if (roll < 0.9) {
    // exotic seeds: enable a missing crop on the home island (never spice)
    const f = G.fertility[homeIslandId()];
    const missing = f ? FERTILITY_CROPS.filter(c => c !== 'spice' && !f[c]) : [];
    if (missing.length) {
      const c = missing[Math.floor(Math.random() * missing.length)];
      f[c] = true;
      toast(`⛵ The expedition brings exotic seeds — your island can now support a ${BUILDINGS[c].name}!`, true, 'good');
    } else {
      G.stock.gold += Math.round(200 * mul);
      toast('⛵ The expedition returns with a modest bounty: +200 🪙', true, 'good');
    }
  } else {
    toast('⛵ The expedition returns empty-handed, with wild tales of sea monsters…', true);
  }
  sfx('coin');
}

/* ---------------- new game / save / load ---------------- */

function newGame(seed) {
  G.seed = seed === undefined ? Math.floor(Math.random() * 1e9) : seed;
  const m = generateMap(G.seed);
  G.tiles = m.tiles;
  G.shore = m.shore;
  G.grid = new Array(MAPW * MAPH).fill(null);
  G.roads = new Uint8Array(MAPW * MAPH);
  G.roadOk = new Uint8Array(MAPW * MAPH);
  G.zone = new Uint8Array(MAPW * MAPH);
  G.buildings = [];
  G.nextId = 1;
  G.stock = { gold: 2500, wood: 40, tools: 20, iron: 0, food: 30, grain: 0, wool: 0, cloth: 0, potato: 0, liquor: 0, spice: 0 };
  G.time = 0;
  G.speed = 1;
  G.paused = false;
  G.unlocked = 1;
  G.selected = null;
  G.flourished = false;
  G.victoryShown = false;
  G.walkers = [];
  G.vilT = 0;
  G.nextWalkerId = 1;
  G.rateHist = [];
  G.rateT = 0;
  G.quest = 0;
  G.eventT = 120 + Math.random() * 60;
  G.stormT = 0;
  G.popHist = [];
  G.popHistT = 0;
  G.autopilot = false;

  G.pirate = null;
  G.pirateT = 360 + Math.random() * 120;
  G.pirateSeen = false;
  G.pirateSunk = 0;
  G.shots = [];

  G.trader = null;
  G.traderT = 150 + Math.random() * 90;
  G.priceDrift = {};
  G.expedition = null;
  G.expeditionsDone = 0;
  G.expBonus = false;
  G.achievements = {};
  G.achT = 0;
  G.spiceMade = 0;

  const spot = findWarehouseSpot(G.tiles);
  // warehouse placement bypasses zone (zone radiates FROM it)
  G.zone.fill(1);
  placeBuilding('warehouse', spot.x, spot.y, true);
  G.islands = floodFillIslands(G.tiles);
  G.fertility = assignFertility(G.islands, islandAt(spot.x, spot.y), G.seed);
  recomputeAll();
  return spot;
}

function saveGame() {
  try {
    const data = {
      v: 1,
      seed: G.seed,
      time: G.time,
      unlocked: G.unlocked,
      flourished: G.flourished,
      victoryShown: G.victoryShown,
      quest: G.quest,
      popHist: G.popHist,
      autopilot: G.autopilot,
      fertility: G.fertility,
      pirateSeen: G.pirateSeen,
      pirateSunk: G.pirateSunk,
      priceDrift: G.priceDrift,
      expedition: G.expedition,
      expeditionsDone: G.expeditionsDone,
      expBonus: G.expBonus,
      achievements: G.achievements,
      spiceMade: G.spiceMade,
      stock: G.stock,
      tiles: Array.from(G.tiles),
      roads: Array.from(G.roads),
      buildings: G.buildings.map(b => ({
        key: b.key, x: b.x, y: b.y, tier: b.tier, res: b.res,
        progress: b.progress, done: b.done,
      })),
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    return false;
  }
}

function loadGame() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(SAVE_KEY) || localStorage.getItem(SAVE_KEY_LEGACY));
  } catch (e) { return false; }
  if (!data || data.v !== 1) return false;
  if (!data.tiles || data.tiles.length !== MAPW * MAPH) return false; // older map format

  G.seed = data.seed;
  const m = generateMap(G.seed); // regenerate for shore flags
  G.tiles = Uint8Array.from(data.tiles);
  G.shore = m.shore;
  G.islands = floodFillIslands(G.tiles);
  G.grid = new Array(MAPW * MAPH).fill(null);
  G.roads = Uint8Array.from(data.roads);
  G.zone = new Uint8Array(MAPW * MAPH);
  G.buildings = [];
  G.nextId = 1;
  G.stock = data.stock;
  for (const g of GOODS) if (G.stock[g] === undefined) G.stock[g] = 0; // saves from older versions
  G.time = data.time || 0;
  G.speed = 1;
  G.paused = false;
  G.unlocked = data.unlocked || 1;
  G.flourished = !!data.flourished;
  G.victoryShown = !!data.victoryShown;
  G.quest = data.quest || 0;
  G.selected = null;
  G.walkers = [];
  G.vilT = 0;
  G.nextWalkerId = 1;
  G.rateHist = [];
  G.rateT = 0;
  G.eventT = 120 + Math.random() * 60;
  G.stormT = 0;
  G.popHist = Array.isArray(data.popHist) ? data.popHist : [];
  G.popHistT = 0;
  G.autopilot = !!data.autopilot;
  G.pirate = null;
  G.pirateT = 300 + Math.random() * 120;
  G.pirateSeen = !!data.pirateSeen;
  G.pirateSunk = data.pirateSunk || 0;
  G.shots = [];
  G.trader = null;
  G.traderT = 150 + Math.random() * 90;
  G.priceDrift = data.priceDrift || {};
  G.expedition = (data.expedition && data.expedition.dur) ? { t: data.expedition.t || 0, dur: data.expedition.dur, bonus: !!data.expedition.bonus } : null;
  G.expeditionsDone = data.expeditionsDone || 0;
  G.expBonus = !!data.expBonus;
  G.achievements = data.achievements || {};
  G.achT = 0;
  G.spiceMade = data.spiceMade || 0;
  // home island id straight from the saved buildings (G.buildings is rebuilt later)
  const whSaved = data.buildings.find(s => s.key === 'warehouse');
  const homeId = whSaved ? G.islands.ids[idx(whSaved.x, whSaved.y)] : 0;
  if (data.fertility) {
    G.fertility = data.fertility;
  } else { // legacy save: everything grows everywhere
    G.fertility = {};
    for (let id = 1; id <= G.islands.count; id++) {
      G.fertility[id] = { sheep: true, grain: true, potato: true };
    }
  }
  // pre-spice saves have no spice key → derive it from the seed so the
  // Merchants tier stays reachable (never on the home island)
  if (!Object.values(G.fertility).some(f => f && f.spice)) {
    const fresh = assignFertility(G.islands, homeId, G.seed);
    for (let id = 1; id <= G.islands.count; id++) {
      if (G.fertility[id]) G.fertility[id].spice = !!(fresh[id] && fresh[id].spice);
    }
  }

  for (const s of data.buildings) {
    const b = {
      id: G.nextId++, key: s.key, x: s.x, y: s.y,
      progress: s.progress, done: s.done,
      tier: s.tier || 0, res: s.res || 0,
      t: 0, acc: {}, sat: {}, svc: {},
      growT: 0, conT: 0, carrierOut: false,
      connected: false, cond: true, status: 'ok', condWhy: '',
    };
    const def = BUILDINGS[b.key];
    if (def) {
      for (const [tx, ty] of footprintTiles(b.x, b.y, def.size)) {
        if (inBounds(tx, ty)) G.grid[idx(tx, ty)] = b;
      }
      G.buildings.push(b);
    }
  }
  recomputeAll();
  return true;
}
