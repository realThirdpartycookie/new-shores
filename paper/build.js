'use strict';
/* Builds the paper: fills paper.src.html with tables and figures generated
 * from the repository's own data, writes paper.html and prints paper.pdf.
 *
 *   {{NEURON_TABLE}}  the hand-written net (WSP v2), unit by unit (its weights)
 *   {{RL_CURVE}}      PPO learning curves from dev/rl-log*.json
 *   {{NET_STATS}}     size and sparsity of every net
 *
 * Usage: node paper/build.js   (PDF needs Playwright; set PLAYWRIGHT to its path) */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { FEATURES, AI } = require(path.join(ROOT, 'dev', 'harness.js'));
const v2 = require(path.join(ROOT, 'dev', 'handwritten-net-v2.js'));

/* ---------------- what each neuron is for (plain words) ---------------- */

const ROLE = {
  noMarket: ['Bootstrap', 'Fires while the island has no marketplace at all. Pioneers will not move in without one, so it outbids everything.'],
  foodNeed: ['Economy', 'Graded food pressure: rises with population, falls with food in store and with a positive food balance. Calls for fishers (first) and hunters, and dampens new houses.'],
  woodNeed: ['Economy', 'Graded wood pressure from stock and rate. Has no cap on woodcutters, unlike the game\'s original rule-based policy, whose cap of 4 starved large towns of planks.'],
  toolsNeed: ['Economy', 'Fewer than ~12 tools in store, strongly below 3: buy tools. Upgrades and most buildings consume tools.'],
  goldNeed: ['Economy', 'Treasury under ~250 gold: sell surplus goods.'],
  noChapel: ['Bootstrap', 'No chapel on the island yet.'],
  town10: ['Expansion', '10 or more houses. Drives a depot: a second road anchor that extends the building zone, so the town spreads instead of walling itself in.'],
  weaverLT: ['Chains', 'More sheep farms than weavers, or wool piling up: build a weaver.'],
  toolmakerLT: ['Chains', 'More iron mines than toolmakers, or iron piling up: build a toolmaker.'],
  bakeryLT: ['Chains', 'More grain farms than bakeries, or grain piling up: build a bakery.'],
  distilleryLT: ['Chains', 'More potato farms than distilleries, or potatoes piling up: build a distillery.'],
  growth: ['Growth', 'Houses are more than ~45 % full (or there are none yet): build another house. The default activity once nothing is urgent.'],
  storageFull: ['Expansion', 'Some good is at the storage cap: build a depot, or sell.'],
  foodCrisis: ['Economy', 'Fewer than 25 food and the balance is falling: emergency food purchase and a hard veto on new houses.'],
  grainTrigger: ['Chains', 'Food pressure once Settlers are unlocked and farms ≤ bakeries: build a grain farm (bread scales beyond fishing).'],
  marketTrigger: ['Services', 'More than ~10 % of existing houses lack a marketplace.'],
  faithTrigger: ['Services', 'Settlers unlocked and >15 % of houses lack chapel coverage.'],
  funTrigger: ['Services', '>15 % of houses lack a tavern. Placed above the cloth chain: a Citizen upgrade needs tavern coverage.'],
  fireTrigger: ['Safety', '10+ houses and no fire station.'],
  towerTrigger: ['Safety', 'Pirates have been sighted and there are fewer than 2 watchtowers.'],
  sheepTrigger: ['Chains', 'Cloth demand (Settlers unlocked, settlers and citizens eating cloth, little in store) with farms ≤ weavers and a town of ~60+ people that can carry the investment.'],
  mineTrigger: ['Chains', 'No iron mine yet and a town big enough to invest.'],
  potatoTrigger: ['Chains', 'Citizens unlocked, liquor short, potato farms ≤ distilleries.'],
  colonyTrigger: ['Colonies', 'Citizens unlocked, 20+ citizens, no Kontor yet and ≥ ~1600 gold: found a colony. The only road to spice, Merchants and the Imperial Charter.'],
  liquorImport: ['Trade', 'Liquor almost gone, a colony exists and ≥ ~1000 gold: import liquor (5 units buy several upgrades).'],
  liquorImportEarly: ['Trade', 'The same before a colony exists, but only from ~2000 gold, so imports never eat the Kontor\'s 1500.'],
  clothImport: ['Trade', 'Cloth almost gone and ≥ ~5000 idle gold: import cloth. Converts surplus gold into upgrades.'],
  spiceTrigger: ['Colonies', 'A colony exists, little spice in store, few gardens for the number of merchants: build a spice garden.'],
};

/* ---------------- what each action does, precisely ---------------- */

