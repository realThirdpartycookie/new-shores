'use strict';
/* ============================================================
 * Procedural island generation (seeded).
 * ============================================================ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Coarse random grid sampled with smooth bilinear interpolation.
function noiseGrid(n, rng) {
  const g = new Float32Array((n + 1) * (n + 1));
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const smooth = t => t * t * (3 - 2 * t);
  return function (x, y) { // x, y in [0,1]
    const fx = Math.min(x * n, n - 1e-6), fy = Math.min(y * n, n - 1e-6);
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = smooth(fx - ix), ty = smooth(fy - iy);
    const i00 = g[iy * (n + 1) + ix], i10 = g[iy * (n + 1) + ix + 1];
    const i01 = g[(iy + 1) * (n + 1) + ix], i11 = g[(iy + 1) * (n + 1) + ix + 1];
    return (i00 * (1 - tx) + i10 * tx) * (1 - ty) + (i01 * (1 - tx) + i11 * tx) * ty;
  };
}

function tileHash(x, y) {
  let h = (x * 73856093) ^ (y * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  return (h % 1000) / 1000;
}

/* Returns { tiles: Uint8Array, shore: Uint8Array } */
function generateMap(seed) {
  const rng = mulberry32(seed);
  const n1 = noiseGrid(6, rng), n2 = noiseGrid(12, rng), n3 = noiseGrid(24, rng);
  const mNoise = noiseGrid(9, rng);  // mountains
  const tNoise = noiseGrid(14, rng); // trees

  const tiles = new Uint8Array(MAPW * MAPH);
  const cx = MAPW / 2, cy = MAPH / 2;

  for (let y = 0; y < MAPH; y++) {
    for (let x = 0; x < MAPW; x++) {
      const nx = x / MAPW, ny = y / MAPH;
      const v = n1(nx, ny) * 0.55 + n2(nx, ny) * 0.3 + n3(nx, ny) * 0.15;
      const dx = (x - cx) / (MAPW * 0.48), dy = (y - cy) / (MAPH * 0.48);
      const d = Math.sqrt(dx * dx + dy * dy); // 0 centre → ~1 edge
      const e = v * 0.55 + (1 - d * d) * 0.62 - 0.18;

      let t;
      if (e < 0.30) t = TILE.DEEP;
      else if (e < 0.42) t = TILE.WATER;
      else if (e < 0.47) t = TILE.SAND;
      else t = TILE.GRASS;

      if (t === TILE.GRASS) {
        if (mNoise(nx, ny) > 0.78 && d < 0.55 && e > 0.62) t = TILE.ROCK;
        else if (tNoise(nx, ny) > 0.58) t = TILE.TREE;
      }
      tiles[y * MAPW + x] = t;
    }
  }

  // Sand fringe: grass/tree touching water becomes sand
  const isWater = t => t === TILE.WATER || t === TILE.DEEP;
  const copy = tiles.slice();
  for (let y = 0; y < MAPH; y++) {
    for (let x = 0; x < MAPW; x++) {
      const t = copy[y * MAPW + x];
      if (t !== TILE.GRASS && t !== TILE.TREE && t !== TILE.ROCK) continue;
      let touch = false;
      for (let dy = -1; dy <= 1 && !touch; dy++) {
        for (let dx = -1; dx <= 1 && !touch; dx++) {
          const nx2 = x + dx, ny2 = y + dy;
          if (nx2 < 0 || ny2 < 0 || nx2 >= MAPW || ny2 >= MAPH) continue;
          if (isWater(copy[ny2 * MAPW + nx2])) touch = true;
        }
      }
      if (touch) tiles[y * MAPW + x] = TILE.SAND;
    }
  }

  // Shoreline foam flags: water tiles adjacent to land
  const shore = new Uint8Array(MAPW * MAPH);
  for (let y = 0; y < MAPH; y++) {
    for (let x = 0; x < MAPW; x++) {
      if (!isWater(tiles[y * MAPW + x])) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx2 = x + dx, ny2 = y + dy;
          if (nx2 < 0 || ny2 < 0 || nx2 >= MAPW || ny2 >= MAPH) continue;
          if (!isWater(tiles[ny2 * MAPW + nx2])) { shore[y * MAPW + x] = 1; break; }
        }
      }
    }
  }

  return { tiles, shore };
}

/* Find a 2x2 grass spot near the coast for the starting Warehouse. */
function findWarehouseSpot(tiles) {
  const cx = MAPW / 2, cy = MAPH / 2;
  let best = null, bestScore = Infinity;
  for (let y = 2; y < MAPH - 3; y++) {
    for (let x = 2; x < MAPW - 3; x++) {
      let ok = true;
      for (let dy = 0; dy < 2 && ok; dy++) {
        for (let dx = 0; dx < 2 && ok; dx++) {
          const t = tiles[(y + dy) * MAPW + x + dx];
          if (t !== TILE.GRASS && t !== TILE.TREE) ok = false;
        }
      }
      if (!ok) continue;
      // coast within 4 tiles?
      let coast = false;
      for (let dy = -4; dy <= 5 && !coast; dy++) {
        for (let dx = -4; dx <= 5 && !coast; dx++) {
          const nx2 = x + dx, ny2 = y + dy;
          if (nx2 < 0 || ny2 < 0 || nx2 >= MAPW || ny2 >= MAPH) continue;
          const t = tiles[ny2 * MAPW + nx2];
          if (t === TILE.WATER || t === TILE.DEEP) coast = true;
        }
      }
      if (!coast) continue;
      const score = Math.abs(x - cx) + Math.abs(y - cy);
      if (score < bestScore) { bestScore = score; best = { x, y }; }
    }
  }
  return best || { x: Math.floor(cx), y: Math.floor(cy) };
}
