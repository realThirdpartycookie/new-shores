'use strict';
/* Classical reinforcement learning baseline for the advisor: PPO from
 * scratch — no teacher, no hand-written weights.
 *
 *   policy  67 features → 64 tanh → 26 action logits (same format as
 *           js/ai-weights.js, so the game can load it), softmax over the
 *           actions that are valid in the state (same mask as the game)
 *   value   67 → 64 tanh → 1, a separate net
 *   reward  growth of progress = pioneers + 3·settlers + 6·citizens
 *           + 10·merchants, per decision, / 100
 *   update  PPO-clip (ε 0.2), GAE (γ 0.995, λ 0.95), entropy bonus, Adam
 *
 * Episodes are 30-minute games (450 decisions) on training islands that are
 * disjoint from the 14 benchmark islands; workers play them in parallel.
 *
 * Config (env): RUN name, EP_STEPS (450), EPISODES per iteration (14),
 *   WORKERS (7), ENT (0.01), LR (3e-4); warm start: INIT, INIT_TEMP (10),
 *   WARMUP (0), SPARSE (0) — see below.
 * Usage: node dev/rl-train.js [iterations]   → dev/rl-weights.json (best on validation),
 *        dev/rl-weights-final.json, dev/rl-weights-<iter>.json every 50, dev/rl-log.json
 */

const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const IN = 67, HID = 64;
const WORKERS = Number(process.env.WORKERS || 7);
const EPISODES_PER_ITER = Number(process.env.EPISODES || 14);
const STEPS = Number(process.env.EP_STEPS || 450); // decisions per game: 450 = 30 min
// a run name keeps parallel configurations apart: rl-log-<run>.json, rl-weights-<run>*.json
const RUN = process.env.RUN ? '-' + process.env.RUN : '';
// checkpoints are picked on validation islands; the 14 benchmark islands
// (11 … 606) are never seen in training or selection
const VAL_SEEDS = [901, 902, 903, 904, 905, 906, 907];
const GAMMA = 0.995, LAMBDA = 0.95, CLIP = 0.2, EPOCHS = 4, MINIBATCH = 512;
const ENT = Number(process.env.ENT || 0.01), LR = Number(process.env.LR || 3e-4);
// warm start from a hand-written net (WSP): INIT=<weights.json>, its logits
// divided by INIT_TEMP (the priorities would make the softmax deterministic,
// leaving nothing to explore); WARMUP iterations train only the value net;
// SPARSE=1 lets only the init's non-zero weights and the spare units change
const INIT = process.env.INIT, INIT_TEMP = Number(process.env.INIT_TEMP || 10);
const WARMUP = Number(process.env.WARMUP || 0), SPARSE = process.env.SPARSE === '1';

/* ================= worker: plays episodes ================= */

if (process.argv[2] === '--worker') {
  const H = require('./harness.js');
  const { AI, NN } = H;
  let rng = 1;
  const rand = () => { rng = (Math.imul(rng, 48271) + 1) >>> 0; return rng / 4294967296; };

  process.on('message', ({ id, weights, seed, steps, greedy, record = true }) => {
    const net = NN.fromJSON(weights);
    rng = seed * 2654435761 >>> 0 || 1;
    const feats = [], masks = [], actions = [], logps = [], rewards = [];
    let last = 0;
    const policy = () => {
      const x = AI.features();
      const z = NN.forward(net, x);
      const mask = AI.ACTIONS.map(a => AI.roughValid(a));
      let max = -Infinity;
      for (let i = 0; i < z.length; i++) if (mask[i] && z[i] > max) max = z[i];
      const p = z.map((v, i) => (mask[i] ? Math.exp(v - max) : 0));
      const sum = p.reduce((a, b) => a + b, 0);
      let a = 0;
      if (greedy) {
        for (let i = 1; i < p.length; i++) if (p[i] > p[a]) a = i;
      } else {
        let u = rand() * sum;
        for (a = 0; a < p.length - 1; a++) { u -= p[a]; if (u <= 0 && p[a] > 0) break; }
        while (!mask[a]) a--; // float edge case: never sample a masked action
      }
      if (record) {
        feats.push(Array.from(x)); masks.push(mask); actions.push(a); logps.push(Math.log(p[a] / sum));
      }
      return AI.ACTIONS[a];
    };
    const pops = H.play(policy, seed, steps, () => {
      if (!record) return;
      const now = H.progress(H.pops());
      rewards.push((now - last) / 100);
      last = now;
    });
    process.send({ id, pops, feats, masks, actions, logps, rewards });
  });
  return;
}

