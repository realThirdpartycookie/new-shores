'use strict';
/* Hand-written advisor network, second attempt — same shape as the trained
 * net (61 features → one tanh hidden layer → 22 action logits), every weight
 * set by hand. No training.
 *
 * Design (differs from dev/handwritten-net.js, the first attempt):
 *
 *   hidden units  = NEEDS, graded rather than on/off: tanh of a linear read of
 *                   the features, e.g. "how badly is food short" from food
 *                   stock, food rate and population. Lesson from attempt 1:
 *                   read STOCKS, not rates — with an empty store the net rate
 *                   is ~0 because houses can only eat what exists.
 *                   Conjunctions ("cloth short AND town big enough") are also
 *                   single units: terms scaled to ≈ ±2..3, bias −2 per extra term.
 *   output        = each action collects its needs with a weight p via
 *                   p · (h + 1)/2, i.e. W2 = p/2 and bias += p/2, minus a floor
 *                   of 8 so half-awake units don't act. Several needs on one
 *                   action are an OR; a negative p is a veto (houses while food
 *                   is short). 'wait' stays at 0 and wins ties.
 *
 * chooseAction() masks invalid actions (unaffordable, locked, on placement
 * cooldown), so the weights form a cascade: when the best action is blocked
 * the next-strongest need acts.
 *
 * Usage: node dev/handwritten-net-v2.js            (build, benchmark both attempts, write js/ai-weights.js)
 *        node dev/handwritten-net-v2.js --dry-run  (build + benchmark only)
 */

const fs = require('fs');
const path = require('path');
const v1 = require('./handwritten-net.js'); // shares the headless harness: same seeds, same games

const { F, A, play, netPolicy, sandbox } = v1;
const { AI } = sandbox.E;
const pop = { 'pop.pioneer': 1, 'pop.settler': 1, 'pop.citizen': 1 }; // total population / 100

/* ---------------- terms: linear reads of the features, true ≈ ≥ +2, false ≈ ≤ −2 ----------------
 * Scales: stock.* = share of storage (300 + depots); rate.* = per minute / 20;
 * pop.* = residents / 100; n.* = buildings / 10 (saturates at 10);
 * unlocked = tiers / 3; flags are 0/1; chain diffs = (a − b) / 3. */

const T = (weights, bias) => ({ weights, bias });
const scale = (t, k) => T(Object.fromEntries(Object.entries(t.weights).map(([f, w]) => [f, w * k])), t.bias * k);
function conj(...terms) { // AND: all terms must be positive to clear the margin
  const weights = {};
  let bias = -2 * (terms.length - 1);
  for (const t of terms) {
    for (const [f, w] of Object.entries(t.weights)) weights[f] = (weights[f] || 0) + w;
    bias += t.bias;
  }
  return T(weights, bias);
}
const mul = (o, k) => Object.fromEntries(Object.entries(o).map(([f, w]) => [f, w * k]));

