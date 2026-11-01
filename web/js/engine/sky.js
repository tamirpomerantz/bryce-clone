// Bryce 3.0 sky for one ray, rewritten in JavaScript from the MIT renderer
// https://github.com/tatleoat/stecyk3d
//   src/sky/sky_colours.rs  SkyColours::colour_seen
//   src/sky/clouds.rs       CloudRender::colour_covers (Bryce 3.0 planes)
//   src/sky/air.rs          Air::over
//   src/sky/stars.rs        visibility after the layers
//
// The texture value inside each cloud reading is a stand-in. Bryce's lattice
// permutation is not in the repository; stecyk3d reads it from an installed
// copy and ships no default. The star catalogue is the same kind of table, so
// stars here are a field weighted by the engine's visibility, not the catalogue.

import { cloudStep, hazeBryce30, mainLight } from "../skymath.js";

const CLOUD_K = new Float64Array(new BigUint64Array([0x402cda993e7663ben]).buffer)[0];
const STARS_K5 = new Float64Array(new BigUint64Array([0x4062089fc709fe56n]).buffer)[0];

const B = 1 / 255;
const DELTA = 0.01745329251994;
const SUN_DISC = 1.22;
const MOON_DISC = 1.8;
const CE_CAP = 0.999402948355;
const BETA = 0.3051804379339;
const MOON_OFFSET = [0.05468833447776, 0.06640726329442, 0.12500190737777];
const EDGE_RED = 8.66138315e-5;
const EDGE_GREEN = 4.1909048e-5;
const SUN_POWER = 85;
const MOON_POWER = 120;
const LN2 = Math.LN2;
const LOG2E = Math.LOG2E;
const STARS_A1 = 0.7853981633974;
const STARS_A2 = 1.273239544735241;
const HAZE_START = 4.8828125;
const HAZE_HOLD = 1e9;
const FOG_START = 0.390625;
const FOG_BASE = 19.53125;
const UPPER_RISE = 24.4140625;
const SCALE_FACTOR = 0.00256;
const LOWER_SHIFT = 360.3;
const f32 = Math.fround;

function held(x) {
  if (x > 1) return 1;
  if (x >= 0) return x;
  return 0;
}

function toward1(a, b, w) {
  return f32(a + (b - a) * w);
}

function glowPower(a, power) {
  return 2 ** (((Math.log2(a) * power) * LN2) * LOG2E);
}

function largestChannel(z) {
  const r = z[0];
  const g = z[1];
  const b = z[2];
  let m = g;
  if (g < r || Number.isNaN(g) || Number.isNaN(r)) m = r;
  if (!(b < m) && !Number.isNaN(b) && !Number.isNaN(m)) m = b;
  return m;
}

function hash3(ix, iy, iz) {
  let n = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 2147483647);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function fade(t) {
  return t * t * (3 - 2 * t);
}

/** Value noise in 0..1. Stand-in for a Bryce type-5 lattice sample. */
function noise3(x, y, z) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const tz = fade(z - z0);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;
  const a = hash3(x0, y0, z0);
  const b = hash3(x1, y0, z0);
  const c = hash3(x0, y1, z0);
  const d = hash3(x1, y1, z0);
  const e = hash3(x0, y0, z1);
  const f = hash3(x1, y0, z1);
  const g = hash3(x0, y1, z1);
  const h = hash3(x1, y1, z1);
  const x00 = a + (b - a) * tx;
  const x10 = c + (d - c) * tx;
  const x01 = e + (f - e) * tx;
  const x11 = g + (h - g) * tx;
  const y0m = x00 + (x10 - x00) * ty;
  const y1m = x01 + (x11 - x01) * ty;
  return y0m + (y1m - y0m) * tz;
}

function fbm(x, y, z) {
  let v = 0;
  let a = 0.5;
  let n = 0;
  let f = 1;
  for (let i = 0; i < 3; i++) {
    v += a * noise3(x * f, y * f, z * f);
    n += a;
    a *= 0.5;
    f *= 2;
  }
  return v / n;
}