/* ================= master: PPO ================= */

let seedRng = 12345;
const srand = () => { seedRng = (Math.imul(seedRng, 1103515245) + 12345) >>> 0; return seedRng / 4294967296; };

function mlp(nout, scaleOut) {
  const init = (nin, n, s) => Array.from({ length: nin * n }, () => (srand() * 2 - 1) * s / Math.sqrt(nin));
  return {
    sizes: [IN, HID, nout],
    layers: [{ W: init(IN, HID, Math.sqrt(3)), b: new Array(HID).fill(0) },
             { W: init(HID, nout, scaleOut), b: new Array(nout).fill(0) }],
  };
}

function forward(net, x) {
  const [L1, L2] = net.layers, nout = net.sizes[2];
  const h = new Float64Array(HID);
  for (let j = 0; j < HID; j++) {
    let s = L1.b[j];
    for (let i = 0; i < IN; i++) s += x[i] * L1.W[i * HID + j];
    h[j] = Math.tanh(s);
  }
  const z = new Float64Array(nout);
  for (let k = 0; k < nout; k++) {
    let s = L2.b[k];
    for (let j = 0; j < HID; j++) s += h[j] * L2.W[j * nout + k];
    z[k] = s;
  }
  return { h, z };
}

// accumulate dLoss/dz (gz) back into grads g (same shape as net)
function backward(net, g, x, h, gz) {
  const [L1, L2] = net.layers, nout = net.sizes[2];
  const gh = new Float64Array(HID);
  for (let k = 0; k < nout; k++) {
    if (gz[k] === 0) continue;
    g.layers[1].b[k] += gz[k];
    for (let j = 0; j < HID; j++) { g.layers[1].W[j * nout + k] += h[j] * gz[k]; gh[j] += L2.W[j * nout + k] * gz[k]; }
  }
  for (let j = 0; j < HID; j++) {
    const d = gh[j] * (1 - h[j] * h[j]);
    if (d === 0) continue;
    g.layers[0].b[j] += d;
    for (let i = 0; i < IN; i++) if (x[i] !== 0) g.layers[0].W[i * HID + j] += x[i] * d;
  }
}

const zeros = net => ({ layers: net.layers.map(l => ({ W: new Float64Array(l.W.length), b: new Float64Array(l.b.length) })) });

function adam(net, state, g, n) {
  state.t++;
  const b1 = 0.9, b2 = 0.999, c1 = 1 - b1 ** state.t, c2 = 1 - b2 ** state.t;
  net.layers.forEach((l, li) => {
    for (const key of ['W', 'b']) {
      const p = l[key], gr = g.layers[li][key], m = state.m.layers[li][key], v = state.v.layers[li][key];
      const frozen = state.mask && state.mask.layers[li][key];
      for (let i = 0; i < p.length; i++) {
        if (frozen && !frozen[i]) continue;
        let gi = gr[i] / n;
        gi = Math.max(-1, Math.min(1, gi)); // crude gradient clip
        m[i] = b1 * m[i] + (1 - b1) * gi;
        v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        p[i] -= LR * (m[i] / c1) / (Math.sqrt(v[i] / c2) + 1e-8);
      }
    }
  });
}

function maskedSoftmax(z, mask) {
  let max = -Infinity;
  for (let i = 0; i < z.length; i++) if (mask[i] && z[i] > max) max = z[i];
  const p = new Float64Array(z.length);
  let sum = 0;
  for (let i = 0; i < z.length; i++) if (mask[i]) { p[i] = Math.exp(z[i] - max); sum += p[i]; }
  for (let i = 0; i < z.length; i++) p[i] /= sum;
  return p;
}