// building actions: the building and what it yields (from js/config.js);
// trades: amount and rule (from js/ai.js). The planner picks the spot near a
// town centre and paves the road to it.
const BUILDINGS = require('vm').runInContext('BUILDINGS', require(path.join(ROOT, 'dev', 'harness.js')).sandbox);
const TRADES = {
  wait: 'wait (do nothing this turn)',
  sell: 'sell ≤ 10 of the largest surplus good',
  buytools: 'buy 5 tools from the trader',
  buyfood: 'buy 5 food from the trader',
  buyliquor: 'buy 5 liquor from the trader',
  buycloth: 'buy 5 cloth from the trader',
};
function actionLabel(action) {
  if (!action.startsWith('build:')) return TRADES[action] || action;
  const k = action.slice(6), d = BUILDINGS[k];
  const perMin = p => +(p.n * 60 / p.cycle).toFixed(1);
  let what = '';
  if (d.prod) what = d.prod.in
    ? `${Object.keys(d.prod.in)[0]} → ${perMin(d.prod)} ${d.prod.out}/min`
    : `+${perMin(d.prod)} ${d.prod.out}/min`;
  else if (d.service) what = `${{ market: 'market', faith: 'faith', fun: 'fun' }[d.service]} for houses within ${d.radius}` + (d.zone ? `, zone +${d.zone}` : '');
  else if (k === 'house') what = 'home for 8–40 residents, taxes';
  else if (k === 'depot') what = `zone +${d.zone}, storage +${d.storage}`;
  else if (k === 'kontor') what = `colony on another island, zone ${d.zone}`;
  else if (k === 'watchtower') what = `cannons, range ${d.range}`;
  else if (k === 'firehouse') what = `puts out fires within ${d.radius}`;
  return `build ${d.name}` + (what ? ` · ${what}` : '');
}

/* ---------------- tables ---------------- */

