'use strict';
/* A hand-written advisor network — no training, every weight set on purpose.
 *
 * Same interface as the trained net (61 features in, 22 action logits out,
 * see js/ai.js), but built as a readable program in two tanh layers:
 *
 *   layer 1  CONDITIONS  one threshold switch per unit on a single feature:
 *                        c = tanh(3·(x − threshold)/width)  → ≈ +1 true, −1 false
 *   layer 2  RULES       an AND over conditions (some negated). Inputs are clean
 *                        ±1, so  r = tanh(3·(Σ ±c − (n − 1)))  is +1 only if all hold
 *   output   PRIORITIES  rule r adds its priority p to action a while it fires:
 *                        W[r][a] = p/2 and bias[a] += p/2, so (r + 1)/2 · p
 *
 * chooseAction() takes the highest logit among *valid* actions, so the
 * priorities form a fall-through cascade: an unaffordable or blocked
 * action is masked and the next rule in line wins. No rule firing → 'wait'.
 *
 * Usage: node dev/handwritten-net.js            (build, benchmark, write js/ai-weights.js)
 *        node dev/handwritten-net.js --dry-run  (build + benchmark only)
 */

const fs = require('fs');
const path = require('path');
const { AI, FEATURES, F, A, play, netPolicy, sandbox } = require('./harness.js');

/* ---------------- layer 1: conditions ----------------
 * [feature, '>' | '<', threshold, width]: ±1 is reached at threshold ± width.
 * Remember the scales: rates are per-minute / 20, stocks are share of storage. */

const POP_GATE = Number(process.env.POP_GATE || 100); // pioneers before investing in tier 2

const CONDITIONS = {
  unl2:        ['unlocked', '>', 0.5, 0.1],          // Settlers unlocked
  unl3:        ['unlocked', '>', 0.83, 0.1],         // Citizens unlocked
  noMarket:    ['noMarket', '>', 0.5, 0.5],
  missMarket:  ['miss.market', '>', 0.05, 0.05],     // >5 % of houses off the market
  noChapel:    ['noChapel', '>', 0.5, 0.5],
  missFaith:   ['miss.faith', '>', 0.1, 0.1],
  missFun:     ['miss.fun', '>', 0.1, 0.1],
  pop14:       ['pop.pioneer', '>', 0.14, 0.04],
  bigTown:     ['pop.pioneer', '>', POP_GATE / 100, 0.1],
  foodLow:     ['foodLow', '>', 0.5, 0.5],           // under 25 in stock
  foodFalling: ['rate.food', '<', 0.0, 0.05],        // net food < 0/min
  foodShort:   ['rate.food', '<', 0.15, 0.05],       // net food < 3/min: build ahead of demand
  woodShort:   ['rate.wood', '<', 0.1, 0.05],        // < 2/min
  woodStockLow:['stock.wood', '<', 0.15, 0.05],      // < ~45
  toolsLow:    ['toolsLow', '>', 0.5, 0.5],          // < 3
  toolsUnder10:['stock.tools', '<', 0.033, 0.01],
  goldLow:     ['goldLow', '>', 0.5, 0.5],           // < 120
  rich:        ['gold', '>', 0.75, 0.03],            // > ~1000
  goldUnder200:['gold', '<', 0.575, 0.02],
  storageFull: ['storageFull', '>', 0.5, 0.5],
  pirates:     ['pirateSeen', '>', 0.5, 0.5],
  fewTowers:   ['n.watchtower/3', '<', 0.5, 0.15],   // fewer than 2
  town10:      ['n.house', '>', 0.95, 0.05],         // 10+ houses
  noFirehouse: ['n.firehouse', '<', 0.05, 0.05],
  sheepLE:     ['sheep-weaver', '<', 0.17, 0.17],    // farms ≤ weavers
  clothShort:  ['rate.cloth', '<', 0.1, 0.05],       // < 2/min
  noMine:      ['n.mine', '<', 0.05, 0.05],
  mineGT:      ['mine-toolmaker', '>', 0.17, 0.17],  // mines > toolmakers
  grainLE:     ['grain-bakery', '<', 0.17, 0.17],
  potatoLE:    ['potato-distillery', '<', 0.17, 0.17],
  liquorShort: ['rate.liquor', '<', 0.1, 0.05],
  housesFull:  ['fullnessMargin', '>', 0.0, 0.1],    // houses > 55 % full
};

/* ---------------- layer 2: rules → output priorities ----------------
 * Conditions prefixed with '!' are negated. Priorities decide who wins when
 * several rules fire; masked (invalid) actions fall through to the next. */

