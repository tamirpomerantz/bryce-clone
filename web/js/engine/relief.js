// A Bryce terrain as a relief of triangles.
// The walk follows stecyk3d src/geometry/relief.rs (MIT): clip the ray to the
// box, step from cell to cell, test the two triangles of a cell only when the
// ray's height can reach that cell, and stop at the nearest crossing.
// Coordinates here are the studio's world: x and z span `width`, height is
// `heightScale` times the stored 0..65535 level.

const HEIGHT_MAX = 65535;

export function makeRelief(heights, side, width, heightScale) {
  const cells = side - 1;
  const s = width / cells;
  const y = new Float32Array(side * side);
  let yMax = 0;
  for (let i = 0; i < y.length; i++) {
    const h = (heights[i] / HEIGHT_MAX) * heightScale;
    y[i] = h;
    if (h > yMax) yMax = h;
  }
  const hi = new Float32Array(cells * cells);
  const lo = new Float32Array(cells * cells);
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      const a = y[r * side + c];
      const b = y[r * side + c + 1];
      const e = y[(r + 1) * side + c + 1];
      const g = y[(r + 1) * side + c];
      const k = r * cells + c;
      hi[k] = Math.max(a, b, e, g);
      lo[k] = Math.min(a, b, e, g);
    }
  }
  const nx = new Float32Array(side * side);
  const ny = new Float32Array(side * side);
  const nz = new Float32Array(side * side);
  const at = (i, j) => {
    if (i < 0) i = 0;
    else if (i >= side) i = side - 1;
    if (j < 0) j = 0;
    else if (j >= side) j = side - 1;
    return y[j * side + i];
  };
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const hx = (at(i + 1, j) - at(i - 1, j)) / (2 * s);
      const hz = (at(i, j + 1) - at(i, j - 1)) / (2 * s);
      const len = Math.hypot(hx, 1, hz);
      const k = j * side + i;
      nx[k] = -hx / len;
      ny[k] = 1 / len;
      nz[k] = -hz / len;
    }
  }
  return { y, hi, lo, nx, ny, nz, side, cells, s, x0: -width * 0.5, z0: -width * 0.5, yMax, width };
}

function cellOf(field, v, origin) {
  const x = (v - origin) / field.s;
  const last = field.cells - 1;
  if (!(x >= 0)) return 0;
  if (x >= field.cells) return last;
  const c = Math.floor(x);
  return c < last ? c : last;
}

function slab(o, d, lo, hi) {
  let t0 = 0;
  let t1 = 1e9;
  for (let a = 0; a < 3; a++) {
    const inv = 1 / d[a];
    let ta = (lo[a] - o[a]) * inv;
    let tb = (hi[a] - o[a]) * inv;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (!(t0 <= t1)) return null;
  }
  return { t0, t1 };
}

/** Nearest triangle the ray meets, or null. `near` keeps the ray off its own start.
 * `occlusion` stops at the first hit and skips the shading normal. */
