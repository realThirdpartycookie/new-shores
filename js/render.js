'use strict';
/* ============================================================
 * Isometric renderer: textured ground, roads, sprites, smoke,
 * ghost preview, minimap.
 * ============================================================ */

const Render = (() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const mmCanvas = document.getElementById('minimap');
  const mmCtx = mmCanvas.getContext('2d');

  const cam = { x: 0, y: 0, zoom: 1 };
  const camT = { x: 0, y: 0, zoom: 1 };  // glide targets (wheel zoom, fly-to)
  const camVel = { x: 0, y: 0 };         // flick-pan inertia, px/s
  let mmBase = null;          // minimap terrain cache
  let mmDirty = true;
  let dpr = 1;

  // set by main.js every frame
  const ghost = { active: false, key: null, x: 0, y: 0, ok: false, mode: null };

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }

  /* Smoothed camera: wheel zoom and fly-to write camT; drags write both
   * (instant) and leave a velocity that keeps the map gliding. */
  function clampCamT() {
    const w = canvas.clientWidth, h = canvas.clientHeight, z = camT.zoom;
    camT.x = Math.max(w / 2 - MAPW * TW2 * z, Math.min(w / 2 + MAPH * TW2 * z, camT.x));
    camT.y = Math.max(h / 2 - (MAPW + MAPH) * TH2 * z, Math.min(h / 2, camT.y));
  }

  function updateCamera(dt) {
    if (Math.abs(camVel.x) > 2 || Math.abs(camVel.y) > 2) {
      camT.x += camVel.x * dt;
      camT.y += camVel.y * dt;
      const decay = Math.pow(0.02, dt);
      camVel.x *= decay; camVel.y *= decay;
    } else {
      camVel.x = camVel.y = 0;
    }
    clampCamT();
    const kz = Math.min(1, dt * 14), kp = Math.min(1, dt * 12);
    cam.zoom += (camT.zoom - cam.zoom) * kz;
    cam.x += (camT.x - cam.x) * kp;
    cam.y += (camT.y - cam.y) * kp;
    if (Math.abs(camT.zoom - cam.zoom) < 0.001) cam.zoom = camT.zoom;
  }

  function flyTo(tx, ty) {
    camVel.x = camVel.y = 0;
    camT.x = canvas.clientWidth / 2 - (tx - ty) * TW2 * camT.zoom;
    camT.y = canvas.clientHeight / 2 - (tx + ty) * TH2 * camT.zoom;
  }

  function screenToTile(mx, my) {
    const wx = (mx - cam.x) / cam.zoom;
    const wy = (my - cam.y) / cam.zoom;
    return {
      x: Math.floor((wx / TW2 + wy / TH2) / 2),
      y: Math.floor((wy / TH2 - wx / TW2) / 2),
      fx: (wx / TW2 + wy / TH2) / 2,
      fy: (wy / TH2 - wx / TW2) / 2,
    };
  }

  function centerOn(tx, ty) {
    cam.x = canvas.clientWidth / 2 - (tx - ty) * TW2 * cam.zoom;
    cam.y = canvas.clientHeight / 2 - (tx + ty) * TH2 * cam.zoom;
    camT.x = cam.x; camT.y = cam.y; camT.zoom = cam.zoom;
    camVel.x = camVel.y = 0;
  }

  function zoomAt(mx, my, factor) {
    const before = camT.zoom;
    camT.zoom = Math.max(0.45, Math.min(2.2, camT.zoom * factor));
    const k = camT.zoom / before;
    camT.x = mx - (mx - camT.x) * k;
    camT.y = my - (my - camT.y) * k;
  }

  // Terrain look is baked into tile sprites; refresh the minimap and
  // re-scan the map for ambient-life spots (fish, glades, star water).
  function rebuildGroundCache() {
    mmDirty = true;
    ambient = null;
    expCache = null;
    for (const k in boatSpots) delete boatSpots[k];
  }

  /* ---------------- day/night cycle ---------------- */

  function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  // 0 = day … 1 = deep night. Night covers ~the last quarter of each cycle.
  function nightFactor(time) {
    const ph = (time % DAY_LENGTH) / DAY_LENGTH;
    return smoothstep(0.70, 0.80, ph) * (1 - smoothstep(0.95, 1.0, ph));
  }

  // warm sunset / sunrise band
  function duskFactor(time) {
    const ph = (time % DAY_LENGTH) / DAY_LENGTH;
    const dusk = smoothstep(0.64, 0.70, ph) * (1 - smoothstep(0.74, 0.80, ph));
    const dawn = smoothstep(0.93, 0.96, ph) * (1 - smoothstep(0.99, 1.0, ph));
    return Math.max(dusk, dawn);
  }

  function seaColor(n) { // noon #0d2a40 → midnight #071527
    const mix = (a, b) => Math.round(a + (b - a) * n);
    return `rgb(${mix(13, 7)},${mix(42, 21)},${mix(64, 39)})`;
  }

  /* ---------------- weather (visuals for G.stormT) ---------------- */

  let stormEase = 0;
  let windVal = 0.25;
  let lastDrawT = null;
  let lastWallT = null;
  let rain = null;      // preallocated drop pool
  let flash = 0;        // lightning white-out
  let lightningT = 5;
  let onLightning = null;

  function tickWeather(time, dtF, wallDt) {
    stormEase += ((G.stormT > 0 ? 1 : 0) - stormEase) * Math.min(1, 3 * dtF);
    if (stormEase < 0.005) stormEase = 0;
    windVal = 0.25 + 0.2 * Math.sin(time * 0.05) + 0.15 * Math.sin(time * 0.013 + 2) + 0.6 * stormEase;
    flash *= Math.exp(-8 * wallDt); // wall time: must fade even while paused
    if (stormEase > 0.5) {
      lightningT -= dtF;
      if (lightningT <= 0) {
        lightningT = 3 + Math.random() * 5;
        flash = 1;
        if (onLightning) onLightning();
      }
    }
  }

  function drawWeather() { // screen space, device pixels
    if (stormEase <= 0 && flash < 0.01) return;
    const w = canvas.width, h = canvas.height;
    if (stormEase > 0) {
      ctx.fillStyle = `rgba(22,30,50,${(0.34 * stormEase).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
      if (!rain) {
        rain = [];
        for (let i = 0; i < 220; i++) {
          rain.push({ x: Math.random(), y: Math.random(), spd: 0.8 + Math.random() * 0.4 });
        }
      }
      ctx.strokeStyle = `rgba(195,220,255,${(0.45 * stormEase).toFixed(3)})`;
      ctx.lineWidth = dpr;
      ctx.beginPath();
      const slant = (3 + windVal * 8) * dpr;
      for (const d of rain) {
        const dx = d.x * w, dy = d.y * h;
        ctx.moveTo(dx, dy);
        ctx.lineTo(dx - slant, dy + 15 * dpr);
      }
      ctx.stroke();
    }
    if (flash > 0.01) {
      ctx.fillStyle = `rgba(240,245,255,${(0.4 * flash).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  function advanceRain(dtF) {
    if (!rain || stormEase <= 0) return;
    for (const d of rain) {
      d.y += d.spd * dtF * 1.1;
      d.x -= windVal * 0.12 * dtF;
      if (d.y > 1) { d.y -= 1; d.x = Math.random(); }
      if (d.x < 0) d.x += 1;
    }
  }

  /* ---------------- particles, floating text, screen shake ---------------- */

  const parts = [];
  const floats = [];
  let shakeAmp = 0;

  const FX_SPECS = {
    dust:     { n: 12, cols: ['#c9b28a', '#b9a078'], spd: 40, up: 50, grav: 90, life: 0.7, size: 2.4 },
    crumble:  { n: 16, cols: ['#8a7a66', '#6d5f4e', '#a4937c'], spd: 55, up: 70, grav: 170, life: 0.8, size: 2.6 },
    spark:    { n: 10, cols: ['#ffd75e', '#ff9a3c'], spd: 85, up: 30, grav: 60, life: 0.45, size: 1.8, add: true },
    splash:   { n: 14, cols: ['#bfe0f2', '#8fc4e2'], spd: 60, up: 90, grav: 230, life: 0.7, size: 1.8 },
    complete: { n: 10, cols: ['#fff3c8', '#ffd75e'], spd: 55, up: 60, grav: 40, life: 0.6, size: 2, add: true },
  };

  function fxBurst(kind, x, y, data) {
    if (kind === 'shake') { shakeAmp = Math.min(10, shakeAmp + ((data && data.amp) || 3)); return; }
    const wx = (x - y) * TW2, wy = (x + y) * TH2;
    if (kind === 'float') {
      floats.push({ wx, wy: wy - 26, txt: data && data.txt || '', col: (data && data.col) || '#ffd75e', t: 0 });
      return;
    }
    const spec = FX_SPECS[kind];
    if (!spec) return;
    for (let i = 0; i < spec.n; i++) {
      if (parts.length >= 220) parts.shift();
      const a = Math.random() * Math.PI * 2;
      parts.push({
        x: wx + Math.cos(a) * 7, y: wy + Math.sin(a) * 3.5,
        vx: Math.cos(a) * spec.spd * (0.4 + Math.random() * 0.6),
        vy: -spec.up * (0.4 + Math.random() * 0.8),
        grav: spec.grav, t: 0, life: spec.life * (0.7 + Math.random() * 0.5),
        col: spec.cols[i % spec.cols.length],
        size: spec.size * (0.7 + Math.random() * 0.6),
        add: !!spec.add,
      });
    }
  }

  function drawParticles(dtF) { // world space
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.t += dtF;
      if (p.t >= p.life) { parts.splice(i, 1); continue; }
      p.x += p.vx * dtF;
      p.y += p.vy * dtF;
      p.vy += p.grav * dtF;
      const a = 1 - p.t / p.life;
      ctx.globalAlpha = a;
      if (p.add) ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = p.col;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size * 0.8);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }

  function drawFloats(dtF) { // world space
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      f.t += dtF;
      if (f.t >= 1.7) { floats.splice(i, 1); continue; }
      const a = f.t < 1.2 ? 1 : 1 - (f.t - 1.2) / 0.5;
      ctx.globalAlpha = a;
      ctx.font = 'bold 13px Georgia, serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const y = f.wy - f.t * 22;
      ctx.strokeStyle = 'rgba(30,20,8,0.8)';
      ctx.lineWidth = 3;
      ctx.strokeText(f.txt, f.wx, y);
      ctx.fillStyle = f.col;
      ctx.fillText(f.txt, f.wx, y);
    }
    ctx.globalAlpha = 1;
  }

  /* Pre-rendered radial glow sprites — building one gradient per glow per
   * frame melts the GC in a big night-time town. */
  const glowSprites = {};
  function glowSprite(color) {
    if (!glowSprites[color]) {
      const c = document.createElement('canvas');
      c.width = c.height = 24;
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(12, 12, 0.5, 12, 12, 12);
      gr.addColorStop(0, color);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 24, 24);
      glowSprites[color] = c;
    }
    return glowSprites[color];
  }

  /* ---------------- ambient-life spots (rebuilt per map) ---------------- */

  let ambient = null;

  function buildAmbientSpots() {
    ambient = { fish: [], glade: [], stars: [] };
    for (let y = 0; y < MAPH; y++) {
      for (let x = 0; x < MAPW; x++) {
        const i = idx(x, y), t = G.tiles[i], h = tileHash(x, y);
        if (isWaterTile(t) && G.shore[i]) {
          if (h < 0.08 && ambient.fish.length < 40) ambient.fish.push({ x, y, h });
        } else if (t === TILE.GRASS && h >= 0.08 && h < 0.14 && ambient.glade.length < 24) {
          if (tileAt(x + 1, y) === TILE.TREE || tileAt(x - 1, y) === TILE.TREE ||
              tileAt(x, y + 1) === TILE.TREE || tileAt(x, y - 1) === TILE.TREE) {
            ambient.glade.push({ x, y, h });
          }
        } else if (t === TILE.DEEP && !G.shore[i] && h < 0.05 && ambient.stars.length < 80) {
          ambient.stars.push({ x, y, h });
        }
      }
    }
  }

  /* Repeating-pattern fills for the AI terrain textures, keyed by TILE type.
   * Land only: on wide open water a repeating texture reads as an obvious
   * grid, so the sea stays procedural. */
  let terrainPats = null;

  function getTerrainPatterns() {
    if (terrainPats) return terrainPats;
    const names = { [TILE.SAND]: 'sand', [TILE.GRASS]: 'grass', [TILE.TREE]: 'grass', [TILE.ROCK]: 'rock' };
    const pats = {};
    for (const t in names) {
      const tex = Assets.texture(names[t]);
      if (!tex) return null; // wait until every texture has loaded
      pats[t] = ctx.createPattern(tex.img, 'repeat');
    }
    terrainPats = pats;
    return terrainPats;
  }

  function tilePath(sx, sy) {
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + TW2, sy + TH2);
    ctx.lineTo(sx, sy + TH);
    ctx.lineTo(sx - TW2, sy + TH2);
    ctx.closePath();
  }

  function visibleRange() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const corners = [
      screenToTile(0, 0), screenToTile(w, 0),
      screenToTile(0, h), screenToTile(w, h),
    ];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of corners) {
      minX = Math.min(minX, c.fx); maxX = Math.max(maxX, c.fx);
      minY = Math.min(minY, c.fy); maxY = Math.max(maxY, c.fy);
    }
    return {
      x0: Math.max(0, Math.floor(minX) - 2), x1: Math.min(MAPW - 1, Math.ceil(maxX) + 2),
      y0: Math.max(0, Math.floor(minY) - 2), y1: Math.min(MAPH - 1, Math.ceil(maxY) + 4),
    };
  }

  function drawRoadTile(x, y) {
    const sx = (x - y) * TW2, sy = (x + y) * TH2;
    const cxp = sx, cyp = sy + TH2;
    const connected = G.roadOk[idx(x, y)];
    const edge = connected ? '#8f7340' : '#7a6a4e';
    const col = connected ? '#cdb288' : '#a89570';
    const dirs = [
      [1, 0, TW2 / 2, TH2 / 2], [-1, 0, -TW2 / 2, -TH2 / 2],
      [0, 1, -TW2 / 2, TH2 / 2], [0, -1, TW2 / 2, -TH2 / 2],
    ];
    const arms = [];
    for (const [dx, dy, ox, oy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const nb = G.grid[idx(nx, ny)];
      const link = G.roads[idx(nx, ny)] ||
        (nb && (nb.key === 'warehouse' || nb.key === 'depot' || nb.key === 'market' || nb.key === 'kontor'));
      if (link) arms.push([ox, oy]);
    }
    ctx.lineCap = 'round';
    for (const [w, c] of [[13, edge], [9.5, col]]) {
      ctx.strokeStyle = c;
      ctx.lineWidth = w;
      ctx.beginPath();
      if (arms.length === 0) {
        ctx.moveTo(cxp - 1, cyp); ctx.lineTo(cxp + 1, cyp);
      }
      for (const [ox, oy] of arms) {
        ctx.moveTo(cxp, cyp);
        ctx.lineTo(cxp + ox, cyp + oy);
      }
      ctx.stroke();
    }
    // pebbles & ruts
    const h = tileHash(x, y);
    ctx.fillStyle = 'rgba(110,88,55,0.6)';
    ctx.fillRect(cxp - 8 + h * 10, cyp - 2 + h * 3, 1.6, 1.1);
    ctx.fillRect(cxp + 3 - h * 8, cyp + 1 - h * 4, 1.6, 1.1);
    ctx.fillStyle = 'rgba(230,215,180,0.5)';
    ctx.fillRect(cxp + 5 - h * 12, cyp - 1, 1.3, 0.9);
  }

  function draw(time, toolActive) {
    if (canvas.width !== Math.round(canvas.clientWidth * dpr)) resize();

    // frame delta in sim-time (freezes with pause, scales with game speed)
    const dtF = lastDrawT == null ? 0.016 : Math.max(0, Math.min(0.1, time - lastDrawT));
    lastDrawT = time;
    // wall-clock delta for camera effects that must settle even while paused
    const wallNow = performance.now() / 1000;
    const wallDt = lastWallT == null ? 0.016 : Math.min(0.1, wallNow - lastWallT);
    lastWallT = wallNow;
    tickWeather(time, dtF, wallDt);
    advanceRain(dtF);
    const night = nightFactor(time);
    const dusk = duskFactor(time);
    const nightOn = night > 0.45;

    shakeAmp *= Math.exp(-6 * wallDt);
    const shx = shakeAmp > 0.05 ? (Math.random() * 2 - 1) * shakeAmp : 0;
    const shy = shakeAmp > 0.05 ? (Math.random() * 2 - 1) * shakeAmp : 0;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = seaColor(night);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, (cam.x + shx) * dpr, (cam.y + shy) * dpr);

    const r = visibleRange();
    const PAD = Sprites.TILE_PAD;
    const glows = []; // lit-window positions collected during the sprite pass

    /* ---- ground pass: textured diamond tiles ----
     * With AI raster terrain, all diamonds of a type are batched into one
     * path and filled with a world-anchored repeating pattern — that keeps
     * neighbouring tiles seamless. Falls back to per-tile procedural art. */
    const raster = typeof Assets !== 'undefined' && Assets.texture('grass') ? getTerrainPatterns() : null;
    if (raster) {
      const paths = {};
      const e = 1.5; // slight overlap so terrain types meet without cracks
      for (let y = r.y0; y <= r.y1; y++) {
        for (let x = r.x0; x <= r.x1; x++) {
          const t = G.tiles[idx(x, y)];
          if (!raster[t]) continue; // water stays procedural
          const p = paths[t] || (paths[t] = new Path2D());
          const sx = (x - y) * TW2, sy = (x + y) * TH2;
          p.moveTo(sx, sy - e);
          p.lineTo(sx + TW2 + e, sy + TH2);
          p.lineTo(sx, sy + TH + e);
          p.lineTo(sx - TW2 - e, sy + TH2);
          p.closePath();
        }
      }
      for (const t of [TILE.SAND, TILE.GRASS, TILE.TREE, TILE.ROCK]) {
        if (paths[t]) {
          ctx.fillStyle = raster[t];
          ctx.fill(paths[t]);
        }
      }
    }
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = idx(x, y);
        const t = G.tiles[i];
        const sx = (x - y) * TW2, sy = (x + y) * TH2;
        if (!raster || !raster[t]) {
          const ts = Sprites.getTile(t, Math.floor(tileHash(x, y) * 8));
          ctx.drawImage(ts.c, sx - TW2 - PAD, sy - PAD, ts.w, ts.h);
        }

        if (t === TILE.WATER || t === TILE.DEEP) {
          if (G.shore[i]) { // animated foam on the two upper edges
            const fa = 0.32 + 0.22 * Math.sin(time * 1.7 + (x * 3 + y * 5) * 0.6);
            ctx.strokeStyle = `rgba(235,248,255,${fa.toFixed(3)})`;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(sx - TW2, sy + TH2); ctx.lineTo(sx, sy); ctx.lineTo(sx + TW2, sy + TH2);
            ctx.stroke();
            ctx.strokeStyle = `rgba(235,248,255,${(fa * 0.45).toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(sx - TW2 + 4, sy + TH2 + 3); ctx.lineTo(sx, sy + 4.5); ctx.lineTo(sx + TW2 - 4, sy + TH2 + 3);
            ctx.stroke();
          }
          const h = tileHash(x, y);
          if (h < 0.1) { // sparkles
            const a = 0.18 + 0.18 * Math.sin(time * 2 + h * 60);
            ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(sx + (h - 0.05) * 300, sy + TH2 + (h * 130) % 8 - 4, 1.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        if (toolActive && isLandTile(t) && !G.zone[i]) {
          tilePath(sx, sy);
          ctx.fillStyle = 'rgba(10,10,20,0.25)';
          ctx.fill();
        }
      }
    }

    /* ---- roads ---- */
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        if (G.roads[idx(x, y)]) drawRoadTile(x, y);
      }
    }

    /* ---- collect drawables ---- */
    const items = [];
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const t = G.tiles[idx(x, y)];
        if (t === TILE.TREE) {
          items.push({ d: x + y, kind: 'spr', key: 'tree' + Math.floor(tileHash(x, y) * 6), x, y, s: 1 });
        } else if (t === TILE.ROCK) {
          items.push({ d: x + y, kind: 'spr', key: 'rock' + Math.floor(tileHash(x, y) * 4), x, y, s: 1 });
        }
      }
    }
    for (const b of G.buildings) {
      const def = BUILDINGS[b.key];
      if (b.x + def.size < r.x0 - 2 || b.x > r.x1 + 2 || b.y + def.size < r.y0 - 2 || b.y > r.y1 + 2) continue;
      items.push({
        d: b.x + b.y + 2 * (def.size - 1),
        kind: 'spr',
        key: b.done ? Sprites.keyFor(b) : 'scaffold' + def.size,
        x: b.x, y: b.y, s: def.size, b,
      });
    }
    // people out and about
    for (const w of G.walkers) {
      if (w.fx < r.x0 - 1 || w.fx > r.x1 + 1 || w.fy < r.y0 - 1 || w.fy > r.y1 + 1) continue;
      items.push({ d: w.fx + w.fy + 0.01, kind: 'person', w });
    }
    // visiting merchant ship (sails in, docks, sails out)
    if (G.trader) {
      items.push({ d: G.trader.x + G.trader.y, kind: 'trader', t: G.trader });
    }

    // expedition ship, visible while leaving and returning
    const ex = expeditionPos();
    if (ex) items.push({ d: ex.fx + ex.fy, kind: 'exped', fx: ex.fx, fy: ex.fy, flip: ex.flip });

    // cargo ships shuttling between the warehouse and colonies
    for (const route of cargoRoutes()) {
      const total = route.path.length - 1;
      let leg = (time * 1.5 + route.phase) % (2 * total);
      const forward = leg <= total;
      if (!forward) leg = 2 * total - leg;
      const seg = Math.min(total - 1, Math.floor(leg));
      const prog = leg - seg;
      const a = route.path[seg], n = route.path[seg + 1];
      const fx = a[0] + (n[0] - a[0]) * prog, fy = a[1] + (n[1] - a[1]) * prog;
      const dirX = ((n[0] - a[0]) - (n[1] - a[1])) * (forward ? 1 : -1);
      items.push({ d: fx + fy, kind: 'cargo', fx, fy, flip: dirX < 0 });
    }

    // pirates!
    if (G.pirate) {
      items.push({ d: G.pirate.x + G.pirate.y, kind: 'pirate', p: G.pirate });
    }

    items.sort((p, q) => p.d - q.d);

    /* ---- draw sprites ---- */
    for (const it of items) {
      if (it.kind === 'trader') {
        drawTrader(it.t, time);
        continue;
      }
      if (it.kind === 'exped') {
        drawHullRipple(it.fx, it.fy, time);
        const sp = Sprites.get('ship');
        const sx = (it.fx - it.fy) * TW2, sy = (it.fx + it.fy) * TH2;
        const bob = Math.sin(time * 1.8 + 1) * 1.4;
        ctx.save();
        ctx.translate(sx, sy - sp.oy + bob);
        if (it.flip) ctx.scale(-1, 1);
        ctx.drawImage(sp.c, -sp.w / 2, 0, sp.w, sp.h);
        ctx.restore();
        continue;
      }
      if (it.kind === 'cargo') {
        drawHullRipple(it.fx, it.fy, time);
        const sp = Sprites.get('ship');
        const sx = (it.fx - it.fy) * TW2, sy = (it.fx + it.fy) * TH2;
        const bob = Math.sin(time * 1.6 + it.fx) * 1.2;
        ctx.save();
        ctx.translate(sx, sy - sp.oy * 0.8 + bob);
        if (it.flip) ctx.scale(-1, 1);
        ctx.drawImage(sp.c, -sp.w * 0.4, 0, sp.w * 0.8, sp.h * 0.8);
        ctx.restore();
        continue;
      }
      if (it.kind === 'pirate') {
        drawHullRipple(it.p.x, it.p.y, time);
        drawPirate(it.p, time);
        continue;
      }
      if (it.kind === 'person') {
        const w = it.w;
        const px = (w.fx - w.fy) * TW2;
        const py = (w.fx + w.fy) * TH2 + TH2;
        drawPerson(px, py, {
          anim: 'walk', tint: w.tint,
          carry: w.carry ? GOOD_COLORS[w.carry] : null,
          ph: w.id * 1.31,
          // crate-shouldering figure on the delivery leg, plain walker home
          peep: w.kind === 'carrier' && w.carry ? 'peep_carrier' : 'peep_v' + (w.id % 4),
        }, time);
        continue;
      }
      const useNight = nightOn && it.b && it.b.done;
      const sp = Sprites.get(useNight ? it.key + '@n' : it.key);
      const topX = (it.x - it.y) * TW2;
      const topY = (it.x + it.y) * TH2;
      const baseY = topY + it.s * TH; // bottom vertex of footprint diamond

      if (!it.b && it.key.startsWith('tree') && cam.zoom > 0.7) {
        // wind-swayed canopy: shear around the trunk base
        const sway = Math.sin(time * 1.4 + it.x * 0.7 + it.y * 1.3) * 0.02 * (0.5 + windVal);
        ctx.save();
        ctx.translate(topX, baseY);
        ctx.transform(1, 0, sway, 1, 0, 0);
        ctx.drawImage(sp.c, -sp.w / 2, -sp.oy, sp.w, sp.h);
        ctx.restore();
      } else if (it.b && it.b.bornT != null && time - it.b.bornT < 0.6) {
        // completion pop
        const age = time - it.b.bornT;
        const k = 1 + 0.16 * Math.exp(-4 * age) * Math.sin(12 * age);
        ctx.save();
        ctx.translate(topX, baseY);
        ctx.scale(k, k);
        ctx.drawImage(sp.c, -sp.w / 2, -sp.oy, sp.w, sp.h);
        ctx.restore();
      } else {
        ctx.drawImage(sp.c, topX - sp.w / 2, baseY - sp.oy, sp.w, sp.h);
      }

      if (useNight && sp.lights && sp.lights.length) {
        for (const l of sp.lights) {
          glows.push([topX - sp.w / 2 + l[0], baseY - sp.oy + l[1]]);
        }
      }

      if (it.b) {
        const b = it.b;
        if (b.done && sp.chimney && b.fire == null) drawSmoke(topX, baseY, sp, b, time);
        if (b.fire != null) drawFlames(topX, topY, it.s, b, time);
        else drawWorkers(b, it, topX, topY, time);
        if (!b.done) { // construction progress bar
          const p = Math.min(1, b.progress / BUILDINGS[b.key].buildTime);
          const bw = 30;
          ctx.fillStyle = 'rgba(20,14,8,0.7)';
          ctx.fillRect(topX - bw / 2, baseY - sp.oy - 8, bw, 5);
          ctx.fillStyle = '#ffd75e';
          ctx.fillRect(topX - bw / 2 + 1, baseY - sp.oy - 7, (bw - 2) * p, 3);
        } else if (b.status !== 'ok' && b.status !== 'build') {
          drawBadge(topX, baseY - sp.oy - 4, b.status, time);
        }
        if (G.selected === b.id) drawSelection(b, time);
      }
    }

    drawShots(time);
    drawParticles(dtF);
    drawFloats(dtF);
    drawAmbience(time, night, r);

    /* ---- night & dusk tint (screen space) ---- */
    if (night > 0.01 || dusk > 0.01) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (night > 0.01) {
        ctx.fillStyle = `rgba(13,20,56,${(0.55 * night).toFixed(3)})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      if (dusk > 0.01) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255,120,45,${(0.10 * dusk).toFixed(3)})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, (cam.x + shx) * dpr, (cam.y + shy) * dpr);

      // starlight on open water + warm window glows, above the tint
      if (night > 0.05) {
        if (!ambient) buildAmbientSpots();
        ctx.globalCompositeOperation = 'lighter';
        for (const s of ambient.stars) {
          if (s.x < r.x0 || s.x > r.x1 || s.y < r.y0 || s.y > r.y1) continue;
          const tw = 0.4 + 0.6 * Math.sin(time * 2 + s.h * 90);
          ctx.fillStyle = `rgba(235,240,255,${(0.55 * night * tw).toFixed(3)})`;
          const sx = (s.x - s.y) * TW2 + (s.h * 40) % TW2 - TH2, sy = (s.x + s.y) * TH2 + (s.h * 90) % TH2;
          ctx.fillRect(sx, sy, 1.6, 1.4);
        }
        const warm = glowSprite('rgba(255,195,95,0.55)');
        ctx.globalAlpha = night;
        for (const gpt of glows) {
          ctx.drawImage(warm, gpt[0] - 10, gpt[1] - 10, 20, 20);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    /* ---- rain & lightning (screen space) ---- */
    if (stormEase > 0 || flash > 0.01) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawWeather();
      ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, (cam.x + shx) * dpr, (cam.y + shy) * dpr);
    }

    /* ---- ghost ---- */
    if (ghost.active) drawGhost();

    drawMinimap();
  }

  /* ---------------- pirates, cannons, fire ---------------- */

  function drawPirate(p, time) {
    const sp = Sprites.get('pirateship');
    const sx = (p.x - p.y) * TW2, sy = (p.x + p.y) * TH2;
    let sink = 0, alpha = 1;
    if (p.state === 'sinking') {
      const k = 1 - p.timer / 2.5;
      sink = k * 26;
      alpha = 1 - k;
    }
    const bob = Math.sin(time * 1.8 + 2) * 1.5;
    // direction of travel
    let flip = false;
    if (p.path && p.seg < p.path.length - 1) {
      const a = p.path[p.seg], n = p.path[p.seg + 1];
      flip = ((n[0] - a[0]) - (n[1] - a[1])) < 0;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(sx, sy - sp.oy + bob + sink);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(sp.c, -sp.w / 2, 0, sp.w, sp.h);
    ctx.restore();
    ctx.globalAlpha = 1;
    // hp bar while under fire
    if (p.hp < p.maxHp && p.state !== 'sinking') {
      const bw = 26;
      ctx.fillStyle = 'rgba(20,14,8,0.7)';
      ctx.fillRect(sx - bw / 2, sy - sp.oy - 8 + bob, bw, 4);
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(sx - bw / 2 + 1, sy - sp.oy - 7 + bob, (bw - 2) * Math.max(0, p.hp / p.maxHp), 2);
    }
    if (p.state === 'sinking') { // bubbles & flotsam
      for (let i = 0; i < 3; i++) {
        const ph = (time * 0.8 + i * 0.4) % 1;
        ctx.fillStyle = `rgba(235,248,255,${(0.5 - ph * 0.4).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(sx - 8 + i * 8, sy + TH2 - ph * 6, 1.6 + ph * 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawShots(time) {
    for (const s of G.shots) {
      const x0 = (s.x0 - s.y0) * TW2, y0 = (s.x0 + s.y0) * TH2 - 42; // tower muzzle
      const x1 = (s.x1 - s.y1) * TW2, y1 = (s.x1 + s.y1) * TH2 - 8;
      const k = Math.min(1, s.t / 0.45);
      if (k < 1) { // ball in flight with an arc
        const bx = x0 + (x1 - x0) * k;
        const by = y0 + (y1 - y0) * k - Math.sin(k * Math.PI) * 22;
        ctx.fillStyle = '#26262a';
        ctx.beginPath(); ctx.arc(bx, by, 2.4, 0, Math.PI * 2); ctx.fill();
        // muzzle flash
        if (s.t < 0.12) {
          ctx.fillStyle = `rgba(255,200,90,${(0.8 - s.t * 6).toFixed(3)})`;
          ctx.beginPath(); ctx.arc(x0, y0, 5 - s.t * 20, 0, Math.PI * 2); ctx.fill();
        }
      } else { // splash
        const sk = (s.t - 0.45) / 0.35;
        ctx.strokeStyle = `rgba(235,248,255,${(0.7 - sk * 0.7).toFixed(3)})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.ellipse(x1, y1 + 8, 4 + sk * 9, 2 + sk * 4, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  function drawFlames(topX, topY, s, b, time) {
    const cy = topY + s * TH2;
    for (let i = 0; i < 4; i++) {
      const fx = topX + Math.sin(i * 2.4 + b.id) * s * 12;
      const fy = cy + Math.cos(i * 1.7) * s * 5;
      const flick = 0.7 + 0.3 * Math.sin(time * 11 + i * 2.3);
      const h = (10 + i * 3) * flick;
      const grad = ctx.createLinearGradient(fx, fy, fx, fy - h);
      grad.addColorStop(0, 'rgba(255,120,20,0.85)');
      grad.addColorStop(0.6, 'rgba(255,200,60,0.8)');
      grad.addColorStop(1, 'rgba(255,240,160,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(fx - 4 * flick, fy);
      ctx.quadraticCurveTo(fx - 1, fy - h * 0.5, fx, fy - h);
      ctx.quadraticCurveTo(fx + 1, fy - h * 0.5, fx + 4 * flick, fy);
      ctx.closePath();
      ctx.fill();
    }
    // black smoke
    for (let i = 0; i < 3; i++) {
      const ph = (time * 0.5 + i * 0.33 + b.id * 0.1) % 1;
      ctx.fillStyle = `rgba(40,36,32,${((1 - ph) * 0.45).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(topX + Math.sin(ph * 6 + b.id) * 4, cy - 20 - ph * 24, 3 + ph * 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* cargo routes between warehouse and kontors (cached water paths) */
  let cargoCache = { key: '', routes: [] };

  function nearestWaterTo(b) {
    const def = BUILDINGS[b.key];
    const cx = Math.round(b.x + (def.size - 1) / 2), cy = Math.round(b.y + (def.size - 1) / 2);
    for (let r = 1; r <= 7; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx, y = cy + dy;
          if (inBounds(x, y) && isWaterTile(G.tiles[idx(x, y)])) return idx(x, y);
        }
      }
    }
    return null;
  }

  function cargoRoutes() {
    const kontors = G.buildings.filter(b => b.key === 'kontor' && b.done);
    const key = kontors.map(k => k.id).join(',');
    if (cargoCache.key === key) return cargoCache.routes;
    cargoCache = { key, routes: [] };
    const wh = G.buildings.find(b => b.key === 'warehouse');
    if (!wh) return cargoCache.routes;
    const whDock = nearestWaterTo(wh);
    if (whDock == null) return cargoCache.routes;
    for (const k of kontors) {
      const kd = nearestWaterTo(k);
      if (kd == null) continue;
      const path = waterPath(whDock, i => i === kd);
      if (path && path.length > 3) cargoCache.routes.push({ path, phase: k.id * 13 });
    }
    return cargoCache.routes;
  }

  /* Cloud shadows, gull flocks, jumping fish, rowboats, fireflies,
   * butterflies — the island breathes. */
  function gullAt(gx, gy, time, i) {
    const flap = Math.sin(time * 7 + i * 3) * 2.6;
    ctx.strokeStyle = 'rgba(246,249,251,0.92)';
    ctx.lineWidth = 1.4; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(gx - 4.5, gy);
    ctx.quadraticCurveTo(gx - 2, gy - flap, gx, gy);
    ctx.quadraticCurveTo(gx + 2, gy - flap, gx + 4.5, gy);
    ctx.stroke();
  }

  function drawAmbience(time, night, r) {
    if (!ambient) buildAmbientSpots();

    // cloud shadows — more and darker in a storm, faster with the wind
    const span = (MAPW + MAPH) * TW2 + 1200;
    const clouds = 3 + Math.round(3 * stormEase);
    for (let i = 0; i < clouds; i++) {
      const cx = ((time * (7 + i * 3) * (1 + windVal) + i * 1733) % span) - span / 2;
      const cy = MAPH * TH2 * (0.55 + 0.35 * Math.sin(i * 2.1)) + Math.sin(time * 0.08 + i * 2) * 90;
      ctx.fillStyle = `rgba(14,28,50,${(0.07 + 0.1 * stormEase).toFixed(3)})`;
      ctx.beginPath(); ctx.ellipse(cx, cy, 210, 95, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx + 130, cy + 35, 150, 65, 0, 0, Math.PI * 2); ctx.fill();
    }

    const day = 1 - night;

    // gull flocks over living anchors: fishers, the warehouse, a docked trader
    if (day > 0.2 && stormEase < 0.5) {
      const anchors = [];
      const wh = G.buildings.find(b => b.key === 'warehouse');
      if (wh) anchors.push([wh.x + 1, wh.y + 1]);
      for (const b of G.buildings) {
        if (b.key === 'fisher' && b.done && anchors.length < 4) anchors.push([b.x, b.y]);
      }
      if (G.trader) anchors.push([G.trader.x, G.trader.y]);
      let gi = 0;
      for (const [ax, ay] of anchors) {
        for (let k = 0; k < 2 && gi < 12; k++, gi++) {
          const a = time * (0.25 + gi * 0.03) + gi * 2.2;
          const tx = ax + Math.cos(a) * (1.6 + k);
          const ty = ay + Math.sin(a * 1.3) * (1.4 + k * 0.8);
          if (tx < r.x0 || tx > r.x1 || ty < r.y0 || ty > r.y1) continue;
          gullAt((tx - ty) * TW2, (tx + ty) * TH2 - 66 - k * 14, time, gi);
        }
      }
    }

    // jumping fish along the shoreline
    for (const s of ambient.fish) {
      if (s.x < r.x0 || s.x > r.x1 || s.y < r.y0 || s.y > r.y1) continue;
      const T = 7 + s.h * 9;
      const ph = (time + s.h * 100) % T;
      if (ph > 0.55) continue;
      const k = ph / 0.55;
      const sx = (s.x - s.y) * TW2, sy = (s.x + s.y) * TH2 + TH2;
      const arcY = -Math.sin(k * Math.PI) * 10;
      ctx.strokeStyle = 'rgba(210,225,235,0.85)';
      ctx.lineWidth = 1.8; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx - 3 + k * 6, sy + arcY);
      ctx.quadraticCurveTo(sx - 1 + k * 6, sy + arcY - 2.4, sx + 1.5 + k * 6, sy + arcY - 0.6);
      ctx.stroke();
      ctx.strokeStyle = `rgba(235,248,255,${(0.5 * (1 - k)).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(sx, sy + 1, 2 + k * 8, 1 + k * 3, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // rowboats bobbing off every working fisher's hut
    for (const b of G.buildings) {
      if (b.key !== 'fisher' || !b.done) continue;
      if (b.x < r.x0 - 3 || b.x > r.x1 + 3 || b.y < r.y0 - 3 || b.y > r.y1 + 3) continue;
      if (!boatSpots[b.id]) {
        const w = nearestWaterTo(b);
        boatSpots[b.id] = w == null ? -1 : w;
      }
      const w = boatSpots[b.id];
      if (w === -1) continue;
      const bx = w % MAPW, by = (w - bx) / MAPW;
      const drift = Math.sin(time * 0.14 + b.id) * 0.5;
      const sp = Sprites.get('boat');
      const sx = (bx - by + drift) * TW2, sy = (bx + by) * TH2 + TH2;
      const bob = Math.sin(time * 1.6 + b.id * 2) * 1;
      ctx.save();
      ctx.translate(sx, sy - sp.oy + bob);
      if (b.id % 2) ctx.scale(-1, 1);
      ctx.drawImage(sp.c, -sp.w / 2, 0, sp.w, sp.h);
      ctx.restore();
    }

    // fireflies in forest glades at night…
    if (night > 0.5) {
      ctx.globalCompositeOperation = 'lighter';
      const green = glowSprite('rgba(216,255,160,0.9)');
      for (const s of ambient.glade) {
        if (s.x < r.x0 || s.x > r.x1 || s.y < r.y0 || s.y > r.y1) continue;
        for (let i = 0; i < 2; i++) {
          const fx2 = s.x + Math.sin(time * 0.5 + s.h * 9 + i * 3) * 0.9;
          const fy2 = s.y + Math.cos(time * 0.37 + s.h * 7 + i * 1.7) * 0.7;
          const px = (fx2 - fy2) * TW2, py = (fx2 + fy2) * TH2 + TH2 - 8 - 3 * i;
          const a = (0.35 + 0.45 * Math.sin(time * 3 + i * 2 + s.h * 40)) * night;
          if (a <= 0.05) continue;
          ctx.globalAlpha = a;
          ctx.drawImage(green, px - 4, py - 4, 8, 8);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    } else if (day > 0.6 && stormEase < 0.3) {
      // …butterflies there by day
      for (const s of ambient.glade) {
        if (s.x < r.x0 || s.x > r.x1 || s.y < r.y0 || s.y > r.y1) continue;
        const fx2 = s.x + Math.sin(time * 0.4 + s.h * 20) * 1.1;
        const fy2 = s.y + Math.cos(time * 0.31 + s.h * 13) * 0.9;
        const px = (fx2 - fy2) * TW2, py = (fx2 + fy2) * TH2 + TH2 - 9 + Math.sin(time * 2.2 + s.h * 30) * 2;
        const wing = Math.abs(Math.sin(time * 10 + s.h * 50));
        ctx.fillStyle = s.h < 0.11 ? '#e8b73c' : '#d8dcf0';
        ctx.beginPath();
        ctx.ellipse(px - 1 * wing, py, 1.5 * wing + 0.3, 1, 0.4, 0, Math.PI * 2);
        ctx.ellipse(px + 1 * wing, py, 1.5 * wing + 0.3, 1, -0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const boatSpots = {}; // fisher id -> cached water tile (or -1)

  // breathing wake ellipse under any ship on the water
  function drawHullRipple(fx, fy, time) {
    const sx = (fx - fy) * TW2, sy = (fx + fy) * TH2;
    const k = 0.7 + 0.3 * Math.sin(time * 1.9 + fx);
    ctx.strokeStyle = `rgba(235,248,255,${(0.28 * k).toFixed(3)})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(sx, sy + TH2 * 0.6, 13 * k + 4, 5 * k + 1.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawTrader(t, time) {
    drawHullRipple(t.x, t.y, time);
    const sp = Sprites.get('ship');
    const sx = (t.x - t.y) * TW2, sy = (t.x + t.y) * TH2;
    const bob = Math.sin(time * 1.7 + 0.6) * 1.4;
    let flip = false;
    if (t.path && t.seg < t.path.length - 1) {
      const a = t.path[t.seg], n = t.path[t.seg + 1];
      flip = ((n[0] - a[0]) - (n[1] - a[1])) < 0;
    }
    ctx.save();
    ctx.translate(sx, sy - sp.oy + bob);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(sp.c, -sp.w / 2, 0, sp.w, sp.h);
    ctx.restore();
    if (t.state === 'docked') { // golden "deals!" pennant
      const puls = 0.7 + 0.3 * Math.sin(time * 5);
      ctx.fillStyle = `rgba(255,215,94,${puls.toFixed(3)})`;
      ctx.font = 'bold 12px Georgia, serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('⚖', sx, sy - sp.oy - 8 + bob);
    }
  }

  /* Expedition ship: visible sailing out (first leg) and home (last leg). */
  let expCache = null;

  function expeditionPos() {
    const e = G.expedition;
    if (!e) { expCache = null; return null; }
    const LEG = 12; // seconds of visible sailing each way
    let frac = null, flip = false;
    if (e.t < LEG) frac = e.t / LEG;
    else if (e.dur - e.t < LEG) { frac = (e.dur - e.t) / LEG; flip = true; }
    if (frac == null) return null;
    if (!expCache) {
      const wh = G.buildings.find(b => b.key === 'warehouse');
      const dock = wh && nearestWaterTo(wh);
      if (dock == null) return null;
      expCache = waterPath(dock, i => {
        const x = i % MAPW, y = (i - x) / MAPW;
        return x === 0 || y === 0 || x === MAPW - 1 || y === MAPH - 1;
      });
      if (!expCache || expCache.length < 2) { expCache = null; return null; }
      expCache.reverse(); // waterPath is goal-first; we sail dock → edge
    }
    const p = expCache;
    const pos = frac * (p.length - 1);
    const seg = Math.min(p.length - 2, Math.floor(pos));
    const k = pos - seg;
    const a = p[seg], n = p[seg + 1];
    const dirX = ((n[0] - a[0]) - (n[1] - a[1])) * (flip ? -1 : 1);
    return {
      fx: a[0] + (n[0] - a[0]) * k,
      fy: a[1] + (n[1] - a[1]) * k,
      flip: dirX < 0,
    };
  }

  function drawSmoke(topX, baseY, sp, b, time) {
    const px = topX - sp.w / 2 + sp.chimney[0];
    const py = baseY - sp.oy + sp.chimney[1];
    for (let i = 0; i < 3; i++) {
      const ph = (time * 0.3 + i * 0.33 + (b.id % 7) * 0.137) % 1;
      const a = (1 - ph) * 0.3;
      ctx.fillStyle = `rgba(228,228,225,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px + Math.sin((ph * 5 + b.id) * 1.7) * 2.5 + ph * (3 + windVal * 14), py - ph * 17, 1.6 + ph * 3.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------------- people ---------------- */

  // Tiny animated figure. anim: walk | idle | chop | hammer | bend
  // which raster figure plays which role
  const PEEP_FOR_ANIM = { chop: 'peep_chop', hammer: 'peep_hammer', bend: 'peep_bend', idle: 'peep_idle' };

  function drawPerson(px, py, o, time) {
    // AI raster figure, animated with bob/lean/swing transforms
    if (typeof Assets !== 'undefined') {
      const sp = Assets.get(o.peep || PEEP_FOR_ANIM[o.anim] || 'peep_v0');
      if (sp) { drawRasterPerson(sp, px, py, o, time); return; }
    }
    const t = time * (o.anim === 'walk' ? 9 : 5.5) + (o.ph || 0) * 3;
    let bob = 0, lean = 0;
    // shadow
    ctx.fillStyle = 'rgba(15,25,10,0.25)';
    ctx.beginPath(); ctx.ellipse(px, py + 0.3, 2.4, 1, 0, 0, Math.PI * 2); ctx.fill();
    // legs
    ctx.strokeStyle = '#42384c'; ctx.lineWidth = 1.1; ctx.lineCap = 'round';
    ctx.beginPath();
    if (o.anim === 'walk') {
      const s = Math.sin(t);
      bob = Math.abs(Math.cos(t)) * 0.5;
      ctx.moveTo(px, py - 3); ctx.lineTo(px + s * 1.5, py);
      ctx.moveTo(px, py - 3); ctx.lineTo(px - s * 1.5, py);
    } else {
      ctx.moveTo(px - 0.4, py - 3); ctx.lineTo(px - 0.9, py);
      ctx.moveTo(px + 0.4, py - 3); ctx.lineTo(px + 0.9, py);
    }
    ctx.stroke();
    if (o.anim === 'bend') lean = (Math.sin(t * 0.7) + 1) * 0.5; // 0..1 harvest bow
    if (o.anim === 'idle') bob = Math.sin(t * 0.5) * 0.35;
    const nx = px + lean * 2.4, ny = py - 6.4 + bob + lean * 2.2; // neck
    // body
    ctx.strokeStyle = o.tint; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(px, py - 2.6); ctx.lineTo(nx, ny); ctx.stroke();
    // working arm with tool
    if (o.anim === 'chop' || o.anim === 'hammer') {
      const swing = Math.sin(t);
      const ang = -2.3 + (swing + 1) * (o.anim === 'chop' ? 0.95 : 0.8);
      const ax = nx + Math.cos(ang) * 3.6, ay = ny + 1 + Math.sin(ang) * 3.6;
      ctx.strokeStyle = '#e8b88a'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(nx, ny + 1); ctx.lineTo(ax, ay); ctx.stroke();
      ctx.fillStyle = o.anim === 'chop' ? '#b8bcc0' : '#5a5a64';
      ctx.fillRect(ax - 1.1, ay - 1.1, 2.2, 2.2);
    }
    // head + hair
    ctx.fillStyle = '#e8b88a';
    ctx.beginPath(); ctx.arc(nx, ny - 1.6, 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(72,46,26,0.95)';
    ctx.beginPath(); ctx.arc(nx, ny - 2, 1.6, Math.PI, 0); ctx.fill();
    // bundle carried on the shoulders
    if (o.carry) {
      ctx.fillStyle = o.carry;
      ctx.fillRect(px - 1.8, py - 10.2 + bob, 3.6, 2.6);
      ctx.strokeStyle = 'rgba(40,26,12,0.6)'; ctx.lineWidth = 0.7;
      ctx.strokeRect(px - 1.8, py - 10.2 + bob, 3.6, 2.6);
    }
  }

  function drawRasterPerson(sp, px, py, o, time) {
    const t = time * (o.anim === 'walk' ? 9 : 5.5) + (o.ph || 0) * 3;
    ctx.fillStyle = 'rgba(15,25,10,0.28)';
    ctx.beginPath(); ctx.ellipse(px, py + 0.3, 3, 1.2, 0, 0, Math.PI * 2); ctx.fill();
    let bob = 0, rot = 0;
    if (o.anim === 'walk') { bob = Math.abs(Math.sin(t)) * 0.9; rot = Math.sin(t) * 0.055; }
    else if (o.anim === 'idle') { bob = Math.sin(t * 0.5) * 0.4; }
    else if (o.anim === 'chop' || o.anim === 'hammer') { rot = -0.12 + (Math.sin(t) + 1) * 0.14; }
    else if (o.anim === 'bend') { rot = (Math.sin(t * 0.7) + 1) * 0.16; }
    ctx.save();
    ctx.translate(px, py - bob); // pivot at the feet so leaning reads naturally
    ctx.rotate(rot);
    ctx.drawImage(sp.c, -sp.w / 2, -sp.h, sp.w, sp.h);
    ctx.restore();
    if (o.carry) { // the hauled good, colour-coded as before
      ctx.fillStyle = o.carry;
      ctx.fillRect(px - 1.9, py - sp.h - 1.6 + bob, 3.8, 2.8);
      ctx.strokeStyle = 'rgba(40,26,12,0.6)'; ctx.lineWidth = 0.7;
      ctx.strokeRect(px - 1.9, py - sp.h - 1.6 + bob, 3.8, 2.8);
    }
  }

  // Where staff stand & what they do, per building type.
  const WORK_SPOTS = {
    woodcutter: [{ du: 0.16, dv: 0.52, anim: 'chop' }],
    fisher:     [{ du: -0.05, dv: 0.58, anim: 'idle' }],
    hunter:     [{ du: -0.35, dv: 0.5, anim: 'idle' }],
    sheep:      [{ du: 0.08, dv: 0.34, anim: 'bend' }],
    weaver:     [{ du: 0.3, dv: 0.52, anim: 'idle' }],
    mine:       [{ du: -0.22, dv: 0.45, anim: 'hammer' }],
    toolmaker:  [{ du: 0.48, dv: 0.38, anim: 'hammer' }],
    potato:     [{ du: -0.3, dv: 0.3, anim: 'bend' }, { du: 0.2, dv: -0.05, anim: 'bend', ph: 2.1 }],
    spice:      [{ du: -0.3, dv: 0.32, anim: 'bend' }, { du: 0.22, dv: -0.05, anim: 'bend', ph: 1.8 }],
    grain:      [{ du: -0.3, dv: 0.35, anim: 'bend' }, { du: 0.25, dv: 0, anim: 'bend', ph: 1.4 }],
    bakery:     [{ du: 0.42, dv: 0.4, anim: 'idle' }],
    distillery: [{ du: -0.38, dv: 0.48, anim: 'idle' }],
    market:     [{ du: -0.55, dv: 0.15, anim: 'idle' }, { du: 0.35, dv: 0.62, anim: 'idle', ph: 1.6 }],
    warehouse:  [{ du: 0.78, dv: 0.32, anim: 'idle' }],
    kontor:     [{ du: -0.6, dv: 0.55, anim: 'idle' }],
    watchtower: [{ du: 0.3, dv: 0.35, anim: 'idle', tint: '#5a5a64' }],
    firehouse:  [{ du: 0.35, dv: 0.72, anim: 'idle', tint: '#b8463a' }],
    chapel:     [{ du: 0.62, dv: 0.58, anim: 'idle', tint: '#4a3a2c' }],
    tavern:     [{ du: 0.08, dv: 0.8, anim: 'idle' }],
    depot:      [{ du: 0.62, dv: 0.42, anim: 'idle' }],
  };
  const WORK_TINTS = {
    woodcutter: '#5d7a36', fisher: '#3a6ea8', hunter: '#46582a', sheep: '#8a6a3c',
    weaver: '#8a4a78', mine: '#5a5a64', toolmaker: '#6a4a3a', potato: '#b8862a',
    distillery: '#6d3a2a', market: '#a84a3c', warehouse: '#7a5c3a', chapel: '#4a3a2c',
    tavern: '#3a6ea8', depot: '#7a5c3a', grain: '#b8862a', bakery: '#e2d3b4',
    kontor: '#3a6ea8', watchtower: '#5a5a64', firehouse: '#b8463a', spice: '#c83c2a',
  };

  function drawWorkers(b, it, topX, topY, time) {
    const def = BUILDINGS[b.key];
    let spots;
    if (!b.done) {
      // construction crew hammering on the plot
      const e = def.size / 2 - 0.2;
      spots = [
        { du: -e, dv: e * 0.6, anim: 'hammer', tint: '#b8862a' },
        { du: e * 0.7, dv: -e * 0.4, anim: 'hammer', tint: '#a84a3c', ph: 1.3 },
      ];
    } else if (def.prod) {
      if (b.status !== 'ok') return; // nobody works at a stalled site
      spots = WORK_SPOTS[b.key];
    } else {
      if (!b.connected) return;
      spots = WORK_SPOTS[b.key];
    }
    if (!spots) return;
    for (const sp2 of spots) {
      const px = topX + (sp2.du - sp2.dv) * TW2;
      const py = topY + it.s * TH2 + (sp2.du + sp2.dv) * TH2;
      drawPerson(px, py, {
        anim: sp2.anim,
        tint: sp2.tint || WORK_TINTS[b.key] || '#7a5c3a',
        ph: (sp2.ph || 0) + b.id * 1.7,
      }, time);
    }
  }

  const BADGE_COLORS = {
    noroad: '#c0392b', nocond: '#d87b1e', noinput: '#c8a300',
    full: '#2e6da4', needs: '#c0392b', storm: '#5b7a96',
  };
  const BADGE_GLYPHS = { fire: '🔥', sick: '🤒' };

  function drawBadge(x, y, status, time) {
    const bobY = y + Math.sin(time * 4) * 1.5;
    if (BADGE_GLYPHS[status]) {
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(BADGE_GLYPHS[status], x, bobY);
      return;
    }
    ctx.fillStyle = BADGE_COLORS[status] || '#c0392b';
    ctx.beginPath(); ctx.arc(x, bobY, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('!', x, bobY + 0.5);
  }

  function drawSelection(b, time) {
    const def = BUILDINGS[b.key];
    const s = def.size;
    const sx = (b.x - b.y) * TW2, sy = (b.x + b.y) * TH2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + s * TW2, sy + s * TH2);
    ctx.lineTo(sx, sy + s * TH);
    ctx.lineTo(sx - s * TW2, sy + s * TH2);
    ctx.closePath();
    ctx.strokeStyle = '#ffd75e';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = -time * 16;
    ctx.stroke();
    ctx.setLineDash([]);
    // service / build-area / attack radius of the selected building
    const rr = def.radius || def.zone || def.range;
    if (rr && b.done) {
      const ccx = b.x + (s - 1) / 2, ccy = b.y + (s - 1) / 2;
      const csx = (ccx - ccy) * TW2, csy = (ccx + ccy) * TH2 + TH2;
      ctx.beginPath();
      ctx.ellipse(csx, csy, rr * TW2 * 1.02, rr * TH2 * 1.02, 0, 0, Math.PI * 2);
      ctx.strokeStyle = def.range ? 'rgba(255,90,60,0.7)'
        : def.radius ? 'rgba(255,215,94,0.7)' : 'rgba(120,220,255,0.6)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawGhost() {
    const { key, x, y, ok, mode } = ghost;
    if (mode === 'demolish') {
      const b = inBounds(x, y) ? G.grid[idx(x, y)] : null;
      const s = b ? BUILDINGS[b.key].size : 1;
      const gx = b ? b.x : x, gy = b ? b.y : y;
      const sx = (gx - gy) * TW2, sy = (gx + gy) * TH2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + s * TW2, sy + s * TH2);
      ctx.lineTo(sx, sy + s * TH);
      ctx.lineTo(sx - s * TW2, sy + s * TH2);
      ctx.closePath();
      ctx.fillStyle = 'rgba(200,40,30,0.4)';
      ctx.fill();
      return;
    }
    const def = mode === 'road' ? { size: 1 } : BUILDINGS[key];
    if (!def) return;
    const s = def.size;
    const sx = (x - y) * TW2, sy = (x + y) * TH2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + s * TW2, sy + s * TH2);
    ctx.lineTo(sx, sy + s * TH);
    ctx.lineTo(sx - s * TW2, sy + s * TH2);
    ctx.closePath();
    ctx.fillStyle = ok ? 'rgba(80,220,90,0.35)' : 'rgba(220,60,40,0.4)';
    ctx.fill();
    ctx.strokeStyle = ok ? 'rgba(40,160,50,0.9)' : 'rgba(180,30,20,0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (mode === 'build') {
      const sp = Sprites.get(key === 'house' ? 'house0:0' : key);
      ctx.globalAlpha = 0.65;
      ctx.drawImage(sp.c, sx - sp.w / 2, sy + s * TH - sp.oy, sp.w, sp.h);
      ctx.globalAlpha = 1;
      // service / zone radius preview
      const bdef = BUILDINGS[key];
      const rr = bdef.radius || bdef.zone || bdef.range;
      if (rr) {
        const ccx = x + (s - 1) / 2, ccy = y + (s - 1) / 2;
        const csx = (ccx - ccy) * TW2, csy = (ccx + ccy) * TH2 + TH2;
        ctx.beginPath();
        ctx.ellipse(csx, csy, rr * TW2 * 1.02, rr * TH2 * 1.02, 0, 0, Math.PI * 2);
        ctx.strokeStyle = bdef.range ? 'rgba(255,90,60,0.8)'
          : bdef.radius ? 'rgba(255,215,94,0.8)' : 'rgba(120,220,255,0.7)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  /* ---------------- minimap ---------------- */

  function rebuildMinimapBase() {
    const W = mmCanvas.width, H = mmCanvas.height;
    mmBase = document.createElement('canvas');
    mmBase.width = W; mmBase.height = H;
    const c = mmBase.getContext('2d');
    const sxr = W / MAPW, syr = H / MAPH;
    const cols = ['#16384f', '#2e6d92', '#d9c27e', '#69a244', '#3e6b2f', '#8a8a85'];
    for (let y = 0; y < MAPH; y++) {
      for (let x = 0; x < MAPW; x++) {
        c.fillStyle = cols[G.tiles[idx(x, y)]];
        c.fillRect(Math.floor(x * sxr), Math.floor(y * syr), Math.ceil(sxr), Math.ceil(syr));
      }
    }
    mmDirty = false;
  }

  let mmFrame = 0;
  function drawMinimap() {
    if (mmDirty || !mmBase || (++mmFrame % 120 === 0)) rebuildMinimapBase();
    const W = mmCanvas.width, H = mmCanvas.height;
    mmCtx.clearRect(0, 0, W, H);
    mmCtx.drawImage(mmBase, 0, 0);
    const sxr = W / MAPW, syr = H / MAPH;
    for (const b of G.buildings) {
      const def = BUILDINGS[b.key];
      mmCtx.fillStyle = b.key === 'house' ? '#e8e0c8'
        : (b.key === 'warehouse' || b.key === 'kontor') ? '#ffd75e' : '#c0703a';
      mmCtx.fillRect(b.x * sxr - 0.5, b.y * syr - 0.5, Math.max(2, def.size * sxr), Math.max(2, def.size * syr));
    }
    if (G.pirate && G.pirate.state !== 'sinking') { // pirate blip
      mmCtx.fillStyle = '#ff2d1e';
      mmCtx.beginPath();
      mmCtx.arc(G.pirate.x * sxr, G.pirate.y * syr, 2.5, 0, Math.PI * 2);
      mmCtx.fill();
    }
    if (G.trader) { // merchant blip, brighter while docked
      mmCtx.fillStyle = G.trader.state === 'docked' ? '#ffd75e' : 'rgba(255,215,94,0.6)';
      mmCtx.beginPath();
      mmCtx.arc(G.trader.x * sxr, G.trader.y * syr, 2.2, 0, Math.PI * 2);
      mmCtx.fill();
    }
    // pulsing pings over burning buildings
    const now = performance.now() / 1000;
    for (const b of G.buildings) {
      if (b.fire == null) continue;
      const k = (now * 1.6) % 1;
      mmCtx.strokeStyle = `rgba(255,60,30,${(0.9 - k * 0.9).toFixed(3)})`;
      mmCtx.lineWidth = 1.4;
      mmCtx.beginPath();
      mmCtx.arc(b.x * sxr, b.y * syr, 2 + k * 5, 0, Math.PI * 2);
      mmCtx.stroke();
    }
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const cs = [
      screenToTile(0, 0), screenToTile(w, 0),
      screenToTile(w, h), screenToTile(0, h),
    ];
    mmCtx.beginPath();
    mmCtx.moveTo(cs[0].fx * sxr, cs[0].fy * syr);
    for (let i = 1; i < 4; i++) mmCtx.lineTo(cs[i].fx * sxr, cs[i].fy * syr);
    mmCtx.closePath();
    mmCtx.strokeStyle = 'rgba(255,255,255,0.85)';
    mmCtx.lineWidth = 1.2;
    mmCtx.stroke();
  }

  function minimapToTile(mx, my) {
    return {
      x: Math.floor(mx / (mmCanvas.width / MAPW)),
      y: Math.floor(my / (mmCanvas.height / MAPH)),
    };
  }

  window.addEventListener('resize', resize);
  resize();

  return {
    cam, camT, camVel, ghost, canvas,
    draw, resize, screenToTile, centerOn, zoomAt,
    updateCamera, flyTo, nightFactor,
    fx: fxBurst,
    setLightningHook: fn => { onLightning = fn; },
    stormLevel: () => stormEase,
    rebuildGroundCache, minimapToTile, mmCanvas,
    markMapDirty: () => { mmDirty = true; },
  };
})();