function ppoUpdate(pi, vf, opt, batch, trainPolicy) {
  const n = batch.length;
  for (let ep = 0; ep < EPOCHS; ep++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(srand() * (i + 1)); [batch[i], batch[j]] = [batch[j], batch[i]]; }
    for (let s = 0; s < n; s += MINIBATCH) {
      const mb = batch.slice(s, s + MINIBATCH);
      const gp = zeros(pi), gv = zeros(vf);
      for (const t of mb) {
        const { h, z } = forward(pi, t.x);
        const p = maskedSoftmax(z, t.mask);
        const logp = Math.log(Math.max(1e-12, p[t.a]));
        const ratio = Math.exp(logp - t.logp);
        const gz = new Float64Array(z.length);
        const clipped = (t.adv > 0 && ratio > 1 + CLIP) || (t.adv < 0 && ratio < 1 - CLIP);
        let H = 0;
        for (let i = 0; i < p.length; i++) if (p[i] > 0) H -= p[i] * Math.log(p[i]);
        for (let i = 0; i < p.length; i++) {
          if (!t.mask[i]) continue;
          // policy: −ratio·A·(1[i=a] − p_i), unless the clip holds the ratio
          if (!clipped) gz[i] -= ratio * t.adv * ((i === t.a ? 1 : 0) - p[i]);
          // entropy bonus: −ENT · dH/dz_i, dH/dz_i = −p_i (log p_i + H)
          if (p[i] > 0) gz[i] -= ENT * (-p[i] * (Math.log(p[i]) + H));
        }
        if (trainPolicy) backward(pi, gp, t.x, h, gz);
        const fv = forward(vf, t.x);
        backward(vf, gv, t.x, fv.h, [2 * (fv.z[0] - t.ret) * 0.5]);
      }
      if (trainPolicy) adam(pi, opt.pi, gp, mb.length);
      adam(vf, opt.vf, gv, mb.length);
    }
  }
}

function toJSON(net) {
  return { sizes: net.sizes.slice(), layers: net.layers.map(l => ({ W: Array.from(l.W, v => Math.round(v * 1e5) / 1e5), b: Array.from(l.b, v => Math.round(v * 1e5) / 1e5) })) };
}

/* Policy net from a hand-written one: its units become the first hidden
 * units, spare units start with zero output weights (so the start behaves
 * exactly like the init), and logits are divided by INIT_TEMP. */
function fromInit(file, nAct) {
  const w = JSON.parse(fs.readFileSync(path.resolve(__dirname, file), 'utf8'));
  const [nin, nh0, nout] = w.sizes;
  if (nin !== IN || nout !== nAct || nh0 > HID) throw new Error(`INIT ${w.sizes} does not fit ${IN} → ${HID} → ${nAct}`);
  const pi = mlp(nAct, 0.01);
  const [L1, L2] = pi.layers, [I1, I2] = w.layers;
  const mask = { layers: [{ W: new Uint8Array(L1.W.length), b: new Uint8Array(HID) }, { W: new Uint8Array(L2.W.length), b: new Uint8Array(nAct).fill(1) }] };
  for (let j = 0; j < HID; j++) {
    const own = j < nh0;
    for (let i = 0; i < IN; i++) {
      if (own) L1.W[i * HID + j] = I1.W[i * nh0 + j];
      mask.layers[0].W[i * HID + j] = own ? +(L1.W[i * HID + j] !== 0) : 1;
    }
    if (own) L1.b[j] = I1.b[j];
    mask.layers[0].b[j] = own ? +(L1.b[j] !== 0) : 1;
    for (let k = 0; k < nAct; k++) {
      L2.W[j * nAct + k] = own ? I2.W[j * nAct + k] / INIT_TEMP : 0;
      mask.layers[1].W[j * nAct + k] = own ? +(I2.W[j * nAct + k] !== 0) : 1;
    }
  }
  for (let k = 0; k < nAct; k++) L2.b[k] = I2.b[k] / INIT_TEMP;
  return { pi, mask: SPARSE ? mask : null };
}

