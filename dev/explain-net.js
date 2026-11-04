'use strict';
/* Prints the shipped hand-written net neuron by neuron: what each hidden
 * unit reads (its non-zero input weights and bias), and which action logits
 * it moves. Usage: node dev/explain-net.js [--markdown] */

const { FEATURES, AI } = require('./harness.js');
const { build, UNITS } = require('./handwritten-net-v2.js');

const w = build();
const [L1, L2] = w.layers, [nin, nh, nout] = w.sizes;
const names = Object.keys(UNITS);
const md = process.argv.includes('--markdown');
const fmt = v => (v >= 0 ? '+' : '−') + Math.abs(+v.toFixed(2));

if (md) console.log('| # | neuron | pre-activation (non-zero weights) | moves action logits |\n|---|---|---|---|');
names.forEach((name, j) => {
  const ins = [];
  for (let i = 0; i < nin; i++) { const v = L1.W[i * nh + j]; if (v) ins.push(`${fmt(v)}·${FEATURES[i]}`); }
  const outs = [];
  for (let k = 0; k < nout; k++) { const v = L2.W[j * nout + k]; if (v) outs.push(`${AI.ACTIONS[k].replace('build:', '')} ${fmt(2 * v)}`); }
  const pre = `${ins.join(' ')} ${fmt(L1.b[j])}`;
  if (md) console.log(`| h${j} | \`${name}\` | ${pre} | ${outs.join(', ')} |`);
  else console.log(`h${String(j).padStart(2)} ${name.padEnd(18)} tanh(${pre})\n    → ${outs.join(', ')}`);
});
const nz = w.layers.reduce((s, l) => s + [...l.W, ...l.b].filter(v => v !== 0).length, 0);
const tot = w.layers.reduce((s, l) => s + l.W.length + l.b.length, 0);
console.log(`\n${w.sizes.join(' → ')}: ${tot} weights, ${nz} non-zero (${(100 * nz / tot).toFixed(1)} %)`);
