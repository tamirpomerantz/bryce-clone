// One camera picture: the sky for a miss, the terrain relief where the ray
// meets it, and the water plane in front of whatever is behind it.
// Terrain intersection is engine/relief.js. The miss colour is the sky port.
// Water is that plane with wind-driven waves, the material's own colour, a
// reflection added on top, a view through the shallows, and the sun highlight.

import { colourRay, surfaceAir } from "./sky.js?v=12";
import { makeRelief, traceTerrain } from "./relief.js?v=25";

// Crests travel with the wind. Each train is a sine along its own heading,
// spread a little so the surface is chop rather than one set of ruled lines.
const WAVE_TRAINS = [
  { turn: 0, k: 0.48, a: 0.64 },
  { turn: 0.26, k: 0.9, a: 0.2 },
  { turn: -0.2, k: 1.25, a: 0.13 },
  { turn: 0.1, k: 2.2, a: 0.06 },
  { turn: -0.08, k: 3.5, a: 0.035 },
];

function quatRotate(q, x, y, z) {
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

function dot(ax, ay, az, b) {
  return ax * b[0] + ay * b[1] + az * b[2];
}

function hash3(ix, iy, iz) {
  let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 1440672139);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function fade(t) {
  return t * t * (3 - 2 * t);
}

function noise3(x, y, z) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const tz = fade(z - z0);
  const a = hash3(x0, y0, z0);
  const b = hash3(x0 + 1, y0, z0);
  const c = hash3(x0, y0 + 1, z0);
  const d = hash3(x0 + 1, y0 + 1, z0);
  const e = hash3(x0, y0, z0 + 1);
  const f = hash3(x0 + 1, y0, z0 + 1);
  const g = hash3(x0, y0 + 1, z0 + 1);
  const h = hash3(x0 + 1, y0 + 1, z0 + 1);
  const x00 = a + (b - a) * tx;
  const x10 = c + (d - c) * tx;
  const x01 = e + (f - e) * tx;
  const x11 = g + (h - g) * tx;
  const y0m = x00 + (x10 - x00) * ty;
  const y1m = x01 + (x11 - x01) * ty;
  return y0m + (y1m - y0m) * tz;
}

function waveSettings(ground) {
  const length = ground.waveLength > 0 ? ground.waveLength : 1.2;
  const amp = ground.waveAmp >= 0 ? ground.waveAmp : 1;
  const heading = ((ground.waveHeading || 0) * Math.PI) / 180;
  return { amp, freq: 0.85 / length, heading };
}

// Slope of the height field. A sine along (cx, cz) has derivative k cos(phase)
// times that direction, so the crests stay straight and follow the wind.
function waterSlope(x, z, waves) {
  let gx = 0;
  let gz = 0;
  if (!(waves.amp > 0)) return [gx, gz];
  for (let i = 0; i < WAVE_TRAINS.length; i++) {
    const t = WAVE_TRAINS[i];
    const ang = waves.heading + t.turn;
    const cx = Math.cos(ang);
    const cz = Math.sin(ang);
    const k = waves.freq * t.k;
    const phase = (x * cx + z * cz) * k + t.turn * 1.7;
    const slope = Math.cos(phase) * t.a * k * waves.amp;
    gx += slope * cx;
    gz += slope * cz;
  }
  return [gx, gz];
}

// Blinn: n - factor * (g - (g·n) n), then normalised. shading/bump.rs
function perturb(nx, ny, nz, gx, gy, gz, factor) {
  const along = gx * nx + gy * ny + gz * nz;
  let tx = nx - factor * (gx - along * nx);
  let ty = ny - factor * (gy - along * ny);
  let tz = nz - factor * (gz - along * nz);
  const len = Math.hypot(tx, ty, tz) || 1;
  return [tx / len, ty / len, tz / len];
}

function waterNormal(x, z, dist, ground) {
  const g = waterSlope(x, z, waveSettings(ground));
  const fade = 1 / (1 + dist * 0.035);
  const n = perturb(0, 1, 0, g[0], 0, g[1], 0.72 * fade);
  if (n[1] >= 0.45) return n;
  return perturb(0, 1, 0, g[0], 0, g[1], 0.32 * fade);
}

