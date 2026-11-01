// Height tools from Bryce 3D's terrain editor.
// The arithmetic follows the MIT-licensed description in
// https://github.com/tatleoat/stecyk3d (terrain.rs, terrain_tools.rs):
// the C runtime generator, New, Fractal, Erode, Smooth, and bilinear resize.

const HEIGHT_MAX = 65535;
const DRAW_MAX = 32767;

/** MSVC / Metrowerks `rand`: state = state * 214013 + 2531011, result (state >> 16) & 0x7fff. */
export function createRand(seed = 1) {
  let state = seed >>> 0;
  return {
    next() {
      state = (Math.imul(state, 214013) + 2531011) >>> 0;
      return (state >>> 16) & 0x7fff;
    },
    get state() {
      return state;
    },
  };
}

function limited(v) {
  if (v < 0) return 0;
  if (v > HEIGHT_MAX) return HEIGHT_MAX;
  return v | 0;
}

function divTrunc(a, b) {
  return a < 0 ? Math.ceil(a / b) : Math.floor(a / b);
}

function roundRatio(n, d) {
  return Math.floor((2 * n + d) / (2 * d));
}

/** Bilinear resize, truncated, as the editor resizes a grid. */
export function resize(heights, side, to) {
  if (side === to) return heights.slice();
  const places = new Array(to);
  for (let a = 0; a < to; a++) {
    const place = (a * (side - 1)) / (to - 1);
    const whole = place | 0;
    const frac = place - whole;
    const next = whole + 1 < side ? whole + 1 : whole;
    places[a] = [whole, next, frac];
  }
  const out = new Uint16Array(to * to);
  let i = 0;
  for (let r = 0; r < to; r++) {
    const [r0, r1, fr] = places[r];
    for (let c = 0; c < to; c++) {
      const [c0, c1, fc] = places[c];
      const h00 = heights[r0 * side + c0];
      const h01 = heights[r0 * side + c1];
      const h10 = heights[r1 * side + c0];
      const h11 = heights[r1 * side + c1];
      const top = h00 + (h01 - h00) * fc;
      const bottom = h10 + (h11 - h10) * fc;
      out[i++] = (top + (bottom - top) * fr) | 0;
    }
  }
  return out;
}

function zeroBorder(h, side) {
  for (let i = 0; i < side; i++) {
    h[i] = 0;
    h[(side - 1) * side + i] = 0;
    h[i * side] = 0;
    h[i * side + side - 1] = 0;
  }
}

function applyBell(h, side) {
  const middle = (side / 2) | 0;
  const s2 = side * side;
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const dr = row - middle;
      const dc = col - middle;
      const factor = Math.exp((-6.4 * (dr * dr + dc * dc)) / s2);
      const i = row * side + col;
      h[i] = (h[i] * factor) | 0;
    }
  }
}

function spread(h) {
  let lo = 65535;
  let hi = 0;
  for (let i = 0; i < h.length; i++) {
    if (h[i] < lo) lo = h[i];
    if (h[i] > hi) hi = h[i];
  }
  if (hi === lo) {
    h.fill(0);
    return;
  }
  for (let i = 0; i < h.length; i++) {
    let v = Math.trunc(((h[i] - lo - 1) * HEIGHT_MAX) / (hi - lo));
    if (v < 0) v = 0;
    else if (v > HEIGHT_MAX) v = HEIGHT_MAX;
    h[i] = v;
  }
}

/**
 * Bryce's New terrain: an 8×8 random grid grown to 128, belled into an island, then spread.
 * `seed` is the C `srand` seed. Seed 1 is the generator's start state.
 */