async function main() {
  const iters = Number(process.argv[2] || 300);
  const nAct = require('./harness.js').AI.ACTIONS.length;
  const init = INIT ? fromInit(INIT, nAct) : null;
  const pi = init ? init.pi : mlp(nAct, 0.01), vf = mlp(1, 1);
  const opt = { pi: { t: 0, m: zeros(pi), v: zeros(pi), mask: init && init.mask }, vf: { t: 0, m: zeros(vf), v: zeros(vf) } };

  const workers = Array.from({ length: WORKERS }, () => fork(__filename, ['--worker']));
  const pending = new Map();
  let nextId = 0, rr = 0;
  for (const w of workers) w.on('message', m => { pending.get(m.id)(m); pending.delete(m.id); });
  const run = (weights, seed, steps, greedy, record = !greedy) => new Promise(res => {
    const id = nextId++;
    pending.set(id, res);
    workers[rr++ % workers.length].send({ id, weights, seed, steps, greedy, record });
  });

  const log = [];
  let trainSeed = 10000, best = -Infinity;
  const t0 = Date.now();
  // validation plays the policy PPO actually learns (sampled actions);
  // greedy argmax — how the game uses a net — is logged alongside
  const bench = async greedy => {
    const w = toJSON(pi);
    const runs = await Promise.all(VAL_SEEDS.map(s => run(w, s, STEPS, greedy, false)));
    const avg = t => runs.reduce((a, r) => a + r.pops[t], 0) / runs.length;
    return { pops: [0, 1, 2, 3].map(avg), progress: avg(0) + 3 * avg(1) + 6 * avg(2) + 10 * avg(3) };
  };
  const save = name => fs.writeFileSync(path.join(__dirname, name.replace('rl-weights', 'rl-weights' + RUN)), JSON.stringify(toJSON(pi)) + '\n');
  if (init) save('rl-weights-init.json');

  for (let it = 1; it <= iters; it++) {
    const w = toJSON(pi);
    const eps = await Promise.all(Array.from({ length: EPISODES_PER_ITER }, () => run(w, trainSeed++, STEPS, false)));
    // GAE over each episode, with the value net's estimates
    const batch = [];
    let ret = 0;
    for (const e of eps) {
      const T = e.actions.length;
      const v = e.feats.map(x => forward(vf, x).z[0]);
      let gae = 0;
      for (let t = T - 1; t >= 0; t--) {
        const next = t + 1 < T ? v[t + 1] : 0;
        const delta = e.rewards[t] + GAMMA * next - v[t];
        gae = delta + GAMMA * LAMBDA * gae;
        batch.push({ x: e.feats[t], mask: e.masks[t], a: e.actions[t], logp: e.logps[t], adv: gae, ret: gae + v[t] });
      }
      ret += H_progress(e.pops) / eps.length;
    }
    const mean = batch.reduce((s, t) => s + t.adv, 0) / batch.length;
    const sd = Math.sqrt(batch.reduce((s, t) => s + (t.adv - mean) ** 2, 0) / batch.length) || 1;
    for (const t of batch) t.adv = (t.adv - mean) / sd;
    ppoUpdate(pi, vf, opt, batch, it > WARMUP);

    const entry = { iter: it, episodes: it * EPISODES_PER_ITER, steps: it * EPISODES_PER_ITER * STEPS, trainProgress: Math.round(ret), minutes: +((Date.now() - t0) / 60000).toFixed(1) };
    if (it % 10 === 0 || it === iters) {
      const [b, g] = await Promise.all([bench(false), bench(true)]);
      entry.valProgress = Math.round(b.progress);
      entry.valPops = b.pops.map(Math.round);
      entry.valGreedyProgress = Math.round(g.progress);
      if (b.progress > best) { best = b.progress; save('rl-weights.json'); }
    }
    if (it % 50 === 0) save(`rl-weights-${it}.json`);
    if (it === iters) save('rl-weights-final.json');
    log.push(entry);
    fs.writeFileSync(path.join(__dirname, `rl-log${RUN}.json`), JSON.stringify(log, null, 1) + '\n');
    console.log(JSON.stringify(entry));
  }
  for (const w of workers) w.kill();
}

const H_progress = pops => pops[0] + 3 * pops[1] + 6 * pops[2] + 10 * pops[3];

main();