function smooth(a, b, x) {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const t = (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const STRATA = [
  [0.52, 0.34, 0.2],
  [0.28, 0.19, 0.13],
  [0.7, 0.54, 0.36],
  [0.36, 0.25, 0.16],
  [0.78, 0.7, 0.56],
  [0.22, 0.16, 0.12],
];

function strataColor(x, y, z, tex) {
  const freq = 0.25 + tex * 3.5;
  const warp = (noise3(x * 0.08 * freq, y * 0.03 * freq, z * 0.08 * freq) - 0.5) * 5.5;
  const bend = (noise3(x * 0.22 * freq, 2.1, z * 0.22 * freq) - 0.5) * 1.4;
  const t = y * (0.15 + tex * 0.9) + warp + bend;
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = STRATA[((i % 6) + 6) % 6];
  const b = STRATA[(((i + 1) % 6) + 6) % 6];
  return mix(a, b, u);
}

function scale(c, s) {
  return [c[0] * s, c[1] * s, c[2] * s];
}

function dye(c, tint) {
  const y = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
  return [y * tint[0] * 2.1, y * tint[1] * 2.1, y * tint[2] * 2.1];
}

function albedo(material, hit, heightScale, tint, tex) {
  const x = hit.x;
  const y = hit.y;
  const z = hit.z;
  const height = hit.y / heightScale;
  const h = height < 0 ? 0 : height > 1 ? 1 : height;
  const slope = 1 - Math.max(0, Math.min(1, hit.ny));
  const f = 0.6 + tex * 3;
  const fine = noise3(x * 2.1 * f, y * 1.3 * f, z * 2.1 * f);
  const grain = 0.84 + (0.12 + tex * 0.45) * fine;
  const rock = strataColor(x, y, z, tex);
  let c;
  if (material < 0.5) {
    c = mix([0.55, 0.4, 0.26], rock, smooth(0.35, 0.82, slope) * 0.62);
    const snow = smooth(0.72, 0.9, h) * (1 - smooth(0.18, 0.52, slope));
    c = mix(c, [0.93, 0.94, 0.96], snow * (0.7 + 0.3 * fine));
  } else if (material < 1.5) {
    const soil = [0.46, 0.38, 0.26];
    const grassN = noise3(x * 0.2, 0.4, z * 0.2);
    const grass = smooth(0.04, 0.2, h)
      * (1 - smooth(0.38, 0.7, h))
      * (1 - smooth(0.28, 0.62, slope))
      * smooth(0.42, 0.68, grassN);
    c = mix(soil, rock, smooth(0.4, 0.85, slope) * 0.55);
    c = mix(c, [0.32, 0.5, 0.22], grass);
    const snow = smooth(0.66, 0.86, h) * (1 - smooth(0.16, 0.48, slope));
    c = mix(c, [0.94, 0.95, 0.97], snow * (0.75 + 0.25 * fine));
  } else if (material < 2.5) {
    const dune = smooth(0.25, 0.7, h);
    c = mix([0.76, 0.62, 0.38], [0.58, 0.4, 0.22], dune);
    c = mix(c, [0.42, 0.28, 0.16], smooth(0.4, 0.9, slope) * 0.65);
    c = mix(c, [0.86, 0.74, 0.5], (fine - 0.5) * 0.35 + 0.15);
  } else {
    const pale = smooth(0.2, 0.85, h);
    c = mix([0.2, 0.2, 0.22], [0.55, 0.55, 0.58], pale);
    c = mix(c, rock, smooth(0.3, 0.75, slope) * 0.45);
  }
  return dye(scale(c, grain), tint);
}

function fieldAt(x, y, z, tex) {
  const f = 0.7 + tex * 2.4;
  const grain = noise3(x * 1.6 * f, y * 1.1 * f, z * 1.6 * f);
  const fine = noise3(x * 4.4 * f, y * 3.2 * f, z * 4.4 * f);
  return (grain - 0.5) * 0.55 + (fine - 0.5) * 0.2;
}

function terrainNormal(hit, tex) {
  const h = 0.18;
  const f0 = fieldAt(hit.x, hit.y, hit.z, tex);
  const gx = (fieldAt(hit.x + h, hit.y, hit.z, tex) - f0) / h;
  const gy = (fieldAt(hit.x, hit.y + h, hit.z, tex) - f0) / h;
  const gz = (fieldAt(hit.x, hit.y, hit.z + h, tex) - f0) / h;
  const slope = 1 - Math.max(0, hit.ny);
  return perturb(hit.nx, hit.ny, hit.nz, gx, gy, gz, 0.05 + tex * 0.5 + slope * 0.22);
}

function shadeTerrain(sky, hit, ground, waterY) {
  const tex = ground.earthTex || 0;
  const tint = ground.earthTint || [1, 0.85, 0.6];
  const n = terrainNormal(hit, tex);
  const light = sky.lightDir;
  const ndl = n[0] * light[0] + n[1] * light[1] + n[2] * light[2];
  const base = albedo(ground.material, hit, ground.heightScale, tint, tex);
  const up = Math.max(0, Math.min(1, n[1] * 0.65 + 0.2));
  const fillR = sky.horizon[0] + (sky.overhead[0] - sky.horizon[0]) * up;
  const fillG = sky.horizon[1] + (sky.overhead[1] - sky.horizon[1]) * up;
  const fillB = sky.horizon[2] + (sky.overhead[2] - sky.horizon[2]) * up;
  const direct = hit.shadow ? 0 : Math.max(0, ndl) * sky.lightIntensity;
  const wrap = hit.shadow ? 0.35 : Math.max(0, ndl) * 0.55 + 0.45;
  let r = base[0] * (fillR * 0.62 + sky.lightColour[0] * direct * wrap);
  let g = base[1] * (fillG * 0.62 + sky.lightColour[1] * direct * wrap);
  let b = base[2] * (fillB * 0.62 + sky.lightColour[2] * direct * wrap);
  if (hit.y < waterY) {
    r *= 0.75;
    g *= 0.82;
    b *= 0.8;
  }
  return [r, g, b];
}

function reflect(dx, dy, dz, nx, ny, nz) {
  const nd = dx * nx + dy * ny + dz * nz;
  return [dx - 2 * nd * nx, dy - 2 * nd * ny, dz - 2 * nd * nz];
}

// Bryce's angle law, from the measured form in stecyk3d shading/media.rs.
// e = 1 − 2^(−(η−1)·K10), share = 1 − e·(1 − (0.98·|c|)^0.8). K10 is
// 10·log2(e). The sea presets on the CD (foamy sea water, water/partial wave)
// leave transparency at 0, so the law never runs, and reflection stays the
// channel value 0.16 or 0.29. That amount is added to the material colour.
// It does not replace it. The share below only opens the shallows when the
// view looks down; it is not turned back into extra reflection.
const WATER_E = 1 - 2 ** (-(1.33 - 1) * 14.426950408889635);
const WATER_TRANSPARENCY = 0.42;
const WATER_REFLECTION = 0.16;

function waterShare(ndv) {
  const p = (0.98 * ndv) ** 0.8;
  return 1 - WATER_E * (1 - p);
}

// The heightfield is a square. A Bryce plane does not enclose a volume, so a
// clear plane would show that cut. Fade the bottom into the water colour
// before the rim, and with depth, so only the shallows stay visible.
function rimFade(field, x, z) {
  const half = field.width * 0.5;
  const inset = Math.min(half - Math.abs(x), half - Math.abs(z));
  const u = inset / 8;
  if (!(u > 0)) return 0;
  if (u >= 1) return 1;
  return u * u * (3 - 2 * u);
}

function hitWater(oy, dy, level) {
  if (!(dy < -1e-6 || dy > 1e-6)) return null;
  const t = (level - oy) / dy;
  if (!(t > 0.05)) return null;
  return t;
}

function cameraRay(width, height, x, y, fovY, aspect, quat) {
  const tan = Math.tan(fovY * 0.5);
  let vx = ((x + 0.5) / width * 2 - 1) * aspect * tan;
  let vy = ((y + 0.5) / height * 2 - 1) * tan;
  let vz = -1;
  const inv = 1 / Math.hypot(vx, vy, vz);
  vx *= inv;
  vy *= inv;
  vz *= inv;
  return quatRotate(quat, vx, vy, vz);
}

const JITTER = [[-0.32, -0.18], [0.28, -0.34], [-0.16, 0.36], [0.34, 0.22]];

/**
 * Paint the camera picture. `ground` carries the height grid and the water.
 * Row 0 is the bottom of the view. Edges are drawn again with four extra rays.
 */
export function fillFrame(pixels, width, height, sky, ex, ey, ez, ox, oz, fovY, aspect, quat, ground) {
  fillBand(pixels, width, height, 0, height, sky, ex, ey, ez, ox, oz, fovY, aspect, quat, ground, true);
}

/** Rows [y0, y1) of the camera picture, packed with row 0 at y0. */
function outsideMask(x, y, width, height, ground) {
  if (!ground.mask) return false;
  const rad = ground.maskR * 0.5 * Math.min(width, height);
  const dx = x + 0.5 - width * 0.5;
  const dy = y + 0.5 - height * 0.5;
  return dx * dx + dy * dy > rad * rad;
}

function islandOnly(sky, field, ground, ex, ey, ez, dx, dy, dz) {
  const hit = traceTerrain(field, ex, ey, ez, dx, dy, dz, 0.08, 1e7);
  if (!hit) return [0, 0, 0];
  hit.shadow = ndot(hit, sky.lightDir) > 0 && blocked(field, hit, sky.lightDir);
  const lit = shadeTerrain(sky, hit, ground, -1e9);
  return surfaceAir(sky, dx, dy, dz, ey, hit.t, lit);
}

export function fillBand(pixels, width, height, y0, y1, sky, ex, ey, ez, ox, oz, fovY, aspect, quat, ground, refine) {
  const field = makeRelief(ground.heights, ground.side, ground.span, ground.heightScale);
  const level = ground.waterOn ? ground.waterY : null;
  const paint = (x, y) => {
    const d = cameraRay(width, height, x, y, fovY, aspect, quat);
    if (outsideMask(x, y, width, height, ground)) {
      return islandOnly(sky, field, ground, ex, ey, ez, d[0], d[1], d[2]);
    }
    return pixel(sky, field, ground, ex, ey, ez, ox, oz, d[0], d[1], d[2], level);
  };
  const yStart = refine && y0 > 0 ? y0 - 1 : y0;
  const yEnd = refine && y1 < height ? y1 + 1 : y1;
  const bandW = width;
  const direct = yStart === y0 && yEnd === y1;
  const band = direct ? pixels : new Uint8Array(bandW * (yEnd - yStart) * 4);
  for (let y = yStart; y < yEnd; y++) {
    const row = (y - yStart) * bandW;
    for (let x = 0; x < width; x++) {
      const rgb = paint(x, y);
      const i = (row + x) * 4;
      band[i] = byte(rgb[0]);
      band[i + 1] = byte(rgb[1]);
      band[i + 2] = byte(rgb[2]);
      band[i + 3] = 255;
    }
  }
  if (refine) refineEdges(band, width, height, yStart, y0, y1, paint);
  if (band !== pixels) {
    const rowBytes = width * 4;
    for (let y = y0; y < y1; y++) {
      const from = (y - yStart) * rowBytes;
      pixels.set(band.subarray(from, from + rowBytes), (y - y0) * rowBytes);
    }
  }
}

function lumaAt(pixels, i) {
  return pixels[i] * 0.3 + pixels[i + 1] * 0.5 + pixels[i + 2] * 0.2;
}

function refineEdges(pixels, width, height, yStart, y0, y1, paint) {
  const owned = (y1 - y0) * width;
  const mark = new Uint8Array(owned);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const i = ((y - yStart) * width + x) * 4;
      const l = lumaAt(pixels, i);
      let d = 0;
      if (x + 1 < width) d = Math.max(d, Math.abs(l - lumaAt(pixels, i + 4)));
      if (y + 1 < height) d = Math.max(d, Math.abs(l - lumaAt(pixels, i + width * 4)));
      if (d > 26) mark[(y - y0) * width + x] = 1;
    }
  }
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      if (!mark[(y - y0) * width + x]) continue;
      const i = ((y - yStart) * width + x) * 4;
      let r = pixels[i];
      let g = pixels[i + 1];
      let b = pixels[i + 2];
      for (let k = 0; k < JITTER.length; k++) {
        const rgb = paint(x + JITTER[k][0], y + JITTER[k][1]);
        r += byte(rgb[0]);
        g += byte(rgb[1]);
        b += byte(rgb[2]);
      }
      const n = 1 + JITTER.length;
      pixels[i] = (r / n + 0.5) | 0;
      pixels[i + 1] = (g / n + 0.5) | 0;
      pixels[i + 2] = (b / n + 0.5) | 0;
    }
  }
}