// Coverage noise with a broad puff and a harder edge, so the sky shows between
// clouds. The colour math still reads this the way it reads the lattice value.
function cloudSample(x, y, z) {
  const broad = noise3(x * 0.38, y * 0.38, z * 0.38);
  const mid = fbm(x, y * 0.7, z);
  const v = broad * 0.6 + mid * 0.4;
  const t = v * v * (3 - 2 * v);
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

function horizonFromSun(yc) {
  if (yc > 0.5) return [1, 1, f32((128 + 127 * (2 * yc - 1)) * B)];
  if (yc >= 0) return [1, f32(512 * yc * B), f32(256 * yc * B)];
  return [f32(255 * (yc + 1) * B), 0, 0];
}

/**
 * Numbers fixed for one sky. `stored` uses the panel colours as the dome
 * (Bryce switch bit 0x8). Otherwise the dome is the engine's own overhead
 * and horizon, from the sun's height.
 */
export function makeSky(input) {
  const sun = input.sunDir;
  const y = sun[1];
  const yc = Math.max(-1, Math.min(1, y));
  const chi = Math.min(1, Math.max(0, 0.2 * input.haze));
  const overhead = input.stored ? input.skyColour.map(f32) : input.proceduralOverhead.map(f32);
  const horizon = input.stored ? input.horizonColour.map(f32) : horizonFromSun(yc);
  const sunColour = input.sunColour.map(f32);
  const glow = input.stored ? sunColour : input.glow.map(f32);
  const power = input.stored ? 6 : input.power;
  const zmax = largestChannel(overhead);
  const nu = 1 - (1 - 2 ** (zmax * -CLOUD_K));
  const size = input.discSize;
  const sunDisc = Math.cos(size * SUN_DISC * DELTA);
  const moonDisc = Math.cos(size * MOON_DISC * DELTA);
  const mu = -y;
  const rg = f32(0.5 * mu);
  const step = cloudStep(y, input.cloudColour);
  const light = mainLight(sun, input.sunColour);
  const haze = hazeBryce30(input.haze, input.hazeColour, Math.max(y, 0));
  const wE = f32(0.75 * step.weight);
  const litBase = [0, 1, 2].map((k) => toward1(input.ambient[k], step.hue[k], wE));
  let upperColour = light.colour;
  if (y < 0 && -y < 0.25) {
    const w = f32(4 * -y);
    upperColour = [0, 1, 2].map((k) => toward1(sunColour[k], light.colour[k], w));
  }
  return {
    sun,
    moon: [-sun[0], -sun[1], -sun[2]],
    overhead,
    horizon,
    glow,
    power,
    band: 0.5 * chi,
    sunColour,
    moonColour: [rg, rg, f32(0.625 * mu)],
    nu,
    sunEdge: sunDisc < CE_CAP ? sunDisc : CE_CAP,
    sunDisc,
    moonDisc,
    scale: input.frequency * SCALE_FACTOR,
    cover: input.cover,
    amplitude: input.amplitude,
    lowerHeight: input.cloudHeight,
    upperHeight: input.cloudHeight + UPPER_RISE,
    coreColour: step.colour.map(f32),
    litBase,
    upperColour: upperColour.map(f32),
    lightColour: light.colour.map(f32),
    lightDir: light.direction,
    lightIntensity: light.night ? 0.85 : light.intensity * 1.15,
    hazeAmount: input.haze,
    hazeRates: haze.rates,
    hazeScale: haze.scale,
    hazeColour: input.hazeColour.map(f32),
    hazeOn: input.haze > 0,
    fogColour: input.fogColour.map(f32),
    fogAmount: input.fog,
    fogHeight: input.fogHeight,
    fogOn: input.fog > 0 && input.fogHeight > 0,
    cloudHeight: input.cloudHeight,
  };
}

function skyDot(dx, dy, dz, s) {
  return (dy * s[1] + dz * s[2]) + dx * s[0];
}

function starGain(dx, dy, dz, seen) {
  if (seen < 0.08 || dy < 0.04) return 0;
  const s = 70;
  const ix = Math.floor(dx * s);
  const iy = Math.floor(dy * s);
  const iz = Math.floor(dz * s);
  const h = hash3(ix, iy, iz);
  if (h < 0.985) return 0;
  const fx = dx * s - ix - 0.5;
  const fy = dy * s - iy - 0.5;
  const fz = dz * s - iz - 0.5;
  const d2 = fx * fx + fy * fy + fz * fz;
  if (d2 > 0.08) return 0;
  return seen * (0.45 + 0.55 * hash3(ix + 5, iy, iz)) * (1 - d2 / 0.08);
}

/** Sky colour after step 6, and the star-field visibility beside it. */
function colourSeen(sky, dx, dy, dz) {
  const s = skyDot(dx, dy, dz, sky.sun);
  const a = (s + 1) * 0.5;
  const q = 1 - Math.abs(dy);
  let w = sky.band * (q * q);
  if (w > 1) w = 1;
  const wf = f32(w);
  let r = toward1(sky.overhead[0], sky.horizon[0], wf);
  let g = toward1(sky.overhead[1], sky.horizon[1], wf);
  let b = toward1(sky.overhead[2], sky.horizon[2], wf);

  const along = (Math.acos(Math.min(1, Math.abs(dy))) - STARS_A1) * STARS_A2;
  const e = along > 0 ? along : 0;
  const fade = ((1 - 2 ** ((sky.hazeAmount * 0.2) * -STARS_K5)) * e) * 1.2;
  let seen = 1 - held(fade);

  const glow = glowPower(Math.max(a, 1e-8), sky.power);
  const gw = f32(glow);
  r = toward1(r, sky.glow[0], gw);
  g = toward1(g, sky.glow[1], gw);
  b = toward1(b, sky.glow[2], gw);

  if (s < sky.sunEdge) {
    const sw = f32((a * a) ** SUN_POWER);
    r = toward1(r, sky.sunColour[0], sw);
    g = toward1(g, sky.sunColour[1], sw);
    b = toward1(b, sky.sunColour[2], sw);
  } else {
    r = f32(r + (sky.sunColour[0] - r));
    g = f32(g + (sky.sunColour[1] - g));
    b = f32(b + (sky.sunColour[2] - b));
    seen = 0;
    if (s >= sky.sunDisc) {
      r = f32(r + BETA);
      g = f32(g + BETA);
      b = f32(b + BETA);
    }
  }

  const side = 0.7 + 0.5 * a;
  r = f32(side * r);
  g = f32(side * g);
  b = f32(side * b);

  const s1 = skyDot(dx, dy, dz, sky.moon);
  const a1 = (s1 + 1) * 0.5;
  const e1 = glowPower(Math.max(a1, 1e-8), sky.power);
  const mw = f32((e1 * e1) * sky.nu);
  r = toward1(r, sky.moonColour[0], mw);
  g = toward1(g, sky.moonColour[1], mw);
  b = toward1(b, sky.moonColour[2], mw);

  const n = a1 ** MOON_POWER * sky.nu;
  const q0 = (sky.moonColour[0] + MOON_OFFSET[0]) * n + r;
  const q1 = (sky.moonColour[1] + MOON_OFFSET[1]) * n + g;
  const q2 = (sky.moonColour[2] + MOON_OFFSET[2]) * n + b;
  if (s1 < sky.moonDisc) {
    r = f32(q0);
    g = f32(q1);
    b = f32(q2);
  } else {
    seen = 0;
    r = f32(q0);
    g = f32(q1);
    b = f32(q2);
    if (s1 >= sky.moonDisc + EDGE_RED) r = f32(r + BETA);
    if (s1 >= sky.moonDisc + EDGE_GREEN) g = f32(g + BETA);
    b = f32(b + BETA);
  }

  const bright = Math.max(r, g, b);
  seen *= 1 - held(3.8 * bright);
  return { r, g, b, seen };
}

function seenAfterLayer(seen, kappa) {
  const y = held(1 - 2 ** (kappa * -CLOUD_K));
  return (1 - y) * seen;
}

function cloudsOver(sky, dx, dy, dz, ex, ey, ez, ox, oz, col) {
  if (!(dy > 0.035)) return col;
  let { r, g, b, seen } = col;
  const tUp = (sky.upperHeight - ey) / dy;
  const ux = (dx * tUp + ex + ox * 0.5) * sky.scale;
  const uz = (dz * tUp + ez + oz * 0.5) * sky.scale;
  const vUp = cloudSample(ux + 0.5 * uz, uz, sky.upperHeight);
  const kUp = held(sky.cover + ((2 * vUp - 1) * sky.amplitude) * 0.5);
  const rq = 1 - Math.abs(dy);
  const qq = rq * rq;
  const wq = f32(qq * qq);
  const kf = f32(kUp);
  const p0 = toward1(sky.upperColour[0], sky.horizon[0], wq);
  const p1 = toward1(sky.upperColour[1], sky.horizon[1], wq);
  const p2 = toward1(sky.upperColour[2], sky.horizon[2], wq);
  r = toward1(r, p0, kf);
  g = toward1(g, p1, kf);
  b = toward1(b, p2, kf);
  seen = seenAfterLayer(seen, kUp);

  const tLow = (sky.lowerHeight - ey) / dy;
  const lx = (dx * tLow + ex + ox) * sky.scale;
  const lz = (dz * tLow + ez + oz) * sky.scale;
  const v = cloudSample(lx + LOWER_SHIFT, lz + LOWER_SHIFT, sky.lowerHeight);
  const kappa = (2 * v - 1) * sky.amplitude + sky.cover;
  if (kappa > 0) {
    seen = seenAfterLayer(seen, kappa > 1 ? 1 : kappa);
    const v2 = fbm(0.5 * lx, 0.5 * lz, sky.lowerHeight);
    const s = skyDot(dx, dy, dz, sky.sun);
    const e = (s + 1) * 0.5;
    const e2 = e * e;
    const lambda = f32(held(e2 + (2 * v2 - 1) * 0.5));
    const lam = sky.lightColour;
    let t0 = toward1(sky.litBase[0], lam[0], lambda);
    let t1 = toward1(sky.litBase[1], lam[1], lambda);
    let t2 = toward1(sky.litBase[2], lam[2], lambda);
    const v3 = fbm(lx, lz, 0.5 * sky.lowerHeight);
    const u = f32(held(2 * v3 - 1 + 0.4));
    const a = sky.coreColour;
    t0 = f32(a[0] + u * (t0 - a[0]));
    t1 = f32(a[1] + u * (t1 - a[1]));
    t2 = f32(a[2] + u * (t2 - a[2]));
    const kp = kappa > 4 ? 4 : kappa;
    const sigma = (1 - 0.15 * kp) - 0.5 * e;
    t0 = f32(sigma * t0);
    t1 = f32(sigma * t1);
    t2 = f32(sigma * t2);
    const nu = f32(held((1 - (kp < 1 ? kp : 1)) * e2));
    t0 = f32(t0 + nu * (lam[0] - t0));
    t1 = f32(t1 + nu * (lam[1] - t1));
    t2 = f32(t2 + nu * (lam[2] - t2));
    const rho = f32(kp < 1 ? kp : 1);
    r = f32(r + rho * (t0 - r));
    g = f32(g + rho * (t1 - g));
    b = f32(b + rho * (t2 - b));
  }
  return { r, g, b, seen };
}

function airOver(sky, dx, dy, dz, eyeY, r, g, b, length) {
  if (!(length >= 0)) length = dy !== 0 ? Math.abs(sky.cloudHeight / (dy + dy)) : Infinity;
  if (sky.fogOn) {
    const reach = length - FOG_START;
    if (reach > 0) {
      const depthAt = (t) => {
        const d = 1 - (t * dy + eyeY) / sky.fogHeight;
        return d > 0 ? d : 0;
      };
      const m = (depthAt(FOG_START) + depthAt(length)) * 0.5;
      let n = reach * m;
      if (sky.fogAmount < 0.1) n *= 10 * sky.fogAmount;
      if (n > 0) {
        let a = n / (FOG_BASE + (1 - FOG_BASE) * sky.fogAmount);
        if (a > sky.fogAmount) a = sky.fogAmount;
        if (a > 1) a = 1;
        const af = f32(a);
        r = toward1(r, sky.fogColour[0], af);
        g = toward1(g, sky.fogColour[1], af);
        b = toward1(b, sky.fogColour[2], af);
      }
    }
  }
  if (sky.hazeOn && dy > 0) {
    const kappa = Math.abs(sky.cloudHeight / (dy + dy));
    if (length >= kappa) length = kappa;
  }
  if (sky.hazeOn) {
    let reach = length - HAZE_START;
    if (reach > 0) {
      if (reach > HAZE_HOLD) reach = HAZE_HOLD;
      const x = reach / sky.hazeScale;
      const rates = sky.hazeRates;
      const wr = f32(1 - 2 ** (-rates[0] * x * LOG2E));
      const wg = f32(1 - 2 ** (-rates[1] * x * LOG2E));
      const wb = f32(1 - 2 ** (-rates[2] * x * LOG2E));
      r = toward1(r, sky.hazeColour[0], wr);
      g = toward1(g, sky.hazeColour[1], wg);
      b = toward1(b, sky.hazeColour[2], wb);
    }
  }
  return [r, g, b];
}

/** Sky colour for a ray that meets nothing, from `ex, ey, ez`. */
export function colourRay(sky, dx, dy, dz, ex, ey, ez, ox, oz) {
  return shadeRay(sky, dx, dy, dz, ex, ey, ez, ox, oz);
}

/** Haze and fog over a surface colour at distance `dist`. */
export function surfaceAir(sky, dx, dy, dz, eyeY, dist, rgb) {
  return airOver(sky, dx, dy, dz, eyeY, rgb[0], rgb[1], rgb[2], dist);
}

function shadeRay(sky, dx, dy, dz, ex, ey, ez, ox, oz) {
  let col = colourSeen(sky, dx, dy, dz);
  col = cloudsOver(sky, dx, dy, dz, ex, ey, ez, ox, oz, col);
  const stars = starGain(dx, dy, dz, col.seen);
  if (stars > 0) {
    col.r = f32(col.r + stars * (0.92 - col.r));
    col.g = f32(col.g + stars * (0.95 - col.g));
    col.b = f32(col.b + stars * (1 - col.b));
  }
  return airOver(sky, dx, dy, dz, ey, col.r, col.g, col.b);
}

function byte(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 255;
  return (c * 255 + 0.5) | 0;
}

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

/**
 * The sky as the camera sees it. Row 0 is the bottom of the view.
 * `fovY` is the vertical field of view in radians, `quat` is xyzw.
 */
export function fillView(pixels, width, height, sky, ex, ey, ez, ox, oz, fovY, aspect, quat) {
  const tan = Math.tan(fovY * 0.5);
  const invW = 1 / width;
  const invH = 1 / height;
  for (let y = 0; y < height; y++) {
    const dirY = ((y + 0.5) * invH * 2 - 1) * tan;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const dirX = ((x + 0.5) * invW * 2 - 1) * aspect * tan;
      let vx = dirX;
      let vy = dirY;
      let vz = -1;
      const inv = 1 / Math.hypot(vx, vy, vz);
      vx *= inv;
      vy *= inv;
      vz *= inv;
      const d = quatRotate(quat, vx, vy, vz);
      const rgb = shadeRay(sky, d[0], d[1], d[2], ex, ey, ez, ox, oz);
      const i = (row + x) * 4;
      pixels[i] = byte(rgb[0]);
      pixels[i + 1] = byte(rgb[1]);
      pixels[i + 2] = byte(rgb[2]);
      pixels[i + 3] = 255;
    }
  }
}

/** Equirectangular panorama, row 0 at the south pole. Used for reflections. */
export function fillPanorama(pixels, width, height, sky, ex, ey, ez, ox, oz) {
  const invW = 1 / width;
  const invH = 1 / height;
  for (let y = 0; y < height; y++) {
    const lat = (y + 0.5) * invH * Math.PI - Math.PI / 2;
    const cy = Math.sin(lat);
    const horiz = Math.cos(lat);
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const lon = (x + 0.5) * invW * Math.PI * 2 - Math.PI;
      const dx = Math.cos(lon) * horiz;
      const dz = Math.sin(lon) * horiz;
      const rgb = shadeRay(sky, dx, cy, dz, ex, ey, ez, ox, oz);
      const i = (row + x) * 4;
      pixels[i] = byte(rgb[0]);
      pixels[i + 1] = byte(rgb[1]);
      pixels[i + 2] = byte(rgb[2]);
      pixels[i + 3] = 255;
    }
  }
}