const noMarket   = T({ noMarket: 6 }, -3);
const marketGap  = T({ 'miss.market': 40 }, -4);                 // > 10 % of houses off the market
const foodLow    = T({ foodLow: 6 }, -3);                        // < 25 food
const foodFalling = T({ 'rate.food': -60 }, 0);                  // losing > 1/min
// graded: empty store and a growing town ask for food, a stocked store with a surplus does not
const foodNeed   = T({ 'rate.food': -30, 'stock.food': -20, ...mul(pop, 4) }, 2);     // 0 people + 30 food = neutral
const woodNeed   = T({ 'rate.wood': -30, 'stock.wood': -15 }, 3);
const toolsNeed  = T({ toolsLow: 5, 'stock.tools': -60 }, 2.4);  // < ~12 tools; strongly < 3
const goldNeed   = T({ goldLow: 5, gold: -15 }, 9);              // < ~250 gold
const noChapel   = T({ noChapel: 6 }, -3);
const faithGap   = T({ 'miss.faith': 40 }, -6);                  // > 15 % of houses without a chapel
const funGap     = T({ 'miss.fun': 40 }, -6);
const unl2       = T({ unlocked: 12 }, -6);                      // Settlers unlocked: {−2, +2, +6}
const town10     = T({ 'n.house': 40 }, -38);                    // 10+ houses (the feature saturates there)
const noFirehouse = T({ 'n.firehouse': -40 }, 2);
const hasHouses  = T({ 'n.house': 40 }, -2);                     // miss.* read 1 with no houses at all
const pirates    = T({ pirateSeen: 6 }, -3);
const fewTowers  = T({ 'n.watchtower/3': -6 }, 2);               // 0 → +2, 1 → 0, 2 → −2
const invest     = T(mul(pop, 8), -3.5);                         // town can carry a tier-2 investment (~60+)
// cloth: wanted from the Settler unlock on (to allow the first upgrade), then in
// proportion to the settlers eating it, satisfied by cloth in store
const clothNeed  = T({ unlocked: 20, 'pop.settler': 10, 'pop.citizen': 6, 'stock.cloth': -30, 'rate.cloth': -20 }, -12.9);
const sheepLE    = T({ 'sheep-weaver': -15 }, 2);                // farms ≤ weavers
const weaverLT   = T({ 'sheep-weaver': 15, 'stock.wool': 10 }, -1); // farms > weavers, or wool piling up
const noMine     = T({ 'n.mine': -40 }, 2);
const toolmakerLT = T({ 'mine-toolmaker': 15, 'stock.iron': 10 }, -1);
const grainLE    = T({ 'grain-bakery': -15 }, 2);
const bakeryLT   = T({ 'grain-bakery': 15, 'stock.grain': 10 }, -1);
const liquorNeed = T({ unlocked: 30, 'pop.citizen': 10, 'stock.liquor': -30, 'rate.liquor': -20 }, -29.5);
// Citizens unlocked and (almost) no liquor in store: +3 at 0, −2 at 5 of 300
const liquorLow  = T({ unlocked: 30, 'stock.liquor': -300 }, -27);
const potatoLE   = T({ 'potato-distillery': -15 }, 2);
const distilleryLT = T({ 'potato-distillery': 15, 'stock.potato': 10 }, -1);
// colonies: Citizens unlocked (unlocked saturates at 1), no Kontor yet, 20+ citizens, gold for it
const unl3       = T({ unlocked: 30 }, -27);                     // tier 3: +3, tier 2: −7
const noKontor   = T({ 'n.kontor/2': -10 }, 2);                  // 0 → +2, 1 → −3
const citizens20 = T({ 'pop.citizen': 20 }, -4);                 // 20+ citizens: +0 at 20, +2 at 30
const gold1600   = T({ gold: 60 }, -48);                         // 1600 → 0, 2000 → +1.5, 1000 → −3
const gold1000   = T({ gold: 60 }, -45);                         // 1000 → 0, 2000 → +4.5
const gold2000   = T({ gold: 60 }, -49.5);                       // 2000 → 0, 3000 → +2.6
const gold5000   = T({ gold: 60 }, -55.5);                       // 5000 → 0, 10000 → +4.5
const clothLow   = T({ 'stock.cloth': -200, unlocked: 12 }, -2); // Settlers unlocked, < ~10 cloth in store
const hasKontor  = T({ 'n.kontor/2': 10 }, -2);
// spice: as soon as there is a colony — little in store, few gardens for the Merchants there are
const spiceLow   = T({ 'stock.spice': -150 }, 2);                // 0 → +2, ~6 of 450 → 0
const fewSpice   = T({ 'n.spice': -20, 'pop.merchant': 10 }, 3); // 0 → +3, 1 → +1, 2 → −1 (+1 per 10 merchants)
const growth     = T({ fullnessMargin: 15 }, 1.5);               // houses > ~45 % full (and no houses yet)
const storageFull = T({ storageFull: 6 }, -3);

