'use strict';
/* ============================================================
 * HUD, toolbar, panels, modals, toasts, sounds.
 * ============================================================ */

const UI = (() => {
  const $ = id => document.getElementById(id);

  /* ---------------- sounds (tiny WebAudio synth) ---------------- */
  let audioCtx = null;
  let muted = false;
  let musicOn = true;

  function beep(freq, dur, type = 'triangle', vol = 0.12, delay = 0) {
    if (muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime + delay;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol * panVol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      let out = g;
      if (panBias !== 0 && audioCtx.createStereoPanner) {
        const p = audioCtx.createStereoPanner();
        p.pan.value = panBias;
        g.connect(p); out = p;
      }
      o.connect(g);
      out.connect(audioCtx.destination);
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
    bell:     () => { beep(1568, 0.14, 'sine', 0.09); beep(1245, 0.14, 'sine', 0.09, 0.12); beep(1047, 0.22, 'sine', 0.1, 0.24); },
    splash:   () => { beep(300, 0.12, 'sine', 0.07); beep(180, 0.2, 'sine', 0.06, 0.05); },
  };

  /* Positional sound: events that carry world coordinates get panned to
   * where they happened and quieter when off-screen. */
  let panBias = 0, panVol = 1;

  function sfx(name, x, y) {
    if (!SFX[name]) return;
    panBias = 0; panVol = 1;
    if (x !== undefined && typeof Render !== 'undefined') {
      const sx = ((x - y) * TW2) * Render.cam.zoom + Render.cam.x;
      const w = Render.canvas.clientWidth || 1;
      panBias = Math.max(-0.85, Math.min(0.85, (sx / w) * 2 - 1));
      if (sx < -100 || sx > w + 100) panVol = 0.35;
    }
    SFX[name]();
    panBias = 0; panVol = 1;
  }

  /* ---------------- ambience: waves & gulls ---------------- */
  let ambience = null;

  function startAmbience() {
    if (ambience) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // a context created before the first gesture boots suspended
      if (audioCtx.state === 'suspended') audioCtx.resume();
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
      // rain: the same noise loop through a bandpass, swelling with storms.
      // Routed through the master bus so the mute button silences it instantly.
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.8;
      const rainGain = ctx.createGain();
      rainGain.gain.value = 0;
      src.connect(bp); bp.connect(rainGain); rainGain.connect(master);
      src.start(); lfo.start();
      ambience = { master, rainGain };
      scheduleGull();
      // procedural soundtrack shares the context
      if (typeof Music !== 'undefined') {
        Music.init(ctx);
        Music.setEnabled(musicOn && !muted);
      }
      if (typeof Render !== 'undefined' && Render.setLightningHook) {
        Render.setLightningHook(() => setTimeout(thunder, 300 + Math.random() * 700));
      }
    } catch (e) { ambience = null; /* audio unavailable */ }
  }

  // rain loudness follows the renderer's eased storm level
  // (relative to the 0.05 master bus, so ~1.3 ≈ the old absolute 0.065)
  function tickAmbience() {
    if (!ambience || !ambience.rainGain || typeof Render === 'undefined') return;
    try {
      const target = 1.3 * Render.stormLevel();
      ambience.rainGain.gain.linearRampToValueAtTime(target, audioCtx.currentTime + 1.2);
    } catch (e) { /* ignore */ }
  }

  function thunder() {
    if (muted || !audioCtx) return;
    try {
      const t0 = audioCtx.currentTime;
      const len = Math.floor(1.4 * audioCtx.sampleRate);
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.6);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      const lp = audioCtx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 130;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.22, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.4);
      src.connect(lp); lp.connect(g); g.connect(audioCtx.destination);
      src.start(t0);
      const o = audioCtx.createOscillator(); // low rumble under the crack
      const og = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = 52;
      og.gain.setValueAtTime(0.1, t0);
      og.gain.exponentialRampToValueAtTime(0.001, t0 + 1.2);
      o.connect(og); og.connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + 1.3);
    } catch (e) { /* ignore */ }
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

  /* ---------------- toasts (capped, deduplicated, colour-coded) ---------------- */
  const liveToasts = []; // { el, msg, count, timer1, timer2 }
  const TOAST_MAX = 4;

  function retireToast(t, quick) {
    clearTimeout(t.timer1); clearTimeout(t.timer2);
    const i = liveToasts.indexOf(t);
    if (i >= 0) liveToasts.splice(i, 1);
    t.el.classList.add('fade');
    setTimeout(() => t.el.remove(), quick ? 250 : 700);
  }

  function toastMsg(msg, big, kind) {
    // repeat of a visible toast? bump its counter instead of stacking
    const dup = liveToasts.find(t => t.msg === msg);
    if (dup) {
      dup.count++;
      dup.el.querySelector('.toast-n').textContent = '×' + dup.count;
      dup.el.classList.remove('fade'); // may already be fading out
      clearTimeout(dup.timer1); clearTimeout(dup.timer2);
      const life = big ? 5000 : 3200;
      dup.timer1 = setTimeout(() => dup.el.classList.add('fade'), life);
      dup.timer2 = setTimeout(() => retireToast(dup), life + 700);
      return;
    }
    while (liveToasts.length >= TOAST_MAX) retireToast(liveToasts[0], true);
    const el = document.createElement('div');
    el.className = 'toast' + (big ? ' big' : '') + (kind ? ' ' + kind : '');
    el.innerHTML = `<span class="toast-msg"></span><span class="toast-n"></span>`;
    el.querySelector('.toast-msg').textContent = msg;
    $('toasts').appendChild(el);
    const t = { el, msg, count: 1, timer1: 0, timer2: 0 };
    const life = big ? 5000 : 3200;
    t.timer1 = setTimeout(() => el.classList.add('fade'), life);
    t.timer2 = setTimeout(() => retireToast(t), life + 700);
    liveToasts.push(t);
  }

  /* ---------------- top bar ---------------- */
  const HUD_GOODS = ['wood', 'tools', 'food', 'grain', 'iron', 'wool', 'cloth', 'potato', 'liquor', 'spice'];

  function buildHud() {
    const wrap = $('hud-res');
    wrap.innerHTML = '';
    for (const g of HUD_GOODS) {
      const span = document.createElement('span');
      span.className = 'res';
      span.id = `hudres-${g}`;
      span.innerHTML = `${RES_META[g].icon} <b id="res-${g}">0</b><span class="trend" id="trend-${g}"></span>`;
      span.addEventListener('mouseenter', () => {
        const r = span.getBoundingClientRect();
        tipShow(goodTipHTML(g), r.left, r.bottom + 8);
      });
      span.addEventListener('mouseleave', tipHide);
      wrap.appendChild(span);
    }
  }

  function costStr(cost) {
    const parts = [];
    for (const k in cost) parts.push(`${RES_META[k].icon}${cost[k]}`);
    return parts.join(' ');
  }

  const prevStock = {}; // last shown values, for bump animations
  let lastQuestShown = -1;

  function bump(el, up) {
    el.classList.remove('bump-up', 'bump-down');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(up ? 'bump-up' : 'bump-down');
  }

  function updateHUD() {
    const goldNow = Math.floor(G.stock.gold);
    const goldEl = $('gold');
    if (prevStock.gold !== undefined && goldNow !== prevStock.gold && Math.abs(goldNow - prevStock.gold) > 2) {
      bump(goldEl.parentElement, goldNow > prevStock.gold);
    }
    prevStock.gold = goldNow;
    goldEl.textContent = goldNow.toLocaleString();
    const goldRate = ratePerMin('gold');
    $('hud-gold').title = `Gold · ${goldRate >= 0 ? '+' : ''}${goldRate.toFixed(0)}/min`;
    for (let t = 0; t < TIERS.length; t++) {
      const el = $('pop-' + t);
      if (el) el.textContent = popOf(t);
    }
    const cap = storageCap();
    for (const g of HUD_GOODS) {
      const el = $('res-' + g);
      const now = Math.floor(G.stock[g] || 0);
      if (el) {
        if (prevStock[g] !== undefined && now !== prevStock[g]) bump(el.parentElement, now > prevStock[g]);
        prevStock[g] = now;
        el.textContent = now;
      }
      const r = ratePerMin(g);
      const tr = $('trend-' + g);
      if (tr) {
        tr.textContent = r > 0.05 ? '▴' : r < -0.05 ? '▾' : '';
        tr.className = 'trend ' + (r > 0.05 ? 'up' : r < -0.05 ? 'down' : '');
      }
      const wrap = $('hudres-' + g);
      if (wrap) wrap.classList.toggle('capped', now >= cap);
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
      goal = '👑 The Imperial Charter is yours! Keep building.';
    }
    $('goal').textContent = goal;
    if (lastQuestShown >= 0 && G.quest > lastQuestShown) { // quest fanfare
      const gb = $('goalbar');
      gb.classList.remove('flash');
      void gb.offsetWidth;
      gb.classList.add('flash');
    }
    lastQuestShown = G.quest;

    // expedition status line
    const ge = $('goal-exped');
    if (ge) {
      if (G.expedition) {
        const left = Math.max(0, Math.ceil(G.expedition.dur - G.expedition.t));
        ge.textContent = ` · ⛵ Expedition at sea — ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      } else if (G.expBonus) {
        ge.textContent = ' · 🗺 Sea charts ready — the next expedition sails swift!';
      } else {
        ge.textContent = '';
      }
    }

    if (G.flourished && !G.victoryShown) showVictory();

    // live-refresh open data modals (~1s cadence; updateHUD runs every 0.15s)
    statsRefreshT += 0.15;
    if (statsRefreshT >= 1) {
      statsRefreshT = 0;
      const sm = $('modal-stats');
      if (sm && !sm.classList.contains('hidden')) refreshStats();
      const tm = $('modal-trade');
      if (tm && !tm.classList.contains('hidden')) refreshTrade();
      const am = $('modal-achieve');
      if (am && !am.classList.contains('hidden')) refreshAchieve();
      refreshAdvisor();
      refreshAffordability();
      tickAmbience();
    }

    updatePanel();
  }

  // grey out buildings the treasury can't afford right now
  function refreshAffordability() {
    for (const item of TOOLBAR_ITEMS) {
      if (!item || item === 'road') continue;
      const btn = toolbarButtons[item];
      if (!btn || btn.classList.contains('locked')) continue;
      btn.classList.toggle('poor', !canAfford(BUILDINGS[item].cost));
    }
    const ex = toolbarButtons.exped;
    if (ex) ex.classList.toggle('poor', !!G.expedition || !canAfford(EXPEDITION_COST));
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
      ['👥 Population', `${totalPop()} (${popOf(0)} / ${popOf(1)} / ${popOf(2)} / ${popOf(3)})`],
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
      btn.addEventListener('click', () => { sfx('click'); handler(); });
      btn.addEventListener('mouseenter', () => {
        const r = btn.getBoundingClientRect();
        tipShow(toolbarTipHTML(id), r.left, r.top - 8 - 140);
        // reposition now that the height is known
        const tr = tipEl.getBoundingClientRect();
        tipShow(toolbarTipHTML(id), r.left, r.top - 8 - tr.height);
      });
      btn.addEventListener('mouseleave', tipHide);
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
    addBtn('exped', '⛵', 'Expedition', costStr(EXPEDITION_COST), 'Outfit a ship and send it beyond the map — it may return with goods, treasure, sea charts or exotic seeds.', () => {
      const res = startExpedition();
      if (!res.ok) toastMsg(res.why, false, 'danger');
      updateHUD();
    });
    addBtn('achieve', '🏆', 'Honours', '', 'Your chronicle of achievements.', () => { openModal('modal-achieve'); refreshAchieve(); });
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
      btn.classList.toggle('locked', def.tier > G.unlocked);
    }
  }

  function setActiveTool(tool) {
    for (const id in toolbarButtons) toolbarButtons[id].classList.remove('active');
    if (!tool) return;
    const id = tool.mode === 'build' ? tool.key : tool.mode;
    if (toolbarButtons[id]) toolbarButtons[id].classList.add('active');
  }

  function setHint(text) { $('hint').textContent = text || ''; }

  /* ---------------- rich tooltips ---------------- */
  let tipEl = null;
  let tipHTML = '';
  let tipOwner = null; // 'dom' (toolbar/HUD hover) | 'canvas' (building hover)

  function tipShow(html, x, y, owner = 'dom') {
    if (!tipEl) return;
    tipOwner = owner;
    if (html !== tipHTML) { tipEl.innerHTML = html; tipHTML = html; }
    tipEl.classList.remove('hidden');
    const r = tipEl.getBoundingClientRect();
    const px = Math.max(6, Math.min(window.innerWidth - r.width - 6, x));
    const py = Math.max(6, Math.min(window.innerHeight - r.height - 6, y));
    tipEl.style.left = px + 'px';
    tipEl.style.top = py + 'px';
  }

  function tipHide() {
    if (tipEl) tipEl.classList.add('hidden');
    tipHTML = '';
    tipOwner = null;
  }

  function reqText(def) {
    if (!def.req) return null;
    if (def.req.coast) return 'Must stand at the waterline';
    if (def.req.rock) return 'Must stand against a mountain';
    if (def.req.trees) return `Needs ${def.req.trees.n} trees within ${def.req.trees.r} tiles`;
    if (def.req.pasture) return `Needs ${def.req.pasture.n} free grass tiles around it`;
    return null;
  }

  const UTILITY_TIPS = {
    demolish: 'Demolish buildings and roads — half the cost comes back.',
    trade: 'Open the market. Prices drift with your trading; docked merchants bring better deals.',
    exped: 'Send a ship beyond the map: goods, treasure, sea charts or exotic seeds await… usually.',
    achieve: 'Your chronicle of achievements.',
    stats: 'Population history and goods balance.',
    help: 'How to play.',
    save: 'Save now (autosaves every 30 seconds).',
    new: 'Abandon this island and settle a fresh one.',
  };

  function costHTML(cost) {
    const parts = [];
    for (const k in cost) {
      const ok = (G.stock[k] || 0) >= cost[k];
      parts.push(`<span class="${ok ? '' : 'bad'}">${RES_META[k].icon}${cost[k]}</span>`);
    }
    return parts.join(' ');
  }

  function toolbarTipHTML(id) {
    if (id === 'road') {
      return `<b>🛣 Road</b><div class="tip-line">${costHTML({ gold: ROAD_COST })} per tile</div>
        <div class="tip-sub">Connects buildings to the Warehouse. Drag to draw.</div>`;
    }
    if (id === 'exped') {
      let h = `<b>⛵ Expedition</b><div class="tip-line">${costHTML(EXPEDITION_COST)}</div>
        <div class="tip-sub">${UTILITY_TIPS.exped}</div>`;
      if (G.expedition) h += `<div class="tip-line bad">A ship is already at sea.</div>`;
      else if (G.expBonus) h += `<div class="tip-line ok">Sea charts ready: swift voyage, richer haul!</div>`;
      return h;
    }
    if (UTILITY_TIPS[id]) return `<b>${UTILITY_TIPS[id]}</b>`;
    const def = BUILDINGS[id];
    if (!def) return '';
    let h = `<b>${def.icon} ${def.name}</b>`;
    if (def.tier > G.unlocked) {
      const u = UNLOCKS[def.tier - 1];
      h += `<div class="tip-line bad">🔒 Unlocks with ${TIERS[def.tier - 1].name}` +
        (u ? ` — ${popOf(u.tier)}/${u.count} ${u.label}` : '') + `</div>`;
    }
    h += `<div class="tip-line">${costHTML(def.cost)}</div>`;
    if (def.prod) {
      const perMin = (def.prod.n * 60 / def.prod.cycle).toFixed(1);
      h += `<div class="tip-line">Produces ${RES_META[def.prod.out].icon} ${RES_META[def.prod.out].name} · ~${perMin}/min</div>`;
      if (def.prod.in) {
        const ins = Object.entries(def.prod.in).map(([k, n]) => `${n} ${RES_META[k].icon}`).join(' + ');
        h += `<div class="tip-line">Consumes ${ins} per cycle</div>`;
      }
    }
    const rq = reqText(def);
    if (rq) h += `<div class="tip-line">📍 ${rq}</div>`;
    if (def.service) h += `<div class="tip-line">Serves houses within ${def.radius} tiles</div>`;
    if (def.zone) h += `<div class="tip-line">Extends the building area by ${def.zone} tiles</div>`;
    if (def.storage) h += `<div class="tip-line">+${def.storage} storage</div>`;
    if (def.range) h += `<div class="tip-line">Cannons reach ${def.range} tiles</div>`;
    if (def.needsRoad) h += `<div class="tip-line">Needs a road to the Warehouse</div>`;
    h += `<div class="tip-sub">${def.desc}</div>`;
    return h;
  }

  // goods chain map: good -> {from: [...building names], to: [...consumers]}
  let CHAIN = null;
  function chainFor(g) {
    if (!CHAIN) {
      CHAIN = {};
      for (const gg of GOODS) CHAIN[gg] = { from: [], to: [] };
      for (const key in BUILDINGS) {
        const d = BUILDINGS[key];
        if (!d.prod) continue;
        if (CHAIN[d.prod.out]) CHAIN[d.prod.out].from.push(`${d.icon} ${d.name}`);
        for (const k in (d.prod.in || {})) CHAIN[k] && CHAIN[k].to.push(`${d.icon} ${d.name}`);
      }
      for (const t of TIERS) {
        for (const k in t.goods) CHAIN[k] && CHAIN[k].to.push(`🏠 ${t.name}`);
      }
    }
    return CHAIN[g];
  }

  function goodTipHTML(g) {
    const r = ratePerMin(g);
    const c = chainFor(g);
    let h = `<b>${RES_META[g].icon} ${RES_META[g].name}</b>
      <div class="tip-line">${Math.floor(G.stock[g] || 0)} / ${storageCap()} in store ·
      <span class="${r >= 0 ? 'ok' : 'bad'}">${r >= 0 ? '+' : ''}${r.toFixed(1)}/min</span></div>`;
    if (c.from.length) h += `<div class="tip-line">From: ${c.from.join(', ')}</div>`;
    if (c.to.length) h += `<div class="tip-line">For: ${c.to.join(', ')}</div>`;
    return h;
  }

  /* canvas hover: linger on a building to inspect it without clicking */
  let hoverId = null, hoverSince = 0;

  function hoverTile(mx, my, busy) {
    // DOM hovers (toolbar/HUD) own the tooltip — never fight them from here
    if (!tipEl || tipOwner === 'dom') return;
    if (busy || anyModalOpen()) { hoverId = null; tipHide(); return; }
    const t = Render.screenToTile(mx, my);
    const b = inBounds(t.x, t.y) ? G.grid[idx(t.x, t.y)] : null;
    if (!b || !G.buildings.includes(b)) { hoverId = null; tipHide(); return; }
    const now = performance.now();
    if (b.id !== hoverId) { hoverId = b.id; hoverSince = now; tipHide(); return; }
    if (now - hoverSince < 350) return;
    tipShow(buildingTipHTML(b), mx + 18, my + 18, 'canvas');
  }

  function buildingTipHTML(b) {
    const def = BUILDINGS[b.key];
    let h = `<b>${def.icon} ${b.key === 'house' ? TIERS[b.tier].name + ' ' : ''}${def.name}</b>`;
    if (!b.done) {
      h += `<div class="tip-line">🚧 Building… ${Math.floor(Math.min(1, b.progress / def.buildTime) * 100)}%</div>`;
      return h;
    }
    if (b.key === 'house') {
      h += `<div class="tip-line">👥 ${b.res}/${TIERS[b.tier].resMax} · ${(b.res * TIERS[b.tier].tax * 60).toFixed(1)} 🪙/min</div>`;
      if (b.sick != null) h += `<div class="tip-line bad">🤒 Plague — recovering</div>`;
      const why = whyNoUpgrade(b);
      if (why) h += `<div class="tip-line">⬆ ${why}</div>`;
      else if (TIERS[b.tier].upgrade) h += `<div class="tip-line ok">⬆ Ready to advance!</div>`;
    } else {
      h += `<div class="tip-line">${STATUS_TEXT[b.status] || STATUS_TEXT.ok}</div>`;
      if (b.status === 'nocond' && b.condWhy) h += `<div class="tip-line bad">${b.condWhy}</div>`;
      if (def.prod && b.status === 'ok') {
        const pct = Math.floor(Math.min(1, b.t / def.prod.cycle) * 100);
        h += `<div class="tip-line">${RES_META[def.prod.out].icon} cycle ${pct}%</div>`;
      }
    }
    h += `<div class="tip-sub">Click for details</div>`;
    return h;
  }

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
        html += `Full house + ${costStr(tier.upgrade.cost)} + ${RES_META[tier.upgrade.needsGood].icon} in stock`;
        const why = whyNoUpgrade(b);
        if (why) html += `<br><span class="bad">${why}</span>`;
        else html += `<br><span class="ok">✓ Ready — advancing on the next growth step</span>`;
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
            const names = { sheep: '🐑 Sheep', grain: '🌾 Grain', potato: '🥔 Potatoes', spice: '🌶️ Spice' };
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
        <td id="trade-buy-${g}">${TRADE[g].buy} 🪙</td>
        <td id="trade-sell-${g}">${TRADE[g].sell} 🪙</td>
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
    const dealRows = $('trade-deals-rows');
    if (dealRows) dealRows.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      dealTrade(parseInt(btn.dataset.i, 10), parseInt(btn.dataset.n, 10));
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
      // live prices with drift arrows
      const p = priceOf(g);
      const bl = $('trade-buy-' + g), sl = $('trade-sell-' + g);
      const arrow = d => d > 0.02 ? ' <span class="up">▲</span>' : d < -0.02 ? ' <span class="down">▼</span>' : '';
      if (bl) bl.innerHTML = `${p.buy} 🪙${arrow(p.drift)}`;
      if (sl) sl.innerHTML = `${p.sell} 🪙${arrow(p.drift)}`;
    }
    // docked merchant's special offers
    const box = $('trade-deals');
    if (box) {
      const t = G.trader;
      const docked = t && t.state === 'docked';
      box.classList.toggle('hidden', !docked);
      if (docked) {
        $('trade-deals-timer').textContent = `(sails in ${Math.max(0, Math.ceil(t.timer))}s)`;
        // only rebuild the rows when a deal actually changes — replacing the
        // buttons mid-press would swallow the player's click
        const sig = t.deals.map(d => d.good + d.mode + d.left).join('|');
        if (sig !== dealSig) {
          dealSig = sig;
          const rows = t.deals.map((d, i) => {
            const base = d.mode === 'buy' ? TRADE[d.good].buy : TRADE[d.good].sell;
            const verb = d.mode === 'buy' ? 'She sells' : 'She buys';
            const btn = d.left > 0
              ? `<button data-i="${i}" data-n="5">${d.mode === 'buy' ? 'Buy' : 'Sell'} 5</button>`
              : '<i>sold out</i>';
            return `<tr><td>${RES_META[d.good].icon} ${RES_META[d.good].name}</td>` +
              `<td>${verb} at <b>${d.price} 🪙</b> <s>${base}</s></td>` +
              `<td>${d.left} left</td><td>${btn}</td></tr>`;
          });
          $('trade-deals-rows').innerHTML = rows.join('');
        }
      } else {
        dealSig = '';
      }
    }
  }
  let dealSig = '';

  /* ---------------- achievements ---------------- */
  function refreshAchieve() {
    const body = $('achieve-body');
    if (!body) return;
    const rows = ACHIEVEMENTS.map(a => {
      const t = G.achievements[a.id];
      const got = t != null;
      const when = got ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : '';
      return `<div class="ach ${got ? 'got' : ''}">
        <span class="ach-icon">${got ? a.icon : '🔒'}</span>
        <span class="ach-text"><b>${a.name}</b><br><small>${a.desc}</small></span>
        <span class="ach-when">${when}</span>
      </div>`;
    });
    const n = Object.keys(G.achievements).length;
    body.innerHTML = `<p class="modal-sub">${n} / ${ACHIEVEMENTS.length} earned</p>` + rows.join('');
  }

  /* ---------------- stats panel ---------------- */
  const TIER_COLORS = ['#8ad06c', '#e8c95a', '#e8855a', '#c86adf'];

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
    const tot = e => e[1] + e[2] + e[3] + (e[4] || 0);
    for (const e of h) maxP = Math.max(maxP, tot(e));
    const X = i => padL + (i / (h.length - 1)) * gw;
    const Y = v => padT + gh - (v / maxP) * gh;
    // stacked areas, top tier drawn first so lower tiers overlay it
    const layers = [
      [tot, TIER_COLORS[3]],
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
      const y = Y(tot(h[i]));
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
    const m = $(id);
    if (!m) return; // lean harness pages don't carry every modal
    m.classList.remove('hidden');
    if (id === 'modal-trade') refreshTrade();
    if (id === 'modal-stats') refreshStats();
    if (id === 'modal-achieve') refreshAchieve();
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
    tipEl = document.createElement('div');
    tipEl.id = 'tooltip';
    tipEl.className = 'hidden';
    document.body.appendChild(tipEl);

    // audio preferences survive reloads (separate from the save game)
    try {
      const prefs = JSON.parse(localStorage.getItem('new-shores-audio') || '{}');
      muted = !!prefs.muted;
      musicOn = prefs.music !== false;
    } catch (e) { /* defaults */ }

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
    const saveAudioPrefs = () => {
      try { localStorage.setItem('new-shores-audio', JSON.stringify({ muted, music: musicOn })); } catch (e) { /* ignore */ }
    };
    const applyAudio = () => {
      $('btn-mute').textContent = muted ? '🔇' : '🔊';
      const bm = $('btn-music');
      if (bm) {
        bm.textContent = musicOn ? '🎵' : '🎵̸';
        bm.classList.toggle('off', !musicOn);
      }
      if (ambience) ambience.master.gain.value = muted ? 0 : 0.05;
      if (typeof Music !== 'undefined') Music.setEnabled(musicOn && !muted);
    };
    $('btn-mute').addEventListener('click', () => { muted = !muted; applyAudio(); saveAudioPrefs(); });
    const bmBtn = $('btn-music');
    if (bmBtn) bmBtn.addEventListener('click', () => { musicOn = !musicOn; applyAudio(); saveAudioPrefs(); });
    applyAudio();

    // browsers only allow audio after a user gesture
    window.addEventListener('pointerdown', () => startAmbience(), { once: true });
    // mobile browsers may re-suspend the context (tab switch, phone call)
    window.addEventListener('pointerdown', () => {
      try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) { /* ignore */ }
    });

    Hooks.toast = toastMsg;
    Hooks.sfx = sfx;
    Hooks.onChange = refreshToolbar;
    if (typeof Render !== 'undefined') Hooks.fx = Render.fx;
    refreshSpeedButtons();
  }

  return {
    init, updateHUD, buildToolbar, refreshToolbar, setActiveTool, setHint,
    openModal, closeModal, closeAllModals, anyModalOpen, toastMsg, refreshSpeedButtons,
    refreshStats, hoverTile, tipHide,
  };
})();