export function traceTerrain(field, ox, oy, oz, dx, dy, dz, near, far, occlusion) {
  const { s, x0, z0, cells, hi, lo } = field;
  const x1 = x0 + field.width;
  const z1 = z0 + field.width;
  const box = slab([ox, oy, oz], [dx, dy, dz], [x0, -2, z0], [x1, field.yMax + 2, z1]);
  if (!box) return null;
  let t0 = box.t0 > near ? box.t0 : near;
  const t1 = box.t1 < far ? box.t1 : far;
  if (!(t0 <= t1)) return null;

  let px = ox + t0 * dx;
  let pz = oz + t0 * dz;
  let c = cellOf(field, px, x0);
  let r = cellOf(field, pz, z0);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const maxSteps = cells * 2 + 4;
  let best = null;

  for (let step = 0; step < maxSteps; step++) {
    const nextX = stepX === 0 ? Infinity : (x0 + (stepX > 0 ? c + 1 : c) * s - ox) / dx;
    const nextZ = stepZ === 0 ? Infinity : (z0 + (stepZ > 0 ? r + 1 : r) * s - oz) / dz;
    const leave = nextX < nextZ ? nextX : nextZ;
    const tLeave = leave < t1 ? leave : t1;
    const yIn = oy + t0 * dy;
    const yOut = oy + tLeave * dy;
    const yLo = yIn < yOut ? yIn : yOut;
    const yHi = yIn > yOut ? yIn : yOut;
    const k = r * cells + c;
    const slack = 1e-4;
    if (!(yHi + slack < lo[k] || yLo - slack > hi[k])) {
      const hit = cellHit(field, c, r, ox, oy, oz, dx, dy, dz, t0, tLeave);
      if (hit) {
        if (occlusion) return hit;
        if (best === null || hit.t < best.t) best = hit;
      }
    }
    if (best && best.t <= tLeave + 1e-8) break;
    if (!(leave > t0 + 1e-8) || !(leave < t1)) break;
    t0 = leave;
    if (nextX <= nextZ) {
      c += stepX;
      if (c < 0 || c >= cells) break;
    } else {
      r += stepZ;
      if (r < 0 || r >= cells) break;
    }
  }
  if (!best) return null;
  const fx = (best.x - x0) / s - best.c;
  const fz = (best.z - z0) / s - best.r;
  const n = smoothNormal(field, best.c, best.r, fx, fz);
  best.nx = n[0];
  best.ny = n[1];
  best.nz = n[2];
  return best;
}

function cellHit(field, c, r, ox, oy, oz, dx, dy, dz, t0, t1) {
  const { s, x0, z0, side, y } = field;
  const ax = x0 + c * s;
  const az = z0 + r * s;
  const h00 = y[r * side + c];
  const h10 = y[r * side + c + 1];
  const h01 = y[(r + 1) * side + c];
  const h11 = y[(r + 1) * side + c + 1];
  const B = h10 - h00;
  const C = h01 - h00;
  const D = h00 - h10 - h01 + h11;
  const du = dx / s;
  const dv = dz / s;
  const u0 = (ox - ax) / s;
  const v0 = (oz - az) / s;
  const qa = D * du * dv;
  const qb = B * du + C * dv + D * (u0 * dv + v0 * du) - dy;
  const qc = h00 + B * u0 + C * v0 + D * u0 * v0 - oy;
  const roots = [];
  if (qa > -1e-12 && qa < 1e-12) {
    if (qb > 1e-12 || qb < -1e-12) roots.push(-qc / qb);
  } else {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      roots.push((-qb - root) / (2 * qa));
      roots.push((-qb + root) / (2 * qa));
    }
  }
  let best = null;
  for (let i = 0; i < roots.length; i++) {
    const t = roots[i];
    if (!(t >= t0 && t <= t1)) continue;
    const u = u0 + t * du;
    const v = v0 + t * dv;
    if (u < -1e-4 || u > 1 + 1e-4 || v < -1e-4 || v > 1 + 1e-4) continue;
    if (!best || t < best.t) best = t;
  }
  if (best === null) return null;
  return {
    t: best,
    c,
    r,
    x: ox + best * dx,
    y: oy + best * dy,
    z: oz + best * dz,
  };
}

function smoothNormal(field, c, r, fx, fz) {
  const n = field.side;
  const i00 = r * n + c;
  const i10 = i00 + 1;
  const i01 = i00 + n;
  const i11 = i01 + 1;
  const lx = field.nx[i00] + (field.nx[i10] - field.nx[i00]) * fx;
  const ly = field.ny[i00] + (field.ny[i10] - field.ny[i00]) * fx;
  const lz = field.nz[i00] + (field.nz[i10] - field.nz[i00]) * fx;
  const rx = field.nx[i01] + (field.nx[i11] - field.nx[i01]) * fx;
  const ry = field.ny[i01] + (field.ny[i11] - field.ny[i01]) * fx;
  const rz = field.nz[i01] + (field.nz[i11] - field.nz[i01]) * fx;
  const nx = lx + (rx - lx) * fz;
  const ny = ly + (ry - ly) * fz;
  const nz = lz + (rz - lz) * fz;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}