/* ---------------- hidden layer: one unit per need ---------------- */

const UNITS = {
  noMarket, foodNeed, woodNeed, toolsNeed, goldNeed, noChapel, town10,
  weaverLT, toolmakerLT, bakeryLT, distilleryLT, growth, storageFull,
  foodCrisis:    conj(foodLow, foodFalling),
  grainTrigger:  conj(scale(foodNeed, 0.5), grainLE, unl2),
  marketTrigger: conj(marketGap, hasHouses),
  faithTrigger:  conj(faithGap, unl2, hasHouses),
  funTrigger:    conj(funGap, hasHouses),
  fireTrigger:   conj(town10, noFirehouse),
  towerTrigger:  conj(pirates, fewTowers),
  sheepTrigger:  conj(clothNeed, sheepLE, invest),
  mineTrigger:   conj(noMine, invest),
  potatoTrigger: conj(liquorNeed, potatoLE),
  colonyTrigger: conj(unl3, noKontor, citizens20, gold1600),
  // imported liquor is a luxury: 100 citizens drink ~40/min, ~1200 gold.
  // Before the colony it must not eat the Kontor's 1500 gold: at a 1000
  // threshold the treasury settled at 1000 and no colony was ever founded.
  liquorImport:  conj(liquorLow, gold1000, hasKontor),
  liquorImportEarly: conj(liquorLow, gold2000, noKontor),
  // the weavers rarely keep up with a big town; truly idle gold buys the difference
  clothImport:   conj(clothLow, gold5000), // only gold the Kontor (1500) doesn't need
  spiceTrigger:  conj(hasKontor, spiceLow, fewSpice),
};

/* ---------------- output: action ← Σ p · [need] − 8 ---------------- */

const FLOOR = -8;
const OUTPUTS = {
  market:     { noMarket: 100, marketTrigger: 60 },
  buytools:   { toolsNeed: 90 },
  bakery:     { bakeryLT: 86 },
  fisher:     { foodNeed: 85 },
  grain:      { grainTrigger: 83 },
  woodcutter: { woodNeed: 78 },
  hunter:     { foodNeed: 75 },
  buyfood:    { foodCrisis: 70 },      // below every producer: a last resort, not a habit
  buyliquor:  { liquorImport: 60, liquorImportEarly: 60 }, // islands without potatoes import what upgrades need
  buycloth:   { clothImport: 72 },    // spare gold into upgrades, above everything but food and tools
  kontor:     { colonyTrigger: 66 },   // the only road to spice, Merchants and the Imperial Charter
  spice:      { spiceTrigger: 64 },     // the Merchants' good grows only in colonies
  weaver:     { weaverLT: 58 },
  sheep:      { sheepTrigger: 55 },
  chapel:     { faithTrigger: 55, noChapel: 50 },
  distillery: { distilleryLT: 53 },
  tavern:     { funTrigger: 70 },      // a Citizen upgrade needs tavern coverage — above the cloth chain
  firehouse:  { fireTrigger: 50 },
  potato:     { potatoTrigger: 50 },
  watchtower: { towerTrigger: 48 },
  toolmaker:  { toolmakerLT: 47 },
  mine:       { mineTrigger: 45 },
  depot:      { town10: 42, storageFull: 40 }, // a depot is a second road anchor: spreads the town
  sell:       { goldNeed: 35, storageFull: 20 },
  // a crisis vetoes houses; a mere need only dampens them, or a town with no
  // fishing spot never builds its first house (island 22: deadlock). No veto
  // for pending investments either: when the sheep farm has no spot the veto
  // never lifts and the town stops growing (island 606: 270 idle steps).
  house:      { growth: 30, foodCrisis: -50, foodNeed: -15, woodNeed: -15 },
};

/* ---------------- compile ---------------- */