export function newRelief(seed = 1) {
  const rng = createRand(seed);
  const coarse = 8;
  let side = coarse;
  let h = new Uint16Array(coarse * coarse);
  for (let i = 0; i < h.length; i++) {
    const r = rng.next();
    h[i] = roundRatio(r * HEIGHT_MAX, DRAW_MAX);
  }
  let amplitude = 32767;
  while (side < 128) {
    const next = side * 2;
    h = resize(h, side, next);
    side = next;
    if (side === 32) applyBell(h, side);
    const halfUp = amplitude - Math.floor(amplitude / 2);
    for (let i = 0; i < h.length; i++) {
      const r = rng.next();
      const hv = h[i];
      const reach = Math.max(1, Math.floor((Math.floor((hv * amplitude) / HEIGHT_MAX) + halfUp) / 2));
      const d = roundRatio(2 * reach * r, DRAW_MAX);
      h[i] = limited(hv + d - reach);
    }
    zeroBorder(h, side);
    amplitude = Math.floor(amplitude / 2);
  }
  applyBell(h, side);
  spread(h);
  return { heights: h, side };
}

function fractalLevel(h, m, reach, rng) {
  for (let i = 0; i < h.length; i++) {
    const r = rng.next();
    const p = (h[i] * reach) | 0;
    let a = Math.floor((divTrunc(p, 65535) + reach - divTrunc(reach, 2)) / 2);
    if (a < 2) a = 1;
    const x =
      (2 * a * (r * (1 / 32767)) + 0.5 - a + h[i]);
    h[i] = limited(Math.trunc(x));
  }
  zeroBorder(h, m);
}

/** Fractal, one click, on a square grid. The generator starts at `seed` unless a session `rng` is passed. */
export function fractal(heights, side, seed = 1, rng = null) {
  if (!rng) rng = createRand(seed);
  let curSide = 16;
  let cur = resize(heights, side, curSide);
  let reach = 65535;
  for (;;) {
    fractalLevel(cur, curSide, reach, rng);
    reach = Math.floor(reach / 2);
    if (curSide >= side) break;
    const next = curSide * 2;
    cur = resize(cur, curSide, next);
    curSide = next;
  }
  stretchFull(cur);
  const out = curSide === side ? cur : resize(cur, curSide, side);
  return { heights: out, side };
}

function stretchFull(h) {
  let lo = 65535;
  let hi = 0;
  for (let i = 0; i < h.length; i++) {
    if (h[i] < lo) lo = h[i];
    if (h[i] > hi) hi = h[i];
  }
  if (hi !== lo && hi > 0) {
    for (let i = 0; i < h.length; i++) {
      h[i] = limited(Math.trunc(((h[i] - lo) * 65535) / (hi - lo)));
    }
  }
}

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