const fmt = v => (v >= 0 ? '+' : '−') + String(Math.abs(+v.toFixed(2)));
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function neuronTable() {
  const w = v2.build();
  const [L1, L2] = w.layers, [nin, nh, nout] = w.sizes;
  const names = Object.keys(v2.UNITS);
  const rows = names.map((name, j) => {
    const ins = [];
    for (let i = 0; i < nin; i++) {
      const v = L1.W[i * nh + j];
      if (v) ins.push(`<span class="w">${fmt(v)}</span>·<span class="f">${esc(FEATURES[i])}</span>`);
    }
    ins.push(`<span class="w">${fmt(L1.b[j])}</span>`);
    const outs = [];
    for (let k = 0; k < nout; k++) {
      const v = L2.W[j * nout + k];
      if (v) outs.push(`<span class="w">${fmt(2 * v)}</span>&nbsp;<span class="a">${esc(actionLabel(AI.ACTIONS[k]))}</span>`);
    }
    const [group, text] = ROLE[name] || ['', ''];
    return `<tr><td class="num">h${j}</td><td><code>${name}</code><div class="grp">${group}</div></td>` +
      `<td class="pre">${ins.join(' ')}</td><td class="pre">${outs.join('<br>')}</td><td>${text}</td></tr>`;
  });
  return `<table class="neurons"><thead><tr><th>#</th><th>neuron</th><th>pre-activation: tanh( Σ w·x + b )</th><th>priority added to action</th><th>role</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function netStats() {
  const stat = (name, w, how) => {
    let tot = 0, nz = 0;
    for (const l of w.layers) for (const v of [...l.W, ...l.b]) { tot++; if (v !== 0) nz++; }
    return `<tr><td>${name}</td><td class="num">${w.sizes.join(' → ')}</td><td class="num">${tot.toLocaleString('en')}</td><td class="num">${nz.toLocaleString('en')}</td><td class="num">${(100 * nz / tot).toFixed(1)} %</td><td>${how}</td></tr>`;
  };
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', f), 'utf8')); } catch { return null; } };
  const rows = [
    stat('BC net', read('ai-weights-trained.json'), 'behavior cloning + DAgger (gradient descent)'),
    stat('WSP v2', v2.build(), 'hand-written: needs → priorities'),
  ];
  const rl = read('rl-weights.json');
  if (rl) rows.push(stat('PPO net', rl, 'reinforcement learning from scratch'));
  return `<table class="data"><thead><tr><th>net</th><th>layers</th><th>parameters</th><th>non-zero</th><th>density</th><th>how the weights were made</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

/* ---------------- figure: the hand-written MLP, drawn from its weights ---------------- */

// what each hidden unit does, as a short name for the drawing
const LABEL = {
  noMarket: 'no market yet', noChapel: 'no chapel yet',
  foodNeed: 'food pressure', woodNeed: 'wood pressure', toolsNeed: 'tools short', goldNeed: 'gold short',
  foodCrisis: 'famine', growth: 'houses filling up', town10: 'town of 10+ houses', storageFull: 'storage full',
  marketTrigger: 'market coverage gap', faithTrigger: 'chapel coverage gap', funTrigger: 'tavern coverage gap',
  fireTrigger: 'no fire brigade', towerTrigger: 'pirates, few towers',
  weaverLT: 'wool backlog', toolmakerLT: 'iron backlog', bakeryLT: 'grain backlog', distilleryLT: 'potato backlog',
  grainTrigger: 'bread needed', sheepTrigger: 'cloth needed', mineTrigger: 'own iron needed', potatoTrigger: 'liquor needed',
  colonyTrigger: 'found a colony', spiceTrigger: 'spice needed',
  liquorImport: 'import liquor', liquorImportEarly: 'import liquor (no colony)', clothImport: 'import cloth',
};
const GROUP_ORDER = ['Bootstrap', 'Economy', 'Growth', 'Expansion', 'Services', 'Safety', 'Chains', 'Colonies', 'Trade'];

function mlpFigure() {
  const w = v2.build();
  const [L1, L2] = w.layers, [nin, nh, nout] = w.sizes;
  const names = Object.keys(v2.UNITS);
  // hidden units grouped by role
  const hid = names.map((n, j) => ({ j, n, g: (ROLE[n] || ['Other'])[0] }))
    .sort((a, b) => GROUP_ORDER.indexOf(a.g) - GROUP_ORDER.indexOf(b.g) || a.j - b.j);
  const hpos = new Map(hid.map((h, r) => [h.j, r]));
  // inputs and outputs that carry a weight, ordered by the hidden units they touch
  const bary = (pairs) => pairs.reduce((s, [r, v]) => s + r * Math.abs(v), 0) / pairs.reduce((s, [, v]) => s + Math.abs(v), 0);
  const ins = [], outs = [];
  for (let i = 0; i < nin; i++) {
    const e = []; for (let j = 0; j < nh; j++) if (L1.W[i * nh + j]) e.push([hpos.get(j), L1.W[i * nh + j], j]);
    if (e.length) ins.push({ i, e, b: bary(e) });
  }
  for (let k = 0; k < nout; k++) {
    const e = []; for (let j = 0; j < nh; j++) if (L2.W[j * nout + k]) e.push([hpos.get(j), 2 * L2.W[j * nout + k], j]);
    if (e.length) outs.push({ k, e, b: bary(e) });
  }
  ins.sort((a, b) => a.b - b.b); outs.sort((a, b) => a.b - b.b);

  const W = 900, T = 28, B = 14, rowH = 15.5;
  const H = T + B + rowH * Math.max(ins.length, hid.length, outs.length);
  const yAt = (r, n) => T + (H - T - B) * (r + 0.5) / n;
  const xIn = 168, xH0 = 318, xH1 = 470, xOut = 610;
  const iy = new Map(ins.map((o, r) => [o.i, yAt(r, ins.length)]));
  const hy = new Map(hid.map((h, r) => [h.j, yAt(r, hid.length)]));
  const oy = new Map(outs.map((o, r) => [o.k, yAt(r, outs.length)]));
  const width = (v, k) => Math.min(3.2, 0.35 + Math.log1p(Math.abs(v)) * k).toFixed(2);
  const curve = (x1, y1, x2, y2) => { const m = (x1 + x2) / 2; return `M${x1},${y1.toFixed(1)} C${m},${y1.toFixed(1)} ${m},${y2.toFixed(1)} ${x2},${y2.toFixed(1)}`; };

  let edges = '';
  for (const o of ins) for (const [, v, j] of o.e)
    edges += `<path class="${v > 0 ? 'ep' : 'en'}" stroke-width="${width(v, 0.45)}" d="${curve(xIn + 4, iy.get(o.i), xH0, hy.get(j))}"/>`;
  for (const o of outs) for (const [, v, j] of o.e)
    edges += `<path class="${v > 0 ? 'ep' : 'en'}" stroke-width="${width(v, 0.55)}" d="${curve(xH1, hy.get(j), xOut - 4, oy.get(o.k))}"/>`;

  let nodes = '';
  for (const o of ins) nodes += `<circle class="ni" cx="${xIn}" cy="${iy.get(o.i)}" r="3.4"/><text class="lin" x="${xIn - 8}" y="${iy.get(o.i) + 3.2}" text-anchor="end">${esc(FEATURES[o.i])}</text>`;
  let lastG = '';
  for (const h of hid) {
    const y = hy.get(h.j);
    nodes += `<rect class="nh nh-${h.g.toLowerCase()}" x="${xH0}" y="${(y - 6.6).toFixed(1)}" width="${xH1 - xH0}" height="13.2" rx="6.6"/>` +
      `<text class="lh" x="${xH0 + 9}" y="${(y + 3.4).toFixed(1)}"><tspan class="hid">h${h.j}</tspan> ${esc(LABEL[h.n] || h.n)}</text>`;
    if (h.g !== lastG) { nodes += `<text class="lg" x="${xH1 + 6}" y="${(y + 3.2).toFixed(1)}">${h.g}</text>`; lastG = h.g; }
  }
  for (const o of outs) nodes += `<circle class="no" cx="${xOut}" cy="${oy.get(o.k)}" r="3.4"/><text class="lout" x="${xOut + 8}" y="${oy.get(o.k) + 3.2}">${esc(actionLabel(AI.ACTIONS[o.k]))}</text>`;

  const heads = `<text class="col" x="${xIn}" y="14" text-anchor="end">inputs used (${ins.length} of ${nin})</text>` +
    `<text class="col" x="${(xH0 + xH1) / 2}" y="14" text-anchor="middle">hidden units, tanh (${nh})</text>` +
    `<text class="col" x="${xOut}" y="14">actions (${outs.length} of ${nout})</text>`;
  const nEdges = ins.reduce((s, o) => s + o.e.length, 0) + outs.reduce((s, o) => s + o.e.length, 0);
  return { svg: `<svg class="mlp" viewBox="0 0 ${W} ${H.toFixed(0)}" role="img" aria-label="The hand-written network, every non-zero weight">${edges}${nodes}${heads}</svg>`, nEdges, nIns: ins.length, nOuts: outs.length };
}

/* ---------------- ablation and agreement tables ---------------- */

function ablationTable() {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'ablation.json'), 'utf8')); } catch { return '<p class="pending">dev/ablation.json missing — run node dev/ablate.js</p>'; }
  const base = rows[0], names = Object.keys(v2.UNITS);
  const maxLoss = Math.max(...rows.map(r => -r.delta));
  const body = rows.slice(1).sort((a, b) => a.delta - b.delta).map(r => {
    const j = names.indexOf(r.neuron);
    const bar = r.delta < 0 ? `<span class="bar" style="width:${(100 * -r.delta / maxLoss).toFixed(1)}%"></span>` : '';
    return `<tr><td class="num">h${j}</td><td>${esc(LABEL[r.neuron] || r.neuron)}</td><td class="barcell">${bar}</td>` +
      `<td class="num">${r.delta > 0 ? '+' : r.delta < 0 ? '−' : '±'}${Math.abs(r.delta).toLocaleString('en')}</td>` +
      `<td class="num">${Math.round(r.progress60).toLocaleString('en')}</td><td class="num">${r.citizensOn}/14</td><td class="num">${r.charters}/14</td></tr>`;
  });
  return `<table class="data ablation"><thead><tr><th>#</th><th>unit switched off</th><th>loss of progress</th><th class="num">Δ</th><th class="num">progress</th><th class="num">citizens on</th><th class="num">Charter</th></tr></thead>` +
    `<tbody><tr class="best"><td></td><td>none (WSP v2 as written)</td><td></td><td class="num">—</td><td class="num">${Math.round(base.progress60).toLocaleString('en')}</td><td class="num">${base.citizensOn}/14</td><td class="num">${base.charters}/14</td></tr>${body.join('')}</tbody></table>`;
}

