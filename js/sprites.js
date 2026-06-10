'use strict';
/* ============================================================
 * Procedural isometric sprites — all art is drawn in code.
 * Sprites are rendered at 2x and scaled down for crispness.
 *
 * Sprites.get(key) -> {c, w, h, oy, chimney?}
 *   w/h are LOGICAL sizes (pass to drawImage), oy = canvas-y of
 *   the footprint's bottom diamond vertex, chimney = smoke anchor.
 * Sprites.getTile(type, variant) -> textured ground diamond.
 * ============================================================ */

const Sprites = (() => {
  const cache = {};
  const tileCache = {};
  const SS = 2; // supersampling factor

  function mk(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

  // Point in sprite space: (u,v) tile offsets from footprint centre, dz lifts up.
  function pt(cx, cy, u, v, dz = 0) {
    return [cx + (u - v) * TW2, cy + (u + v) * TH2 - dz];
  }

  function poly(ctx, pts, fill, stroke, lw = 1) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  }

  function line(ctx, a, b, col, lw = 1) {
    ctx.strokeStyle = col; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }

  function circle(ctx, x, y, r, fill, stroke, lw = 1) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  }

  const OUT = 'rgba(40,26,12,0.4)'; // soft outline

  /* Box aligned to the iso axes. Returns lifted corners + face quads. */
  function box(ctx, cx, cy, ax, ay, h, top, left, right, du = 0, dv = 0) {
    const A = pt(cx, cy, du - ax / 2, dv - ay / 2);
    const B = pt(cx, cy, du + ax / 2, dv - ay / 2);
    const C = pt(cx, cy, du + ax / 2, dv + ay / 2);
    const D = pt(cx, cy, du - ax / 2, dv + ay / 2);
    const up = p => [p[0], p[1] - h];
    const fr = [B, C, up(C), up(B)]; // SE face
    const fl = [C, D, up(D), up(C)]; // SW face
    poly(ctx, fr, right, OUT);
    poly(ctx, fl, left, OUT);
    poly(ctx, [up(A), up(B), up(C), up(D)], top, OUT);
    return {
      A: up(A), B: up(B), C: up(C), D: up(D),
      gB: B, gC: C, gD: D,
      faceR: fr, faceL: fl,
      cx, cy, ax, ay, du, dv, h,
    };
  }

  /* Horizontal courses on a wall face quad [b0,b1,t1,t0]. */
  function texRows(ctx, quad, n, col, lw = 0.7) {
    const [b0, b1, t1, t0] = quad;
    ctx.strokeStyle = col; ctx.lineWidth = lw;
    ctx.beginPath();
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const p = lerp(b0, t0, t), q = lerp(b1, t1, t);
      ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
    }
    ctx.stroke();
  }

  /* Stone courses: rows + staggered vertical ticks. */
  function texStone(ctx, quad, n, col) {
    texRows(ctx, quad, n, col, 0.7);
    const [b0, b1, t1, t0] = quad;
    ctx.strokeStyle = col; ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const tA = i / n, tB = (i + 1) / n;
      for (let k = 0; k < 3; k++) {
        const f = ((i % 2) * 0.17 + 0.16 + k * 0.33);
        const pA = lerp(lerp(b0, t0, tA), lerp(b1, t1, tA), f);
        const pB = lerp(lerp(b0, t0, tB), lerp(b1, t1, tB), f);
        ctx.moveTo(pA[0], pA[1]); ctx.lineTo(pB[0], pB[1]);
      }
    }
    ctx.stroke();
  }

  /* Timber framing: studs + diagonal brace on a wall face. */
  function texTimber(ctx, quad, col = '#6d5436') {
    const [b0, b1, t1, t0] = quad;
    ctx.strokeStyle = col; ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (const f of [0.05, 0.5, 0.95]) {
      const p = lerp(b0, b1, f), q = lerp(t0, t1, f);
      ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
    }
    // top + bottom rails
    ctx.moveTo(t0[0], t0[1]); ctx.lineTo(t1[0], t1[1]);
    ctx.moveTo(b0[0], b0[1]); ctx.lineTo(b1[0], b1[1]);
    // diagonal brace
    const d0 = lerp(b0, b1, 0.05), d1 = lerp(t0, t1, 0.5);
    ctx.moveTo(d0[0], d0[1]); ctx.lineTo(d1[0], d1[1]);
    ctx.stroke();
  }

  /* Gabled roof with shingle rows (ridge along the u axis). */
  function gable(ctx, b, rh, slope, gableCol, shingleCol) {
    const { cx, cy, ax, ay, du, dv, h } = b;
    const D2 = pt(cx, cy, du - ax / 2, dv + ay / 2, h);
    const C2 = pt(cx, cy, du + ax / 2, dv + ay / 2, h);
    const B2 = pt(cx, cy, du + ax / 2, dv - ay / 2, h);
    const E1 = pt(cx, cy, du - ax / 2, dv, h + rh);
    const E2 = pt(cx, cy, du + ax / 2, dv, h + rh);
    poly(ctx, [B2, C2, E2], gableCol, OUT);          // gable end
    poly(ctx, [D2, C2, E2, E1], slope, OUT);         // front slope
    if (shingleCol) {
      // shingle courses parallel to the eave + ridge cap
      texRows(ctx, [D2, C2, E2, E1], 4, shingleCol, 0.8);
      line(ctx, E1, E2, shingleCol, 1.6);
    }
    // eave highlight
    line(ctx, D2, C2, 'rgba(255,255,235,0.25)', 1);
    return { E1, E2 };
  }

  /* Pyramid roof for square towers. */
  function pyramid(ctx, b, rh, colL, colR) {
    const { cx, cy, ax, ay, du, dv, h } = b;
    const top = pt(cx, cy, du, dv, h + rh);
    const C2 = pt(cx, cy, du + ax / 2, dv + ay / 2, h);
    const D2 = pt(cx, cy, du - ax / 2, dv + ay / 2, h);
    const B2 = pt(cx, cy, du + ax / 2, dv - ay / 2, h);
    poly(ctx, [B2, C2, top], colR, OUT);
    poly(ctx, [C2, D2, top], colL, OUT);
    return top;
  }

  /* Base plot diamond with dirt/cobble speckles. */
  function plot(ctx, cx, cy, s, col = '#b59a6a', edge = '#8f7340', speckle = '#9c8252') {
    const a = pt(cx, cy, -s / 2, -s / 2), b = pt(cx, cy, s / 2, -s / 2);
    const c = pt(cx, cy, s / 2, s / 2), d = pt(cx, cy, -s / 2, s / 2);
    poly(ctx, [a, b, c, d], col, edge);
    const rng = mulberry32(s * 977 + 13);
    ctx.fillStyle = speckle;
    for (let i = 0; i < 10 * s; i++) {
      const u = (rng() - 0.5) * s * 0.85, v = (rng() - 0.5) * s * 0.85;
      const p = pt(cx, cy, u, v);
      ctx.fillRect(p[0], p[1] - 0.6, 1.4, 0.9);
    }
  }

  function shadow(ctx, x, y, rx, ry, a = 0.2) {
    ctx.fillStyle = `rgba(15,25,10,${a})`;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /* Window with frame, glass shine and sill. */
  function windowAt(ctx, p, w = 5, h = 6, lit = false) {
    const [x, y] = [p[0] - w / 2, p[1] - h];
    ctx.fillStyle = '#54422c';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = lit ? '#ffd98a' : '#9cc7da';
    ctx.fillRect(x, y, w, h);
    if (!lit) { // glass shine
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.moveTo(x, y + h * 0.45); ctx.lineTo(x + w * 0.45, y);
      ctx.lineTo(x + w * 0.75, y); ctx.lineTo(x, y + h * 0.8);
      ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = '#54422c'; ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h);
    ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2);
    ctx.stroke();
    ctx.fillStyle = '#6d5436';
    ctx.fillRect(x - 1.4, y + h, w + 2.8, 1.4);
  }

  function doorAt(ctx, p, w = 6, h = 9, col = '#4a3018', arch = false) {
    const [x, y] = [p[0] - w / 2, p[1] - h];
    ctx.fillStyle = '#54422c';
    if (arch) {
      ctx.beginPath();
      ctx.moveTo(x - 1, p[1]); ctx.lineTo(x - 1, y + w / 2);
      ctx.arc(p[0], y + w / 2 + 1, w / 2 + 1, Math.PI, 0);
      ctx.lineTo(x + w + 1, p[1]);
      ctx.closePath(); ctx.fill();
    } else {
      ctx.fillRect(x - 1, y - 1, w + 2, h + 1);
    }
    ctx.fillStyle = col;
    if (arch) {
      ctx.beginPath();
      ctx.moveTo(x, p[1]); ctx.lineTo(x, y + w / 2 + 1);
      ctx.arc(p[0], y + w / 2 + 1, w / 2, Math.PI, 0);
      ctx.lineTo(x + w, p[1]);
      ctx.closePath(); ctx.fill();
    } else {
      ctx.fillRect(x, y, w, h);
    }
    // planks + handle
    ctx.strokeStyle = 'rgba(20,12,4,0.4)'; ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(p[0], y + 1); ctx.lineTo(p[0], p[1] - 1);
    ctx.stroke();
    ctx.fillStyle = '#c8a84a';
    ctx.fillRect(x + w - 2, y + h * 0.55, 1.4, 1.4);
  }

  function chimneyAt(s, u, v, dz) {
    const p = pt(s.cx, s.cy, u, v, dz);
    s.ctx.fillStyle = '#9a6a4a';
    s.ctx.fillRect(p[0] - 2.6, p[1] - 9, 5.2, 9.5);
    s.ctx.fillStyle = '#7c5239';
    s.ctx.fillRect(p[0] - 2.6, p[1] - 9, 2.1, 9.5);
    s.ctx.strokeStyle = 'rgba(40,26,12,0.45)'; s.ctx.lineWidth = 0.8;
    s.ctx.strokeRect(p[0] - 2.6, p[1] - 9, 5.2, 9.5);
    s.ctx.fillStyle = '#4c4c4c';
    s.ctx.fillRect(p[0] - 3.4, p[1] - 11, 6.8, 2.4);
    s.chimney = [p[0], p[1] - 12];
  }

  function barrel(ctx, x, y, r = 4) {
    ctx.fillStyle = '#8d6a3a';
    ctx.beginPath(); ctx.ellipse(x, y - r, r * 0.78, r, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#5c452c'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.strokeStyle = '#c8b070';
    ctx.beginPath(); ctx.moveTo(x - r * 0.75, y - r * 1.3); ctx.lineTo(x + r * 0.75, y - r * 1.3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - r * 0.75, y - r * 0.7); ctx.lineTo(x + r * 0.75, y - r * 0.7); ctx.stroke();
    ctx.fillStyle = '#a8854c';
    ctx.beginPath(); ctx.ellipse(x, y - r * 1.9, r * 0.7, r * 0.3, 0, 0, Math.PI * 2); ctx.fill();
  }

  function crate(ctx, cx, cy, du, dv, size = 0.24, h = 7) {
    const b = box(ctx, cx, cy, size, size, h, '#c8a86c', '#9a7c42', '#b08d52', du, dv);
    line(ctx, b.faceR[0], b.faceR[2], 'rgba(70,50,20,0.5)', 0.8);
    line(ctx, b.faceL[0], b.faceL[2], 'rgba(70,50,20,0.5)', 0.8);
    return b;
  }

  /* Standard sprite canvas. */
  function base(s, hh = 64, pad = 8) {
    const w = s * TW + pad * 2, h = s * TH + hh + pad * 2;
    const c = mk(w * SS, h * SS);
    const ctx = c.getContext('2d');
    ctx.scale(SS, SS);
    ctx.lineJoin = 'round';
    const cx = w / 2;
    const cy = h - pad - s * TH2; // centre of footprint diamond
    return { c, ctx, cx, cy, w, h, oy: h - pad, chimney: null };
  }

  /* ---------------- houses (3 tiers x 3 variants) ---------------- */

  const D = {};

  D.house0 = (v) => { // pioneer log cabin with thatched roof
    const s = base(1, 56);
    const roof = [['#b89a52', '#8f7434'], ['#a8954e', '#7f6e30'], ['#bda35c', '#94793a']][v];
    plot(s.ctx, s.cx, s.cy, 1, '#a8c06a', '#7e9a47', '#8fa854');
    const b = box(s.ctx, s.cx, s.cy, 0.66, 0.66, 14, '#9a7344', '#7a5832', '#8c683c');
    texRows(s.ctx, b.faceL, 4, 'rgba(60,40,20,0.45)');  // log courses
    texRows(s.ctx, b.faceR, 4, 'rgba(60,40,20,0.45)');
    gable(s.ctx, b, 10, roof[0], roof[1], 'rgba(90,70,30,0.5)');
    doorAt(s.ctx, pt(s.cx, s.cy, v === 1 ? -0.12 : 0.1, 0.33), 5.5, 8);
    windowAt(s.ctx, pt(s.cx, s.cy, v === 1 ? 0.18 : -0.18, 0.33, 1), 4.5, 5);
    // wood pile beside the hut
    const wp = pt(s.cx, s.cy, 0.36, -0.18);
    s.ctx.strokeStyle = '#7d5a33'; s.ctx.lineWidth = 3;
    s.ctx.beginPath(); s.ctx.moveTo(wp[0] - 5, wp[1] - 2); s.ctx.lineTo(wp[0] + 5, wp[1] - 5); s.ctx.stroke();
    circle(s.ctx, wp[0] + 5, wp[1] - 5, 1.6, '#d8c9a3', '#7d5a33', 0.7);
    return s;
  };

  D.house1 = (v) => { // settler timber-frame house
    const s = base(1, 72);
    const roofs = [['#a8492e', '#8c3a24'], ['#b85c30', '#97481f'], ['#94432c', '#7a3520']][v];
    plot(s.ctx, s.cx, s.cy, 1, '#b6b09a', '#8f8a76', '#a39d87');
    const b = box(s.ctx, s.cx, s.cy, 0.74, 0.74, 22, '#ecdfc4', '#cdbd9c', '#ddcdaa');
    texTimber(s.ctx, b.faceL);
    texTimber(s.ctx, b.faceR);
    gable(s.ctx, b, 12, roofs[0], roofs[1], 'rgba(90,30,15,0.45)');
    chimneyAt(s, 0.2, -0.05, 30);
    doorAt(s.ctx, pt(s.cx, s.cy, v === 2 ? -0.1 : 0.12, 0.37), 6, 9.5);
    windowAt(s.ctx, pt(s.cx, s.cy, v === 2 ? 0.18 : -0.18, 0.37, 4), 5, 6);
    windowAt(s.ctx, pt(s.cx, s.cy, 0.37, v === 1 ? -0.12 : 0.12, 4), 5, 6);
    // flower box
    const fp = pt(s.cx, s.cy, v === 2 ? 0.18 : -0.18, 0.37, 3);
    s.ctx.fillStyle = '#6d5436'; s.ctx.fillRect(fp[0] - 3.4, fp[1], 6.8, 1.8);
    s.ctx.fillStyle = '#c84a5c'; s.ctx.fillRect(fp[0] - 2.8, fp[1] - 1, 1.6, 1.4);
    s.ctx.fillStyle = '#e8c94a'; s.ctx.fillRect(fp[0] + 0.4, fp[1] - 1, 1.6, 1.4);
    return s;
  };

  D.house2 = (v) => { // citizen stone townhouse, two storeys
    const s = base(1, 88);
    const roofs = [['#41608c', '#324d73'], ['#3a5577', '#2d4260'], ['#4a6a99', '#3a547d']][v];
    plot(s.ctx, s.cx, s.cy, 1, '#b9b9b9', '#909090', '#a6a6a6');
    const b = box(s.ctx, s.cx, s.cy, 0.8, 0.8, 36, '#e2dbcd', '#bfb6a4', '#d1c8b5');
    texStone(s.ctx, b.faceL, 6, 'rgba(95,88,72,0.35)');
    texStone(s.ctx, b.faceR, 6, 'rgba(95,88,72,0.3)');
    // storey divider
    line(s.ctx, lerp(b.gC, b.C, 0.5), lerp(b.gD, b.D, 0.5), '#a89e8a', 1.4);
    line(s.ctx, lerp(b.gB, b.B, 0.5), lerp(b.gC, b.C, 0.5), '#a89e8a', 1.4);
    gable(s.ctx, b, 13, roofs[0], roofs[1], 'rgba(20,35,60,0.45)');
    chimneyAt(s, -0.2, 0.05, 45);
    for (const [u, z] of [[-0.2, 7], [0.16, 7], [-0.2, 23], [0.16, 23]]) {
      windowAt(s.ctx, pt(s.cx, s.cy, u, 0.4, z), 5, 6.5);
    }
    windowAt(s.ctx, pt(s.cx, s.cy, 0.4, -0.12, 23), 5, 6.5);
    doorAt(s.ctx, pt(s.cx, s.cy, 0.4, 0.14), 6, 10, '#3a2c16', true);
    // step
    const st = pt(s.cx, s.cy, 0.46, 0.14);
    s.ctx.fillStyle = '#9a9488'; s.ctx.fillRect(st[0] - 3.5, st[1] - 1, 7, 2);
    return s;
  };

  /* ---------------- civic & storage ---------------- */

  D.warehouse = () => {
    const s = base(2, 84);
    plot(s.ctx, s.cx, s.cy, 2, '#c2a878', '#9a8050', '#ab9162');
    // stone ground floor + timber upper
    const b = box(s.ctx, s.cx, s.cy, 1.35, 1.35, 30, '#d8c9a3', '#ae9468', '#c2a87a');
    texStone(s.ctx, [b.faceL[0], b.faceL[1], lerp(b.faceL[1], b.faceL[2], 0.45), lerp(b.faceL[0], b.faceL[3], 0.45)], 3, 'rgba(95,75,45,0.4)');
    texStone(s.ctx, [b.faceR[0], b.faceR[1], lerp(b.faceR[1], b.faceR[2], 0.45), lerp(b.faceR[0], b.faceR[3], 0.45)], 3, 'rgba(95,75,45,0.35)');
    texTimber(s.ctx, [lerp(b.faceL[0], b.faceL[3], 0.5), lerp(b.faceL[1], b.faceL[2], 0.5), b.faceL[2], b.faceL[3]]);
    texTimber(s.ctx, [lerp(b.faceR[0], b.faceR[3], 0.5), lerp(b.faceR[1], b.faceR[2], 0.5), b.faceR[2], b.faceR[3]]);
    const r = gable(s.ctx, b, 18, '#c46a2a', '#a85822', 'rgba(120,55,15,0.5)');
    // big loading door + hoist beam
    doorAt(s.ctx, pt(s.cx, s.cy, 0.1, 0.68), 9, 13, '#4a3018', true);
    const hb = pt(s.cx, s.cy, 0.1, 0.68, 24);
    line(s.ctx, hb, [hb[0], hb[1] - 6], '#4a3322', 2);
    // flag on the ridge
    const f = [r.E1[0] * 0.5 + r.E2[0] * 0.5, r.E1[1] * 0.5 + r.E2[1] * 0.5];
    line(s.ctx, f, [f[0], f[1] - 16], '#4a3322', 1.5);
    poly(s.ctx, [[f[0], f[1] - 16], [f[0] + 11, f[1] - 13], [f[0], f[1] - 10]], '#d8b13c', OUT);
    // goods in the yard
    crate(s.ctx, s.cx, s.cy, 0.55, 0.75);
    crate(s.ctx, s.cx, s.cy, 0.82, 0.5, 0.2, 5.5);
    barrel(s.ctx, ...pt(s.cx, s.cy, -0.75, 0.62), 4);
    barrel(s.ctx, ...pt(s.cx, s.cy, -0.55, 0.78), 3.6);
    return s;
  };

  D.depot = () => {
    const s = base(2, 66);
    plot(s.ctx, s.cx, s.cy, 2, '#c2a878', '#9a8050', '#ab9162');
    const b = box(s.ctx, s.cx, s.cy, 1.25, 1.25, 20, '#cdbd96', '#a08a58', '#b89f6c');
    texRows(s.ctx, b.faceL, 5, 'rgba(95,75,45,0.4)');
    texRows(s.ctx, b.faceR, 5, 'rgba(95,75,45,0.35)');
    gable(s.ctx, b, 13, '#8c6a3a', '#75582f', 'rgba(60,45,20,0.5)');
    doorAt(s.ctx, pt(s.cx, s.cy, 0.05, 0.62), 8, 11, '#4a3018');
    crate(s.ctx, s.cx, s.cy, 0.6, 0.55);
    barrel(s.ctx, ...pt(s.cx, s.cy, -0.6, 0.65), 3.8);
    return s;
  };

  D.market = () => {
    const s = base(2, 54);
    // cobbled square
    plot(s.ctx, s.cx, s.cy, 2, '#cdb791', '#a08a5a', '#b6a075');
    const rng = mulberry32(42);
    s.ctx.strokeStyle = 'rgba(120,100,60,0.4)'; s.ctx.lineWidth = 0.7;
    for (let i = 0; i < 26; i++) {
      const u = (rng() - 0.5) * 1.7, v = (rng() - 0.5) * 1.7;
      const p = pt(s.cx, s.cy, u, v);
      s.ctx.beginPath(); s.ctx.ellipse(p[0], p[1], 2, 1, 0, 0, Math.PI * 2); s.ctx.stroke();
    }
    // stalls with scalloped awnings
    const stall = (du, dv, c1, c2) => {
      const b = box(s.ctx, s.cx, s.cy, 0.6, 0.45, 9, '#b09a6e', '#8d7a50', '#9d8a5c', du, dv);
      const g = gable(s.ctx, b, 7, c1, '#e7e0cd');
      // scallops along the eave
      const e0 = pt(s.cx, s.cy, du - 0.3, dv + 0.225, 9), e1 = pt(s.cx, s.cy, du + 0.3, dv + 0.225, 9);
      s.ctx.fillStyle = c2;
      for (let i = 0; i < 4; i++) {
        const p = lerp(e0, e1, i / 4 + 0.125);
        s.ctx.beginPath(); s.ctx.arc(p[0], p[1], 2.4, 0, Math.PI); s.ctx.fill();
      }
      return g;
    };
    stall(-0.45, -0.4, '#b8463a', '#d8d0bc');
    stall(0.5, 0.05, '#3a6ea8', '#d8d0bc');
    // produce table
    const tb = box(s.ctx, s.cx, s.cy, 0.4, 0.22, 5, '#a8854c', '#82663a', '#947543', -0.35, 0.55);
    for (let i = 0; i < 5; i++) {
      const p = lerp(tb.A, tb.C, 0.18 + i * 0.16);
      circle(s.ctx, p[0], p[1], 1.5, ['#c84a3a', '#e8c94a', '#7ea84a', '#c84a3a', '#d88a3a'][i], null);
    }
    // well
    const w = box(s.ctx, s.cx, s.cy, 0.24, 0.24, 7, '#9a9a9a', '#737373', '#858585', 0.05, 0.55);
    texStone(s.ctx, w.faceL, 2, 'rgba(60,60,60,0.5)');
    pyramid(s.ctx, { ...w, h: 14 }, 6, '#6d5436', '#5c452c');
    line(s.ctx, [w.A[0], w.A[1]], [w.A[0], w.A[1] - 7], '#5c452c', 1.2);
    return s;
  };

  D.chapel = () => {
    const s = base(2, 92);
    plot(s.ctx, s.cx, s.cy, 2, '#b6b09a', '#8f8a76', '#a39d87');
    // nave
    const nave = box(s.ctx, s.cx, s.cy, 1.15, 0.72, 22, '#e6dfce', '#c0b7a1', '#d2c8b0', 0.12, 0.18);
    texStone(s.ctx, nave.faceL, 4, 'rgba(110,100,80,0.35)');
    texStone(s.ctx, nave.faceR, 4, 'rgba(110,100,80,0.3)');
    gable(s.ctx, nave, 15, '#7a5638', '#66472e', 'rgba(70,45,25,0.5)');
    // pointed window on the nave
    const wp = pt(s.cx, s.cy, 0.12, 0.54, 8);
    s.ctx.fillStyle = '#54422c';
    s.ctx.beginPath();
    s.ctx.moveTo(wp[0] - 3.4, wp[1]); s.ctx.lineTo(wp[0] - 3.4, wp[1] - 6);
    s.ctx.quadraticCurveTo(wp[0], wp[1] - 11, wp[0] + 3.4, wp[1] - 6);
    s.ctx.lineTo(wp[0] + 3.4, wp[1]); s.ctx.closePath(); s.ctx.fill();
    s.ctx.fillStyle = '#7fa8d8';
    s.ctx.beginPath();
    s.ctx.moveTo(wp[0] - 2.2, wp[1]); s.ctx.lineTo(wp[0] - 2.2, wp[1] - 5.4);
    s.ctx.quadraticCurveTo(wp[0], wp[1] - 9, wp[0] + 2.2, wp[1] - 5.4);
    s.ctx.lineTo(wp[0] + 2.2, wp[1]); s.ctx.closePath(); s.ctx.fill();
    doorAt(s.ctx, pt(s.cx, s.cy, 0.62, 0.3), 6, 9, '#4a3018', true);
    // bell tower
    const tw = box(s.ctx, s.cx, s.cy, 0.45, 0.45, 44, '#e6dfce', '#c0b7a1', '#d2c8b0', -0.55, -0.38);
    texStone(s.ctx, tw.faceL, 7, 'rgba(110,100,80,0.35)');
    texStone(s.ctx, tw.faceR, 7, 'rgba(110,100,80,0.3)');
    // belfry openings
    const bf = pt(s.cx, s.cy, -0.55, -0.16, 36);
    s.ctx.fillStyle = '#3a3026';
    s.ctx.fillRect(bf[0] - 2, bf[1] - 5, 4, 6);
    const bf2 = pt(s.cx, s.cy, -0.33, -0.38, 36);
    s.ctx.fillRect(bf2[0] - 2, bf2[1] - 5, 4, 6);
    const top = pyramid(s.ctx, tw, 16, '#5c452c', '#6d5436');
    // cross
    s.ctx.strokeStyle = '#e8d9a0'; s.ctx.lineWidth = 1.6;
    s.ctx.beginPath();
    s.ctx.moveTo(top[0], top[1]); s.ctx.lineTo(top[0], top[1] - 10);
    s.ctx.moveTo(top[0] - 3.5, top[1] - 7); s.ctx.lineTo(top[0] + 3.5, top[1] - 7);
    s.ctx.stroke();
    return s;
  };

  D.tavern = () => {
    const s = base(2, 76);
    plot(s.ctx, s.cx, s.cy, 2, '#b59a6a', '#8f7340', '#a08454');
    const b = box(s.ctx, s.cx, s.cy, 1.3, 0.95, 24, '#ecdfc4', '#cdbd9c', '#ddcdaa', 0, 0.05);
    texTimber(s.ctx, b.faceL);
    texTimber(s.ctx, b.faceR);
    gable(s.ctx, b, 15, '#5d7a36', '#4d662c', 'rgba(45,60,25,0.5)');
    chimneyAt(s, 0.45, -0.1, 35);
    doorAt(s.ctx, pt(s.cx, s.cy, -0.15, 0.53), 7, 10, '#4a3018', true);
    windowAt(s.ctx, pt(s.cx, s.cy, 0.25, 0.53, 5), 5.5, 6, true); // warm light
    windowAt(s.ctx, pt(s.cx, s.cy, -0.5, 0.53, 5), 5.5, 6, true);
    windowAt(s.ctx, pt(s.cx, s.cy, 0.66, 0.2, 5), 5, 6, true);
    // hanging sign: tankard
    const sp2 = pt(s.cx, s.cy, 0.68, 0.42, 18);
    line(s.ctx, sp2, [sp2[0] + 7, sp2[1]], '#4a3322', 1.4);
    s.ctx.fillStyle = '#e8ddc0';
    s.ctx.fillRect(sp2[0] + 3, sp2[1] + 1, 7, 8);
    s.ctx.strokeStyle = '#5c452c'; s.ctx.lineWidth = 0.9;
    s.ctx.strokeRect(sp2[0] + 3, sp2[1] + 1, 7, 8);
    s.ctx.fillStyle = '#c8902a';
    s.ctx.fillRect(sp2[0] + 4.4, sp2[1] + 3, 3.4, 4.6);
    // barrels by the door
    barrel(s.ctx, ...pt(s.cx, s.cy, -0.55, 0.8), 4.2);
    barrel(s.ctx, ...pt(s.cx, s.cy, -0.78, 0.6), 3.6);
    return s;
  };

  /* ---------------- production ---------------- */

  D.woodcutter = () => {
    const s = base(1, 54);
    plot(s.ctx, s.cx, s.cy, 1, '#9aa86a', '#788448', '#87935a');
    const b = box(s.ctx, s.cx, s.cy, 0.58, 0.58, 13, '#9a7344', '#7a5832', '#8c683c', -0.14, -0.14);
    texRows(s.ctx, b.faceL, 4, 'rgba(60,40,20,0.45)');
    texRows(s.ctx, b.faceR, 4, 'rgba(60,40,20,0.45)');
    gable(s.ctx, b, 9, '#556b2f', '#46582a', 'rgba(40,55,20,0.5)');
    doorAt(s.ctx, pt(s.cx, s.cy, -0.14, 0.15), 5, 7.5);
    // log pile with ring ends
    for (let i = 0; i < 3; i++) {
      const lp = pt(s.cx, s.cy, 0.3, 0.3, i * 3.6);
      s.ctx.strokeStyle = i % 2 ? '#7d5a33' : '#8d6a40'; s.ctx.lineWidth = 3.6;
      s.ctx.beginPath(); s.ctx.moveTo(lp[0] - 8, lp[1] - 2); s.ctx.lineTo(lp[0] + 8, lp[1] - 6); s.ctx.stroke();
      circle(s.ctx, lp[0] + 8, lp[1] - 6, 1.9, '#d8c9a3', '#7d5a33', 0.7);
      circle(s.ctx, lp[0] + 8, lp[1] - 6, 0.8, null, '#a8895a', 0.6);
    }
    // stump with axe
    const st = pt(s.cx, s.cy, -0.05, 0.4);
    circle(s.ctx, st[0], st[1] - 2, 2.6, '#a8854c', '#6e4f2e', 0.9);
    line(s.ctx, [st[0] + 1, st[1] - 4], [st[0] + 4, st[1] - 9], '#6e4f2e', 1.4);
    poly(s.ctx, [[st[0] + 3, st[1] - 10], [st[0] + 7, st[1] - 9], [st[0] + 4.5, st[1] - 7]], '#b8bcc0', '#6a6e72');
    return s;
  };

  D.fisher = () => {
    const s = base(1, 54);
    plot(s.ctx, s.cx, s.cy, 1, '#d9c27e', '#b39e5e', '#c4ad6c');
    const b = box(s.ctx, s.cx, s.cy, 0.58, 0.58, 13, '#c2b090', '#9c8a68', '#af9c78', -0.12, -0.12);
    texRows(s.ctx, b.faceL, 4, 'rgba(90,75,50,0.45)');
    texRows(s.ctx, b.faceR, 4, 'rgba(90,75,50,0.45)');
    gable(s.ctx, b, 9, '#3a6ea8', '#30598a', 'rgba(25,50,85,0.5)');
    doorAt(s.ctx, pt(s.cx, s.cy, -0.12, 0.17), 5, 7.5);
    // drying nets between poles
    const np = pt(s.cx, s.cy, 0.32, 0.26);
    line(s.ctx, [np[0] - 8, np[1]], [np[0] - 8, np[1] - 14], '#5c452c', 1.4);
    line(s.ctx, [np[0] + 8, np[1] - 4], [np[0] + 8, np[1] - 18], '#5c452c', 1.4);
    s.ctx.strokeStyle = 'rgba(80,65,40,0.8)'; s.ctx.lineWidth = 0.7;
    for (let i = 0; i < 4; i++) {
      s.ctx.beginPath();
      s.ctx.moveTo(np[0] - 8, np[1] - 3 - i * 3.4);
      s.ctx.quadraticCurveTo(np[0], np[1] + 1 - i * 3.4, np[0] + 8, np[1] - 7 - i * 3.4);
      s.ctx.stroke();
    }
    for (let i = 0; i < 3; i++) {
      s.ctx.beginPath();
      s.ctx.moveTo(np[0] - 7 + i * 5, np[1] - 2 - i * 1.2);
      s.ctx.lineTo(np[0] - 5 + i * 5, np[1] - 15 - i * 1.2);
      s.ctx.stroke();
    }
    // rowing boat pulled ashore
    const bp = pt(s.cx, s.cy, -0.28, 0.42);
    s.ctx.fillStyle = '#7a5a36';
    s.ctx.beginPath();
    s.ctx.moveTo(bp[0] - 8, bp[1] - 3);
    s.ctx.quadraticCurveTo(bp[0], bp[1] + 2, bp[0] + 8, bp[1] - 4);
    s.ctx.lineTo(bp[0] + 6, bp[1] - 5.5);
    s.ctx.quadraticCurveTo(bp[0], bp[1] - 1.5, bp[0] - 6, bp[1] - 4.5);
    s.ctx.closePath(); s.ctx.fill();
    s.ctx.strokeStyle = '#4a3322'; s.ctx.lineWidth = 0.8; s.ctx.stroke();
    barrel(s.ctx, ...pt(s.cx, s.cy, 0.38, -0.3), 3.2);
    return s;
  };

  D.hunter = () => {
    const s = base(1, 54);
    plot(s.ctx, s.cx, s.cy, 1, '#8fa45e', '#6f8344', '#7e9350');
    const b = box(s.ctx, s.cx, s.cy, 0.58, 0.58, 12, '#7d6a4a', '#615239', '#6f5e42');
    texRows(s.ctx, b.faceL, 4, 'rgba(40,32,18,0.5)');
    texRows(s.ctx, b.faceR, 4, 'rgba(40,32,18,0.5)');
    gable(s.ctx, b, 10, '#46582a', '#3a4a23', 'rgba(30,42,18,0.55)');
    doorAt(s.ctx, pt(s.cx, s.cy, 0.05, 0.29), 5, 7.5);
    // antlers over the door
    const ap = pt(s.cx, s.cy, 0.05, 0.29, 10);
    s.ctx.strokeStyle = '#e8d9b0'; s.ctx.lineWidth = 1.2;
    s.ctx.beginPath();
    s.ctx.moveTo(ap[0] - 4, ap[1] - 1); s.ctx.lineTo(ap[0] - 1.5, ap[1] - 5);
    s.ctx.moveTo(ap[0] - 3.5, ap[1] - 3.5); s.ctx.lineTo(ap[0] - 4.5, ap[1] - 5.5);
    s.ctx.moveTo(ap[0] + 4, ap[1] - 1); s.ctx.lineTo(ap[0] + 1.5, ap[1] - 5);
    s.ctx.moveTo(ap[0] + 3.5, ap[1] - 3.5); s.ctx.lineTo(ap[0] + 4.5, ap[1] - 5.5);
    s.ctx.stroke();
    // hide drying on a frame
    const hp = pt(s.cx, s.cy, 0.36, -0.05);
    line(s.ctx, [hp[0] - 6, hp[1]], [hp[0] - 6, hp[1] - 12], '#5c452c', 1.2);
    line(s.ctx, [hp[0] + 6, hp[1] - 3], [hp[0] + 6, hp[1] - 15], '#5c452c', 1.2);
    line(s.ctx, [hp[0] - 6, hp[1] - 12], [hp[0] + 6, hp[1] - 15], '#5c452c', 1.2);
    poly(s.ctx, [
      [hp[0] - 4.5, hp[1] - 11], [hp[0] + 4.5, hp[1] - 13.5],
      [hp[0] + 3.5, hp[1] - 6], [hp[0], hp[1] - 4], [hp[0] - 3.5, hp[1] - 5.5],
    ], '#c8a878', '#8f7340');
    // target
    const tp = pt(s.cx, s.cy, -0.35, 0.3);
    circle(s.ctx, tp[0], tp[1] - 6, 4, '#e8ddc0', '#5c452c', 0.9);
    circle(s.ctx, tp[0], tp[1] - 6, 2.2, '#c84a3a', null);
    line(s.ctx, [tp[0] - 2, tp[1]], [tp[0], tp[1] - 3], '#5c452c', 1);
    line(s.ctx, [tp[0] + 2, tp[1]], [tp[0], tp[1] - 3], '#5c452c', 1);
    return s;
  };

  D.sheep = () => {
    const s = base(2, 60);
    plot(s.ctx, s.cx, s.cy, 2, '#9ec46a', '#7e9a47', '#8cb055');
    // red barn with white trim
    const b = box(s.ctx, s.cx, s.cy, 0.85, 0.62, 16, '#b8463a', '#8f3329', '#a53e33', -0.32, -0.32);
    texRows(s.ctx, b.faceL, 4, 'rgba(90,25,15,0.45)');
    texRows(s.ctx, b.faceR, 4, 'rgba(90,25,15,0.45)');
    gable(s.ctx, b, 11, '#6d5436', '#5c452c', 'rgba(60,45,25,0.5)');
    // white X-door
    const dp = pt(s.cx, s.cy, -0.32, -0.01);
    s.ctx.fillStyle = '#9a3a30'; s.ctx.fillRect(dp[0] - 4, dp[1] - 9, 8, 9);
    s.ctx.strokeStyle = '#e8ddc8'; s.ctx.lineWidth = 1.2;
    s.ctx.strokeRect(dp[0] - 4, dp[1] - 9, 8, 9);
    s.ctx.beginPath();
    s.ctx.moveTo(dp[0] - 4, dp[1] - 9); s.ctx.lineTo(dp[0] + 4, dp[1]);
    s.ctx.moveTo(dp[0] + 4, dp[1] - 9); s.ctx.lineTo(dp[0] - 4, dp[1]);
    s.ctx.stroke();
    // fence around the paddock
    s.ctx.strokeStyle = '#8a6a40'; s.ctx.lineWidth = 1.3;
    const fpts = [pt(s.cx, s.cy, 0.85, -0.6), pt(s.cx, s.cy, 0.85, 0.85), pt(s.cx, s.cy, -0.6, 0.85)];
    s.ctx.beginPath();
    s.ctx.moveTo(fpts[0][0], fpts[0][1] - 4); s.ctx.lineTo(fpts[1][0], fpts[1][1] - 4); s.ctx.lineTo(fpts[2][0], fpts[2][1] - 4);
    s.ctx.moveTo(fpts[0][0], fpts[0][1] - 2); s.ctx.lineTo(fpts[1][0], fpts[1][1] - 2); s.ctx.lineTo(fpts[2][0], fpts[2][1] - 2);
    s.ctx.stroke();
    for (let i = 0; i <= 6; i++) {
      const p = lerp(fpts[0], fpts[1], i / 6);
      line(s.ctx, [p[0], p[1]], [p[0], p[1] - 5], '#7a5c36', 1.3);
    }
    for (let i = 1; i <= 6; i++) {
      const p = lerp(fpts[1], fpts[2], i / 6);
      line(s.ctx, [p[0], p[1]], [p[0], p[1] - 5], '#7a5c36', 1.3);
    }
    // sheep with heads & legs
    for (const [u, v, flip] of [[0.3, 0.18, 1], [-0.02, 0.48, -1], [0.5, 0.52, 1]]) {
      const sp2 = pt(s.cx, s.cy, u, v);
      s.ctx.fillStyle = '#3a342c';
      s.ctx.fillRect(sp2[0] - 2.5, sp2[1] - 2.5, 1.2, 2.5);
      s.ctx.fillRect(sp2[0] + 1.5, sp2[1] - 2.5, 1.2, 2.5);
      circle(s.ctx, sp2[0], sp2[1] - 4.5, 4, '#f2efe6', '#b9b4a4', 0.8);
      circle(s.ctx, sp2[0] - 1.5, sp2[1] - 6, 1.6, 'rgba(255,255,255,0.8)', null);
      circle(s.ctx, sp2[0] + 3.8 * flip, sp2[1] - 5.5, 2, '#4a4038', null);
      circle(s.ctx, sp2[0] + 4.6 * flip, sp2[1] - 6.3, 0.5, '#fff', null);
    }
    // grass tufts
    s.ctx.strokeStyle = '#6f9340'; s.ctx.lineWidth = 1;
    for (const [u, v] of [[0.1, 0.7], [0.65, 0.25], [-0.25, 0.6]]) {
      const p = pt(s.cx, s.cy, u, v);
      s.ctx.beginPath();
      s.ctx.moveTo(p[0] - 2, p[1]); s.ctx.lineTo(p[0] - 1, p[1] - 3);
      s.ctx.moveTo(p[0], p[1]); s.ctx.lineTo(p[0], p[1] - 4);
      s.ctx.moveTo(p[0] + 2, p[1]); s.ctx.lineTo(p[0] + 1, p[1] - 3);
      s.ctx.stroke();
    }
    return s;
  };

  D.weaver = () => {
    const s = base(1, 58);
    plot(s.ctx, s.cx, s.cy, 1, '#b6b09a', '#8f8a76', '#a39d87');
    const b = box(s.ctx, s.cx, s.cy, 0.62, 0.62, 15, '#ecdfc4', '#cdbd9c', '#ddcdaa');
    texTimber(s.ctx, b.faceL);
    texTimber(s.ctx, b.faceR);
    gable(s.ctx, b, 10, '#8a4a78', '#733e64', 'rgba(80,30,65,0.45)');
    doorAt(s.ctx, pt(s.cx, s.cy, 0.08, 0.31), 5.5, 8);
    windowAt(s.ctx, pt(s.cx, s.cy, -0.18, 0.31, 2), 4.5, 5.5);
    // cloth bolts leaning at the wall
    const cp = pt(s.cx, s.cy, 0.34, 0.16);
    line(s.ctx, [cp[0], cp[1]], [cp[0] + 3, cp[1] - 13], '#b8463a', 3);
    line(s.ctx, [cp[0] + 4.5, cp[1]], [cp[0] + 7.5, cp[1] - 12], '#3a6ea8', 3);
    line(s.ctx, [cp[0] - 4, cp[1] + 1], [cp[0] - 1.5, cp[1] - 11], '#d8b13c', 3);
    // spinning wheel
    const wp = pt(s.cx, s.cy, -0.35, 0.32);
    circle(s.ctx, wp[0], wp[1] - 5, 4, null, '#6d5436', 1.4);
    circle(s.ctx, wp[0], wp[1] - 5, 1, '#6d5436', null);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 4;
      line(s.ctx, [wp[0] - Math.cos(a) * 3.4, wp[1] - 5 - Math.sin(a) * 3.4],
        [wp[0] + Math.cos(a) * 3.4, wp[1] - 5 + Math.sin(a) * 3.4], '#6d5436', 0.8);
    }
    line(s.ctx, [wp[0] - 3, wp[1]], [wp[0] + 3, wp[1]], '#6d5436', 1.2);
    return s;
  };

  D.mine = () => {
    const s = base(1, 60);
    plot(s.ctx, s.cx, s.cy, 1, '#8a8a85', '#6e6e69', '#7c7c77');
    // gray mound
    const mp = pt(s.cx, s.cy, 0, -0.1);
    poly(s.ctx, [
      [mp[0] - 22, mp[1] + 8], [mp[0] - 14, mp[1] - 14], [mp[0] - 2, mp[1] - 20],
      [mp[0] + 10, mp[1] - 15], [mp[0] + 20, mp[1] + 8],
    ], '#7e7e7a', '#5a5a56');
    poly(s.ctx, [
      [mp[0] - 14, mp[1] - 14], [mp[0] - 2, mp[1] - 20], [mp[0] + 2, mp[1] - 8], [mp[0] - 8, mp[1] - 4],
    ], '#94948e', '#5a5a56');
    // timber portal with dark entrance
    const dpt = pt(s.cx, s.cy, 0.05, 0.32);
    s.ctx.fillStyle = '#1c1c1c';
    s.ctx.beginPath();
    s.ctx.moveTo(dpt[0] - 5, dpt[1] - 1);
    s.ctx.lineTo(dpt[0] - 5, dpt[1] - 9); s.ctx.lineTo(dpt[0], dpt[1] - 12);
    s.ctx.lineTo(dpt[0] + 5, dpt[1] - 9); s.ctx.lineTo(dpt[0] + 5, dpt[1] - 1);
    s.ctx.closePath(); s.ctx.fill();
    s.ctx.strokeStyle = '#8a6a40'; s.ctx.lineWidth = 2.2;
    s.ctx.beginPath();
    s.ctx.moveTo(dpt[0] - 6, dpt[1]); s.ctx.lineTo(dpt[0] - 6, dpt[1] - 10);
    s.ctx.lineTo(dpt[0], dpt[1] - 13.5); s.ctx.lineTo(dpt[0] + 6, dpt[1] - 10);
    s.ctx.lineTo(dpt[0] + 6, dpt[1]);
    s.ctx.stroke();
    // rails + ore cart
    line(s.ctx, [dpt[0] - 1.5, dpt[1]], [dpt[0] - 6, dpt[1] + 7], '#5a5a56', 1);
    line(s.ctx, [dpt[0] + 1.5, dpt[1]], [dpt[0] - 2, dpt[1] + 8], '#5a5a56', 1);
    const op = [dpt[0] - 5, dpt[1] + 5];
    s.ctx.fillStyle = '#6a5440';
    s.ctx.fillRect(op[0] - 4, op[1] - 6, 8, 4.5);
    s.ctx.strokeStyle = '#4a3a2c'; s.ctx.lineWidth = 0.8;
    s.ctx.strokeRect(op[0] - 4, op[1] - 6, 8, 4.5);
    circle(s.ctx, op[0] - 2.2, op[1] - 0.8, 1.4, '#3c3c3c', null);
    circle(s.ctx, op[0] + 2.2, op[1] - 0.8, 1.4, '#3c3c3c', null);
    circle(s.ctx, op[0] - 1.5, op[1] - 6.5, 1.6, '#5a5a5a', '#3c3c3c', 0.6);
    circle(s.ctx, op[0] + 1.5, op[1] - 7, 1.4, '#6e6e6e', '#3c3c3c', 0.6);
    return s;
  };

  D.toolmaker = () => {
    const s = base(1, 62);
    plot(s.ctx, s.cx, s.cy, 1, '#a89a86', '#857a6a', '#968a78');
    const b = box(s.ctx, s.cx, s.cy, 0.64, 0.64, 15, '#a09080', '#7e7060', '#8f806e');
    texStone(s.ctx, b.faceL, 4, 'rgba(60,50,40,0.4)');
    texStone(s.ctx, b.faceR, 4, 'rgba(60,50,40,0.35)');
    gable(s.ctx, b, 10, '#5a5a5a', '#4a4a4a', 'rgba(30,30,30,0.5)');
    chimneyAt(s, -0.18, -0.18, 23);
    // forge glow in the doorway
    const dp = pt(s.cx, s.cy, 0.08, 0.32);
    s.ctx.fillStyle = '#54422c';
    s.ctx.fillRect(dp[0] - 4, dp[1] - 9.5, 8, 9.5);
    const gl = s.ctx.createLinearGradient(dp[0], dp[1] - 9, dp[0], dp[1]);
    gl.addColorStop(0, '#3a2210');
    gl.addColorStop(1, '#e8762a');
    s.ctx.fillStyle = gl;
    s.ctx.fillRect(dp[0] - 3, dp[1] - 8.5, 6, 8.5);
    // anvil on a block
    const ap = pt(s.cx, s.cy, 0.32, 0.22);
    s.ctx.fillStyle = '#8a6a40'; s.ctx.fillRect(ap[0] - 2, ap[1] - 3, 4, 3);
    s.ctx.fillStyle = '#4a4a4e';
    s.ctx.beginPath();
    s.ctx.moveTo(ap[0] - 4.5, ap[1] - 6); s.ctx.lineTo(ap[0] + 4.5, ap[1] - 6);
    s.ctx.lineTo(ap[0] + 3, ap[1] - 3.5); s.ctx.lineTo(ap[0] - 2.5, ap[1] - 3.5);
    s.ctx.closePath(); s.ctx.fill();
    s.ctx.fillStyle = '#5e5e62';
    s.ctx.fillRect(ap[0] - 4.5, ap[1] - 7, 9, 1.4);
    // hammer leaning
    line(s.ctx, [ap[0] + 6, ap[1]], [ap[0] + 8, ap[1] - 7], '#6e4f2e', 1.2);
    s.ctx.fillStyle = '#5a5a5e';
    s.ctx.fillRect(ap[0] + 6.6, ap[1] - 9, 3, 2.4);
    return s;
  };

  D.potato = () => {
    const s = base(2, 54);
    plot(s.ctx, s.cx, s.cy, 2, '#a8915c', '#86733f', '#97824d');
    // furrow rows with sprouts
    for (let i = -2; i <= 2; i++) {
      const r1 = pt(s.cx, s.cy, -0.82, i * 0.18 + 0.08), r2 = pt(s.cx, s.cy, 0.5, i * 0.18 + 0.08);
      line(s.ctx, [r1[0], r1[1] - 1], [r2[0], r2[1] - 1], '#8a7344', 2.6);
      for (let k = 0; k < 6; k++) {
        const p = lerp(r1, r2, 0.08 + k * 0.16);
        s.ctx.strokeStyle = '#5d8a36'; s.ctx.lineWidth = 1;
        s.ctx.beginPath();
        s.ctx.moveTo(p[0] - 1.4, p[1] - 1); s.ctx.lineTo(p[0], p[1] - 3.6);
        s.ctx.lineTo(p[0] + 1.4, p[1] - 1);
        s.ctx.stroke();
      }
    }
    // farmhouse
    const b = box(s.ctx, s.cx, s.cy, 0.52, 0.48, 12, '#9a7344', '#7a5832', '#8c683c', 0.62, -0.58);
    texRows(s.ctx, b.faceL, 3, 'rgba(60,40,20,0.45)');
    gable(s.ctx, b, 8, '#6d5436', '#5c452c', 'rgba(60,45,25,0.5)');
    doorAt(s.ctx, pt(s.cx, s.cy, 0.62, -0.34), 5, 7);
    // sacks
    const sp2 = pt(s.cx, s.cy, 0.3, -0.62);
    for (let i = 0; i < 2; i++) {
      circle(s.ctx, sp2[0] + i * 5, sp2[1] - 3 - i, 2.8, '#c2a878', '#8f7340', 0.9);
      line(s.ctx, [sp2[0] + i * 5 - 1, sp2[1] - 5.5 - i], [sp2[0] + i * 5 + 1, sp2[1] - 5.5 - i], '#6d5436', 1.2);
    }
    return s;
  };

  D.grain = () => {
    const s = base(2, 54);
    plot(s.ctx, s.cx, s.cy, 2, '#c8a85c', '#a08440', '#b6964e');
    // wheat rows: golden stalks with seed heads
    for (let i = -2; i <= 2; i++) {
      const r1 = pt(s.cx, s.cy, -0.82, i * 0.18 + 0.08), r2 = pt(s.cx, s.cy, 0.5, i * 0.18 + 0.08);
      line(s.ctx, [r1[0], r1[1] - 1], [r2[0], r2[1] - 1], '#a88a3c', 2.4);
      for (let k = 0; k < 7; k++) {
        const p = lerp(r1, r2, 0.05 + k * 0.14);
        s.ctx.strokeStyle = '#d8b13c'; s.ctx.lineWidth = 1;
        s.ctx.beginPath();
        s.ctx.moveTo(p[0], p[1] - 1); s.ctx.lineTo(p[0] + 0.6, p[1] - 5);
        s.ctx.stroke();
        s.ctx.fillStyle = '#e8c95a';
        s.ctx.fillRect(p[0] - 0.2, p[1] - 6.6, 1.8, 2.4);
      }
    }
    // small barn
    const b = box(s.ctx, s.cx, s.cy, 0.52, 0.48, 12, '#9a7344', '#7a5832', '#8c683c', 0.62, -0.58);
    texRows(s.ctx, b.faceL, 3, 'rgba(60,40,20,0.45)');
    gable(s.ctx, b, 8, '#b89a52', '#8f7434', 'rgba(90,70,30,0.5)'); // thatched
    doorAt(s.ctx, pt(s.cx, s.cy, 0.62, -0.34), 5, 7);
    // haystack
    const hp = pt(s.cx, s.cy, 0.25, -0.66);
    s.ctx.fillStyle = '#d8b860';
    s.ctx.beginPath();
    s.ctx.moveTo(hp[0] - 5, hp[1]);
    s.ctx.quadraticCurveTo(hp[0], hp[1] - 11, hp[0] + 5, hp[1]);
    s.ctx.closePath(); s.ctx.fill();
    s.ctx.strokeStyle = '#a88a3c'; s.ctx.lineWidth = 0.8; s.ctx.stroke();
    return s;
  };

  D.bakery = () => {
    const s = base(1, 60);
    plot(s.ctx, s.cx, s.cy, 1, '#b6b09a', '#8f8a76', '#a39d87');
    const b = box(s.ctx, s.cx, s.cy, 0.62, 0.62, 15, '#e2d3b4', '#c2b394', '#d2c3a2');
    texStone(s.ctx, b.faceL, 4, 'rgba(120,100,70,0.35)');
    texStone(s.ctx, b.faceR, 4, 'rgba(120,100,70,0.3)');
    gable(s.ctx, b, 10, '#9a5c3a', '#82492c', 'rgba(95,50,25,0.5)');
    chimneyAt(s, -0.16, -0.16, 24);
    // dome oven at the side, glowing mouth
    const op = pt(s.cx, s.cy, 0.34, 0.22);
    s.ctx.fillStyle = '#a08868';
    s.ctx.beginPath();
    s.ctx.moveTo(op[0] - 6, op[1]);
    s.ctx.quadraticCurveTo(op[0], op[1] - 12, op[0] + 6, op[1]);
    s.ctx.closePath(); s.ctx.fill();
    s.ctx.strokeStyle = '#7c6448'; s.ctx.lineWidth = 0.9; s.ctx.stroke();
    s.ctx.fillStyle = '#e8762a';
    s.ctx.beginPath();
    s.ctx.moveTo(op[0] - 2.4, op[1]);
    s.ctx.quadraticCurveTo(op[0], op[1] - 4.5, op[0] + 2.4, op[1]);
    s.ctx.closePath(); s.ctx.fill();
    // bread sign: pretzel-ish loaf on a bracket
    const sp2 = pt(s.cx, s.cy, -0.34, 0.3, 13);
    line(s.ctx, sp2, [sp2[0] - 6, sp2[1]], '#4a3322', 1.3);
    s.ctx.fillStyle = '#d8a050';
    s.ctx.beginPath();
    s.ctx.ellipse(sp2[0] - 5, sp2[1] + 4, 3.4, 2.2, 0.3, 0, Math.PI * 2);
    s.ctx.fill();
    s.ctx.strokeStyle = '#a87434'; s.ctx.lineWidth = 0.8; s.ctx.stroke();
    doorAt(s.ctx, pt(s.cx, s.cy, 0.05, 0.32), 5.5, 8);
    return s;
  };

  D.distillery = () => {
    const s = base(1, 62);
    plot(s.ctx, s.cx, s.cy, 1, '#a89a86', '#857a6a', '#968a78');
    const b = box(s.ctx, s.cx, s.cy, 0.64, 0.64, 16, '#a8765a', '#876048', '#977052');
    texStone(s.ctx, b.faceL, 4, 'rgba(80,45,30,0.4)'); // brick
    texStone(s.ctx, b.faceR, 4, 'rgba(80,45,30,0.35)');
    gable(s.ctx, b, 10, '#6d3a2a', '#5a3023', 'rgba(60,28,18,0.5)');
    chimneyAt(s, -0.18, -0.18, 24);
    doorAt(s.ctx, pt(s.cx, s.cy, -0.18, 0.33), 5.5, 8);
    // big copper still with coil
    const kp = pt(s.cx, s.cy, 0.32, 0.2);
    s.ctx.fillStyle = '#c87a32';
    s.ctx.beginPath();
    s.ctx.ellipse(kp[0], kp[1] - 6, 5, 6.2, 0, 0, Math.PI * 2);
    s.ctx.fill();
    s.ctx.strokeStyle = '#9a5c22'; s.ctx.lineWidth = 0.9; s.ctx.stroke();
    circle(s.ctx, kp[0] - 1.8, kp[1] - 8, 1.8, 'rgba(255,225,180,0.65)', null); // shine
    s.ctx.fillStyle = '#b06a28';
    s.ctx.beginPath();
    s.ctx.moveTo(kp[0] - 2, kp[1] - 11.5); s.ctx.lineTo(kp[0], kp[1] - 15); s.ctx.lineTo(kp[0] + 2, kp[1] - 11.5);
    s.ctx.closePath(); s.ctx.fill();
    s.ctx.strokeStyle = '#9a5c22'; s.ctx.lineWidth = 1.4;
    s.ctx.beginPath();
    s.ctx.moveTo(kp[0], kp[1] - 15);
    s.ctx.quadraticCurveTo(kp[0] + 8, kp[1] - 18, kp[0] + 9, kp[1] - 10);
    s.ctx.quadraticCurveTo(kp[0] + 10, kp[1] - 4, kp[0] + 8, kp[1] - 2);
    s.ctx.stroke();
    barrel(s.ctx, ...pt(s.cx, s.cy, -0.36, 0.36), 3.6);
    return s;
  };

  /* ---------------- nature ---------------- */

  function serratedLayer(ctx, x, baseY, halfW, h, fill, stroke) {
    const steps = 3;
    ctx.beginPath();
    ctx.moveTo(x, baseY - h);
    for (let i = 1; i <= steps; i++) { // left edge, jagged
      const px = x - halfW * (i / steps), py = baseY - h + h * (i / steps);
      ctx.lineTo(px + halfW * 0.14, py - h * 0.13);
      ctx.lineTo(px, py);
    }
    for (let i = steps - 1; i >= 0; i--) { // right edge back up
      const px = x + halfW * (i / steps), py = baseY - h + h * (i / steps);
      ctx.lineTo(px, py);
      ctx.lineTo(px - halfW * 0.14 * (i > 0 ? 1 : 0), py - h * 0.13);
    }
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.8; ctx.stroke(); }
  }

  function pineAt(ctx, x, y, h, w, shade) {
    shadow(ctx, x, y - 1, w * 0.9, w * 0.38, 0.18);
    // trunk
    ctx.fillStyle = '#5e4326';
    ctx.fillRect(x - 1.6, y - 8, 3.2, 8);
    ctx.fillStyle = '#4a341e';
    ctx.fillRect(x + 0.2, y - 8, 1.4, 8);
    const g = [
      ['#35602a', '#406f31'],
      ['#3f7232', '#4c843a'],
      ['#4a8540', '#5b9a4a'],
    ];
    for (let i = 0; i < 3; i++) {
      const ly = y - 5 - (h - 14) * (i / 3);
      const lw = w * (1 - i * 0.27);
      const lh = h * 0.42;
      serratedLayer(ctx, x, ly, lw, lh, g[i][shade ? 1 : 0], 'rgba(25,40,16,0.55)');
    }
    // snow-light highlight on the sunny side
    ctx.fillStyle = 'rgba(190,225,140,0.3)';
    ctx.beginPath();
    ctx.moveTo(x, y - h - 1);
    ctx.lineTo(x + w * 0.4, y - h * 0.55);
    ctx.lineTo(x + w * 0.15, y - h * 0.55);
    ctx.closePath(); ctx.fill();
  }

  function oakAt(ctx, x, y, r) {
    shadow(ctx, x, y - 1, r * 1.15, r * 0.45, 0.18);
    ctx.fillStyle = '#5e4326';
    ctx.fillRect(x - 1.8, y - 9, 3.6, 9);
    ctx.fillStyle = '#4a341e';
    ctx.fillRect(x + 0.4, y - 9, 1.4, 9);
    const blobs = [
      [-r * 0.55, -r * 0.2, r * 0.72, '#446e2e'],
      [r * 0.5, -r * 0.25, r * 0.7, '#4c7a34'],
      [0, -r * 0.85, r * 0.8, '#558a3a'],
      [-r * 0.15, -r * 0.15, r * 0.75, '#4c7a34'],
    ];
    for (const [dx, dy, rr, col] of blobs) {
      circle(ctx, x + dx, y - 9 - r * 0.5 + dy, rr, col, 'rgba(30,48,18,0.4)', 0.8);
    }
    // leaf-cluster highlights
    ctx.fillStyle = 'rgba(160,200,90,0.5)';
    for (const [dx, dy] of [[r * 0.35, -r * 0.85], [-r * 0.3, -r * 0.5], [r * 0.55, -r * 0.3]]) {
      circle(ctx, x + dx, y - 9 - r * 0.5 + dy, r * 0.2, 'rgba(160,200,90,0.45)', null);
    }
  }

  function tree(variant) {
    const s = base(1, 58);
    if (variant === 4 || variant === 5) { // lone oak
      const tp = pt(s.cx, s.cy, 0, 0.05);
      oakAt(s.ctx, tp[0], tp[1], variant === 4 ? 11 : 9);
      return s;
    }
    const n = 1 + (variant % 3);
    const offs = [[0, 0], [-0.24, 0.2], [0.26, -0.14]];
    for (let i = n - 1; i >= 0; i--) {
      const [du, dv] = offs[i];
      const tp = pt(s.cx, s.cy, du, dv);
      const hgt = 30 - i * 6 + (variant * 7) % 5;
      pineAt(s.ctx, tp[0], tp[1], hgt, 12 - i * 2, (variant + i) % 2);
    }
    return s;
  }

  function rock(variant) {
    const s = base(1, 50);
    const tp = pt(s.cx, s.cy, 0, 0);
    const h = 26 + (variant % 3) * 7;
    shadow(s.ctx, tp[0], tp[1] + 3, 24, 8, 0.22);
    // main massif: three faces
    poly(s.ctx, [
      [tp[0] - 26, tp[1]], [tp[0] - 16, tp[1] - h * 0.6], [tp[0] - 8, tp[1] - h],
      [tp[0] + 4, tp[1] - h + 5], [tp[0] - 4, tp[1] + 6], [tp[0] - 14, tp[1] + 6],
    ], '#74746e', '#54544e');
    poly(s.ctx, [
      [tp[0] - 8, tp[1] - h], [tp[0] + 4, tp[1] - h + 5], [tp[0] + 14, tp[1] - h * 0.55],
      [tp[0] + 26, tp[1]], [tp[0] + 12, tp[1] + 6], [tp[0] - 4, tp[1] + 6],
    ], '#8e8e88', '#54544e');
    poly(s.ctx, [
      [tp[0] - 16, tp[1] - h * 0.6], [tp[0] - 8, tp[1] - h], [tp[0] + 4, tp[1] - h + 5],
      [tp[0] - 2, tp[1] - h * 0.45],
    ], '#a8a8a2', '#54544e');
    // cracks
    s.ctx.strokeStyle = 'rgba(50,50,46,0.6)'; s.ctx.lineWidth = 0.9;
    s.ctx.beginPath();
    s.ctx.moveTo(tp[0] - 4, tp[1] - h + 6); s.ctx.lineTo(tp[0], tp[1] - h * 0.5); s.ctx.lineTo(tp[0] - 3, tp[1] - h * 0.2);
    s.ctx.moveTo(tp[0] + 10, tp[1] - h * 0.5); s.ctx.lineTo(tp[0] + 7, tp[1] - h * 0.25);
    s.ctx.stroke();
    // sunlit top edge
    s.ctx.strokeStyle = 'rgba(235,235,225,0.55)'; s.ctx.lineWidth = 1.2;
    s.ctx.beginPath();
    s.ctx.moveTo(tp[0] - 8, tp[1] - h); s.ctx.lineTo(tp[0] + 4, tp[1] - h + 5);
    s.ctx.stroke();
    // scattered stones + moss
    circle(s.ctx, tp[0] + 18, tp[1] + 3, 2.6, '#8e8e88', '#54544e', 0.8);
    circle(s.ctx, tp[0] - 20, tp[1] + 4, 2, '#7e7e78', '#54544e', 0.8);
    if (variant % 2 === 0) {
      s.ctx.fillStyle = 'rgba(95,135,60,0.55)';
      circle(s.ctx, tp[0] - 12, tp[1] - 2, 3, 'rgba(95,135,60,0.5)', null);
      circle(s.ctx, tp[0] + 8, tp[1] + 2, 2.4, 'rgba(95,135,60,0.45)', null);
    }
    return s;
  }

  function scaffold(size) {
    const s = base(size, 44);
    plot(s.ctx, s.cx, s.cy, size, '#b59a6a', '#8f7340', '#9c8252');
    const e = size / 2 - 0.12;
    const posts = [[-e, -e], [e, -e], [e, e], [-e, e]];
    s.ctx.strokeStyle = '#8a6a3c'; s.ctx.lineWidth = 2;
    const tops = [];
    for (const [u, v] of posts) {
      const p = pt(s.cx, s.cy, u, v);
      line(s.ctx, p, [p[0], p[1] - 24], '#8a6a3c', 2);
      line(s.ctx, [p[0], p[1] - 16], [p[0], p[1] - 15], '#6d5436', 3); // joint
      tops.push([p[0], p[1] - 24]);
    }
    s.ctx.strokeStyle = '#8a6a3c'; s.ctx.lineWidth = 1.6;
    s.ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      s.ctx.moveTo(tops[i][0], tops[i][1]);
      s.ctx.lineTo(tops[(i + 1) % 4][0], tops[(i + 1) % 4][1]);
    }
    s.ctx.stroke();
    // diagonal braces
    const p0 = pt(s.cx, s.cy, -e, e), p1 = pt(s.cx, s.cy, e, e);
    line(s.ctx, p0, [p1[0], p1[1] - 24], '#8a6a3c', 1.4);
    line(s.ctx, p1, [p0[0], p0[1] - 24], 'rgba(138,106,60,0.6)', 1.4);
    // plank platform halfway up
    s.ctx.fillStyle = 'rgba(176,141,82,0.85)';
    const m0 = pt(s.cx, s.cy, -e, -e), m1 = pt(s.cx, s.cy, e, -e);
    poly(s.ctx, [
      [m0[0], m0[1] - 13], [m1[0], m1[1] - 13],
      [p1[0], p1[1] - 13], [p0[0], p0[1] - 13],
    ], 'rgba(176,141,82,0.5)', '#6d5436', 0.8);
    crate(s.ctx, s.cx, s.cy, 0, 0.1);
    // lumber stack
    const lp = pt(s.cx, s.cy, -e * 0.5, -e * 0.8);
    line(s.ctx, [lp[0] - 6, lp[1] - 1], [lp[0] + 6, lp[1] - 4], '#a8854c', 2.4);
    line(s.ctx, [lp[0] - 6, lp[1] - 3.5], [lp[0] + 6, lp[1] - 6.5], '#97793f', 2.4);
    return s;
  }

  function ship() {
    const w = 64, h = 72;
    const c = mk(w * SS, h * SS);
    const ctx = c.getContext('2d');
    ctx.scale(SS, SS);
    ctx.lineJoin = 'round';
    // hull
    ctx.beginPath();
    ctx.moveTo(8, 48);
    ctx.quadraticCurveTo(32, 62, 54, 47);
    ctx.lineTo(50, 38); ctx.lineTo(14, 38);
    ctx.closePath();
    ctx.fillStyle = '#6e4f2e'; ctx.fill();
    ctx.strokeStyle = '#46311c'; ctx.lineWidth = 1.4; ctx.stroke();
    // plank lines + railing
    ctx.strokeStyle = 'rgba(60,40,20,0.55)'; ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(11, 44); ctx.quadraticCurveTo(32, 54, 52, 43);
    ctx.moveTo(10, 41); ctx.quadraticCurveTo(32, 49, 53, 40);
    ctx.stroke();
    ctx.strokeStyle = '#8a6a40'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(13, 38); ctx.lineTo(51, 38); ctx.stroke();
    // bowsprit
    ctx.strokeStyle = '#46311c'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(52, 39); ctx.lineTo(62, 33); ctx.stroke();
    // masts
    ctx.beginPath();
    ctx.moveTo(28, 38); ctx.lineTo(28, 5);
    ctx.moveTo(44, 38); ctx.lineTo(44, 14);
    ctx.stroke();
    // main sail
    ctx.beginPath();
    ctx.moveTo(28, 8);
    ctx.quadraticCurveTo(46, 18, 29, 34);
    ctx.closePath();
    ctx.fillStyle = '#f2eddc'; ctx.fill();
    ctx.strokeStyle = '#b9ae94'; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = 'rgba(150,135,105,0.5)';
    ctx.beginPath();
    ctx.moveTo(30, 13); ctx.quadraticCurveTo(40, 19, 31, 29);
    ctx.stroke();
    // fore sail
    ctx.beginPath();
    ctx.moveTo(44, 16);
    ctx.quadraticCurveTo(56, 24, 45, 35);
    ctx.closePath();
    ctx.fillStyle = '#eee8d4'; ctx.fill();
    ctx.strokeStyle = '#b9ae94'; ctx.stroke();
    // jib to the bowsprit
    ctx.beginPath();
    ctx.moveTo(28, 8); ctx.lineTo(61, 33); ctx.strokeStyle = '#8a7a5c'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(28, 12); ctx.quadraticCurveTo(44, 22, 56, 31); ctx.lineTo(28, 22);
    ctx.closePath();
    ctx.fillStyle = '#e8e0c8'; ctx.fill();
    ctx.strokeStyle = '#b9ae94'; ctx.stroke();
    // pennant
    ctx.beginPath(); ctx.moveTo(28, 5); ctx.lineTo(39, 8); ctx.lineTo(28, 11); ctx.closePath();
    ctx.fillStyle = '#b8463a'; ctx.fill();
    return { c, w, h, oy: 56, chimney: null };
  }

  /* ---------------- textured ground tiles ---------------- */

  const TILE_PAD = 2;

  function makeTile(type, variant) {
    const w = TW + TILE_PAD * 2, h = TH + TILE_PAD * 2;
    const c = mk(w * SS, h * SS);
    const ctx = c.getContext('2d');
    ctx.scale(SS, SS);
    const cx = w / 2, cy = h / 2;
    const rng = mulberry32(type * 131 + variant * 17 + 7);

    // diamond clip, slightly oversized to hide seams between tiles
    const k = 1.07;
    ctx.beginPath();
    ctx.moveTo(cx, cy - TH2 * k);
    ctx.lineTo(cx + TW2 * k, cy);
    ctx.lineTo(cx, cy + TH2 * k);
    ctx.lineTo(cx - TW2 * k, cy);
    ctx.closePath();
    ctx.clip();

    const v = Math.floor(rng() * 7) - 3;
    const dot = (col, n, rMin, rMax) => {
      ctx.fillStyle = col;
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2, rr = Math.sqrt(rng());
        const x = cx + Math.cos(a) * rr * TW2 * 0.92;
        const y = cy + Math.sin(a) * rr * TH2 * 0.92;
        const r = rMin + rng() * (rMax - rMin);
        ctx.fillRect(x, y, r, r * 0.7);
      }
    };

    if (type === TILE.GRASS || type === TILE.TREE) {
      const gv = Math.floor(rng() * 5) - 2; // gentler variance, no grid pattern
      ctx.fillStyle = `hsl(95, 41%, ${40 + gv}%)`;
      ctx.fillRect(0, 0, w, h);
      dot(`hsla(95, 50%, ${31 + gv}%, 0.55)`, 12, 1, 2);
      dot(`hsla(85, 55%, ${50 + gv}%, 0.55)`, 9, 1, 1.8);
      // grass tufts
      ctx.strokeStyle = 'hsla(95, 50%, 28%, 0.7)'; ctx.lineWidth = 0.8;
      for (let i = 0; i < 4; i++) {
        const x = cx + (rng() - 0.5) * TW2 * 1.2, y = cy + (rng() - 0.5) * TH2 * 1.2;
        ctx.beginPath();
        ctx.moveTo(x - 1.5, y); ctx.lineTo(x - 0.5, y - 2.6);
        ctx.moveTo(x, y); ctx.lineTo(x, y - 3.2);
        ctx.moveTo(x + 1.5, y); ctx.lineTo(x + 0.5, y - 2.6);
        ctx.stroke();
      }
    } else if (type === TILE.SAND) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, `hsl(45, 54%, ${67 + v}%)`);
      g.addColorStop(1, `hsl(43, 48%, ${60 + v}%)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      dot(`hsla(40, 45%, ${48 + v}%, 0.8)`, 16, 0.8, 1.4);
      dot(`hsla(48, 65%, ${78 + v}%, 0.8)`, 12, 0.8, 1.4);
      // ripple line
      ctx.strokeStyle = `hsla(40, 40%, ${52 + v}%, 0.6)`; ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(cx - TW2 * 0.6, cy + (rng() - 0.5) * 6);
      ctx.quadraticCurveTo(cx, cy + (rng() - 0.5) * 8, cx + TW2 * 0.6, cy + (rng() - 0.5) * 6);
      ctx.stroke();
    } else if (type === TILE.WATER || type === TILE.DEEP) {
      const deep = type === TILE.DEEP;
      const g = ctx.createLinearGradient(0, 0, w, h);
      if (deep) {
        g.addColorStop(0, `hsl(207, 64%, ${23 + v}%)`);
        g.addColorStop(1, `hsl(210, 66%, ${18 + v}%)`);
      } else {
        g.addColorStop(0, `hsl(196, 56%, ${41 + v}%)`);
        g.addColorStop(1, `hsl(202, 58%, ${33 + v}%)`);
      }
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      // wave dashes
      ctx.strokeStyle = deep ? 'rgba(120,170,210,0.25)' : 'rgba(190,230,250,0.35)';
      ctx.lineWidth = 1;
      for (let i = 0; i < (deep ? 2 : 3); i++) {
        const x = cx + (rng() - 0.5) * TW2, y = cy + (rng() - 0.5) * TH2;
        ctx.beginPath();
        ctx.moveTo(x - 4, y);
        ctx.quadraticCurveTo(x, y - 1.6, x + 4, y);
        ctx.stroke();
      }
    } else { // ROCK ground
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, `hsl(40, 7%, ${55 + v}%)`);
      g.addColorStop(1, `hsl(40, 8%, ${47 + v}%)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      dot(`hsla(40, 8%, ${38 + v}%, 0.8)`, 10, 1, 2.2);
      dot(`hsla(40, 10%, ${66 + v}%, 0.7)`, 7, 0.8, 1.6);
    }
    return { c, w, h };
  }

  function getTile(type, variant) {
    const k = type * 8 + variant;
    if (!tileCache[k]) tileCache[k] = makeTile(type, variant);
    return tileCache[k];
  }

  /* ---------------- public API ---------------- */

  function get(key) {
    if (cache[key]) return cache[key];
    let s;
    let m = key.match(/^house(\d):(\d)$/);
    if (m) s = D['house' + m[1]](parseInt(m[2], 10));
    else if (key.startsWith('tree')) s = tree(parseInt(key.slice(4), 10) || 0);
    else if (key.startsWith('rock')) s = rock(parseInt(key.slice(4), 10) || 0);
    else if (key.startsWith('scaffold')) s = scaffold(parseInt(key.slice(8), 10) || 1);
    else if (key === 'ship') { cache[key] = ship(); return cache[key]; }
    else if (D[key]) s = D[key](0);
    else s = D.house0(0);
    cache[key] = { c: s.c, w: s.w, h: s.h, oy: s.oy, chimney: s.chimney || null };
    return cache[key];
  }

  function keyFor(b) {
    if (b.key === 'house') return `house${b.tier}:${(b.x * 7 + b.y * 13) % 3}`;
    return b.key;
  }

  return { get, keyFor, getTile, TILE_PAD };
})();
