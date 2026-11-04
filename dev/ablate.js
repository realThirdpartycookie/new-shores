'use strict';
/* Neuron ablation for the hand-written net: switch one hidden unit off at a
 * time (bias −100 and no inputs: tanh = −1, i.e. "this need never fires")
 * and replay the 14 benchmark islands for 60 minutes.
 * Usage: node dev/ablate.js   → dev/ablation.json */

const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const SEEDS = [11, 22, 33, 44, 55, 66, 77, 88, 101, 202, 303, 404, 505, 606];

if (process.argv[2] === '--worker') {
  const H = require('./harness.js');
  process.on('message', ({ id, weights, seed }) => {
    const p = H.play(H.netPolicy(weights), seed, 900);
    process.send({ id, pops: p });
  });
  return;
}

const { build, UNITS } = require('./handwritten-net-v2.js');
const names = ['(none)', ...Object.keys(UNITS)];
const base = build();
const variant = j => {
  if (j < 0) return base;
  const w = JSON.parse(JSON.stringify(base));
  const nh = w.sizes[1];
  for (let i = 0; i < w.sizes[0]; i++) w.layers[0].W[i * nh + j] = 0;
  w.layers[0].b[j] = -100;
  return w;
};

(async () => {
  const workers = Array.from({ length: 7 }, () => fork(__filename, ['--worker']));
  const pending = new Map();
  let id = 0, rr = 0;
  for (const w of workers) w.on('message', m => { pending.get(m.id)(m); pending.delete(m.id); });
  const run = (weights, seed) => new Promise(res => { const i = id++; pending.set(i, res); workers[rr++ % 7].send({ id: i, weights, seed }); });
  const prog = p => p[0] + 3 * p[1] + 6 * p[2] + 10 * p[3];
  const out = [];
  await Promise.all(names.map(async (name, k) => {
    const w = variant(k - 1);
    const runs = await Promise.all(SEEDS.map(s => run(w, s)));
    out[k] = { neuron: name, progress60: runs.reduce((s, r) => s + prog(r.pops), 0) / runs.length,
      charters: runs.filter(r => r.pops[3] >= 25).length, citizensOn: runs.filter(r => r.pops[2] + r.pops[3] > 0).length };
  }));
  for (const w of workers) w.kill();
  const b = out[0].progress60;
  for (const o of out) { o.delta = +(o.progress60 - b).toFixed(0); console.log(`${o.neuron.padEnd(18)} progress ${o.progress60.toFixed(0).padStart(5)} (${o.delta >= 0 ? '+' : ''}${o.delta})  charters ${o.charters}/14  citizens on ${o.citizensOn}/14`); }
  fs.writeFileSync(path.join(__dirname, 'ablation.json'), JSON.stringify(out, null, 1) + '\n');
})();
