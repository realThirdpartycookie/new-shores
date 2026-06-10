'use strict';
/* ============================================================
 * HUD, toolbar, panels, modals, toasts, sounds.
 * ============================================================ */

const UI = (() => {
  const $ = id => document.getElementById(id);

  /* ---------------- sounds (tiny WebAudio synth) ---------------- */
  let audioCtx = null;
  let muted = false;

  function beep(freq, dur, type = 'triangle', vol = 0.12, delay = 0) {
    if (muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime + delay;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + dur);
    } catch (e) { /* audio unavailable */ }
  }

  const SFX = {
    click:    () => beep(660, 0.06, 'square', 0.05),
    place:    () => { beep(330, 0.09, 'triangle'); beep(440, 0.12, 'triangle', 0.12, 0.07); },
    demolish: () => beep(140, 0.2, 'sawtooth', 0.1),
    error:    () => beep(160, 0.18, 'square', 0.08),
    coin:     () => { beep(880, 0.07, 'sine', 0.1); beep(1320, 0.09, 'sine', 0.08, 0.05); },
    upgrade:  () => { beep(523, 0.1); beep(659, 0.1, 'triangle', 0.12, 0.09); beep(784, 0.16, 'triangle', 0.12, 0.18); },
    unlock:   () => { beep(523, 0.12); beep(659, 0.12, 'triangle', 0.12, 0.1); beep(784, 0.12, 'triangle', 0.12, 0.2); beep(1047, 0.25, 'triangle', 0.14, 0.3); },
    cannon:   () => { beep(75, 0.3, 'sawtooth', 0.14); beep(48, 0.4, 'square', 0.1, 0.04); },
  };

  function sfx(name) { if (SFX[name]) SFX[name](); }

  /* ---------------- ambience: waves & gulls ---------------- */
  let ambience = null;

  function startAmbience() {
    if (ambience) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtx;
      const master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.05;
      master.connect(ctx.destination);
      // surf: looped noise through a lowpass, swelling slowly
      const len = 2 * ctx.sampleRate;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.6;
      const waveGain = ctx.createGain();
      waveGain.gain.value = 0.55;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.12;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.3;
      lfo.connect(lfoGain); lfoGain.connect(waveGain.gain);
      src.connect(lp); lp.connect(waveGain); waveGain.connect(master);
      src.start(); lfo.start();
      ambience = { master };
      scheduleGull();
    } catch (e) { ambience = null; /* audio unavailable */ }
  }

  function scheduleGull() {
    if (!ambience) return;
    setTimeout(() => { gullCry(); scheduleGull(); }, 9000 + Math.random() * 15000);
  }

  function gullCry() {
    if (muted || !audioCtx || !ambience) return;
    try {
      const n = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < n; i++) {
        const t0 = audioCtx.currentTime + i * 0.38;
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'triangle';
        o.frequency.setValueAtTime(1280 + Math.random() * 180, t0);
        o.frequency.exponentialRampToValueAtTime(840, t0 + 0.3);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.045, t0 + 0.07);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t0); o.stop(t0 + 0.34);
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------------- toasts ---------------- */
  function toastMsg(msg, big) {
    const el = document.createElement('div');
    el.className = 'toast' + (big ? ' big' : '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.classList.add('fade'), big ? 5000 : 3200);
    setTimeout(() => el.remove(), (big ? 5000 : 3200) + 700);
  }

  /* ---------------- top bar ---------------- */
  const HUD_GOODS = ['wood', 'tools', 'food', 'grain', 'iron', 'wool', 'cloth', 'potato', 'liquor'];

  function buildHud() {
    const wrap = $('hud-res');
    wrap.innerHTML = '';
    for (const g of HUD_GOODS) {
      const span = document.createElement('span');
      span.className = 'res';
      span.id = `hudres-${g}`;
      span.title = RES_META[g].name;
      span.innerHTML = `${RES_META[g].icon} <b id="res-${g}">0</b><span class="trend" id="trend-${g}"></span>`;
      wrap.appendChild(span);
    }
  }

  function costStr(cost) {
    const parts = [];
    for (const k in cost) parts.push(`${RES_META[k].icon}${cost[k]}`);
    return parts.join(' ');
  }

  function updateHUD() {
    $('gold').textContent = Math.floor(G.stock.gold).toLocaleString();
    const goldRate = ratePerMin('gold');
    $('hud-gold').title = `Gold · ${goldRate >= 0 ? '+' : ''}${goldRate.toFixed(0)}/min`;
    for (let t = 0; t < 3; t++) $('pop-' + t).textContent = popOf(t);
    const cap = storageCap();
    for (const g of HUD_GOODS) {
      const el = $('res-' + g);
      if (el) el.textContent = Math.floor(G.stock[g] || 0);
      const r = ratePerMin(g);
      const tr = $('trend-' + g);
      if (tr) {
        tr.textContent = r > 0.05 ? '▴' : r < -0.05 ? '▾' : '';
        tr.className = 'trend ' + (r > 0.05 ? 'up' : r < -0.05 ? 'down' : '');
      }
      const wrap = $('hudres-' + g);
      if (wrap) wrap.title = `${RES_META[g].name}: ${Math.floor(G.stock[g] || 0)} / ${cap} · ${r >= 0 ? '+' : ''}${r.toFixed(1)}/min`;
    }
    // goal line: active quest, or victory note when all are done
    let goal;
    if (G.quest < QUESTS.length) {
      const q = QUESTS[G.quest];
      goal = `📜 ${q.text}`;
      if (q.prog) {
        const [cur, target] = q.prog();
        goal += ` (${cur}/${target})`;
      }
      const parts = [];
      for (const k in q.reward) parts.push(`+${q.reward[k]}${RES_META[k].icon}`);
      goal += ` · Reward: ${parts.join(' ')}`;
    } else {
      goal = '👑 Your island flourishes! Keep building.';
    }
    $('goal').textContent = goal;

    if (G.flourished && !G.victoryShown) showVictory();

    // live-refresh open data modals (~1s cadence; updateHUD runs every 0.15s)
    statsRefreshT += 0.15;
    if (statsRefreshT >= 1) {
      statsRefreshT = 0;
      const sm = $('modal-stats');
      if (sm && !sm.classList.contains('hidden')) refreshStats();
      const tm = $('modal-trade');
      if (tm && !tm.classList.contains('hidden')) refreshTrade();
      refreshAdvisor();
    }

    updatePanel();
  }

  function refreshAdvisor() {
    const box = $('advisor');
    if (!box || typeof AI === 'undefined') return;
    const s = AI.getSuggestion();
    $('advisor-text').textContent = (s.label ? s.label + ' — ' : '') + s.reason;
    const last = AI.getLastAct();
    $('advisor-last').textContent = G.autopilot && last ? `🤖 last action: ${last}` : '';
    const apply = $('advisor-apply');
    apply.classList.toggle('hidden', G.autopilot || s.action === 'wait');
    if (s.label) apply.textContent = s.label;
    const btn = $('btn-autopilot');
    btn.textContent = G.autopilot ? '🤖 Auto: ON' : '🤖 Auto: OFF';
    btn.classList.toggle('on', G.autopilot);
  }
  let statsRefreshT = 0;

  function showVictory() {
    G.victoryShown = true;
    const mins = Math.floor(G.time / 60);
    const houses = G.buildings.filter(b => b.key === 'house').length;
    const rows = [
      ['👥 Population', `${totalPop()} (${popOf(0)} / ${popOf(1)} / ${popOf(2)})`],
      ['🏠 Houses', houses],
      ['🏗 Buildings', G.buildings.length],
      ['🪙 Treasury', Math.floor(G.stock.gold).toLocaleString()],
      ['⏱ Time played', `${Math.floor(mins / 60) ? Math.floor(mins / 60) + 'h ' : ''}${mins % 60}min`],
    ];
    $('victory-stats').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    openModal('modal-victory');
    sfx('unlock');
  }

  /* ---------------- toolbar ---------------- */
  let toolbarButtons = {};

  function buildToolbar(onTool) {
    const bar = $('toolbar');
    bar.innerHTML = '';
    toolbarButtons = {};

    const addBtn = (id, icon, label, costS, title, handler) => {
      const btn = document.createElement('button');
      btn.className = 'tb-btn';
      btn.id = 'tb-' + id;
      btn.innerHTML = `<span class="tb-icon">${icon}</span><span>${label}</span><span class="tb-cost">${costS || '&nbsp;'}</span>`;
      btn.title = title;
      btn.addEventListener('click', () => { sfx('click'); handler(); });
      bar.appendChild(btn);
      toolbarButtons[id] = btn;
      return btn;
    };

    for (const item of TOOLBAR_ITEMS) {
      if (item === null) {
        const sep = document.createElement('div');
        sep.className = 'tb-sep';
        bar.appendChild(sep);
        continue;
      }
      if (item === 'road') {
        addBtn('road', '🛣', 'Road', `🪙${ROAD_COST}`, 'Dirt road — connects buildings to the Warehouse. Drag to draw.', () => onTool({ mode: 'road' }));
        continue;
      }
      const def = BUILDINGS[item];
      addBtn(item, def.icon, def.name, costStr(def.cost), `${def.name} — ${def.desc}`, () => onTool({ mode: 'build', key: item }));
    }

    const sep = document.createElement('div');
    sep.className = 'tb-sep';
    bar.appendChild(sep);

    addBtn('demolish', '🗑', 'Demolish', '', 'Demolish buildings and roads (50% refund).', () => onTool({ mode: 'demolish' }));
    addBtn('trade', '🚢', 'Trade', '', 'Trade with the free merchant.', () => { openModal('modal-trade'); refreshTrade(); });
    addBtn('stats', '📊', 'Stats', '', 'Population history and goods balance.', () => { openModal('modal-stats'); refreshStats(); });
    addBtn('help', '❓', 'Help', '', 'How to play.', () => openModal('modal-help'));
    addBtn('save', '💾', 'Save', '', 'Save your game (autosaves every 30s).', () => {
      if (saveGame()) toastMsg('Game saved.');
      else toastMsg('Could not save!');
    });
    addBtn('new', '🔄', 'New', '', 'Start a fresh island.', () => {
      if (confirm('Abandon this island and settle a new one?')) {
        const spot = newGame();
        Render.rebuildGroundCache();
        Render.centerOn(spot.x + 1, spot.y + 1);
        refreshToolbar();
        toastMsg('A new island awaits!', true);
      }
    });

    refreshToolbar();
  }

  function refreshToolbar() {
    for (const item of TOOLBAR_ITEMS) {
      if (!item || item === 'road') continue;
      const def = BUILDINGS[item];
      const btn = toolbarButtons[item];
      if (!btn) continue;
      const locked = def.tier > G.unlocked;
      btn.classList.toggle('locked', locked);
      btn.title = locked
        ? `${def.name} — unlocks with ${TIERS[def.tier - 1].name}`
        : `${def.name} — ${def.desc}`;
    }
  }

  function setActiveTool(tool) {
    for (const id in toolbarButtons) toolbarButtons[id].classList.remove('active');
    if (!tool) return;
    const id = tool.mode === 'build' ? tool.key : tool.mode;
    if (toolbarButtons[id]) toolbarButtons[id].classList.add('active');
  }

  function setHint(text) { $('hint').textContent = text || ''; }

  /* ---------------- info panel ---------------- */
  const STATUS_TEXT = {
    ok: '<span class="ok">✓ Working</span>',
    build: '🚧 Under construction…',
    noroad: '<span class="bad">✗ No road connection to the Warehouse</span>',
    full: '<span class="bad">⏸ Storage is full</span>',
    storm: '<span class="bad">⛈ Sheltering from the storm</span>',
    fire: '<span class="bad">🔥 ON FIRE — pray the brigade is near!</span>',
    sick: '<span class="bad">🤒 Plague — residents are recovering</span>',
    needs: '<span class="bad">✗ Needs are not met</span>',
  };

  function updatePanel() {
    const panel = $('panel');
    const b = G.buildings.find(o => o.id === G.selected);
    if (!b) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    const def = BUILDINGS[b.key];
    $('panel-title').textContent = `${def.icon} ${b.key === 'house' ? TIERS[b.tier].name + ' ' : ''}${def.name}`;
    $('panel-demolish').classList.toggle('hidden', b.key === 'warehouse');

    let html = '';
    if (b.key === 'house') {
      const tier = TIERS[b.tier];
      if (b.sick != null) html += STATUS_TEXT.sick + '<hr>';
      html += `<div class="row"><span>Residents</span><b>${b.res} / ${tier.resMax}</b></div>`;
      html += `<div class="row"><span>Taxes</span><b>${(b.res * tier.tax * 60).toFixed(1)} 🪙/min</b></div><hr>`;
      html += '<b>Needs</b>';
      for (const good in tier.goods) {
        const ok = b.sat[good] !== false;
        html += `<div class="row"><span>${RES_META[good].icon} ${RES_META[good].name}</span><span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span></div>`;
      }
      for (const s of tier.services) {
        const ok = !!b.svc[s];
        html += `<div class="row"><span>${SERVICE_NAMES[s]} nearby</span><span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span></div>`;
      }
      if (tier.upgrade) {
        const next = TIERS[b.tier + 1];
        html += `<hr><b>Upgrade to ${next.name}</b><br>`;
        if (b.tier + 1 >= G.unlocked) {
          const u = UNLOCKS[b.tier + 1];
          html += `<span class="bad">Locked — reach ${u.count} ${u.label}</span>`;
        } else {
          html += `Full house + ${costStr(tier.upgrade.cost)} + ${RES_META[tier.upgrade.needsGood].icon} in stock`;
          const missing = next.services.filter(s => !b.svc[s]);
          if (missing.length) html += `<br><span class="bad">Missing: ${missing.map(s => SERVICE_NAMES[s]).join(', ')}</span>`;
        }
      }
    } else {
      if (!b.done) {
        html += STATUS_TEXT.build;
      } else if (b.status === 'nocond') {
        html += `<span class="bad">✗ ${b.condWhy || 'Nature requirement not met'}</span>`;
      } else if (b.status === 'noinput') {
        const ins = Object.keys(def.prod.in).map(k => RES_META[k].icon + ' ' + RES_META[k].name).join(', ');
        html += `<span class="bad">✗ Waiting for input: ${ins}</span>`;
      } else {
        html += STATUS_TEXT[b.status] || STATUS_TEXT.ok;
      }
      if (def.prod) {
        html += `<hr><div class="row"><span>Produces</span><b>${def.prod.n} ${RES_META[def.prod.out].icon} / ${def.prod.cycle}s</b></div>`;
        if (def.prod.in) {
          const ins = Object.entries(def.prod.in).map(([k, n]) => `${n} ${RES_META[k].icon}`).join(' + ');
          html += `<div class="row"><span>Consumes</span><b>${ins}</b></div>`;
        }
        if (b.done) {
          const pct = Math.min(100, Math.floor(b.t / def.prod.cycle * 100));
          html += `<div class="pbar"><div style="width:${pct}%"></div></div>`;
          const r = ratePerMin(def.prod.out);
          html += `<div class="row"><span>${RES_META[def.prod.out].name} net</span><b class="${r >= 0 ? 'ok' : 'bad'}">${r >= 0 ? '+' : ''}${r.toFixed(1)}/min</b></div>`;
        }
      }
      if (def.service) html += `<hr>Serves houses within ${def.radius} tiles.`;
      if (def.zone) html += `<hr>Extends the building area by ${def.zone} tiles.`;
      if (def.storage) html += `<br>+${def.storage} storage capacity.`;
      if (b.key === 'warehouse' || b.key === 'kontor') {
        html += `<hr>Storage capacity: <b>${storageCap()}</b> per good.`;
        const fert = G.fertility[islandAt(b.x, b.y)];
        if (fert) {
          const items = FERTILITY_CROPS.map(c => {
            const names = { sheep: '🐑 Sheep', grain: '🌾 Grain', potato: '🥔 Potatoes' };
            return `<span class="${fert[c] ? 'ok' : 'bad'}">${names[c]} ${fert[c] ? '✓' : '✗'}</span>`;
          });
          html += `<br><b>This island:</b><br>` + items.join(' &nbsp; ');
        }
      }
    }
    $('panel-body').innerHTML = html;
  }

  /* ---------------- trade modal ---------------- */
  function buildTrade() {
    const tbody = $('trade-rows');
    tbody.innerHTML = '';
    for (const g of GOODS) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${RES_META[g].icon} ${RES_META[g].name}</td>
        <td id="trade-stock-${g}">0</td>
        <td id="trade-rate-${g}" class="rate">–</td>
        <td>${TRADE[g].buy} 🪙</td>
        <td>${TRADE[g].sell} 🪙</td>
        <td>
          <button data-act="buy" data-good="${g}" data-n="5">Buy 5</button>
          <button data-act="sell" data-good="${g}" data-n="5">Sell 5</button>
        </td>`;
      tbody.appendChild(tr);
    }
    tbody.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const { act, good, n } = btn.dataset;
      if (act === 'buy') buyGood(good, parseInt(n, 10));
      else sellGood(good, parseInt(n, 10));
      refreshTrade();
      updateHUD();
    });
  }

  function refreshTrade() {
    for (const g of GOODS) {
      const el = $('trade-stock-' + g);
      if (el) el.textContent = Math.floor(G.stock[g] || 0);
      const rl = $('trade-rate-' + g);
      if (rl) {
        const r = ratePerMin(g);
        rl.textContent = (r >= 0 ? '+' : '') + r.toFixed(1);
        rl.className = 'rate ' + (r > 0.05 ? 'up' : r < -0.05 ? 'down' : '');
      }
    }
  }

  /* ---------------- stats panel ---------------- */
  const TIER_COLORS = ['#8ad06c', '#e8c95a', '#e8855a'];

  function refreshStats() {
    drawStatsGraph();
    const rows = [];
    for (const g of GOODS) {
      const r = ratePerMin(g);
      const cls = r > 0.05 ? 'up' : r < -0.05 ? 'down' : '';
      const trend = r > 0.05 ? '▲ surplus' : r < -0.05 ? '▼ deficit' : '— balanced';
      rows.push(`<tr><td>${RES_META[g].icon} ${RES_META[g].name}</td>` +
        `<td>${Math.floor(G.stock[g] || 0)}</td>` +
        `<td class="${cls}">${(r >= 0 ? '+' : '') + r.toFixed(1)}</td>` +
        `<td class="${cls}">${trend}</td></tr>`);
    }
    $('stats-goods-rows').innerHTML = rows.join('');
  }

  function drawStatsGraph() {
    const cv = $('stats-graph');
    if (!cv || !cv.getContext) return;
    const c = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    const h = G.popHist;
    if (h.length < 2) {
      c.fillStyle = '#8f7340';
      c.font = '13px sans-serif';
      c.textAlign = 'center';
      c.fillText('Gathering data — population is sampled every few seconds…', W / 2, H / 2);
      return;
    }
    const padL = 30, padB = 16, padT = 8;
    const gw = W - padL - 6, gh = H - padT - padB;
    let maxP = 10;
    for (const e of h) maxP = Math.max(maxP, e[1] + e[2] + e[3]);
    const X = i => padL + (i / (h.length - 1)) * gw;
    const Y = v => padT + gh - (v / maxP) * gh;
    // stacked areas: total (citizens on top) → settlers+pioneers → pioneers
    const layers = [
      [e => e[1] + e[2] + e[3], TIER_COLORS[2]],
      [e => e[1] + e[2], TIER_COLORS[1]],
      [e => e[1], TIER_COLORS[0]],
    ];
    for (const [fn, col] of layers) {
      c.beginPath();
      c.moveTo(X(0), Y(0));
      for (let i = 0; i < h.length; i++) c.lineTo(X(i), Y(fn(h[i])));
      c.lineTo(X(h.length - 1), Y(0));
      c.closePath();
      c.fillStyle = col;
      c.fill();
    }
    // outline of total
    c.beginPath();
    for (let i = 0; i < h.length; i++) {
      const y = Y(h[i][1] + h[i][2] + h[i][3]);
      if (i === 0) c.moveTo(X(i), y); else c.lineTo(X(i), y);
    }
    c.strokeStyle = '#6b4f33'; c.lineWidth = 1.4; c.stroke();
    // axes labels
    c.fillStyle = '#6b4f33';
    c.font = '11px sans-serif';
    c.textAlign = 'left';
    c.fillText(String(maxP), 4, padT + 10);
    c.fillText('0', 4, padT + gh);
    const span = h[h.length - 1][0] - h[0][0];
    c.textAlign = 'right';
    c.fillText(`last ${Math.max(1, Math.round(span / 60))} min`, W - 8, H - 4);
  }

  /* ---------------- modals ---------------- */
  function openModal(id) {
    $(id).classList.remove('hidden');
    if (id === 'modal-trade') refreshTrade();
    if (id === 'modal-stats') refreshStats();
  }
  function closeModal(id) { $(id).classList.add('hidden'); }
  function closeAllModals() {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  }
  function anyModalOpen() {
    return [...document.querySelectorAll('.modal')].some(m => !m.classList.contains('hidden'));
  }

  /* ---------------- speed / pause controls ---------------- */
  function refreshSpeedButtons() {
    $('btn-pause').textContent = G.paused ? '▶' : '⏸';
    $('btn-pause').classList.toggle('active', G.paused);
    for (let i = 1; i <= 3; i++) {
      $('btn-spd' + i).classList.toggle('active', !G.paused && G.speed === i);
    }
    const po = $('pause-overlay');
    if (po) po.classList.toggle('hidden', !G.paused);
  }

  function init() {
    buildHud();
    buildTrade();

    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => closeModal(btn.dataset.close));
    });
    document.querySelectorAll('.modal').forEach(m => {
      m.addEventListener('mousedown', e => { if (e.target === m) m.classList.add('hidden'); });
    });

    const vc = $('victory-continue');
    if (vc) vc.addEventListener('click', () => closeModal('modal-victory'));

    const ap = $('btn-autopilot');
    if (ap) ap.addEventListener('click', () => {
      G.autopilot = !G.autopilot;
      sfx('click');
      if (G.autopilot) toastMsg('🤖 The neural net takes the helm — it builds, trades and routes roads on its own.');
      refreshAdvisor();
    });
    const aa = $('advisor-apply');
    if (aa) aa.addEventListener('click', () => {
      if (typeof AI !== 'undefined' && AI.applySuggestion()) {
        sfx('place');
        Render.rebuildGroundCache();
      } else {
        sfx('error');
      }
      refreshAdvisor();
    });

    $('panel-close').addEventListener('click', () => { G.selected = null; updatePanel(); });
    $('panel-demolish').addEventListener('click', () => {
      const b = G.buildings.find(o => o.id === G.selected);
      if (b && b.key !== 'warehouse') {
        removeBuilding(b);
        sfx('demolish');
        Render.rebuildGroundCache();
      }
    });

    $('btn-pause').addEventListener('click', () => { G.paused = !G.paused; refreshSpeedButtons(); });
    for (let i = 1; i <= 3; i++) {
      $('btn-spd' + i).addEventListener('click', () => { G.paused = false; G.speed = i; refreshSpeedButtons(); });
    }
    $('btn-mute').addEventListener('click', () => {
      muted = !muted;
      $('btn-mute').textContent = muted ? '🔇' : '🔊';
      if (ambience) ambience.master.gain.value = muted ? 0 : 0.05;
    });

    // browsers only allow audio after a user gesture
    window.addEventListener('pointerdown', () => startAmbience(), { once: true });

    Hooks.toast = toastMsg;
    Hooks.sfx = sfx;
    Hooks.onChange = refreshToolbar;
    refreshSpeedButtons();
  }

  return {
    init, updateHUD, buildToolbar, refreshToolbar, setActiveTool, setHint,
    openModal, closeModal, closeAllModals, anyModalOpen, toastMsg, refreshSpeedButtons,
    refreshStats,
  };
})();
