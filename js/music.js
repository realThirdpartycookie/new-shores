'use strict';
/* ============================================================
 * Procedural music director (WebAudio, zero assets).
 *
 * A lookahead scheduler composes gentle renaissance-flavoured
 * music bar by bar: lute-like plucks over a soft pad and bass.
 * The mood follows the game — calm days, sparse nights, muted
 * storms, and a driving theme while pirates are on the water.
 * ============================================================ */

const Music = (() => {
  let ctx = null;
  let master = null;     // music bus (separate from SFX/ambience)
  let delay = null;      // echo for the melody plucks
  let timer = null;
  let nextBar = 0;
  let enabled = true;
  let volume = 0.14;
  let melodyDeg = 4;     // random-walk position in the scale
  let barCount = 0;

  const NOTE = n => 440 * Math.pow(2, (n - 69) / 12);

  /* Progressions as [root midi, isMinor]. A minor throughout, with the
   * old Andalusian descent for storms and a tense Am–F–E for pirates. */
  const MOODS = {
    calm:   { bpm: 72,  prog: [[45, 1], [41, 0], [48, 0], [43, 0]], melodyProb: 0.4,  lp: 950, padVol: 0.045 },
    night:  { bpm: 56,  prog: [[45, 1], [41, 0]],                   melodyProb: 0.15, lp: 700, padVol: 0.04 },
    storm:  { bpm: 66,  prog: [[45, 1], [43, 0], [41, 0], [40, 0]], melodyProb: 0.12, lp: 480, padVol: 0.05 },
    pirate: { bpm: 104, prog: [[45, 1], [45, 1], [41, 0], [40, 0]], melodyProb: 0.55, lp: 1200, padVol: 0.05, drums: true },
  };

  // melody scale: A natural minor degrees, walked up to two octaves
  const SCALE = [0, 2, 3, 5, 7, 8, 10, 12, 14, 15, 17, 19];

  function currentMood() {
    try {
      if (typeof G !== 'undefined') {
        if (G.pirate && G.pirate.state !== 'sinking') return 'pirate';
        if (G.stormT > 0) return 'storm';
        if (typeof Render !== 'undefined' && Render.nightFactor(G.time) > 0.5) return 'night';
      }
    } catch (e) { /* state not ready */ }
    return 'calm';
  }

  function env(g, t0, attack, peak, decay) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  function pluck(freq, t0, vol) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = freq;
    env(g, t0, 0.012, vol, 0.5);
    o.connect(g);
    g.connect(delay.input);
    o.start(t0); o.stop(t0 + 0.6);
  }

  function padNote(freq, t0, dur, vol, lpFreq) {
    const o = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = lpFreq;
    o.type = 'triangle'; o.frequency.value = freq;
    o2.type = 'triangle'; o2.frequency.value = freq * 1.004; // gentle chorus
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 1.1);
    g.gain.setValueAtTime(vol, t0 + dur - 1.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(master);
    o.start(t0); o2.start(t0);
    o.stop(t0 + dur); o2.stop(t0 + dur);
  }

  function bassNote(freq, t0, vol) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    env(g, t0, 0.02, vol, 0.9);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + 1);
  }

  let drumBuf = null;
  function drum(t0, vol) {
    if (!drumBuf) {
      const len = Math.floor(0.2 * ctx.sampleRate);
      drumBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = drumBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    const src = ctx.createBufferSource();
    src.buffer = drumBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 160;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
    src.connect(lp); lp.connect(g); g.connect(master);
    src.start(t0);
  }

  function scheduleBar(t0) {
    const paused = typeof G !== 'undefined' && G.paused;
    const mood = MOODS[currentMood()];
    const barDur = 60 / mood.bpm * 4;
    if (!paused && enabled && volume > 0) {
      const [root, minor] = mood.prog[barCount % mood.prog.length];
      const third = root + (minor ? 3 : 4);
      // pad chord an octave up, bass on the root
      padNote(NOTE(root + 12), t0, barDur + 0.6, mood.padVol, mood.lp);
      padNote(NOTE(third + 12), t0, barDur + 0.6, mood.padVol * 0.8, mood.lp);
      padNote(NOTE(root + 19), t0, barDur + 0.6, mood.padVol * 0.7, mood.lp);
      bassNote(NOTE(root - 12), t0, 0.055);
      bassNote(NOTE(root - 12), t0 + barDur / 2, 0.04);
      if (mood.drums) {
        drum(t0, 0.10);
        drum(t0 + barDur / 2, 0.07);
      }
      // melody: plucked 8ths random-walking the minor scale
      for (let i = 0; i < 8; i++) {
        if (Math.random() > mood.melodyProb) continue;
        melodyDeg = Math.max(0, Math.min(SCALE.length - 1,
          melodyDeg + (Math.random() < 0.5 ? -1 : 1) * (Math.random() < 0.3 ? 2 : 1)));
        pluck(NOTE(57 + SCALE[melodyDeg]), t0 + i * barDur / 8, 0.05);
      }
    }
    barCount++;
    return barDur;
  }

  function tick() {
    if (!ctx) return;
    try {
      while (nextBar < ctx.currentTime + 0.6) {
        nextBar += scheduleBar(Math.max(nextBar, ctx.currentTime + 0.05));
      }
    } catch (e) { /* keep the game alive whatever audio does */ }
  }

  /* Wire into an existing AudioContext (after the first user gesture). */
  function init(audioCtx) {
    if (ctx || !audioCtx) return;
    try {
      ctx = audioCtx;
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      const d = ctx.createDelay(1);
      d.delayTime.value = 0.28;
      const fb = ctx.createGain();
      fb.gain.value = 0.22;
      const mix = ctx.createGain();
      mix.gain.value = 1;
      d.connect(fb); fb.connect(d);
      mix.connect(master); mix.connect(d); d.connect(master);
      delay = { input: mix };
      nextBar = ctx.currentTime + 0.1;
      timer = setInterval(tick, 200);
    } catch (e) {
      ctx = null; // audio unavailable — the game plays on silently
    }
  }

  function setEnabled(on) {
    enabled = on;
    if (master) master.gain.value = on ? volume : 0;
  }

  function setVolume(v) {
    volume = v;
    if (master && enabled) master.gain.value = v;
  }

  return { init, setEnabled, setVolume, isEnabled: () => enabled };
})();