function agreementTable() {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'agreement.json'), 'utf8')); } catch { return ''; }
  const pct = v => (100 * v).toFixed(1) + ' %';
  return `<table class="data"><thead><tr><th>policy</th><th class="num">accuracy (agrees with imitated policy)</th><th class="num">houses fully supplied</th></tr></thead><tbody>` +
    Object.entries(d).map(([n, r]) => `<tr><td>${n}</td><td class="num">${pct(r.agreement)}</td><td class="num">${pct(r.satisfied)}</td></tr>`).join('') + '</tbody></table>';
}

/* ---------------- main results ---------------- */

const NICE = {
  random: 'uniform random (valid actions)', teacher: 'rule-based teacher', 'BC net': 'BC net (imitation)',
  'WSP v1': 'WSP v1 (hand-written)', 'WSP v2': 'WSP v2 (hand-written)',
};
function nice(name) {
  if (NICE[name]) return NICE[name];
  const m = name.match(/^PPO (\S+?)(-final)? (smp|grd)$/);
  if (!m) return name;
  const ckpt = m[2] ? 'final' : 'best';
  m[2] = m[3];
  const run = { base: '30-min games', h60: '60-min games', big: '30-min, 4× batch', lowent: '30-min, low entropy', h60big: '60-min, 4× batch',
    wsprl: 'WSP v2 init, all weights', wsprlsparse: 'WSP v2 init, sparse' }[m[1]] || m[1];
  const init = m[1].startsWith('wsp');
  return `${init ? 'WSP+PPO' : 'PPO'} ${m[1]} (${run}), ${ckpt} checkpoint, ${m[2] === 'smp' ? 'sampled' : 'greedy'}`;
}

const MAIN = k => ['random', 'BC net', 'WSP v2'].includes(k) || /^PPO (h60big|wsprl|wsprlsparse)(-final)? /.test(k);
const SEARCH = k => /^PPO (base|h60|big|lowent|h60big)(-final)? /.test(k);