function dropletRun(h, m, count, rate, rng) {
  const px = new Int16Array(320);
  const py = new Int16Array(320);
  const ph = new Int32Array(320);
  const hs = new Int32Array(320);
  const old = new Int32Array(320);
  const mi = m;
  for (let n = 0; n < count; n++) {
    const r1 = rng.next();
    const r2 = rng.next();
    px[0] = 2 + (r1 % (m - 4));
    py[0] = 2 + (r2 % (m - 4));
    ph[0] = h[py[0] * m + px[0]];
    let len = 1;
    let dir = 2;
    let flat = 0;
    for (;;) {
      const x = px[len - 1];
      const y = py[len - 1];
      const hh = ph[len - 1];
      const heightAt = (d) => {
        const nx = (x + DX[d] + mi) % mi;
        const ny = (y + DY[d] + mi * 2) % mi;
        return h[ny * m + nx];
      };
      let best = heightAt(dir);
      for (let d = 0; d < 8; d++) {
        if (d % 2 === 1 && rng.next() >= 6540) continue;
        const hd = heightAt(d);
        if (hd < best) {
          dir = d;
          best = hd;
        }
      }
      if (rng.next() < 3270) dir = (dir + 1) % 8;
      else if (rng.next() < 3270) dir = (dir + 7) % 8;
      const hp = heightAt(dir);
      flat += hp === hh ? 1 : -1;
      if (len < 320 && hp <= hh && flat <= 5 && hp > 0 && hp <= 65535) {
        px[len] = (x + DX[dir] + mi) % mi;
        py[len] = (y + DY[dir] + mi) % mi;
        ph[len] = hp;
        len++;
      } else break;
    }
    const k = len - 1;
    if (k <= 8) continue;
    const e = ph[k];
    const half = (k / 2) | 0;
    for (let j = 0; j <= k; j++) hs[j] = ph[j];
    let w = 64;
    for (let j = 0; j < half; j++) {
      let t = Math.floor(w / 64);
      if (t > 255) t = 256;
      const carved = hs[j] - 32 * t;
      hs[j] = carved > e ? carved : e;
      w += rate;
    }
    for (let j = half; j < k; j++) {
      const carved = hs[j] - 32 * Math.floor(w / 64);
      hs[j] = carved > e ? carved : e;
      w -= rate;
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j <= k; j++) old[j] = hs[j];
      for (let j = 0; j <= k; j++) {
        const a = old[Math.min(j + 1, k)];
        const b = old[Math.min(j + 2, k)];
        hs[j] = Math.floor((2 * old[j] + a + b) / 4);
      }
    }
    for (let j = 0; j <= k; j++) {
      h[py[j] * m + px[j]] = limited(hs[j]);
    }
    if (k > 20) {
      const steps = [
        [1, 0],
        [-2, 0],
        [1, 1],
        [0, -2],
      ];
      for (let j = 10; j <= k; j++) {
        let weight = (j - 10) * (1 / 54);
        if (weight >= 0.75) weight = 0.75;
        let x = px[j];
        let y = py[j];
        for (let s = 0; s < 4; s++) {
          x = Math.max(0, Math.min(mi - 1, x + steps[s][0]));
          y = Math.max(0, Math.min(mi - 1, y + steps[s][1]));
          const cell = y * m + x;
          const g = h[cell];
          h[cell] = limited(Math.trunc(g + (hs[j] - g) * weight));
        }
      }
    }
  }
}

/**
 * Erode, one click: 1500 droplets are drawn and discarded (they only advance the generator),
 * then 500 droplets carve the grid.
 */
export function erode(heights, side, seed = 1, rng = null) {
  if (!rng) rng = createRand(seed);
  const copy = heights.slice();
  dropletRun(copy, side, 1500, 24, rng);
  const h = heights.slice();
  dropletRun(h, side, 500, 24, rng);
  return { heights: h, side };
}

/** The editor's smooth: rows, then columns. */
export function smooth(heights, side) {
  const n = side;
  const v = new Int32Array(heights.length);
  for (let i = 0; i < heights.length; i++) v[i] = heights[i];
  const line = new Int32Array(n);
  const old = new Int32Array(n);
  const blur = () => {
    old.set(line);
    for (let i = 1; i < n - 2; i++) {
      line[i] = Math.floor((old[i - 1] + 2 * old[i] + old[i + 1]) / 4);
    }
    if (n >= 3) line[n - 2] = Math.floor((old[n - 3] + 3 * old[n - 2]) / 4);
  };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) line[c] = v[r * n + c];
    blur();
    for (let c = 0; c < n; c++) v[r * n + c] = line[c];
  }
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < n; r++) line[r] = v[r * n + c];
    blur();
    for (let r = 0; r < n; r++) v[r * n + c] = line[r];
  }
  const out = new Uint16Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i];
  return { heights: out, side };
}

function chanceX(r) {
  return Math.trunc((r * (1 / 32767) - 0.5) * 65535);
}

function at(heights, side, r, c) {
  if (r < 0) r = 0;
  else if (r >= side) r = side - 1;
  if (c < 0) c = 0;
  else if (c >= side) c = side - 1;
  return heights[r * side + c];
}

function smoothLines(values, n) {
  const line = new Int32Array(n);
  const old = new Int32Array(n);
  const blur = () => {
    old.set(line);
    for (let i = 1; i < n - 2; i++) {
      line[i] = Math.floor((old[i - 1] + 2 * old[i] + old[i + 1]) / 4);
    }
    if (n >= 3) line[n - 2] = Math.floor((old[n - 3] + 3 * old[n - 2]) / 4);
  };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) line[c] = values[r * n + c];
    blur();
    for (let c = 0; c < n; c++) values[r * n + c] = line[c];
  }
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < n; r++) line[r] = values[r * n + c];
    blur();
    for (let r = 0; r < n; r++) values[r * n + c] = line[r];
  }
}

