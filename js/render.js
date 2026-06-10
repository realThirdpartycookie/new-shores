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
  }

  function zoomAt(mx, my, factor) {
    const before = cam.zoom;
    cam.zoom = Math.max(0.45, Math.min(2.2, cam.zoom * factor));
    const k = cam.zoom / before;
    cam.x = mx - (mx - cam.x) * k;
    cam.y = my - (my - cam.y) * k;
  }

  // Terrain look is baked into tile sprites; this just refreshes the minimap.
  function rebuildGroundCache() { mmDirty = true; }

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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d2a40';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(cam.zoom * dpr, 0, 0, cam.zoom * dpr, cam.x * dpr, cam.y * dpr);

    const r = visibleRange();
    const PAD = Sprites.TILE_PAD;

    /* ---- ground pass: textured diamond tiles ---- */
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = idx(x, y);
        const t = G.tiles[i];
        const sx = (x - y) * TW2, sy = (x + y) * TH2;
        const ts = Sprites.getTile(t, Math.floor(tileHash(x, y) * 8));
        ctx.drawImage(ts.c, sx - TW2 - PAD, sy - PAD, ts.w, ts.h);

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
    // trading ship circling the archipelago
    const sa = time * 0.045;
    const RX = MAPW * 0.47, RY = MAPH * 0.44;
    const shipX = MAPW / 2 + Math.cos(sa) * RX;
    const shipY = MAPH / 2 + Math.sin(sa) * RY;
    items.push({ d: shipX + shipY, kind: 'ship', fx: shipX, fy: shipY, a: sa });

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
      if (it.kind === 'ship') {
        drawShip(it, time, RX, RY);
        continue;
      }
      if (it.kind === 'cargo') {
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
        }, time);
        continue;
      }
      const sp = Sprites.get(it.key);
      const topX = (it.x - it.y) * TW2;
      const topY = (it.x + it.y) * TH2;
      const baseY = topY + it.s * TH; // bottom vertex of footprint diamond
      ctx.drawImage(sp.c, topX - sp.w / 2, baseY - sp.oy, sp.w, sp.h);

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
    drawAmbience(time);

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

  /* Drifting cloud shadows + circling gulls. */
  function drawAmbience(time) {
    const span = (MAPW + MAPH) * TW2 + 1200;
    for (let i = 0; i < 3; i++) {
      const cx = ((time * (7 + i * 3) + i * 1733) % span) - span / 2;
      const cy = MAPH * TH2 * (0.55 + 0.35 * Math.sin(i * 2.1)) + Math.sin(time * 0.08 + i * 2) * 90;
      ctx.fillStyle = 'rgba(14,28,50,0.07)';
      ctx.beginPath(); ctx.ellipse(cx, cy, 210, 95, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx + 130, cy + 35, 150, 65, 0, 0, Math.PI * 2); ctx.fill();
    }
    for (let i = 0; i < 3; i++) {
      const a = time * (0.07 + i * 0.02) + i * 2.2;
      const tx = MAPW / 2 + Math.cos(a) * (13 + i * 6);
      const ty = MAPH / 2 + Math.sin(a * 1.3) * (11 + i * 5);
      const gx = (tx - ty) * TW2, gy = (tx + ty) * TH2 - 76 - i * 16;
      const flap = Math.sin(time * 7 + i * 3) * 2.6;
      ctx.strokeStyle = 'rgba(246,249,251,0.92)';
      ctx.lineWidth = 1.4; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(gx - 4.5, gy);
      ctx.quadraticCurveTo(gx - 2, gy - flap, gx, gy);
      ctx.quadraticCurveTo(gx + 2, gy - flap, gx + 4.5, gy);
      ctx.stroke();
    }
  }

  function drawShip(it, time, RX, RY) {
    const sp = Sprites.get('ship');
    // wake: fading puffs along the path behind the ship
    for (let i = 1; i <= 3; i++) {
      const wa = it.a - i * 0.025;
      const wx = MAPW / 2 + Math.cos(wa) * RX;
      const wy = MAPH / 2 + Math.sin(wa) * RY;
      const wsx = (wx - wy) * TW2, wsy = (wx + wy) * TH2;
      ctx.fillStyle = `rgba(235,248,255,${(0.3 - i * 0.085).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(wsx, wsy + TH2, 4 + i * 2.5, 1.6 + i, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const sx = (it.fx - it.fy) * TW2, sy = (it.fx + it.fy) * TH2;
    const bob = Math.sin(time * 1.8) * 1.5;
    // flip so the bow faces the direction of travel
    const screenVX = (-Math.sin(it.a) * RX - Math.cos(it.a) * RY);
    ctx.save();
    ctx.translate(sx, sy - sp.oy + bob);
    if (screenVX < 0) ctx.scale(-1, 1);
    ctx.drawImage(sp.c, -sp.w / 2, 0, sp.w, sp.h);
    ctx.restore();
  }

  function drawSmoke(topX, baseY, sp, b, time) {
    const px = topX - sp.w / 2 + sp.chimney[0];
    const py = baseY - sp.oy + sp.chimney[1];
    for (let i = 0; i < 3; i++) {
      const ph = (time * 0.3 + i * 0.33 + (b.id % 7) * 0.137) % 1;
      const a = (1 - ph) * 0.3;
      ctx.fillStyle = `rgba(228,228,225,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px + Math.sin((ph * 5 + b.id) * 1.7) * 2.5 + ph * 3, py - ph * 17, 1.6 + ph * 3.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------------- people ---------------- */

  // Tiny animated figure. anim: walk | idle | chop | hammer | bend
  function drawPerson(px, py, o, time) {
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
    kontor: '#3a6ea8', watchtower: '#5a5a64', firehouse: '#b8463a',
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
    cam, ghost, canvas,
    draw, resize, screenToTile, centerOn, zoomAt,
    rebuildGroundCache, minimapToTile, mmCanvas,
    markMapDirty: () => { mmDirty = true; },
  };
})();
