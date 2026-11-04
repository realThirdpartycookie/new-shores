'use strict';
/* Benchmark for the paper: every advisor policy on the same 14 seeded
 * islands, 60-minute games with a snapshot at 30 minutes.
 *
 *   random        uniform over the valid actions (the mask alone)
 *   teacher       the rule-based policy in js/ai.js
 *   BC net        behavior cloning of the teacher (dev/train.js)
 *   WSP v1 / v2   hand-written weights (dev/handwritten-net*.js), v2 ships
 *   PPO <run>     reinforcement learning from scratch (dev/rl-train.js), PPO=base,h60,…
 *                 each sampled (smp, as trained) and greedy (grd, as the game plays)
 *
 * Usage: SET=test|dev node dev/compare.js   → table on stdout, dev/results-<set>.json */

const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

// dev: the 14 islands the hand-written nets were developed on (looked at often);
// test: 30 fresh islands no method has seen — training, checkpoint selection
// and hand-tuning all happened elsewhere
const SETS = {
  dev: [11, 22, 33, 44, 55, 66, 77, 88, 101, 202, 303, 404, 505, 606],
  test: Array.from({ length: 30 }, (_, i) => 2001 + i),
};
const SET = process.env.SET || 'test';
const SEEDS = SETS[SET];
const STEPS = 900, SNAP = 450;

/* ---------------- worker ---------------- */

if (process.argv[2] === '--worker') {
  const H = require('./harness.js');
  const { AI } = H;
  process.on('message', ({ id, policy, weights, seed }) => {
    let fn;
    let rng = seed * 2654435761 >>> 0 || 1;
    if (policy === 'random') {
      fn = () => {
        const valid = AI.ACTIONS.filter(a => AI.roughValid(a));
        rng = (Math.imul(rng, 48271) + 1) >>> 0;
        return valid[Math.floor(rng / 4294967296 * valid.length)];
      };
    } else if (policy === 'teacher') fn = () => AI.teacherAction();
    else if (policy === 'sampled') {
      // a stochastic policy as PPO trains it: softmax over the valid actions, seeded
      const net = H.NN.fromJSON(weights);
      fn = () => {
        const z = H.NN.forward(net, AI.features());
        const ok = AI.ACTIONS.map((a, i) => i < z.length && AI.roughValid(a));
        let max = -Infinity;
        for (let i = 0; i < z.length; i++) if (ok[i] && z[i] > max) max = z[i];
        const p = z.map((v, i) => (ok[i] ? Math.exp(v - max) : 0));
        rng = (Math.imul(rng, 48271) + 1) >>> 0;
        let u = rng / 4294967296 * p.reduce((a, b) => a + b, 0), a = 0;
        for (; a < p.length - 1; a++) { u -= p[a]; if (u <= 0 && p[a] > 0) break; }
        while (!ok[a]) a--;
        return AI.ACTIONS[a];
      };
    } else fn = H.netPolicy(weights);
    let at30 = null, charter = null;
    const final = H.play(fn, seed, STEPS, s => {
      if (s + 1 === SNAP) at30 = H.pops();
      if (charter === null && H.sandbox.E.popOf(3) >= 25) charter = s + 1;
    });
    process.send({ id, at30, at60: final, charterStep: charter });
  });
  return;
}

/* ---------------- master ---------------- */

const progress = p => p[0] + 3 * p[1] + 6 * p[2] + 10 * p[3];

function netStats(w) {
  let total = 0, nonzero = 0;
  for (const l of w.layers) for (const v of [...l.W, ...l.b]) { total++; if (v !== 0) nonzero++; }
  return { sizes: w.sizes, weights: total, nonzero };
}

async function main() {
  const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
  const policies = [
    { name: 'random', policy: 'random' },
    { name: 'teacher', policy: 'teacher' },
    { name: 'BC net', policy: 'net', weights: read('ai-weights-trained.json') },
    { name: 'WSP v1', policy: 'net', weights: require('./handwritten-net.js').build() },
    { name: 'WSP v2', policy: 'net', weights: require('./handwritten-net-v2.js').build() },
  ];
  // PPO runs (dev/rl-weights-<run>.json), each played as trained (sampled) and as the game plays a net (greedy)
  for (const r of (process.env.PPO || '').split(',').filter(Boolean)) {
    const w = read(`rl-weights-${r}.json`);
    policies.push({ name: `PPO ${r} smp`, policy: 'sampled', weights: w }, { name: `PPO ${r} grd`, policy: 'net', weights: w });
  }

  const workers = Array.from({ length: Number(process.env.WORKERS || 7) }, () => fork(__filename, ['--worker']));
  const pending = new Map();
  let id = 0, rr = 0;
  for (const w of workers) w.on('message', m => { pending.get(m.id)(m); pending.delete(m.id); });
  const run = msg => new Promise(res => { const i = id++; pending.set(i, res); workers[rr++ % workers.length].send({ id: i, ...msg }); });

  const results = {};
  await Promise.all(policies.map(async p => {
    const runs = await Promise.all(SEEDS.map(seed => run({ policy: p.policy, weights: p.weights, seed })));
    results[p.name] = { net: p.weights ? netStats(p.weights) : null, runs: runs.map((r, i) => ({ seed: SEEDS[i], ...r })) };
  }));
  for (const w of workers) w.kill();

  const avg = (runs, k, t) => runs.reduce((s, r) => s + r[k][t], 0) / runs.length;
  console.log('policy           |  30 min: progress  P/S/C/M          |  60 min: progress  P/S/C/M          | charter  median min');
  for (const p of policies) {
    const { runs } = results[p.name];
    const row = k => {
      const prog = runs.reduce((s, r) => s + progress(r[k]), 0) / runs.length;
      return `${prog.toFixed(0).padStart(8)}  ${[0, 1, 2, 3].map(t => avg(runs, k, t).toFixed(0)).join('/').padEnd(18)}`;
    };
    const ch = runs.filter(r => r.charterStep !== null).map(r => r.charterStep * 4 / 60).sort((a, b) => a - b);
    const med = ch.length ? ch[Math.floor(ch.length / 2)].toFixed(0) : '–';
    results[p.name].summary = {
      progress30: runs.reduce((s, r) => s + progress(r.at30), 0) / runs.length,
      progress60: runs.reduce((s, r) => s + progress(r.at60), 0) / runs.length,
      pops30: [0, 1, 2, 3].map(t => avg(runs, 'at30', t)),
      pops60: [0, 1, 2, 3].map(t => avg(runs, 'at60', t)),
      charters: ch.length, charterMedianMin: ch.length ? +med : null,
      progress60PerIsland: runs.map(r => progress(r.at60)),
    };
    console.log(`${p.name.padEnd(16)} | ${row('at30')} | ${row('at60')} | ${String(ch.length).padStart(2)}/${SEEDS.length}  ${med.padStart(6)}`);
  }
  fs.writeFileSync(path.join(__dirname, `results-${SET}.json`), JSON.stringify(results, null, 1) + '\n');
}

main();