function isqrt(v) {
  let r = Math.trunc(Math.sqrt(v));
  while (r * r > v) r -= 1;
  while ((r + 1) * (r + 1) <= v) r += 1;
  return r;
}

function mapHeights(heights, fn) {
  const out = new Uint16Array(heights.length);
  for (let i = 0; i < heights.length; i++) out[i] = limited(fn(heights[i], i));
  return out;
}

function smoothing(heights, side) {
  const out = heights.slice();
  for (let r = 0; r < side; r++) {
    const up = r === 0 ? 0 : r - 1;
    const down = r + 1 < side ? r + 1 : side - 1;
    for (let c = 1; c < side - 1; c++) {
      let s = 0;
      for (const rr of [up, r, down]) {
        for (let cc = c - 1; cc <= c + 1; cc++) s += heights[rr * side + cc];
      }
      const v = heights[r * side + c];
      s -= v;
      out[r * side + c] = limited(Math.floor((15 * s + 10 * v) / 128));
    }
  }
  return out;
}

function sharpening(heights, side) {
  const out = heights.slice();
  for (let r = 0; r < side; r++) {
    const up = r === 0 ? 0 : r - 1;
    const down = r + 1 < side ? r + 1 : side - 1;
    for (let c = 1; c < side - 1; c++) {
      let s = 0;
      for (const rr of [up, r, down]) {
        for (let cc = c - 1; cc <= c + 1; cc++) s += heights[rr * side + cc];
      }
      const v = heights[r * side + c];
      s -= v;
      out[r * side + c] = limited(Math.floor((1643 * v - 189 * s) / 128));
    }
  }
  return out;
}

function edgeMask(heights, side, mask) {
  const h = (side / 2) | 0;
  const out = new Uint16Array(heights.length);
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      const v = heights[r * side + c];
      const m = mask(r - h, c - h, side, h);
      out[r * side + c] = m.ratio != null ? ((v * m.ratio) / h) | 0 : Math.floor(v * m.factor);
    }
  }
  return out;
}

function squareEdges(heights, side) {
  const h = (side / 2) | 0;
  return edgeMask(heights, side, (dr, dc) => ({ ratio: Math.max(0, h - Math.max(Math.abs(dr), Math.abs(dc))) }));
}

function roundEdges(heights, side) {
  const h = (side / 2) | 0;
  return edgeMask(heights, side, (dr, dc) => ({ ratio: Math.max(0, h - Math.floor((dr * dr + dc * dc) / h)) }));
}

function gaussianEdges(heights, side) {
  const n2 = side * side;
  return edgeMask(heights, side, (dr, dc) => ({ factor: Math.exp((-6.4 * (dr * dr + dc * dc)) / n2) }));
}

function posterize(heights, step) {
  const s = Math.max(1, step | 0);
  return mapHeights(heights, (v) => (Math.floor(v / s) * s));
}

function heightNoise(heights, rng) {
  return mapHeights(heights, (v) => {
    const r = rng.next();
    const half = (v / 2) | 0;
    const add = Math.floor((640 * (2 * half * r + 32767)) / (65535 * 32767));
    return v + add;
  });
}

function basicNoise(heights, d, rng) {
  const big = 16 * Math.abs(d);
  return mapHeights(heights, (v) => {
    const r = rng.next();
    const x = 2 * big * (r * (1 / 32767)) + 0.5 - big + v;
    return Math.trunc(x);
  });
}

function sawtooth(heights, side, rng) {
  const h = new Int32Array(heights);
  const n = side;
  for (let wave = 0; wave < 16; wave++) {
    const a = rng.next();
    const b = rng.next();
    const d = rng.next();
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const t = d * a + r * b + c * a;
        const m = Math.floor(t / n) % 32767;
        const add = Math.floor((m - 16383) / 2);
        const i = r * n + c;
        let v = h[i] + add;
        if (v < 0) v = 0;
        else if (v > HEIGHT_MAX) v = HEIGHT_MAX;
        h[i] = v;
      }
    }
  }
  return Uint16Array.from(h);
}