const RULES = [
  // the bare essentials
  { if: ['noMarket'],                          then: { market: 100 } },
  { if: ['foodLow', 'foodFalling'],            then: { buyfood: 95, house: -60 } }, // famine: feed, don't grow
  { if: ['toolsLow'],                          then: { buytools: 90 } },
  { if: ['foodShort'],                         then: { fisher: 80, hunter: 70 } },
  { if: ['foodShort', 'unl2', 'grainLE'],      then: { grain: 78 } },
  { if: ['unl2', '!grainLE'],                  then: { bakery: 85 } },
  // no cap on woodcutters (the trained net stopped at 4 and starved of planks)
  { if: ['woodShort', 'woodStockLow'],         then: { woodcutter: 75 } },
  // services
  { if: ['noChapel', 'pop14'],                 then: { chapel: 65 } },
  { if: ['missMarket'],                        then: { market: 60 } },
  { if: ['missFaith', 'unl2'],                 then: { chapel: 55 } },
  { if: ['unl3', 'missFun'],                   then: { tavern: 52 } },
  { if: ['town10', 'noFirehouse', 'unl2'],     then: { firehouse: 50 } },
  { if: ['pirates', 'fewTowers', 'unl2'],      then: { watchtower: 50 } },
  // tier-2 production, once the town can carry the investment
  { if: ['unl2', 'bigTown', 'sheepLE', 'clothShort'], then: { sheep: 55 } },
  { if: ['unl2', 'bigTown', 'sheepLE', 'clothShort', 'goldUnder200'], then: { house: -40 } }, // save up for it
  { if: ['unl2', '!sheepLE'],                  then: { weaver: 58 } },
  { if: ['unl2', 'bigTown', 'noMine'],         then: { mine: 45 } },
  { if: ['unl2', 'mineGT'],                    then: { toolmaker: 47 } },
  { if: ['toolsUnder10', 'rich'],              then: { buytools: 45 } },
  // tier 3
  { if: ['unl3', 'potatoLE', 'liquorShort'],   then: { potato: 50 } },
  { if: ['unl3', '!potatoLE'],                 then: { distillery: 53 } },
  // growth & housekeeping
  { if: ['storageFull', 'unl2'],               then: { depot: 40 } },
  { if: ['goldLow'],                           then: { sell: 35 } },
  { if: ['housesFull', '!foodLow'],            then: { house: 30 } },
  { if: ['storageFull'],                       then: { sell: 20 } },
];

const IDLE_BIAS = -10; // every action but 'wait' starts here: nothing fires → wait

/* ---------------- compile to weights ---------------- */

function build() {
  const condNames = Object.keys(CONDITIONS);
  const nin = FEATURES.length, nc = condNames.length, nr = RULES.length, nout = AI.ACTIONS.length;
  const W1 = new Array(nin * nc).fill(0), b1 = new Array(nc).fill(0);
  condNames.forEach((name, j) => {
    const [feat, op, thr, width] = CONDITIONS[name];
    if (!(feat in F)) throw new Error(`condition ${name}: unknown feature ${feat}`);
    const k = 3 / width, s = op === '>' ? 1 : -1;
    W1[F[feat] * nc + j] = s * k;
    b1[j] = -s * k * thr;
  });
  const W2 = new Array(nc * nr).fill(0), b2 = new Array(nr).fill(0);
  const W3 = new Array(nr * nout).fill(0);
  const b3 = AI.ACTIONS.map(a => (a === 'wait' ? 0 : IDLE_BIAS));
  RULES.forEach((rule, r) => {
    for (const c of rule.if) {
      const neg = c.startsWith('!'), name = neg ? c.slice(1) : c;
      const j = condNames.indexOf(name);
      if (j < 0) throw new Error(`rule ${r}: unknown condition ${name}`);
      W2[j * nr + r] = neg ? -3 : 3;
    }
    b2[r] = -3 * (rule.if.length - 1);
    for (const [act, p] of Object.entries(rule.then)) {
      if (!(act in A)) throw new Error(`rule ${r}: unknown action ${act}`);
      W3[r * nout + A[act]] = p / 2;
      b3[A[act]] += p / 2;
    }
  });
  return {
    sizes: [nin, nc, nr, nout],
    layers: [{ W: W1, b: b1 }, { W: W2, b: b2 }, { W: W3, b: b3 }],
  };
}

/* ---------------- benchmark ---------------- */

const SEEDS = [11, 22, 33, 44, 55, 66, 77, 88, 101, 202, 303, 404, 505, 606];

function bench(name, policy) {
  const runs = SEEDS.map(s => play(policy, s));
  const avg = t => runs.reduce((s, p) => s + p[t], 0) / runs.length;
  const upgraded = runs.filter(p => p[1] + p[2] + p[3] > 0).length;
  console.log(name.padEnd(12) +
    ['pioneers', 'settlers', 'citizens', 'merchants'].map((n, t) => `${n} ${avg(t).toFixed(0).padStart(4)}`).join('  ') +
    `   islands with upgrades ${upgraded}/${runs.length}`);
  return runs;
}

if (require.main === module) {
  const w = build();
  const weights = w.layers.reduce((s, l) => s + l.W.length + l.b.length, 0);
  console.log(`hand-written net: ${w.sizes.join(' → ')} (${weights} weights, ` +
    `${Object.keys(CONDITIONS).length} conditions, ${RULES.length} rules), 30-min games on ${SEEDS.length} islands\n`);
  bench('teacher', () => AI.teacherAction());
  const trainedFile = path.join(__dirname, 'ai-weights-trained.json');
  if (fs.existsSync(trainedFile)) bench('trained net', netPolicy(JSON.parse(fs.readFileSync(trainedFile, 'utf8'))));
  bench('hand-written', netPolicy(w));

  if (!process.argv.includes('--dry-run')) {
    const out = '\'use strict\';\n' +
      '/* Advisor network — written by hand, not trained: generated by\n' +
      ' * dev/handwritten-net.js from its table of conditions and rules.\n' +
      ' * Change the rules there and regenerate — do not edit. */\n' +
      'const AI_WEIGHTS = ' + JSON.stringify(w) + ';\n';
    fs.writeFileSync(path.join(__dirname, '..', 'js', 'ai-weights.js'), out);
    console.log('\nwrote js/ai-weights.js');
  }
}

module.exports = { build, CONDITIONS, RULES, F, A, play, netPolicy, sandbox };