function resultsTable(set, keep = MAIN) {
  let r;
  try { r = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', `results-${set}.json`), 'utf8')); } catch { return `<p class="pending">dev/results-${set}.json missing — run SET=${set} node dev/compare.js</p>`; }
  // the rule-based policy and the discarded first hand-written net are left out of the paper
  const names = Object.keys(r).filter(k => k !== 'teacher' && k !== 'WSP v1' && keep(k)), n = r[names[0]].runs.length;
  const best = Math.max(...names.map(k => r[k].summary.progress60));
  const bestCh = Math.max(...names.map(k => r[k].summary.charters));
  const fmtP = p => p.map(v => Math.round(v)).join(' / ');
  const rows = names.map(k => {
    const s = r[k].summary;
    const b = (v, m) => v === m ? `<b>${typeof v === 'number' ? Math.round(v).toLocaleString('en') : v}</b>` : (typeof v === 'number' ? Math.round(v).toLocaleString('en') : v);
    return `<tr${k.startsWith('PPO') && k.endsWith('grd') ? ' class="grd"' : ''}><td>${nice(k)}</td><td class="num">${Math.round(s.progress30).toLocaleString('en')}</td>` +
      `<td class="num">${b(s.progress60, best)}</td><td class="num">${fmtP(s.pops60)}</td><td class="num">${s.charters === bestCh ? '<b>' + s.charters + '</b>' : s.charters}/${n}</td><td class="num">${s.charterMedianMin ?? '–'}</td></tr>`;
  });
  return `<table class="data"><thead><tr><th>policy</th><th class="num">progress 30 min</th><th class="num">progress 60 min</th><th class="num">P / S / C / M at 60 min</th><th class="num">Charter</th><th class="num">median min to Charter</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

/* ---------------- what PPO changed in the hand-written net ---------------- */

function rlDiffTable(run = 'wsprlsparse-final', temp = 10) {
  let w;
  try { w = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', `rl-weights-${run}.json`), 'utf8')); } catch { return ''; }
  const w0 = v2.build(), names = Object.keys(v2.UNITS);
  const [nin, nh, nout] = w.sizes, nh0 = w0.sizes[1];
  const rows = [];
  for (let j = 0; j < nh0; j++) {
    let d = 0, n = 0;
    for (let i = 0; i < nin; i++) { d += Math.abs(w.layers[0].W[i * nh + j] - w0.layers[0].W[i * nh0 + j]); n += Math.abs(w0.layers[0].W[i * nh0 + j]); }
    const ch = [];
    for (let k = 0; k < nout; k++) {
      const p0 = 2 * w0.layers[1].W[j * nout + k], p1 = 2 * w.layers[1].W[j * nout + k] * temp;
      if (p0 !== 0) ch.push({ a: actionLabel(AI.ACTIONS[k]), p0, p1 });
    }
    for (const c of ch) rows.push({ j, unit: LABEL[names[j]] || names[j], drift: 100 * d / n, ...c });
  }
  rows.sort((a, b) => Math.abs(b.p1 - b.p0) - Math.abs(a.p1 - a.p0));
  const spare = [];
  for (let j = nh0; j < nh; j++) { let s = 0; for (let k = 0; k < nout; k++) s += Math.abs(2 * w.layers[1].W[j * nout + k] * temp); spare.push(s); }
  const fmtD = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(0);
  const body = rows.map(r => `<tr><td class="num">h${r.j}</td><td>${esc(r.unit)}</td><td>${esc(r.a)}</td><td class="num">${r.p0.toFixed(0)}</td><td class="num">${r.p1.toFixed(0)}</td><td class="num">${fmtD(r.p1 - r.p0)}</td><td class="num">${r.drift.toFixed(1)} %</td></tr>`);
  return `<table class="data"><thead><tr><th>#</th><th>hand-written unit</th><th>action</th><th class="num">priority written</th><th class="num">after PPO</th><th class="num">Δ</th><th class="num">input drift</th></tr></thead><tbody>${body.join('')}</tbody></table>` +
    `<p class="figmeta">${nh - nh0} spare units added by PPO: their summed priorities range from ${Math.min(...spare).toFixed(0)} to ${Math.max(...spare).toFixed(0)} (median ${spare.sort((a, b) => a - b)[Math.floor(spare.length / 2)].toFixed(0)}). Input drift = Σ|Δw| / Σ|w| over the unit's input weights.</p>`;
}

/* ---------------- cost ---------------- */

// Sources and assumptions (all in the paper's references):
// CPU: AWS c7a on-demand, ~$0.0513 per vCPU-hour (us-east-1), assumed flat over time.
// Tokens: list prices of the models used (Claude Opus 5.5 $4/$20 per M input/output,
// cache reads $0.20; Claude Fable 5.1 $10/$50, cache reads $0.25).
// The token use of this study is an ESTIMATE (no billing export): a few hundred
// requests, each re-sending a growing context (up to ~200k tokens), mostly cached.
const CPU_USD_PER_CORE_HOUR = 0.0513;
const WSP_TOKEN_USD = [15, 30];        // estimated, WSP development only (bounds)
const SESSION_TOKEN_USD = [30, 60];    // estimated, whole study incl. bug fixes, paper
const WSP_DECISIONS = 0.3e6;           // estimated: ~25 benchmark runs + ~50 traced games
// workers per RL run (cores in use while it ran), from how each was launched
const RL_WORKERS = { base: 14, h60: 14, big: 56, lowent: 14, h60big: 56, wsprl: 56, wsprlsparse: 56 };

function rlRuns() {
  const out = [];
  for (const [name, w] of Object.entries(RL_WORKERS)) {
    let log;
    try { log = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', `rl-log-${name}.json`), 'utf8')); } catch { continue; }
    const last = log[log.length - 1];
    const coreHours = last.minutes / 60 * (w + 1);
    out.push({ name, iters: last.iter, decisions: last.steps, minutes: last.minutes, coreHours, usd: coreHours * CPU_USD_PER_CORE_HOUR });
  }
  return out;
}

const money = v => v < 10 ? '$' + v.toFixed(2) : '$' + Math.round(v);
const mega = v => (v / 1e6).toFixed(v < 1e6 ? 2 : 1) + ' M';

function costTable() {
  const runs = rlRuns();
  const rows = [
    ['BC net (dev/train.js)', '≈ 0.05 M', '≈ 0.2 core-h', money(0.2 * CPU_USD_PER_CORE_HOUR), '—', 'imitates a rule-based policy written by hand beforehand'],
    ['WSP v2 (this study)', `≈ ${mega(WSP_DECISIONS)}`, '≈ 2 core-h', money(2 * CPU_USD_PER_CORE_HOUR), `≈ $${WSP_TOKEN_USD[0]}–${WSP_TOKEN_USD[1]} (est.)`, 'an AI agent writing weights; a person steering'],
    ...runs.map(r => [`PPO ${r.name}`, mega(r.decisions), `${r.coreHours.toFixed(0)} core-h`, money(r.usd), '—', `${r.iters} iterations, ${Math.round(r.minutes)} min wall time`]),
  ];
  const total = runs.reduce((s, r) => s + r.usd, 0), totalH = runs.reduce((s, r) => s + r.coreHours, 0);
  if (runs.length) rows.push([`all ${runs.length} PPO runs`, mega(runs.reduce((s, r) => s + r.decisions, 0)), `${totalH.toFixed(0)} core-h`, money(total), '—', 'every configuration tried, incl. the WSP-initialized runs']);
  return `<table class="data"><thead><tr><th>method</th><th class="num">simulated decisions</th><th class="num">CPU</th><th class="num">CPU cost</th><th class="num">LLM tokens</th><th>note</th></tr></thead><tbody>` +
    rows.map(r => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td class="num">${r[2]}</td><td class="num">${r[3]}</td><td class="num">${r[4]}</td><td>${r[5]}</td></tr>`).join('') + '</tbody></table>';
}

// numbers quoted in the running text, derived from the same logs
function costFacts() {
  const runs = rlRuns(), best = runs.find(r => r.name === 'h60big') || runs[0];
  const mid = (WSP_TOKEN_USD[0] + WSP_TOKEN_USD[1]) / 2;
  const cross = rate => Math.log(mid / best.usd) / Math.log(rate); // years until WSP tokens < best PPO run
  const months = t => Math.max(1, Math.round(t * 12));
  return {
    ALL_USD: money(runs.reduce((s, r) => s + r.usd, 0)),
    N_RUNS: String(runs.length),
    BEST_USD: money(best.usd),
    BEST_DECISIONS: mega(best.decisions),
    SAMPLE_RATIO: String(Math.round(best.decisions / WSP_DECISIONS)),
    CROSS_FRONTIER: (cross(2)).toFixed(1),
    CROSS_10: String(months(cross(10))),
    CROSS_50: String(months(cross(50))),
  };
}

/* Strategy comparison: test-set performance next to the effort behind it */
function strategyTable() {
  let r;
  try { r = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'results-test.json'), 'utf8')); } catch { return ''; }
  const runs = Object.fromEntries(rlRuns().map(x => [x.name, x]));
  const S = k => r[k] && r[k].summary, n = 30;
  const perf = (smp, grd) => {
    const a = S(smp), b = grd && S(grd);
    return `<td class="num">${a.charters}/${n}${b ? ` · ${b.charters}/${n}` : ''}</td><td class="num">${Math.round(a.progress60).toLocaleString('en')}${b ? ` · ${Math.round(b.progress60).toLocaleString('en')}` : ''}</td>`;
  };
  const search = ['base', 'h60', 'big', 'lowent', 'h60big'].map(k => runs[k]).filter(Boolean);
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  const wspCpu = 2 * CPU_USD_PER_CORE_HOUR;
  const tok = `$${WSP_TOKEN_USD[0]}–${WSP_TOKEN_USD[1]} (est.)`;
  const row = (name, perfCells, dec, coreH, usdCpu, tokens, wall, needs) =>
    `<tr><td>${name}</td>${perfCells}<td class="num">${dec}</td><td class="num">${coreH}</td><td class="num">${usdCpu}</td><td class="num">${tokens}</td><td>${wall}</td><td>${needs}</td></tr>`;
  const h = runs.h60big, sp = runs.wsprlsparse, de = runs.wsprl;
  const rows = [
    row('Imitation (BC)', perf('BC net'), '0.05 M', '0.2 core-h', money(0.2 * CPU_USD_PER_CORE_HOUR), '—', 'minutes', 'a rule-based policy to imitate'),
    row('RL only, one run (h60big)', perf('PPO h60big smp', 'PPO h60big-final grd'), mega(h.decisions), `${h.coreHours.toFixed(0)} core-h`, money(h.usd), '—', `${Math.round(h.minutes)} min on ${RL_WORKERS.h60big + 1} cores`, 'a reward, the right episode length and batch size'),
    row('RL only, with the configuration search', perf('PPO h60big smp', 'PPO h60big-final grd'), mega(sum(search, x => x.decisions)), `${sum(search, x => x.coreHours).toFixed(0)} core-h`, money(sum(search, x => x.usd)), '—', `≈ ${Math.round(Math.max(...search.map(x => x.minutes)))} min on ${search.reduce((s, x) => s + RL_WORKERS[x.name] + 1, 0)} cores`, 'as above, found by trying five configurations'),
    row('WSP only (v2)', perf('WSP v2'), `≈ ${mega(WSP_DECISIONS)}`, '≈ 2 core-h', money(wspCpu), tok, 'one working session of an agent', 'an agent that can read the game; a person steering'),
    row('Hybrid, sparse (WSP + one RL run)', perf('PPO wsprlsparse smp', 'PPO wsprlsparse-final grd'), mega(WSP_DECISIONS + sp.decisions), `≈ ${(2 + sp.coreHours).toFixed(0)} core-h`, money(wspCpu + sp.usd), tok, `WSP session + ${Math.round(sp.minutes)} min on ${RL_WORKERS.wsprlsparse + 1} cores`, 'both of the above; the RL configuration from the search'),
    row('Hybrid, all weights (WSP + one RL run)', perf('PPO wsprl smp', 'PPO wsprl-final grd'), mega(WSP_DECISIONS + de.decisions), `≈ ${(2 + de.coreHours).toFixed(0)} core-h`, money(wspCpu + de.usd), tok, `WSP session + ${Math.round(de.minutes)} min on ${RL_WORKERS.wsprl + 1} cores`, 'as above'),
  ];
  return `<table class="data"><thead><tr><th>strategy</th><th class="num">Charter sampled · greedy</th><th class="num">progress sampled · greedy</th><th class="num">simulated decisions</th><th class="num">CPU</th><th class="num">CPU cost</th><th class="num">LLM tokens</th><th>wall time</th><th>what it needs</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

/* Projection: the estimated token cost of WSP v2 under the published rates at
 * which LLM prices fall, against the CPU cost of PPO (assumed flat). */
function costFigure() {
  const runs = rlRuns();
  const best = runs.find(r => r.name === 'h60big') || runs[0];
  const all = runs.reduce((s, r) => s + r.usd, 0);
  const W = 640, H = 270, L = 58, R = 150, T = 14, B = 40;
  const years = 3, yMin = 0.01, yMax = 100;
  const x = t => L + (W - L - R) * t / years;
  const y = v => T + (H - T - B) * (Math.log10(yMax) - Math.log10(Math.max(yMin, v))) / (Math.log10(yMax) - Math.log10(yMin));
  let g = '';
  for (let e = -2; e <= 2; e++) { const v = 10 ** e; g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v >= 1 ? '$' + v : '$' + v.toFixed(2)}</text>`; }
  for (let t = 0; t <= years; t++) g += `<text class="tick" x="${x(t)}" y="${H - B + 16}" text-anchor="middle">${t === 0 ? 'today' : '+' + t + ' y'}</text>`;
  const mid = (WSP_TOKEN_USD[0] + WSP_TOKEN_USD[1]) / 2;
  const curve = (rate, cls, label) => {
    const pts = []; for (let i = 0; i <= 30; i++) { const t = years * i / 30; pts.push(`${x(t).toFixed(1)},${y(mid / rate ** t).toFixed(1)}`); }
    const tEnd = Math.min(years, Math.log(mid / yMin) / Math.log(rate));
    return `<polyline class="${cls}" points="${pts.join(' ')}"/><text class="lbl" x="${x(years) + 6}" y="${y(Math.max(yMin, mid / rate ** years)) + 4}">${label}</text>`;
  };
  const flat = (v, cls, label) => `<line class="${cls}" x1="${x(0)}" x2="${x(years)}" y1="${y(v)}" y2="${y(v)}"/><text class="lbl" x="${x(years) + 6}" y="${y(v) + 4}">${label}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Projected cost of WSP versus PPO">${g}
    <text class="axis" transform="translate(13 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">cost of one policy (log scale)</text>
    ${curve(2, 'c-front', 'WSP, frontier list price −2×/y')}
    ${curve(10, 'c-ten', 'WSP, same capability −10×/y')}
    ${curve(50, 'c-fifty', 'WSP, same capability −50×/y')}
    ${best ? flat(best.usd, 'c-rl', `PPO best run ${money(best.usd)}`) : ''}
    ${all ? flat(all, 'c-rlall', `PPO search ${money(all)}`) : ''}
  </svg>`;
}

/* ---------------- figure: PPO learning curves ---------------- */

function rlCurve() {
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', f), 'utf8')); } catch { return []; } };
  const runs = [['h60big', 'PPO from scratch', 'r-scratch'], ['wsprl', 'WSP+PPO, all weights', 'r-dense'], ['wsprlsparse', 'WSP+PPO, sparse', 'r-sparse']]
    .map(([n, label, cls]) => ({ label, cls, log: read(`rl-log-${n}.json`).filter(e => e.valProgress != null) }));
  const W = 640, H = 270, L = 52, R = 16, T = 14, B = 40;
  const maxIt = 200, maxY = 3500;
  const x = i => L + (W - L - R) * i / maxIt, y = v => T + (H - T - B) * (1 - v / maxY);
  let g = '';
  for (let v = 0; v <= maxY; v += 500) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  for (let i = 0; i <= maxIt; i += 50) g += `<text class="tick" x="${x(i)}" y="${H - B + 16}" text-anchor="middle">${i}</text>`;
  const line = (pts, cls) => `<polyline class="${cls}" points="${pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`;
  let lines = '';
  for (const r of runs) {
    lines += line(r.log.map(e => [e.iter, e.valProgress]), r.cls + ' smp') + line(r.log.map(e => [e.iter, e.valGreedyProgress]), r.cls + ' grd');
  }
  const wsp = 2445; // WSP v2 alone, 60 min, development islands — reference only
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="PPO learning curves">${g}
    <text class="axis" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">iteration (56 sixty-minute games each)</text>
    <text class="axis" transform="translate(13 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">progress after 60 min, validation</text>
    <line class="x20" x1="${x(20)}" x2="${x(20)}" y1="${T}" y2="${H - B}"/><text class="tick" x="${x(20) + 4}" y="${T + 10}">policy unfrozen</text>
    ${lines}</svg>
  <div class="legend">${runs.map(r => `<span><i class="k ${r.cls}"></i>${r.label}</span>`).join('')}<span><i class="k smpk"></i>sampled</span><span><i class="k grdk"></i>greedy</span></div>`;
}

/* ---------------- build ---------------- */

let html = fs.readFileSync(path.join(__dirname, 'paper.src.html'), 'utf8');
const mlp = mlpFigure();
html = html.replace('{{NEURON_TABLE}}', neuronTable())
  .replace('{{MLP_FIGURE}}', mlp.svg)
  .replace('{{MLP_EDGES}}', String(mlp.nEdges)).replace('{{MLP_INS}}', String(mlp.nIns)).replace('{{MLP_OUTS}}', String(mlp.nOuts))
  .replace('{{RL_CURVE}}', rlCurve())
  .replace('{{NET_STATS}}', netStats())
  .replace('{{ABLATION}}', ablationTable())
  .replace('{{AGREEMENT}}', agreementTable())
  .replace('{{RESULTS_TEST}}', resultsTable('test'))
  .replace('{{RESULTS_SEARCH}}', resultsTable('test', SEARCH))
  .replace('{{RL_DIFF}}', rlDiffTable())
  .replace('{{RESULTS_DEV}}', resultsTable('dev'))
  .replace('{{COST_TABLE}}', costTable())
  .replace('{{COST_FIGURE}}', costFigure())
  .replace('{{STRATEGY_TABLE}}', strategyTable())
  .replace(/\{\{COST_(\w+)\}\}/g, (_, k) => costFacts()[k])
  .replace('{{BUILT}}', new Date().toISOString().slice(0, 10));
fs.writeFileSync(path.join(__dirname, 'paper.html'), html);
console.log('wrote paper/paper.html');
// the same paper as a web page body (the artifact host adds its own skeleton)
const page = html.replace(/<!doctype html>\s*<html[^>]*>\s*<head>/i, '')
  .replace('<meta charset="utf-8">', '<meta name="claude:viewport-fit-sides" content="cover">')
  .replace(/<\/head>\s*<body>/i, '').replace(/<\/body>\s*<\/html>\s*$/i, '');
fs.writeFileSync(path.join(__dirname, 'paper.page.html'), page);

(async () => {
  let chromium;
  try { ({ chromium } = require(process.env.PLAYWRIGHT || 'playwright')); } catch { console.log('Playwright not found — skipping the PDF'); return; }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + path.join(__dirname, 'paper.html'), { waitUntil: 'networkidle' });
  await page.pdf({ path: path.join(__dirname, 'paper.pdf'), format: 'A4', printBackground: true,
    margin: { top: '18mm', bottom: '18mm', left: '20mm', right: '20mm' },
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#777">Writing the Weights — draft · <span class="pageNumber"></span></div>' });
  await browser.close();
  console.log('wrote paper/paper.pdf');
})();