function subcontours(heights, side) {
  const n = side;
  const m = new Int32Array(heights);
  for (let r = 0; r < n; r++) {
    for (let c = 1; c < n - 1; c++) {
      if (Math.abs(heights[r * n + c - 1] - heights[r * n + c + 1]) > 960) m[r * n + c] = 0;
    }
  }
  for (let r = 1; r < n - 1; r++) {
    for (let c = 0; c < n; c++) {
      if (Math.abs(heights[(r - 1) * n + c] - heights[(r + 1) * n + c]) > 960) m[r * n + c] = 0;
    }
  }
  smoothLines(m, n);
  const out = new Uint16Array(heights.length);
  for (let i = 0; i < heights.length; i++) {
    out[i] = limited(m[i] + Math.floor((40 * (heights[i] - m[i])) / 100));
  }
  return out;
}

function spikes(heights, side, rng) {
  const n = side;
  const f = new Int32Array(n * n);
  if (n > 7) {
    const k = ((n - 5) / 3) | 0;
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        const x = chanceX(rng.next());
        const peak = x > 28000 ? 65535 : x > 16000 ? 63487 : 0;
        const row = 1 + 3 * i;
        const col = 1 + 3 * j + (x < 0 ? 0 : x % 3);
        const half = (peak / 2) | 0;
        f[row * n + col] = peak;
        f[row * n + col + 1] = half;
        f[row * n + col - 1] = half;
        f[(row + 1) * n + col] = half;
        f[(row - 1) * n + col] = half;
      }
    }
  }
  const out = new Uint16Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (r === n - 1 || c === n - 1) {
        out[r * n + c] = f[r * n + c];
      } else {
        const g = (rr, cc) => heights[rr * n + cc];
        const curve = Math.abs(g(r, c + 1) - 2 * g(r, c) + g(r + 1, c));
        out[r * n + c] = curve < 1024 ? limited(g(r, c) + Math.floor((16384 * f[r * n + c]) / 65535)) : g(r, c);
      }
    }
  }
  return out;
}

function slopeNoise(heights, side, rng) {
  const n = side;
  const s = new Int32Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const sum =
        Math.abs(at(heights, n, r, c - 1) - at(heights, n, r, c + 1)) +
        Math.abs(at(heights, n, r - 1, c) - at(heights, n, r + 1, c)) +
        Math.abs(at(heights, n, r - 1, c - 1) - at(heights, n, r + 1, c + 1)) +
        Math.abs(at(heights, n, r + 1, c - 1) - at(heights, n, r - 1, c + 1));
      s[r * n + c] = sum % 65536;
    }
  }
  smoothLines(s, n);
  const out = new Uint16Array(n * n);
  for (let i = 0; i < out.length; i++) {
    const rnd = rng.next();
    const sv = s[i];
    const a = rnd * (1 / 32767);
    const f = (((a * (2 * sv) + 0.5 - sv) * 4096) / 65535);
    out[i] = limited(heights[i] + Math.trunc(f));
  }
  return out;
}

function moundStep(base, u, m, rng) {
  const out = base.slice();
  for (let r = 1; r < m - 1; r++) {
    for (let c = 1; c < m - 1; c++) {
      const x = chanceX(rng.next());
      const c2 = x < -16000 || (x >= 0 && x <= 16000) ? c - 1 : c + 1;
      const uu = (rr, cc) => u[rr * m + cc];
      const best = x < 0
        ? Math.max(uu(r - 1, c), uu(r, c), uu(r - 1, c2), uu(r, c2))
        : Math.max(uu(r + 1, c), uu(r, c), uu(r + 1, c2), uu(r, c2));
      out[r * m + c - 1] = Math.max(0, best - 12);
    }
  }
  return out;
}

