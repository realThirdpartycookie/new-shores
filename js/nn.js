'use strict';
/* ============================================================
 * Tiny neural network — a plain multi-layer perceptron.
 * No dependencies; used for inference in the browser and for
 * training in the headless harness (dev/train.js).
 *
 * Layout: input → tanh hidden layer(s) → linear logits.
 * ============================================================ */

const NN = (() => {
  function create(sizes, rng = Math.random) {
    const layers = [];
    for (let l = 0; l < sizes.length - 1; l++) {
      const nin = sizes[l], nout = sizes[l + 1];
      const W = new Float64Array(nin * nout);
      const b = new Float64Array(nout);
      const s = Math.sqrt(2 / nin); // He-ish init
      for (let i = 0; i < W.length; i++) W[i] = (rng() * 2 - 1) * s;
      layers.push({ W, b, nin, nout, vW: new Float64Array(nin * nout), vb: new Float64Array(nout) });
    }
    return { sizes: sizes.slice(), layers };
  }

  /* Forward pass. If `cache` is given, post-activation values are stored
   * (needed for backprop). Returns the output logits. */
  function forward(net, x, cache) {
    let a = x;
    const acts = [x];
    for (let l = 0; l < net.layers.length; l++) {
      const { W, b, nin, nout } = net.layers[l];
      const z = new Float64Array(nout);
      for (let j = 0; j < nout; j++) {
        let s = b[j];
        for (let i = 0; i < nin; i++) s += a[i] * W[i * nout + j];
        z[j] = l < net.layers.length - 1 ? Math.tanh(s) : s;
      }
      acts.push(z);
      a = z;
    }
    if (cache) cache.acts = acts;
    return a;
  }

  function softmax(logits) {
    let max = -Infinity;
    for (const v of logits) max = Math.max(max, v);
    const exp = new Float64Array(logits.length);
    let sum = 0;
    for (let i = 0; i < logits.length; i++) { exp[i] = Math.exp(logits[i] - max); sum += exp[i]; }
    for (let i = 0; i < logits.length; i++) exp[i] /= sum;
    return exp;
  }

  /* One SGD-with-momentum step on a single (x, label) sample using
   * softmax cross-entropy. Returns the sample loss. */
  function trainStep(net, x, label, lr = 0.05, momentum = 0.9) {
    const cache = {};
    const logits = forward(net, x, cache);
    const p = softmax(logits);
    const loss = -Math.log(Math.max(1e-12, p[label]));

    let delta = Float64Array.from(p);
    delta[label] -= 1;

    for (let l = net.layers.length - 1; l >= 0; l--) {
      const { W, b, nin, nout, vW, vb } = net.layers[l];
      const aPrev = cache.acts[l];
      let deltaPrev = null;
      if (l > 0) {
        deltaPrev = new Float64Array(nin);
        for (let i = 0; i < nin; i++) {
          let s = 0;
          for (let j = 0; j < nout; j++) s += W[i * nout + j] * delta[j];
          deltaPrev[i] = s * (1 - aPrev[i] * aPrev[i]); // tanh'
        }
      }
      for (let j = 0; j < nout; j++) {
        vb[j] = momentum * vb[j] - lr * delta[j];
        b[j] += vb[j];
        for (let i = 0; i < nin; i++) {
          const k = i * nout + j;
          vW[k] = momentum * vW[k] - lr * aPrev[i] * delta[j];
          W[k] += vW[k];
        }
      }
      delta = deltaPrev;
    }
    return loss;
  }

  function toJSON(net) {
    return {
      sizes: net.sizes,
      layers: net.layers.map(l => ({ W: Array.from(l.W), b: Array.from(l.b) })),
    };
  }

  function fromJSON(o) {
    const net = create(o.sizes);
    for (let l = 0; l < net.layers.length; l++) {
      net.layers[l].W = Float64Array.from(o.layers[l].W);
      net.layers[l].b = Float64Array.from(o.layers[l].b);
    }
    return net;
  }

  return { create, forward, softmax, trainStep, toJSON, fromJSON };
})();