function build() {
  const names = Object.keys(UNITS);
  const nin = Object.keys(F).length, nh = names.length, nout = AI.ACTIONS.length;
  const W1 = new Array(nin * nh).fill(0), b1 = new Array(nh).fill(0);
  names.forEach((name, j) => {
    const { weights, bias } = UNITS[name];
    for (const [f, w] of Object.entries(weights)) {
      if (!(f in F)) throw new Error(`${name}: unknown feature ${f}`);
      W1[F[f] * nh + j] = w;
    }
    b1[j] = bias;
  });
  const W2 = new Array(nh * nout).fill(0);
  const b2 = AI.ACTIONS.map(a => (a === 'wait' ? 0 : FLOOR)); // 'wait' has no floor: it wins ties
  for (const [act, needs] of Object.entries(OUTPUTS)) {
    if (!(act in A)) throw new Error(`unknown action ${act}`);
    for (const [need, p] of Object.entries(needs)) {
      const j = names.indexOf(need);
      if (j < 0) throw new Error(`${act}: unknown need ${need}`);
      W2[j * nout + A[act]] = p / 2;
      b2[A[act]] += p / 2;
    }
  }
  return { sizes: [nin, nh, nout], layers: [{ W: W1, b: b1 }, { W: W2, b: b2 }] };
}

/* ---------------- benchmark: both attempts, teacher, trained net ---------------- */

const SEEDS = (process.env.SEEDS || '11,22,33,44,55,66,77,88,101,202,303,404,505,606').split(',').map(Number);

function bench(policies) {
  const rows = {};
  for (const name of Object.keys(policies)) rows[name] = [];
  for (const seed of SEEDS) for (const [name, p] of Object.entries(policies)) rows[name].push(play(p, seed));
  console.log('island'.padEnd(8) + Object.keys(policies).map(n => n.padEnd(22)).join(''));
  SEEDS.forEach((s, i) => console.log(String(s).padEnd(8) +
    Object.keys(policies).map(n => rows[n][i].join('/').padEnd(22)).join('')));
  console.log('\n' + 'policy'.padEnd(14) + 'pioneers settlers citizens merchants  islands w/ upgrades  progress');
  for (const [name, runs] of Object.entries(rows)) {
    const avg = t => runs.reduce((s, p) => s + p[t], 0) / runs.length;
    const up = runs.filter(p => p[1] + p[2] + p[3] > 0).length;
    const progress = avg(0) + 3 * avg(1) + 6 * avg(2) + 10 * avg(3);
    console.log(name.padEnd(14) + [0, 1, 2, 3].map(t => avg(t).toFixed(0).padStart(8)).join(' ') +
      `  ${String(up).padStart(2)}/${runs.length}` + progress.toFixed(0).padStart(21));
  }
}

if (require.main === module) {
  const w = build();
  console.log(`attempt 2: ${w.sizes.join(' → ')}, ${Object.keys(UNITS).length} need units — 30-min games on ${SEEDS.length} islands\n`);
  const policies = { teacher: () => AI.teacherAction() };
  const trainedFile = path.join(__dirname, 'ai-weights-trained.json');
  if (fs.existsSync(trainedFile)) policies['trained net'] = netPolicy(JSON.parse(fs.readFileSync(trainedFile, 'utf8')));
  policies['attempt 1'] = netPolicy(v1.build());
  policies['attempt 2'] = netPolicy(w);
  bench(policies);

  if (!process.argv.includes('--dry-run')) {
    const out = '\'use strict\';\n' +
      '/* Advisor network — written by hand, not trained: generated by\n' +
      ' * dev/handwritten-net-v2.js from its table of needs and action weights.\n' +
      ' * Change the tables there and regenerate — do not edit. */\n' +
      'const AI_WEIGHTS = ' + JSON.stringify(w) + ';\n';
    fs.writeFileSync(path.join(__dirname, '..', 'js', 'ai-weights.js'), out);
    console.log('\nwrote js/ai-weights.js');
  }
}

module.exports = { build, UNITS, OUTPUTS };
