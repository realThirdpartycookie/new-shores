'use strict';
/* ============================================================
 * Neural-net island intelligence.
 *
 * A small MLP (see js/nn.js, weights in js/ai-weights.js trained
 * by dev/train.js) maps the game state to a next action:
 * which building to construct, or a trade move. Placement (where)
 * and road routing are handled by deterministic search.
 *
 * Modes: Advisor (suggests, you click) and Autopilot (it governs).
 * ============================================================ */

const AI = (() => {
  const BUILD_ACTIONS = ['house', 'market', 'chapel', 'woodcutter', 'fisher', 'hunter',
    'sheep', 'weaver', 'grain', 'bakery', 'mine', 'toolmaker', 'tavern', 'potato', 'distillery', 'depot',
    'watchtower', 'firehouse'];
  const ACTIONS = ['wait', ...BUILD_ACTIONS.map(k => 'build:' + k), 'sell', 'buytools', 'buyfood'];

  // Frozen feature space: the net was trained before spice/Merchants existed.
  // New goods must NOT change the feature vector or the weights go stale.
  const AI_GOODS = GOODS.slice(0, 9);

  let net = null;
  function getNet() {
    if (!net && typeof AI_WEIGHTS !== 'undefined') net = NN.fromJSON(AI_WEIGHTS);
    return net;
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function countOf(key) {
    let n = 0;
    for (const b of G.buildings) if (b.key === key) n++;
    return n;
  }

  /* ---------------- feature vector (fixed length) ---------------- */

  function houseStats() {
    let houses = 0, res = 0, capr = 0, mkMiss = 0, faMiss = 0, fuMiss = 0;
    for (const b of G.buildings) {
      if (b.key !== 'house') continue;
      houses++;
      res += b.res;
      capr += TIERS[b.tier].resMax;
      if (!b.svc.market) mkMiss++;
      if (!b.svc.faith) faMiss++;
      if (!b.svc.fun) fuMiss++;
    }
    return { houses, res, capr, mkMiss, faMiss, fuMiss };
  }

  function features() {
    const f = [];
    const cap = storageCap();
    for (const g of AI_GOODS) f.push(clamp((G.stock[g] || 0) / cap, 0, 1));     // 9
    for (const g of AI_GOODS) f.push(clamp(ratePerMin(g) / 20, -1, 1));         // 9
    f.push(clamp(Math.log10(1 + Math.max(0, G.stock.gold)) / 4, 0, 1.5));       // 1
    f.push(popOf(0) / 100, popOf(1) / 100, popOf(2) / 100);                     // 3
    const hs = houseStats();
    f.push(hs.capr ? hs.res / hs.capr : 0);                                     // 1
    f.push(Math.min(1, G.unlocked / 3)); // saturate: tier 4 postdates training // 1
    for (const k of BUILD_ACTIONS) f.push(clamp(countOf(k) / 10, 0, 1));        // 16
    f.push(hs.houses ? hs.mkMiss / hs.houses : 1,
           hs.houses ? hs.faMiss / hs.houses : 1,
           hs.houses ? hs.fuMiss / hs.houses : 1);                              // 3
    f.push(G.stormT > 0 ? 1 : 0);                                               // 1
    // decision-relevant aggregates (the net learns the priorities,
    // these expose the quantities the priorities act on)
    const foodTarget = 1 + totalPop() * 0.05;
    f.push(clamp((ratePerMin('food') - foodTarget) / 10, -1, 1));               // food gap
    f.push(countOf('market') === 0 ? 1 : 0);
    f.push(countOf('chapel') === 0 ? 1 : 0);
    f.push(ratePerMin('wood') < 2 && countOf('woodcutter') < 4 ? 1 : 0);
    f.push(G.stock.tools < 3 ? 1 : 0);
    f.push(G.stock.gold < 120 ? 1 : 0);
    f.push(G.stock.food < 25 ? 1 : 0);
    f.push(AI_GOODS.some(g => (G.stock[g] || 0) >= storageCap() * 0.95) ? 1 : 0);
    f.push(clamp((countOf('sheep') - countOf('weaver')) / 3, -1, 1));
    f.push(clamp((countOf('grain') - countOf('bakery')) / 3, -1, 1));
    f.push(clamp((countOf('potato') - countOf('distillery')) / 3, -1, 1));
    f.push(clamp((countOf('mine') - countOf('toolmaker')) / 3, -1, 1));
    f.push(clamp((hs.capr ? hs.res / hs.capr : 1) - 0.55, -1, 1));              // fullness margin
    f.push(G.pirateSeen ? 1 : 0);
    f.push(clamp(countOf('watchtower') / 3, 0, 1));
    return f;                                                                   // = 57
  }
  const FEATURE_COUNT = 61;

  /* ---------------- placement: where to build ---------------- */

  function baseAdjacentSet() {
    const s = new Set();
    for (const b of G.buildings) {
      if (!isBase(b)) continue;
      for (const [nx, ny] of footprintNeighbors(b.x, b.y, BUILDINGS[b.key].size)) {
        if (inBounds(nx, ny)) s.add(idx(nx, ny));
      }
    }
    return s;
  }

  /* Plan a road from a prospective building site to the network.
   * Returns an array of [x,y] tiles to pave (may be empty if already
   * connected), or null if unreachable within budget. */
  function planRoad(x, y, size) {
    const baseAdj = baseAdjacentSet();
    // already connected by direct adjacency?
    for (const [nx, ny] of footprintNeighbors(x, y, size)) {
      if (!inBounds(nx, ny)) continue;
      const i = idx(nx, ny);
      if (G.roadOk[i]) return [];
      const nb = G.grid[i];
      if (nb && isBase(nb)) return [];
    }
    const inFootprint = (tx, ty) => tx >= x && tx < x + size && ty >= y && ty < y + size;
    const passable = i => {
      const t = G.tiles[i];
      if (G.grid[i]) return false;
      return G.roads[i] === 1 || t === TILE.GRASS || t === TILE.TREE || t === TILE.SAND;
    };
    const parent = new Map();
    const queue = [];
    for (const [nx, ny] of footprintNeighbors(x, y, size)) {
      if (!inBounds(nx, ny) || inFootprint(nx, ny)) continue;
      const i = idx(nx, ny);
      if (!passable(i)) continue;
      parent.set(i, -1);
      queue.push(i);
    }
    let found = -1;
    for (let qi = 0; qi < queue.length && found < 0; qi++) {
      const cur = queue[qi];
      if (G.roadOk[cur] || baseAdj.has(cur)) { found = cur; break; }
      if (parent.size > 900) break; // search budget
      const cx2 = cur % MAPW, cy2 = (cur - cx2) / MAPW;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx2 + dx, ny = cy2 + dy;
        if (!inBounds(nx, ny) || inFootprint(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (!parent.has(ni) && passable(ni)) { parent.set(ni, cur); queue.push(ni); }
      }
    }
    if (found < 0) return null;
    const path = [];
    for (let cur = found; cur !== -1; cur = parent.get(cur)) {
      if (!G.roads[cur]) path.push([cur % MAPW, Math.floor(cur / MAPW)]);
    }
    if (path.length > 25) return null;
    return path.reverse();
  }

  function findSpotFor(key) {
    const def = BUILDINGS[key];
    const centers = G.buildings.filter(b =>
      b.key === 'warehouse' || ((b.key === 'market' || b.key === 'depot' || b.key === 'kontor') && b.done));
    const services = G.buildings.filter(b => BUILDINGS[b.key].service && b.done);
    const seen = new Set();
    let best = null;

    for (const c of centers) {
      for (let r = 1; r <= 13; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = c.x + dx, y = c.y + dy;
            const k = x + ',' + y;
            if (seen.has(k)) continue;
            seen.add(k);
            if (!canPlace(key, x, y).ok) continue;

            let score = -r * 0.3;
            let roadPlan = null;
            if (def.needsRoad) {
              roadPlan = planRoad(x, y, def.size);
              if (!roadPlan) continue;
              const roadCost = roadPlan.length * ROAD_COST;
              if (G.stock.gold < (def.cost.gold || 0) + roadCost) continue;
              score -= roadPlan.length * 0.6;
            }
            if (key === 'house') { // prefer spots covered by services
              for (const s of services) {
                const sd = BUILDINGS[s.key];
                const scx = s.x + (sd.size - 1) / 2, scy = s.y + (sd.size - 1) / 2;
                const dd = (x - scx) * (x - scx) + (y - scy) * (y - scy);
                if (dd <= sd.radius * sd.radius) score += 4;
              }
            }
            if (!best || score > best.score) best = { x, y, score, roadPlan, r };
          }
        }
        if (best && r > best.r + 2) break; // found something close; stop widening
      }
    }
    return best;
  }

  /* ---------------- action validity & execution ---------------- */

  /* Placement failures put the building on cooldown so policies move on
   * to their next-best action instead of retrying forever. */
  let spotFail = {};
  let lastTime = 0;
  function maybeReset() {
    if (G.time < lastTime) { spotFail = {}; aiT = 0; apT = 0; lastAct = ''; }
    lastTime = G.time;
  }

  function surplusGood() {
    let best = null;
    for (const g of GOODS) {
      if (g === 'tools' || g === 'spice') continue; // spice is the Merchants' upgrade good — never dump it
      const r = ratePerMin(g);
      const stock = G.stock[g] || 0;
      if ((r > 2 && stock > 60) || stock > storageCap() * 0.92) {
        if (!best || stock > (G.stock[best] || 0)) best = g;
      }
    }
    return best;
  }

  // Cheap validity (no spot search) — used to mask the net's choices.
  function roughValid(action) {
    maybeReset();
    if (action === 'wait') return true;
    if (action === 'sell') return !!surplusGood();
    if (action === 'buytools') return G.stock.gold > 300 && G.stock.tools < 10;
    if (action === 'buyfood') return G.stock.gold > 200 && G.stock.food < 10 && ratePerMin('food') < 0.5;
    const key = action.slice(6);
    const def = BUILDINGS[key];
    if (!def || def.tier > G.unlocked) return false;
    if (!canAfford(def.cost)) return false;
    if ((spotFail[key] || 0) > G.time) return false;
    if (def.service || key === 'market') { // one service building of a kind per ~coverage
      if (key === 'chapel' && countOf('chapel') > countOf('house') / 8) return false;
      if (key === 'tavern' && countOf('tavern') > countOf('house') / 10) return false;
      if (key === 'market' && countOf('market') > countOf('house') / 6 + 1) return false;
    }
    if (key === 'depot' && countOf('depot') >= 2) return false;
    return true;
  }

  function execute(action) {
    maybeReset();
    if (action === 'wait') return true;
    if (action === 'sell') {
      const g = surplusGood();
      return g ? sellGood(g, Math.min(10, Math.floor(G.stock[g]))) : false;
    }
    if (action === 'buytools') return buyGood('tools', 5);
    if (action === 'buyfood') return buyGood('food', 5);
    const key = action.slice(6);
    const spot = findSpotFor(key);
    if (!spot) {
      spotFail[key] = G.time + 45; // try something else for a while
      return false;
    }
    if (spot.roadPlan) for (const [rx, ry] of spot.roadPlan) placeRoad(rx, ry);
    const ok = placeBuilding(key, spot.x, spot.y).ok;
    if (!ok) spotFail[key] = G.time + 20;
    return ok;
  }

  /* ---------------- teacher policy (rule-based) ----------------
   * Used to generate training data, and as fallback when no
   * trained weights are present. */
  function teacherAction() {
    maybeReset();
    const can = k => roughValid('build:' + k);
    const foodRate = ratePerMin('food');
    const hs = houseStats();
    const n = countOf;
    const fullness = hs.capr ? hs.res / hs.capr : 1;
    // food demand grows with population — keep healthy headroom
    const foodTarget = 1 + totalPop() * 0.05;

    if (n('market') === 0 && can('market')) return 'build:market';
    if (G.stock.food < 8 && roughValid('buyfood')) return 'buyfood';
    // food security: build production until comfortably in surplus
    if (foodRate < foodTarget || G.stock.food < 25) {
      if (G.unlocked >= 2 && n('grain') <= n('bakery') && can('grain')) return 'build:grain';
      if (G.unlocked >= 2 && n('bakery') < n('grain') && can('bakery')) return 'build:bakery';
      if (can('fisher')) return 'build:fisher';
      if (can('hunter')) return 'build:hunter';
    }
    if (ratePerMin('wood') < 2 && n('woodcutter') < 4 && can('woodcutter')) return 'build:woodcutter';
    if (G.stock.tools < 3 && roughValid('buytools')) return 'buytools';
    if (hs.mkMiss > 0 && can('market')) return 'build:market';
    if (n('chapel') === 0 && popOf(0) >= 14 && can('chapel')) return 'build:chapel';
    if (G.pirateSeen && n('watchtower') < 2 && can('watchtower')) return 'build:watchtower';
    if (hs.houses >= 10 && n('firehouse') < 1 + Math.floor(hs.houses / 18) && can('firehouse')) return 'build:firehouse';
    // grow the town while supplies hold — mild deficits are fine, famine is not
    if (fullness > 0.55 && (foodRate > -0.5 || G.stock.food > 80) && can('house')) return 'build:house';
    if (G.unlocked >= 2) {
      if (n('sheep') <= n('weaver') && ratePerMin('cloth') < 1 && can('sheep')) return 'build:sheep';
      if (n('weaver') < n('sheep') && can('weaver')) return 'build:weaver';
      if (n('mine') === 0 && can('mine')) return 'build:mine';
      if (n('toolmaker') < n('mine') && can('toolmaker')) return 'build:toolmaker';
      if (hs.faMiss > 0 && can('chapel')) return 'build:chapel';
    }
    if (G.unlocked >= 3) {
      if (hs.fuMiss > 0 && can('tavern')) return 'build:tavern';
      if (n('potato') <= n('distillery') && can('potato')) return 'build:potato';
      if (n('distillery') < n('potato') && can('distillery')) return 'build:distillery';
    }
    const storagePressed = GOODS.some(g => (G.stock[g] || 0) >= storageCap() * 0.95);
    if (storagePressed && can('depot')) return 'build:depot';
    if (G.stock.gold < 120 && roughValid('sell')) return 'sell';
    if (can('house') && fullness > 0.4 && foodRate > 0) return 'build:house';
    return 'wait';
  }

  /* ---------------- choosing an action ---------------- */

  function chooseAction() {
    const theNet = getNet();
    if (!theNet) return teacherAction();
    const logits = NN.forward(theNet, features());
    let bestI = -1, bestV = -Infinity;
    for (let i = 0; i < ACTIONS.length; i++) {
      if (!roughValid(ACTIONS[i])) continue;
      if (logits[i] > bestV) { bestV = logits[i]; bestI = i; }
    }
    return bestI < 0 ? 'wait' : ACTIONS[bestI];
  }

  /* ---------------- advisor / autopilot ---------------- */

  const REASONS = {
    'build:fisher': () => `Food balance is ${ratePerMin('food').toFixed(1)}/min — the island needs more to eat.`,
    'build:hunter': () => `Food balance is ${ratePerMin('food').toFixed(1)}/min — game from the woods will help.`,
    'build:grain': () => 'Grain fields feed the bakeries that feed a growing town.',
    'build:bakery': () => 'Bread scales food production beyond fishing.',
    'build:woodcutter': () => `Wood runs at ${ratePerMin('wood').toFixed(1)}/min — building needs more.`,
    'build:house': () => 'Homes are filling up — new settlers are waiting to come ashore.',
    'build:market': () => 'Houses need a marketplace within reach.',
    'build:chapel': () => 'A chapel fulfils the faith your people will soon demand.',
    'build:sheep': () => 'Wool starts the cloth chain for Settler upgrades.',
    'build:weaver': () => 'A weaver turns stored wool into cloth.',
    'build:mine': () => 'Iron from the mountain makes you independent of the trader.',
    'build:toolmaker': () => 'A toolmaker forges iron into the tools every upgrade needs.',
    'build:tavern': () => 'Citizens demand entertainment within reach of their homes.',
    'build:potato': () => 'Potatoes are the first step towards liquor for Citizens.',
    'build:distillery': () => 'A distillery turns potatoes into liquor.',
    'build:depot': () => 'Storage is overflowing — a depot adds capacity.',
    'build:watchtower': () => 'Pirates prowl these waters — cannons will greet them.',
    'build:firehouse': () => 'A fire brigade saves buildings before they burn down.',
    'build:kontor': () => 'Found a colony to use another island\'s fertile ground.',
    sell: () => `Selling surplus ${surplusGood() ? RES_META[surplusGood()].name.toLowerCase() : 'goods'} for gold.`,
    buytools: () => 'Buying tools from the trader to keep building.',
    buyfood: () => 'Emergency rations — the pantry is nearly empty!',
    wait: () => 'All is well — watching the town grow.',
  };

  let suggestion = { action: 'wait', reason: 'Thinking…' };
  let lastAct = '';
  let aiT = 0, apT = 0;

  function refreshSuggestion() {
    const action = chooseAction();
    const reason = (REASONS[action] || REASONS.wait)();
    let label = null;
    if (action.startsWith('build:')) {
      const def = BUILDINGS[action.slice(6)];
      label = `${def.icon} Build ${def.name}`;
    } else if (action === 'sell') label = '🚢 Sell surplus';
    else if (action === 'buytools') label = '🚢 Buy 5 tools';
    else if (action === 'buyfood') label = '🚢 Buy 5 food';
    suggestion = { action, reason, label };
  }

  function tick(dt) {
    aiT += dt;
    if (aiT >= 2.5) { aiT = 0; refreshSuggestion(); }
    if (!G.autopilot) return;
    apT += dt;
    if (apT < 5) return;
    apT = 0;
    refreshSuggestion();
    const act = suggestion.action;
    if (act === 'wait') { lastAct = ''; return; }
    if (execute(act)) {
      lastAct = suggestion.label || act;
      if (Hooks.onChange) Hooks.onChange();
      refreshSuggestion();
    } else {
      lastAct = '';
    }
  }

  function applySuggestion() {
    const act = suggestion.action;
    if (act === 'wait') return false;
    const ok = execute(act);
    if (ok) {
      lastAct = suggestion.label || act;
      refreshSuggestion();
    }
    return ok;
  }

  return {
    ACTIONS, BUILD_ACTIONS, FEATURE_COUNT,
    features, roughValid, execute, teacherAction, chooseAction,
    findSpotFor, planRoad,
    tick, applySuggestion,
    getSuggestion: () => suggestion,
    getLastAct: () => lastAct,
    hasNet: () => !!getNet(),
  };
})();
