// A live spectrogram used as the whole height map.
// Columns are time, scrolling toward the left. Rows are pitch, low at the bottom.

function mod(n, m) {
  return ((n % m) + m) % m;
}

export function readSpectrumColumn(freq, sampleRate, fftSize, side) {
  const col = new Float32Array(side);
  const bins = freq.length;
  const nyquist = sampleRate / 2;
  const lo = 70;
  const hi = Math.min(nyquist * 0.9, 11000);
  const span = Math.log(hi / lo);
  for (let y = 0; y < side; y++) {
    const u0 = y / side;
    const u1 = (y + 1) / side;
    const f0 = lo * Math.exp(span * u0);
    const f1 = lo * Math.exp(span * u1);
    let i0 = Math.max(1, Math.min(bins - 1, Math.floor((f0 / nyquist) * bins)));
    let i1 = Math.max(i0 + 1, Math.min(bins, Math.ceil((f1 / nyquist) * bins)));
    let peak = -200;
    for (let i = i0; i < i1; i++) {
      const db = freq[i];
      if (db > peak) peak = db;
    }
    let v = !Number.isFinite(peak) || peak < -120 ? 0 : (peak + 95) / 70;
    if (v < 0) v = 0;
    else if (v > 1) v = 1;
    col[y] = v;
  }
  return col;
}

export function writeSpectrogram(out, side, history, head, sense) {
  const gain = 0.2 + Math.max(0, Math.min(1, sense)) * 1.8;
  for (let x = 0; x < side; x++) {
    const index = mod(head - side + x, side);
    const src = index * side;
    for (let y = 0; y < side; y++) {
      let v = history[src + y];
      v = Math.pow(v, 0.55) * gain;
      if (v > 1) v = 1;
      else if (v < 0) v = 0;
      const row = side - 1 - y;
      out[row * side + x] = (v * 65535) | 0;
    }
  }
}

function sample16(src, side, x, y) {
  const last = side - 1;
  if (x < 0) x = 0;
  else if (x > last) x = last;
  if (y < 0) y = 0;
  else if (y > last) y = last;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 < last ? x0 + 1 : x0;
  const y1 = y0 < last ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const h00 = src[y0 * side + x0];
  const h01 = src[y0 * side + x1];
  const h10 = src[y1 * side + x0];
  const h11 = src[y1 * side + x1];
  const top = h00 + (h01 - h00) * fx;
  const bottom = h10 + (h11 - h10) * fx;
  return top + (bottom - top) * fy;
}

function applyLevels(src, out, side, low, high, brightness) {
  let lo = low;
  let hi = high;
  if (hi < lo + 0.01) hi = lo + 0.01;
  const scale = 1 / (hi - lo);
  // 0.5 = neutral; above lifts toward gray/white, below darkens.
  const bias = ((brightness == null ? 0.5 : brightness) - 0.5) * 0.9;
  const n = side * side;
  for (let i = 0; i < n; i++) {
    let t = src[i] / 65535;
    t = (t - lo) * scale + bias;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    out[i] = (t * 65535) | 0;
  }
}

let blurTmp = new Float32Array(0);

function boxBlur(src, out, side, radius) {
  const r = radius | 0;
  const n = side * side;
  if (blurTmp.length !== n) blurTmp = new Float32Array(n);
  const tmp = blurTmp;
  const w = r * 2 + 1;
  const last = side - 1;
  for (let y = 0; y < side; y++) {
    const row = y * side;
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      const x = k < 0 ? 0 : k > last ? last : k;
      sum += src[row + x];
    }
    for (let x = 0; x < side; x++) {
      tmp[row + x] = sum / w;
      const xAdd = x + r + 1 > last ? last : x + r + 1;
      const xSub = x - r < 0 ? 0 : x - r;
      sum += src[row + xAdd] - src[row + xSub];
    }
  }
  for (let x = 0; x < side; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      const y = k < 0 ? 0 : k > last ? last : k;
      sum += tmp[y * side + x];
    }
    for (let y = 0; y < side; y++) {
      let v = sum / w;
      if (v < 0) v = 0;
      else if (v > 65535) v = 65535;
      out[y * side + x] = v | 0;
      const yAdd = y + r + 1 > last ? last : y + r + 1;
      const ySub = y - r < 0 ? 0 : y - r;
      sum += tmp[yAdd * side + x] - tmp[ySub * side + x];
    }
  }
}

function zoomInto(src, out, side, zoom) {
  const win = 1 / zoom;
  const origin = (1 - win) * 0.5 * (side - 1);
  const step = win;
  for (let y = 0; y < side; y++) {
    const sy = origin + (y / (side - 1)) * step * (side - 1);
    for (let x = 0; x < side; x++) {
      const sx = origin + (x / (side - 1)) * step * (side - 1);
      let v = sample16(src, side, sx, sy);
      if (v < 0) v = 0;
      else if (v > 65535) v = 65535;
      out[y * side + x] = v | 0;
    }
  }
}

/**
 * Stretch a normalized crop rect (0–1) of src to fill out.
 * @param {Uint16Array} src
 * @param {Uint16Array} out
 * @param {number} side
 * @param {{ x0: number, y0: number, x1: number, y1: number }} crop
 */
