'use strict';
/* Headless game harness shared by every advisor experiment (hand-written
 * nets, RL training, benchmarks): the real game code in a vm sandbox with
 * seeded randomness, so every policy plays the exact same games.
 *
 * One decision every 4 sim-seconds: 450 steps = 30 minutes. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = f => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
let seedState = 1;
const SeededMath = Object.create(Math);
SeededMath.random = () => {
  seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0;
  return seedState / 4294967296;
};
const sandbox = {
  console, Math: SeededMath, JSON, Array, Object, Number, String, Boolean, Date, Symbol,
  Infinity, NaN, Uint8Array, Float32Array, Float64Array, Set, Map, Promise,
  parseInt, parseFloat, isNaN, isFinite,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(['config.js', 'nn.js', 'map.js', 'game.js', 'ai.js'].map(JS).join('\n') +
  '\nglobalThis.E = { AI, NN, newGame, simTick, popOf, G: () => G, whyNoUpgrade };', sandbox);
const { AI, NN, newGame, simTick, popOf } = sandbox.E;

/* ---------------- names for the inputs and outputs ---------------- */

const AI_GOODS = ['wood', 'tools', 'iron', 'food', 'grain', 'wool', 'cloth', 'potato', 'liquor'];
const FEATURES = [
  ...AI_GOODS.map(g => 'stock.' + g),      // stock / storage cap (300 + depots)
  ...AI_GOODS.map(g => 'rate.' + g),       // net change per minute / 20
  'gold',                                  // log10(1 + gold) / 4: 100 → .50, 1000 → .75
  'pop.pioneer', 'pop.settler', 'pop.citizen', // residents / 100
  'fullness', 'unlocked',                  // unlocked = tiers / 3, saturates at 1
  ...AI.BUILD_ACTIONS.map(k => 'n.' + k),  // buildings / 10, saturates at 10
  'miss.market', 'miss.faith', 'miss.fun', // share of houses without the service (1 with no houses)
  'storm', 'foodGap', 'noMarket', 'noChapel', 'woodLow', 'toolsLow', 'goldLow', 'foodLow',
  'storageFull', 'sheep-weaver', 'grain-bakery', 'potato-distillery', 'mine-toolmaker',
  'fullnessMargin', 'pirateSeen', 'n.watchtower/3',
  'stock.spice', 'rate.spice', 'pop.merchant', 'merchantsUnlocked', 'n.kontor/2', 'n.spice',
];
if (FEATURES.length !== AI.FEATURE_COUNT) throw new Error('feature names out of sync with ai.js');
const F = Object.fromEntries(FEATURES.map((n, i) => [n, i]));
const A = Object.fromEntries(AI.ACTIONS.map((n, i) => [n.replace('build:', ''), i]));

/* ---------------- playing ---------------- */

const STEPS = Number(process.env.STEPS || 450);

// progress: the game is won by climbing tiers, so higher tiers count more
const progress = pops => pops[0] + 3 * pops[1] + 6 * pops[2] + 10 * pops[3];

const validMask = () => AI.ACTIONS.map(a => AI.roughValid(a));

function netPolicy(w) {
  const net = NN.fromJSON(w);
  return () => {
    const logits = NN.forward(net, AI.features());
    let bi = 0, bv = -Infinity;
    for (let i = 0; i < AI.ACTIONS.length; i++) {
      // a net with fewer outputs than ACTIONS never picks the newer ones
      if (i < logits.length && AI.roughValid(AI.ACTIONS[i]) && logits[i] > bv) { bv = logits[i]; bi = i; }
    }
    return AI.ACTIONS[bi];
  };
}

/* Plays one game; policy() returns an action name. onStep(step), if given,
 * runs after each decision's 4 sim-seconds. Returns [pioneers, settlers,
 * citizens, merchants] at the end. */
function play(policy, seed, steps = STEPS, onStep) {
  seedState = seed * 7919 + 1;
  newGame(seed);
  for (let s = 0; s < steps; s++) {
    AI.execute(policy());
    for (let i = 0; i < 8; i++) simTick(0.5);
    if (onStep) onStep(s);
  }
  return [0, 1, 2, 3].map(popOf);
}

const pops = () => [0, 1, 2, 3].map(popOf);

module.exports = { sandbox, AI, NN, FEATURES, F, A, STEPS, progress, validMask, netPolicy, play, pops };