function pixel(sky, field, ground, ex, ey, ez, ox, oz, dx, dy, dz, level) {
  const groundHit = traceTerrain(field, ex, ey, ez, dx, dy, dz, 0.08, 1e7);
  const waterT = level === null ? null : hitWater(ey, dy, level);
  const waterFirst = waterT !== null && (!groundHit || waterT < groundHit.t);
  if (!waterFirst && !groundHit) {
    return colourRay(sky, dx, dy, dz, ex, ey, ez, ox, oz);
  }
  if (!waterFirst) {
    groundHit.shadow = ndot(groundHit, sky.lightDir) > 0 && blocked(field, groundHit, sky.lightDir);
    const lit = shadeTerrain(sky, groundHit, ground, level === null ? -1e9 : level);
    return surfaceAir(sky, dx, dy, dz, ey, groundHit.t, lit);
  }
  const wx = ex + waterT * dx;
  const wz = ez + waterT * dz;
  const n = waterNormal(wx, wz, waterT, ground);
  const ndv = Math.max(0, -(dx * n[0] + dy * n[1] + dz * n[2]));
  const share = waterShare(ndv);
  const through = share * WATER_TRANSPARENCY;
  const R = reflect(dx, dy, dz, n[0], n[1], n[2]);
  const reflected = colourRay(sky, R[0], R[1], R[2], wx, level, wz, ox, oz);
  const lx = sky.lightDir[0];
  const ly = sky.lightDir[1];
  const lz = sky.lightDir[2];
  const ndl = Math.max(0, n[0] * lx + n[1] * ly + n[2] * lz);
  const ink = ground.waterColour || [0.06, 0.16, 0.22];
  const sun = 0.62 + 0.7 * ndl;
  let r = ink[0] * sun + reflected[0] * WATER_REFLECTION;
  let g = ink[1] * sun + reflected[1] * WATER_REFLECTION;
  let b = ink[2] * sun + reflected[2] * WATER_REFLECTION;
  if (groundHit && groundHit.t > waterT) {
    const under = shadeTerrain(sky, groundHit, ground, level);
    const depth = Math.max(0, level - groundHit.y);
    const seen = through * Math.exp(-depth * 1.15) * rimFade(field, groundHit.x, groundHit.z);
    r += under[0] * (0.62 + 0.38 * ink[0]) * seen;
    g += under[1] * (0.62 + 0.38 * ink[1]) * seen;
    b += under[2] * (0.62 + 0.38 * ink[2]) * seen;
  }
  const cRef = Math.max(0, R[0] * lx + R[1] * ly + R[2] * lz);
  const spec = (cRef ** 90 * 0.85 + cRef ** 40 * 0.12) * sky.lightIntensity;
  r += sky.lightColour[0] * spec;
  g += sky.lightColour[1] * spec;
  b += sky.lightColour[2] * spec;
  return surfaceAir(sky, dx, dy, dz, ey, waterT, [r, g, b]);
}

function ndot(hit, light) {
  return hit.nx * light[0] + hit.ny * light[1] + hit.nz * light[2];
}

function blocked(field, hit, light) {
  const bias = 0.45;
  const hit2 = traceTerrain(
    field,
    hit.x + hit.nx * bias,
    hit.y + hit.ny * bias,
    hit.z + hit.nz * bias,
    light[0],
    light[1],
    light[2],
    0.05,
    400,
    true,
  );
  return hit2 !== null;
}

function byte(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 255;
  return (c * 255 + 0.5) | 0;
}
