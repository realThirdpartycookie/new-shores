'use strict';
/* ============================================================
 * Input handling, game loop, boot.
 * ============================================================ */

(() => {
  const canvas = Render.canvas;

  let tool = null;               // null | {mode:'build', key} | {mode:'road'} | {mode:'demolish'}
  let mouse = { x: 0, y: 0, leftDown: false, rightDown: false, downX: 0, downY: 0, moved: 0 };
  let lastDragTile = null;

  function setTool(t) {
    if (t && t.mode === 'build' && BUILDINGS[t.key].tier > G.unlocked) {
      UI.toastMsg(`Locked — unlocks with ${TIERS[BUILDINGS[t.key].tier - 1].name}.`);
      return;
    }
    tool = t;
    G.selected = null;
    UI.setActiveTool(t);
    updateHint();
  }

  function cancelTool() {
    tool = null;
    UI.setActiveTool(null);
    UI.setHint('');
  }

  function updateHint() {
    if (!tool) { UI.setHint(''); return; }
    if (tool.mode === 'road') { UI.setHint(`Road (🪙${ROAD_COST}/tile) — click or drag to draw, right-click to stop.`); return; }
    if (tool.mode === 'demolish') { UI.setHint('Demolish — click buildings or roads. 50% refund.'); return; }
    const def = BUILDINGS[tool.key];
    const t = Render.screenToTile(mouse.x, mouse.y);
    const chk = canPlace(tool.key, t.x, t.y);
    UI.setHint(chk.ok ? `${def.name} — click to build.` : `${def.name} — ${chk.why}`);
  }

  function tryBuildAt(x, y, quiet) {
    const res = placeBuilding(tool.key, x, y);
    if (res.ok) {
      Render.rebuildGroundCache();
      Render.markMapDirty();
    } else if (!quiet) {
      UI.toastMsg(res.why);
      if (Hooks.sfx) Hooks.sfx('error');
    }
    return res.ok;
  }

  /* ---------------- mouse ---------------- */

  canvas.addEventListener('mousedown', e => {
    const t = Render.screenToTile(e.clientX, e.clientY);
    mouse.downX = e.clientX; mouse.downY = e.clientY; mouse.moved = 0;
    // grabbing the map catches any ongoing glide; stale drag velocity
    // must not turn a plain click into a flick
    Render.camVel.x = Render.camVel.y = 0;
    dragVel = { x: 0, y: 0, t: performance.now() };
    if (e.button === 0) {
      mouse.leftDown = true;
      lastDragTile = t.x + ',' + t.y;
      if (tool) {
        if (tool.mode === 'build') tryBuildAt(t.x, t.y, false);
        else if (tool.mode === 'road') { if (placeRoad(t.x, t.y)) { Render.rebuildGroundCache(); if (Hooks.sfx) Hooks.sfx('click'); } }
        else if (tool.mode === 'demolish') { if (demolishAt(t.x, t.y)) Render.rebuildGroundCache(); }
      }
    } else if (e.button === 2) {
      mouse.rightDown = true;
    }
  });

  let dragVel = { x: 0, y: 0, t: 0 };

  window.addEventListener('mousemove', e => {
    const dx = e.clientX - mouse.x, dy = e.clientY - mouse.y;
    mouse.moved += Math.abs(dx) + Math.abs(dy);
    // pan: right-drag always, left-drag when no tool (write-through so the
    // glide targets follow; velocity is kept for flick inertia on release)
    if (mouse.rightDown || (mouse.leftDown && !tool)) {
      Render.cam.x += dx; Render.cam.y += dy;
      Render.camT.x += dx; Render.camT.y += dy;
      const now = performance.now();
      // 8ms floor keeps a 1000Hz mouse's single-pixel twitch from
      // registering as a huge velocity
      const dt = Math.max(8, now - dragVel.t);
      dragVel = { x: dx / dt * 1000, y: dy / dt * 1000, t: now };
    }
    mouse.x = e.clientX; mouse.y = e.clientY;

    // drag-painting roads & buildings
    if (mouse.leftDown && tool) {
      const t = Render.screenToTile(e.clientX, e.clientY);
      const key = t.x + ',' + t.y;
      if (key !== lastDragTile) {
        lastDragTile = key;
        if (tool.mode === 'road') { if (placeRoad(t.x, t.y)) { Render.rebuildGroundCache(); if (Hooks.sfx) Hooks.sfx('click'); } }
        else if (tool.mode === 'build') tryBuildAt(t.x, t.y, true);
        else if (tool.mode === 'demolish') { if (demolishAt(t.x, t.y)) Render.rebuildGroundCache(); }
      }
    }
    updateHint();
  });

  function releaseFlick() {
    // recent fast drag? let the map glide on
    if (performance.now() - dragVel.t < 60 && Math.hypot(dragVel.x, dragVel.y) > 250) {
      Render.camVel.x = dragVel.x;
      Render.camVel.y = dragVel.y;
    }
  }

  window.addEventListener('mouseup', e => {
    if (e.button === 0) {
      // plain click with no tool: select building under cursor
      if (!tool && mouse.leftDown && mouse.moved < 8) {
        const t = Render.screenToTile(e.clientX, e.clientY);
        const b = inBounds(t.x, t.y) ? G.grid[idx(t.x, t.y)] : null;
        G.selected = b ? b.id : null;
        if (b && Hooks.sfx) Hooks.sfx('click');
      }
      if (!tool && mouse.leftDown && mouse.moved >= 8) releaseFlick();
      mouse.leftDown = false;
      lastDragTile = null;
    } else if (e.button === 2) {
      if (mouse.rightDown && mouse.moved >= 8) releaseFlick();
      if (mouse.moved < 8) {
        // right-click: cancel tool or deselect
        if (UI.anyModalOpen()) UI.closeAllModals();
        else if (tool) cancelTool();
        else G.selected = null;
      }
      mouse.rightDown = false;
    }
  });

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    Render.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  /* ---------------- minimap ---------------- */
  let mmDown = false;
  const mmJump = e => {
    const r = Render.mmCanvas.getBoundingClientRect();
    const t = Render.minimapToTile(e.clientX - r.left, e.clientY - r.top);
    Render.flyTo(t.x, t.y);
  };
  Render.mmCanvas.addEventListener('mousedown', e => { mmDown = true; mmJump(e); });
  window.addEventListener('mousemove', e => { if (mmDown) mmJump(e); });
  window.addEventListener('mouseup', () => { mmDown = false; });

  /* ---------------- keyboard ---------------- */
  const keys = new Set();

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    keys.add(e.key.toLowerCase());
    switch (e.key) {
      case 'Escape':
        if (UI.anyModalOpen()) UI.closeAllModals();
        else if (tool) cancelTool();
        else G.selected = null;
        break;
      case ' ':
        e.preventDefault();
        G.paused = !G.paused;
        UI.refreshSpeedButtons();
        break;
      case '1': case '2': case '3':
        G.paused = false;
        G.speed = parseInt(e.key, 10);
        UI.refreshSpeedButtons();
        break;
      case '+': case '=':
        Render.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.2);
        break;
      case '-':
        Render.zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.2);
        break;
      case 'h': case 'H':
        UI.openModal('modal-help');
        break;
      case 't': case 'T':
        UI.openModal('modal-trade');
        break;
    }
  });
  window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));

  function keyPan(dt) {
    const v = 480 * dt;
    let mx = 0, my = 0;
    if (keys.has('w') || keys.has('arrowup')) my += v;
    if (keys.has('s') || keys.has('arrowdown')) my -= v;
    if (keys.has('a') || keys.has('arrowleft')) mx += v;
    if (keys.has('d') || keys.has('arrowright')) mx -= v;
    if (mx || my) {
      Render.cam.x += mx; Render.cam.y += my;
      Render.camT.x += mx; Render.camT.y += my;
    }
  }

  /* ---------------- game loop ---------------- */
  let last = performance.now();
  let hudT = 0;

  function frame(now) {
    let dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    keyPan(dt);
    Render.updateCamera(dt);
    if (!G.paused) simTick(dt * G.speed);

    // ghost state for renderer
    const gh = Render.ghost;
    if (tool) {
      const t = Render.screenToTile(mouse.x, mouse.y);
      gh.active = true;
      gh.mode = tool.mode;
      gh.x = t.x; gh.y = t.y;
      gh.key = tool.key || null;
      if (tool.mode === 'build') gh.ok = canPlace(tool.key, t.x, t.y).ok;
      else if (tool.mode === 'road') gh.ok = inBounds(t.x, t.y) && !G.roads[idx(t.x, t.y)] && !G.grid[idx(t.x, t.y)] && !!G.zone[idx(t.x, t.y)];
      else gh.ok = true;
    } else {
      gh.active = false;
    }

    Render.draw(G.time, !!tool && tool.mode !== 'demolish');
    UI.hoverTile(mouse.x, mouse.y, !!tool || mouse.leftDown || mouse.rightDown);

    hudT += dt;
    if (hudT >= 0.15) { hudT = 0; UI.updateHUD(); }

    requestAnimationFrame(frame);
  }

  /* ---------------- boot ---------------- */
  function boot() {
    UI.init();
    UI.buildToolbar(setTool);

    let loaded = false;
    try { loaded = loadGame(); } catch (e) { loaded = false; }

    if (!loaded) {
      newGame();
      UI.toastMsg('Welcome to your new island! Build roads, houses and a fishery. Press H for help.', true);
    } else {
      UI.toastMsg('Welcome back, Governor!');
    }
    const wh = G.buildings.find(b => b.key === 'warehouse');
    Render.rebuildGroundCache();
    if (wh) Render.centerOn(wh.x + 1, wh.y + 1);
    UI.refreshToolbar();
    UI.updateHUD();

    setInterval(saveGame, 30000);
    window.addEventListener('beforeunload', saveGame);

    requestAnimationFrame(frame);
  }

  boot();
})();