function moundPass(v, m, f, rng) {
  const t = new Int32Array(m * m);
  if (m > 10) {
    const k = ((m - 8) / 3) | 0;
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        const x = chanceX(rng.next());
        if (x <= 16000) continue;
        const e = x % 512;
        const peak = x > 28000 ? 65535 - e : 512 - e;
        const o = x % 3;
        const y = 5 + 3 * i;
        const xx = 5 + 3 * j + o;
        const cells = o === 0
          ? [[y, xx - 1], [y, xx], [y, xx + 1], [y + 1, xx], [y + 1, xx + 1], [y - 1, xx - 1], [y - 1, xx]]
          : o === 1
            ? [[y + 1, xx - 1], [y + 1, xx], [y + 1, xx + 1], [y + 1, xx + 2], [y + 2, xx], [y + 2, xx + 1], [y, xx], [y, xx + 1]]
            : [[y, xx - 1], [y, xx], [y, xx + 1], [y + 1, xx - 1], [y + 1, xx], [y + 1, xx + 1], [y - 1, xx]];
        for (const [rr, cc] of cells) {
          if (rr >= 0 && cc >= 0 && rr < m && cc < m) t[rr * m + cc] = peak;
        }
      }
    }
  }
  smoothLines(t, m);
  const u = new Int32Array(m * m);
  for (let i = 0; i < u.length; i++) u[i] = Math.max(Math.trunc(t[i] * f), v[i]);
  return moundStep(v, u, m, rng);
}

function mounds(heights, side, rng) {
  const n = side;
  if (n <= 64) return moundPass(heights, n, 0.5, rng);
  let curSide = 64;
  let cur = resize(heights, n, curSide);
  let f = 0.5;
  for (;;) {
    cur = moundPass(cur, curSide, f, rng);
    f /= 2;
    if (curSide >= n) break;
    const next = Math.min(curSide * 2, n);
    cur = resize(cur, curSide, next);
    curSide = next;
  }
  return cur;
}

function eroded(heights, side, rng) {
  let curSide = Math.max(16, (side / 4) | 0);
  let h = resize(heights, side, curSide);
  zeroBorder(h, curSide);
  let wrapped = smooth(h, curSide).heights;
  wrapped = smooth(wrapped, curSide).heights;
  h = wrapped;
  let count = 200;
  let rate = 200;
  for (;;) {
    stretchFull(h);
    h = smooth(h, curSide).heights;
    dropletRun(h, curSide, count, rate, rng);
    for (let i = 0; i < h.length; i++) h[i] = 65535 - h[i];
    h = smooth(h, curSide).heights;
    dropletRun(h, curSide, count, rate, rng);
    for (let i = 0; i < h.length; i++) h[i] = 65535 - h[i];
    count *= 2;
    rate = Math.trunc(rate * (2 / 3));
    if (curSide >= side) break;
    const next = Math.min(curSide * 2, side);
    h = resize(h, curSide, next);
    curSide = next;
  }
  return smooth(h, curSide).heights;
}

function subplateaus(heights, side, rng) {
  if (side < 4) return heights.slice();
  let h = heights.slice();
  for (let pass = 0; pass < 4; pass++) {
    const u = new Int32Array(h.length);
    for (let i = 0; i < h.length; i++) u[i] = h[i];
    h = moundStep(h, u, side, rng);
  }
  return smooth(h, side).heights;
}

function reliefNoise(heights, side) {
  const above = [2330, 258, -1147];
  const same = [924, -4474, 925];
  const below = [1147, 258, 2330];
  const out = heights.slice();
  for (let r = 0; r < side; r++) {
    const rows = [
      [r === 0 ? 0 : r - 1, above],
      [r, same],
      [r + 1 < side ? r + 1 : side - 1, below],
    ];
    for (let c = 1; c < side - 1; c++) {
      let sum = 0;
      for (const [rr, weights] of rows) {
        for (let k = 0; k < 3; k++) sum += weights[k] * heights[rr * side + c + k - 1];
      }
      out[r * side + c] = limited(Math.floor(sum / 2048));
    }
  }
  return out;
}

