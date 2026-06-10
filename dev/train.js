'use strict';
/* Trains the advisor neural net by behavior cloning.
 *
 * 1. Plays headless games with the rule-based teacher policy
 *    (+ exploration noise) and records (features, teacher action).
 * 2. Trains the MLP on those decisions.
 * 3. Evaluates random / teacher / net policies on held-out islands.
 * 4. Bakes the weights into js/ai-weights.js.
 *
 * Usage: node dev/train.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = f => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');

const sandbox = {
  console, Math, JSON, Array, Object, Number, String, Boolean, Date, Symbol,
  Infinity, NaN, Uint8Array, Float32Array, Float64Array, Set, Map, Promise,
  parseInt, parseFloat, isNaN, isFinite,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let src = ['config.js', 'nn.js', 'map.js', 'game.js', 'ai.js'].map(JS).join('\n');

src += `
(function trainMain() {
  const A = AI.ACTIONS;

  function stepEnv(action) {
    AI.execute(action);
    for (let i = 0; i < 8; i++) simTick(0.5); // 4 seconds per decision
  }
  function score() { return popOf(0) + 2 * popOf(1) + 3 * popOf(2); }

  /* ---- 1. collect teacher decisions with exploration ---- */
  const X = [], Y = [];
  const GAMES = 28, STEPS = 180; // 12 sim-minutes per game
  for (let g = 0; g < GAMES; g++) {
    newGame(1000 + g * 17);
    for (let s = 0; s < STEPS; s++) {
      const feats = AI.features();
      const label = A.indexOf(AI.teacherAction());
      X.push(feats); Y.push(label);
      // exploration: sometimes do something else so the net sees off-policy states
      let act = A[label];
      if (Math.random() < 0.18) {
        const valid = A.filter(a => AI.roughValid(a));
        act = valid[Math.floor(Math.random() * valid.length)];
      }
      stepEnv(act);
    }
  }

  /* ---- 2. train (with DAgger rounds against distribution shift) ---- */
  function trainOn(X, Y) {
    // de-emphasise 'wait' so the net doesn't collapse to it
    const keep = [];
    let waits = 0;
    for (let i = 0; i < X.length; i++) {
      if (Y[i] === 0) { waits++; if (waits % 4 !== 0) continue; }
      keep.push(i);
    }
    const net = NN.create([AI.FEATURE_COUNT, 48, A.length], () => Math.random());
    const EPOCHS = 16;
    let acc = 0;
    for (let e = 0; e < EPOCHS; e++) {
      for (let i = keep.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = keep[i]; keep[i] = keep[j]; keep[j] = t;
      }
      const lr = 0.03 * Math.pow(0.8, e);
      for (const i of keep) NN.trainStep(net, X[i], Y[i], lr, 0.9);
    }
    for (const i of keep) {
      const out = NN.forward(net, X[i]);
      let bi = 0;
      for (let k = 1; k < out.length; k++) if (out[k] > out[bi]) bi = k;
      if (bi === Y[i]) acc++;
    }
    console.log('  trained on ' + keep.length + ' samples, accuracy ' + (100 * acc / keep.length).toFixed(1) + '%');
    return net;
  }

  let net = trainOn(X, Y);

  function netActionWith(theNet) {
    const logits = NN.forward(theNet, AI.features());
    let bi = -1, bv = -Infinity;
    for (let i = 0; i < A.length; i++) {
      if (!AI.roughValid(A[i])) continue;
      if (logits[i] > bv) { bv = logits[i]; bi = i; }
    }
    return bi < 0 ? 'wait' : A[bi];
  }

  // DAgger: visit states under the NET's policy, label them with the teacher
  const DAGGER_ROUNDS = 3, DAGGER_GAMES = 10;
  for (let d = 1; d <= DAGGER_ROUNDS; d++) {
    for (let g = 0; g < DAGGER_GAMES; g++) {
      newGame(5000 + d * 100 + g * 13);
      for (let s = 0; s < STEPS; s++) {
        X.push(AI.features());
        Y.push(A.indexOf(AI.teacherAction()));
        stepEnv(netActionWith(net)); // follow the net, not the teacher
      }
    }
    console.log('DAgger round ' + d + ': dataset now ' + X.length + ' decisions');
    net = trainOn(X, Y);
  }

  /* ---- 2b. model selection: training is noisy, keep the best of several ---- */
  function quickEval(theNet) {
    let tot = 0, totSat = 0;
    for (const sd of [101, 202, 303]) {
      newGame(sd);
      for (let s = 0; s < STEPS; s++) stepEnv(netActionWith(theNet));
      tot += popOf(0) + 2 * popOf(1) + 3 * popOf(2);
      let houses = 0, happy = 0;
      for (const b of G.buildings) {
        if (b.key !== 'house') continue;
        houses++;
        if (b.status === 'ok') happy++;
      }
      totSat += houses ? happy / houses : 1;
    }
    return { score: tot / 3, sat: totSat / 3 };
  }

  const CANDIDATES = 4;
  let bestNet = net, bestVal = quickEval(net);
  console.log('candidate 1: score ' + bestVal.score.toFixed(1) + ', sat ' + Math.round(bestVal.sat * 100) + '%');
  for (let c = 2; c <= CANDIDATES; c++) {
    const cand = trainOn(X, Y);
    const val = quickEval(cand);
    console.log('candidate ' + c + ': score ' + val.score.toFixed(1) + ', sat ' + Math.round(val.sat * 100) + '%');
    if (val.score + val.sat * 60 > bestVal.score + bestVal.sat * 60) { bestNet = cand; bestVal = val; }
  }
  net = bestNet;

  /* ---- 3. evaluate on held-out islands ---- */
  function netAction() { return netActionWith(net); }
  function randomAction() {
    const valid = A.filter(a => AI.roughValid(a));
    return valid[Math.floor(Math.random() * valid.length)];
  }
  function evalPolicy(actFn, seed) {
    newGame(seed);
    for (let s = 0; s < STEPS; s++) stepEnv(actFn());
    let houses = 0, happy = 0;
    for (const b of G.buildings) {
      if (b.key !== 'house') continue;
      houses++;
      if (b.status === 'ok') happy++;
    }
    return {
      score: score(), pop: totalPop(), buildings: G.buildings.length,
      sat: houses ? happy / houses : 1,
    };
  }

  const seeds = [101, 202, 303];
  for (const [name, fn] of [['random', randomAction], ['teacher', () => AI.teacherAction()], ['net', netAction]]) {
    let tot = 0, totSat = 0;
    const det = [];
    for (const sd of seeds) {
      const r = evalPolicy(fn, sd);
      tot += r.score;
      totSat += r.sat;
      det.push('pop ' + r.pop + '/' + r.buildings + 'b/' + Math.round(r.sat * 100) + '%sat');
    }
    console.log(name.padEnd(8) + ' avg score ' + (tot / seeds.length).toFixed(1) +
      ', satisfied ' + Math.round(100 * totSat / seeds.length) + '%  (' + det.join(', ') + ')');
  }

  /* ---- 4. export ---- */
  const json = NN.toJSON(net);
  for (const l of json.layers) {
    l.W = l.W.map(v => Math.round(v * 1e5) / 1e5);
    l.b = l.b.map(v => Math.round(v * 1e5) / 1e5);
  }
  globalThis.__WEIGHTS = JSON.stringify(json);
})();
`;

vm.runInContext(src, sandbox, { filename: 'train-bundle.js' });

const out = '\'use strict\';\n' +
  '/* Trained advisor network — generated by dev/train.js (behavior cloning\n' +
  ' * of the teacher policy over headless self-play games). Do not edit. */\n' +
  'const AI_WEIGHTS = ' + sandbox.__WEIGHTS + ';\n';
fs.writeFileSync(path.join(__dirname, '..', 'js', 'ai-weights.js'), out);
console.log('wrote js/ai-weights.js (' + (out.length / 1024).toFixed(1) + ' KB)');