export function cropStretch(src, out, side, crop) {
  const last = side - 1;
  let u0 = Math.min(crop.x0, crop.x1);
  let v0 = Math.min(crop.y0, crop.y1);
  let u1 = Math.max(crop.x0, crop.x1);
  let v1 = Math.max(crop.y0, crop.y1);
  if (u1 - u0 < 0.02) {
    const mid = (u0 + u1) * 0.5;
    u0 = mid - 0.01;
    u1 = mid + 0.01;
  }
  if (v1 - v0 < 0.02) {
    const mid = (v0 + v1) * 0.5;
    v0 = mid - 0.01;
    v1 = mid + 0.01;
  }
  u0 = Math.max(0, Math.min(1, u0));
  v0 = Math.max(0, Math.min(1, v0));
  u1 = Math.max(0, Math.min(1, u1));
  v1 = Math.max(0, Math.min(1, v1));
  const xA = u0 * last;
  const yA = v0 * last;
  const xSpan = (u1 - u0) * last;
  const ySpan = (v1 - v0) * last;
  for (let y = 0; y < side; y++) {
    const sy = yA + (y / last) * ySpan;
    for (let x = 0; x < side; x++) {
      const sx = xA + (x / last) * xSpan;
      let v = sample16(src, side, sx, sy);
      if (v < 0) v = 0;
      else if (v > 65535) v = 65535;
      out[y * side + x] = v | 0;
    }
  }
}

function rotateInto(src, out, side, turns) {
  const last = side - 1;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const v = src[y * side + x];
      let dx = x;
      let dy = y;
      if (turns === 1) {
        dx = last - y;
        dy = x;
      } else if (turns === 2) {
        dx = last - x;
        dy = last - y;
      } else if (turns === 3) {
        dx = y;
        dy = last - x;
      }
      out[dy * side + dx] = v;
    }
  }
}

function mirrorInto(src, out, side) {
  const last = side - 1;
  for (let y = 0; y < side; y++) {
    const row = y * side;
    for (let x = 0; x < side; x++) out[row + (last - x)] = src[row + x];
  }
}

function invertInto(src, out, side) {
  const n = side * side;
  for (let i = 0; i < n; i++) out[i] = 65535 - src[i];
}

/**
 * Rectangular → polar: width wraps to 360°, top of the source becomes the
 * center, bottom becomes the outer rim. Outside the inscribed circle is 0.
 */
function radialInto(src, out, side) {
  const last = side - 1;
  const cx = last * 0.5;
  const cy = last * 0.5;
  const maxR = cx > 0 ? cx : 1;
  const twoPi = Math.PI * 2;
  for (let y = 0; y < side; y++) {
    const dy = y - cy;
    const row = y * side;
    for (let x = 0; x < side; x++) {
      const dx = x - cx;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r > maxR + 0.5) {
        out[row + x] = 0;
        continue;
      }
      // 0 at +X, full circle maps across source width.
      let ang = Math.atan2(dy, dx);
      if (ang < 0) ang += twoPi;
      const sx = (ang / twoPi) * last;
      // Top of source → center, bottom → rim.
      const sy = Math.min(last, (r / maxR) * last);
      let v = sample16(src, side, sx, sy);
      if (v < 0) v = 0;
      else if (v > 65535) v = 65535;
      out[row + x] = v | 0;
    }
  }
}

export function presentSpectrogram(src, out, side, view, tmp, tmp2) {
  const blur = view.blur | 0;
  const zoom = view.zoom > 1 ? view.zoom : 1;
  const turns = view.turns & 3;
  const low = view.low || 0;
  const high = view.high == null ? 1 : view.high;
  const brightness = view.brightness == null ? 0.5 : view.brightness;
  const radial = !!view.radial;
  const invert = !!view.invert;
  const plain =
    blur < 1 &&
    zoom <= 1.01 &&
    turns === 0 &&
    !view.mirror &&
    !radial &&
    !invert &&
    low <= 0 &&
    high >= 0.999 &&
    Math.abs(brightness - 0.5) < 0.005;
  if (plain) {
    if (out !== src) out.set(src);
    return;
  }
  applyLevels(src, tmp, side, low, high, brightness);
  let cur = tmp;
  if (blur > 0) {
    boxBlur(cur, tmp2, side, blur);
    cur = tmp2;
  }
  if (zoom > 1.01) {
    const dest = cur === tmp ? tmp2 : tmp;
    zoomInto(cur, dest, side, zoom);
    cur = dest;
  }
  if (turns !== 0) {
    const dest = cur === tmp ? tmp2 : tmp;
    rotateInto(cur, dest, side, turns);
    cur = dest;
  }
  if (view.mirror) {
    const dest = cur === tmp ? tmp2 : tmp;
    mirrorInto(cur, dest, side);
    cur = dest;
  }
  // Invert before radial so polar outside stays 0 (black), not flipped white.
  if (invert) {
    const dest = cur === tmp ? tmp2 : tmp;
    invertInto(cur, dest, side);
    cur = dest;
  }
  if (radial) {
    const dest = cur === tmp ? tmp2 : tmp;
    radialInto(cur, dest, side);
    cur = dest;
  }
  if (cur !== out) out.set(cur);
}