function centredShape(heights, side, kind, d, e) {
  const n = side;
  const h = (n / 2) | 0;
  const raise = kind === "raise-edges";
  const c0 = raise ? h : h + d;
  const r0 = raise ? h : h + e;
  let big = h - d;
  if (kind === "bubbles") big = h;
  if (kind === "cross" || kind === "cross2") big = Math.min(c0, n - c0, r0, n - r0);
  const out = new Uint16Array(heights.length);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = heights[r * n + c];
      const dc = Math.abs(c - c0);
      const dr = Math.abs(r - r0);
      const gap = 65535 - v;
      let x = v;
      if (kind === "raise-edges") {
        const raw = Math.floor((Math.min(h, Math.max(dc, dr)) * 4 * d) / h);
        const w = raw < 0 ? 0 : raw > h ? h : raw;
        x = v + Math.floor((gap * w) / h);
      } else if (kind === "blob" || kind === "bubbles") {
        let a = isqrt(dr * dr + dc * dc);
        if (a < 0) a = 0;
        if (a > big) a = big;
        x = v + Math.floor(((big - a) * gap) / h);
      } else if (kind === "cross") {
        let m = Math.min(dc, dr);
        if (m < 0) m = 0;
        if (m > big) m = big;
        x = v + Math.floor((gap * m) / h);
      } else {
        let m = Math.min(dc, dr);
        if (m < 0) m = 0;
        if (m > big) m = big;
        x = v + Math.floor(((big - m) * gap) / h);
      }
      out[r * n + c] = limited(x);
    }
  }
  return out;
}

/**
 * One editor click. Random tools continue `rng` (the C session). Amount tools use one
 * short drag so a press is visible: posterize step 4096, basic noise and raise edges
 * at a quarter of the grid.
 */
export function applyEffect(name, heights, side, rng) {
  const h = (side / 2) | 0;
  switch (name) {
    case "invert":
      return mapHeights(heights, (v) => 65535 - v);
    case "raise":
      return mapHeights(heights, (v) => Math.floor((256 * v + 64 * v) / 256));
    case "lower":
      return mapHeights(heights, (v) => Math.floor((256 * v - 64 * v) / 256));
    case "equalize": {
      let lo = 65535;
      let hi = 0;
      for (let i = 0; i < heights.length; i++) {
        if (heights[i] < lo) lo = heights[i];
        if (heights[i] > hi) hi = heights[i];
      }
      if (hi === lo) return heights.slice();
      return mapHeights(heights, (v) => Math.floor(((v - lo) * 65535) / (hi - lo)));
    }
    case "dampen":
      return mapHeights(heights, (v) => Math.floor((256 * v + 64 * (2 * v - 65535)) / 256));
    case "smoothing":
      return smoothing(heights, side);
    case "sharpen":
      return sharpening(heights, side);
    case "square":
      return squareEdges(heights, side);
    case "round":
      return roundEdges(heights, side);
    case "gaussian":
      return gaussianEdges(heights, side);
    case "posterize":
      return posterize(heights, 4096);
    case "height-noise":
      return heightNoise(heights, rng);
    case "basic-noise":
      return basicNoise(heights, h >> 1, rng);
    case "sawtooth":
      return sawtooth(heights, side, rng);
    case "subcontours":
      return subcontours(heights, side);
    case "spikes":
      return spikes(heights, side, rng);
    case "slope-noise":
      return slopeNoise(heights, side, rng);
    case "mounds":
      return mounds(heights, side, rng);
    case "eroded":
      return eroded(heights, side, rng);
    case "subplateaus":
      return subplateaus(heights, side, rng);
    case "relief":
      return reliefNoise(heights, side);
    case "blob":
    case "bubbles":
    case "cross":
    case "cross2":
      return centredShape(heights, side, name, 0, 0);
    case "raise-edges":
      return centredShape(heights, side, name, h >> 1, 0);
    default:
      return heights.slice();
  }
}

export function blank(side) {
  return { heights: new Uint16Array(side * side), side };
}
