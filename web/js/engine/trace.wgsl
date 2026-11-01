// The camera picture, one pixel per thread. Same walk as engine/relief.js and
// the same sky, water and rock colour as engine/sky.js and engine/frame.js.
// The CPU bake stays the fallback when this shader cannot be compiled.

struct Frame {
  eye: vec3f,
  fov_y: f32,
  quat: vec4f,
  ox: f32,
  oz: f32,
  aspect: f32,
  pix_w: f32,
  pix_h: f32,
  water_y: f32,
  water_on: f32,
  wave_amp: f32,
  wave_freq: f32,
  wave_heading: f32,
  material: f32,
  height_scale: f32,
  span: f32,
  side: f32,
  cells: f32,
  cell_size: f32,
  x0: f32,
  z0: f32,
  y_max: f32,
  sun: vec3f,
  power: f32,
  moon: vec3f,
  band: f32,
  overhead: vec3f,
  nu: f32,
  horizon: vec3f,
  sun_edge: f32,
  glow: vec3f,
  sun_disc: f32,
  sun_colour: vec3f,
  moon_disc: f32,
  moon_colour: vec3f,
  scale: f32,
  cover: f32,
  amplitude: f32,
  lower_height: f32,
  upper_height: f32,
  core_colour: vec3f,
  haze_amount: f32,
  lit_base: vec3f,
  haze_scale: f32,
  upper_colour: vec3f,
  haze_on: f32,
  light_colour: vec3f,
  light_intensity: f32,
  light_dir: vec3f,
  fog_amount: f32,
  haze_rates: vec3f,
  fog_height: f32,
  haze_colour: vec3f,
  fog_on: f32,
  fog_colour: vec3f,
  cloud_height: f32,
  water_colour: vec3f,
  pad_end: f32,
  earth: vec3f,
  earth_tex: f32,
  mask: f32,
  mask_r: f32,
  mask_pad0: f32,
  mask_pad1: f32,
}

struct Hit {
  t: f32,
  x: f32,
  y: f32,
  z: f32,
  nx: f32,
  ny: f32,
  nz: f32,
  ok: u32,
}

struct Col {
  rgb: vec3f,
  seen: f32,
}

const CLOUD_K: f32 = 14.426950408889635;
const STARS_K5: f32 = 144.26950408889633;
const SUN_DISC: f32 = 1.22;
const MOON_DISC_ANG: f32 = 1.8;
const DELTA: f32 = 0.01745329251994;
const CE_CAP: f32 = 0.999402948355;
const BETA: f32 = 0.3051804379339;
const SUN_POWER: f32 = 85.0;
const MOON_POWER: f32 = 120.0;
const STARS_A1: f32 = 0.7853981633974;
const STARS_A2: f32 = 1.273239544735241;
const HAZE_START: f32 = 4.8828125;
const FOG_START: f32 = 0.390625;
const FOG_BASE: f32 = 19.53125;
const LOWER_SHIFT: f32 = 360.3;
const LOG2E: f32 = 1.4426950408889634;
const LN2: f32 = 0.6931471805599453;
const WATER_E: f32 = 0.96311683259876;
const WATER_T: f32 = 0.42;
const WATER_RHO: f32 = 0.16;

@group(0) @binding(0) var out_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> frame: Frame;
@group(0) @binding(2) var<storage, read> heights: array<f32>;
@group(0) @binding(3) var<storage, read> normals: array<vec4f>;
@group(0) @binding(4) var<storage, read> hi: array<f32>;
@group(0) @binding(5) var<storage, read> lo: array<f32>;

fn hash_add(ix: i32, iy: i32, iz: i32) -> f32 {
  let n1 = bitcast<u32>(ix) * 374761393u + bitcast<u32>(iy) * 668265263u + bitcast<u32>(iz) * 1440672139u;
  let n2 = ((n1 ^ (n1 >> 13u)) * 1274126177u);
  return f32(n2 ^ (n2 >> 16u)) / 4294967295.0;
}

fn hash_xor(ix: i32, iy: i32, iz: i32) -> f32 {
  let n1 = (bitcast<u32>(ix) * 374761393u) ^ (bitcast<u32>(iy) * 668265263u) ^ (bitcast<u32>(iz) * 2147483647u);
  let n2 = ((n1 ^ (n1 >> 13u)) * 1274126177u);
  return f32(n2 ^ (n2 >> 16u)) / 4294967295.0;
}

fn fade(t: f32) -> f32 {
  return t * t * (3.0 - 2.0 * t);
}

fn noise_kind(x: f32, y: f32, z: f32, sky: bool) -> f32 {
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let z0 = i32(floor(z));
  let tx = fade(x - f32(x0));
  let ty = fade(y - f32(y0));
  let tz = fade(z - f32(z0));
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  let z1 = z0 + 1;
  var a: f32;
  var b: f32;
  var c: f32;
  var d: f32;
  var e: f32;
  var f: f32;
  var g: f32;
  var h: f32;
  if sky {
    a = hash_xor(x0, y0, z0);
    b = hash_xor(x1, y0, z0);
    c = hash_xor(x0, y1, z0);
    d = hash_xor(x1, y1, z0);
    e = hash_xor(x0, y0, z1);
    f = hash_xor(x1, y0, z1);
    g = hash_xor(x0, y1, z1);
    h = hash_xor(x1, y1, z1);
  } else {
    a = hash_add(x0, y0, z0);
    b = hash_add(x1, y0, z0);
    c = hash_add(x0, y1, z0);
    d = hash_add(x1, y1, z0);
    e = hash_add(x0, y0, z1);
    f = hash_add(x1, y0, z1);
    g = hash_add(x0, y1, z1);
    h = hash_add(x1, y1, z1);
  }
  let x00 = a + (b - a) * tx;
  let x10 = c + (d - c) * tx;
  let x01 = e + (f - e) * tx;
  let x11 = g + (h - g) * tx;
  let y0m = x00 + (x10 - x00) * ty;
  let y1m = x01 + (x11 - x01) * ty;
  return y0m + (y1m - y0m) * tz;
}

fn noise_sky(x: f32, y: f32, z: f32) -> f32 { return noise_kind(x, y, z, true); }
fn noise_rock(x: f32, y: f32, z: f32) -> f32 { return noise_kind(x, y, z, false); }

fn fbm_sky(x: f32, y: f32, z: f32) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var n = 0.0;
  var f = 1.0;
  for (var i = 0; i < 3; i++) {
    v += a * noise_sky(x * f, y * f, z * f);
    n += a;
    a *= 0.5;
    f *= 2.0;
  }
  return v / n;
}

fn cloud_sample(x: f32, y: f32, z: f32) -> f32 {
  let broad = noise_sky(x * 0.38, y * 0.38, z * 0.38);
  let mid = fbm_sky(x, y * 0.7, z);
  let v = broad * 0.6 + mid * 0.4;
  return clamp(fade(v), 0.0, 1.0);
}

fn held(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }

fn toward(a: f32, b: f32, w: f32) -> f32 { return a + (b - a) * w; }

fn quat_rotate(x: f32, y: f32, z: f32) -> vec3f {
  let q = frame.quat;
  let tx = 2.0 * (q.y * z - q.z * y);
  let ty = 2.0 * (q.z * x - q.x * z);
  let tz = 2.0 * (q.x * y - q.y * x);
  return vec3f(
    x + q.w * tx + (q.y * tz - q.z * ty),
    y + q.w * ty + (q.z * tx - q.x * tz),
    z + q.w * tz + (q.x * ty - q.y * tx),
  );
}

fn camera_ray(x: f32, y: f32) -> vec3f {
  let t = tan(frame.fov_y * 0.5);
  let vx = ((x + 0.5) / frame.pix_w * 2.0 - 1.0) * frame.aspect * t;
  let vy = ((y + 0.5) / frame.pix_h * 2.0 - 1.0) * t;
  return quat_rotate(vx, vy, -1.0);
}

fn hy(i: i32, j: i32) -> f32 {
  let n = i32(frame.side);
  let c = clamp(i, 0, n - 1);
  let r = clamp(j, 0, n - 1);
  return heights[r * n + c];
}

fn n_at(i: i32) -> vec3f { return normals[i].xyz; }

fn miss() -> Hit {
  var h: Hit;
  h.ok = 0u;
  return h;
}

fn cell_hit(c: i32, r: i32, ox: f32, oy: f32, oz: f32, d: vec3f, t0: f32, t1: f32) -> Hit {
  let s = frame.cell_size;
  let side = i32(frame.side);
  let ax = frame.x0 + f32(c) * s;
  let az = frame.z0 + f32(r) * s;
  let h00 = hy(c, r);
  let h10 = hy(c + 1, r);
  let h01 = hy(c, r + 1);
  let h11 = hy(c + 1, r + 1);
  let B = h10 - h00;
  let C = h01 - h00;
  let D = h00 - h10 - h01 + h11;
  let du = d.x / s;
  let dv = d.z / s;
  let u0 = (ox - ax) / s;
  let v0 = (oz - az) / s;
  let qa = D * du * dv;
  let qb = B * du + C * dv + D * (u0 * dv + v0 * du) - d.y;
  let qc = h00 + B * u0 + C * v0 + D * u0 * v0 - oy;
  var roots = array<f32, 2>(1e30, 1e30);
  var nroot = 0;
  if abs(qa) < 1e-12 {
    if abs(qb) > 1e-12 {
      roots[0] = -qc / qb;
      nroot = 1;
    }
  } else {
    let disc = qb * qb - 4.0 * qa * qc;
    if disc >= 0.0 {
      let root = sqrt(disc);
      roots[0] = (-qb - root) / (2.0 * qa);
      roots[1] = (-qb + root) / (2.0 * qa);
      nroot = 2;
    }
  }
  var best = 1e30;
  var found = false;
  for (var i = 0; i < 2; i++) {
    if i >= nroot { continue; }
    let t = roots[i];
    if t < t0 || t > t1 { continue; }
    let u = u0 + t * du;
    let v = v0 + t * dv;
    if u < -1e-4 || u > 1.0 + 1e-4 || v < -1e-4 || v > 1.0 + 1e-4 { continue; }
    if !found || t < best {
      best = t;
      found = true;
    }
  }
  if !found { return miss(); }
  var h: Hit;
  h.ok = 1u;
  h.t = best;
  h.x = ox + best * d.x;
  h.y = oy + best * d.y;
  h.z = oz + best * d.z;
  let fx = (h.x - frame.x0) / s - f32(c);
  let fz = (h.z - frame.z0) / s - f32(r);
  let i00 = r * side + c;
  let i10 = i00 + 1;
  let i01 = i00 + side;
  let i11 = i01 + 1;
  let lx = n_at(i00) + (n_at(i10) - n_at(i00)) * fx;
  let rx = n_at(i01) + (n_at(i11) - n_at(i01)) * fx;
  h.nx = lx.x + (rx.x - lx.x) * fz;
  h.ny = lx.y + (rx.y - lx.y) * fz;
  h.nz = lx.z + (rx.z - lx.z) * fz;
  let n = safe_norm(vec3f(h.nx, h.ny, h.nz));
  h.nx = n.x;
  h.ny = n.y;
  h.nz = n.z;
  return h;
}

fn safe_norm(v: vec3f) -> vec3f {
  let L = length(v);
  if L < 1e-8 { return vec3f(0.0, 1.0, 0.0); }
  return v / L;
}

fn trace(ox: f32, oy: f32, oz: f32, d: vec3f, near: f32, far: f32, occlusion: bool) -> Hit {
  let s = frame.cell_size;
  let cells = i32(frame.cells);
  let x1 = frame.x0 + frame.span;
  let z1 = frame.z0 + frame.span;
  var t_enter = near;
  var t_leave = far;
  let o = vec3f(ox, oy, oz);
  let b0 = vec3f(frame.x0, -2.0, frame.z0);
  let b1 = vec3f(x1, frame.y_max + 2.0, z1);
  {
    let inv = 1.0 / d.x;
    var ta = (b0.x - o.x) * inv;
    var tb = (b1.x - o.x) * inv;
    if ta > tb { let sw = ta; ta = tb; tb = sw; }
    t_enter = max(t_enter, ta);
    t_leave = min(t_leave, tb);
  }
  {
    let inv = 1.0 / d.y;
    var ta = (b0.y - o.y) * inv;
    var tb = (b1.y - o.y) * inv;
    if ta > tb { let sw = ta; ta = tb; tb = sw; }
    t_enter = max(t_enter, ta);
    t_leave = min(t_leave, tb);
  }
  {
    let inv = 1.0 / d.z;
    var ta = (b0.z - o.z) * inv;
    var tb = (b1.z - o.z) * inv;
    if ta > tb { let sw = ta; ta = tb; tb = sw; }
    t_enter = max(t_enter, ta);
    t_leave = min(t_leave, tb);
  }
  if !(t_enter <= t_leave) { return miss(); }
  var t0 = t_enter;
  var px = ox + t0 * d.x;
  var pz = oz + t0 * d.z;
  var c = i32(floor((px - frame.x0) / s));
  var r = i32(floor((pz - frame.z0) / s));
  c = clamp(c, 0, cells - 1);
  r = clamp(r, 0, cells - 1);
  let step_x = select(select(0, -1, d.x < 0.0), 1, d.x > 0.0);
  let step_z = select(select(0, -1, d.z < 0.0), 1, d.z > 0.0);
  let max_steps = cells * 2 + 4;
  var best = miss();
  for (var step = 0; step < max_steps; step++) {
    var next_x = 1e30;
    var next_z = 1e30;
    if step_x != 0 {
      let edge = frame.x0 + f32(select(c, c + 1, step_x > 0)) * s;
      next_x = (edge - ox) / d.x;
    }
    if step_z != 0 {
      let edge = frame.z0 + f32(select(r, r + 1, step_z > 0)) * s;
      next_z = (edge - oz) / d.z;
    }
    let leave = min(next_x, next_z);
    let t_cell = min(leave, t_leave);
    let y_in = oy + t0 * d.y;
    let y_out = oy + t_cell * d.y;
    let y_lo = min(y_in, y_out);
    let y_hi = max(y_in, y_out);
    let k = r * cells + c;
    if !(y_hi + 1e-4 < lo[k] || y_lo - 1e-4 > hi[k]) {
      let hit = cell_hit(c, r, ox, oy, oz, d, t0, t_cell);
      if hit.ok == 1u {
        if occlusion { return hit; }
        if best.ok == 0u || hit.t < best.t { best = hit; }
      }
    }
    if best.ok == 1u && best.t <= t_cell + 1e-8 { break; }
    if !(leave > t0 + 1e-8) || !(leave < t_leave) { break; }
    t0 = leave;
    if next_x <= next_z {
      c += step_x;
      if c < 0 || c >= cells { break; }
    } else {
      r += step_z;
      if r < 0 || r >= cells { break; }
    }
  }
  return best;
}

fn sky_dot(d: vec3f, s: vec3f) -> f32 { return dot(d, s); }

fn glow_power(a: f32, power: f32) -> f32 {
  return pow(max(a, 1e-8), power);
}

fn colour_seen(d: vec3f) -> Col {
  let s = sky_dot(d, frame.sun);
  let a = (s + 1.0) * 0.5;
  let q = 1.0 - abs(d.y);
  let w = min(frame.band * (q * q), 1.0);
  var r = toward(frame.overhead.x, frame.horizon.x, w);
  var g = toward(frame.overhead.y, frame.horizon.y, w);
  var b = toward(frame.overhead.z, frame.horizon.z, w);
  let along = (acos(min(1.0, abs(d.y))) - STARS_A1) * STARS_A2;
  let e = max(along, 0.0);
  let fade_s = ((1.0 - exp2((frame.haze_amount * 0.2) * -STARS_K5)) * e) * 1.2;
  var seen = 1.0 - held(fade_s);
  let gw = glow_power(a, frame.power);
  r = toward(r, frame.glow.x, gw);
  g = toward(g, frame.glow.y, gw);
  b = toward(b, frame.glow.z, gw);
  if s < frame.sun_edge {
    let sw = pow(a * a, SUN_POWER);
    r = toward(r, frame.sun_colour.x, sw);
    g = toward(g, frame.sun_colour.y, sw);
    b = toward(b, frame.sun_colour.z, sw);
  } else {
    r = frame.sun_colour.x;
    g = frame.sun_colour.y;
    b = frame.sun_colour.z;
    seen = 0.0;
    if s >= frame.sun_disc {
      r += BETA;
      g += BETA;
      b += BETA;
    }
  }
  let side = 0.7 + 0.5 * a;
  r *= side;
  g *= side;
  b *= side;
  let s1 = sky_dot(d, frame.moon);
  let a1 = (s1 + 1.0) * 0.5;
  let e1 = glow_power(a1, frame.power);
  let mw = (e1 * e1) * frame.nu;
  r = toward(r, frame.moon_colour.x, mw);
  g = toward(g, frame.moon_colour.y, mw);
  b = toward(b, frame.moon_colour.z, mw);
  let n = pow(a1, MOON_POWER) * frame.nu;
  r = (frame.moon_colour.x + 0.05468833447776) * n + r;
  g = (frame.moon_colour.y + 0.06640726329442) * n + g;
  b = (frame.moon_colour.z + 0.12500190737777) * n + b;
  if s1 >= frame.moon_disc {
    seen = 0.0;
    if s1 >= frame.moon_disc + 8.66138315e-5 { r += BETA; }
    if s1 >= frame.moon_disc + 4.1909048e-5 { g += BETA; }
    b += BETA;
  }
  seen *= 1.0 - held(3.8 * max(r, max(g, b)));
  var col: Col;
  col.rgb = vec3f(r, g, b);
  col.seen = seen;
  return col;
}

fn seen_after(seen: f32, kappa: f32) -> f32 {
  let y = held(1.0 - exp2(kappa * -CLOUD_K));
  return (1.0 - y) * seen;
}

fn clouds_over(d: vec3f, ex: f32, ey: f32, ez: f32, col: Col) -> Col {
  if !(d.y > 0.035) { return col; }
  var r = col.rgb.x;
  var g = col.rgb.y;
  var b = col.rgb.z;
  var seen = col.seen;
  let t_up = (frame.upper_height - ey) / d.y;
  let ux = (d.x * t_up + ex + frame.ox * 0.5) * frame.scale;
  let uz = (d.z * t_up + ez + frame.oz * 0.5) * frame.scale;
  let v_up = cloud_sample(ux + 0.5 * uz, uz, frame.upper_height);
  let k_up = held(frame.cover + ((2.0 * v_up - 1.0) * frame.amplitude) * 0.5);
  let rq = 1.0 - abs(d.y);
  let qq = rq * rq;
  let wq = qq * qq;
  r = toward(r, toward(frame.upper_colour.x, frame.horizon.x, wq), k_up);
  g = toward(g, toward(frame.upper_colour.y, frame.horizon.y, wq), k_up);
  b = toward(b, toward(frame.upper_colour.z, frame.horizon.z, wq), k_up);
  seen = seen_after(seen, k_up);
  let t_low = (frame.lower_height - ey) / d.y;
  let lx = (d.x * t_low + ex + frame.ox) * frame.scale;
  let lz = (d.z * t_low + ez + frame.oz) * frame.scale;
  let v = cloud_sample(lx + LOWER_SHIFT, lz + LOWER_SHIFT, frame.lower_height);
  let kappa = (2.0 * v - 1.0) * frame.amplitude + frame.cover;
  if kappa > 0.0 {
    let kp = min(kappa, 4.0);
    seen = seen_after(seen, min(kappa, 1.0));
    let v2 = fbm_sky(0.5 * lx, 0.5 * lz, frame.lower_height);
    let s = sky_dot(d, frame.sun);
    let e = (s + 1.0) * 0.5;
    let e2 = e * e;
    let lambda = held(e2 + (2.0 * v2 - 1.0) * 0.5);
    let lam = frame.light_colour;
    var t0 = toward(frame.lit_base.x, lam.x, lambda);
    var t1 = toward(frame.lit_base.y, lam.y, lambda);
    var t2 = toward(frame.lit_base.z, lam.z, lambda);
    let v3 = fbm_sky(lx, lz, 0.5 * frame.lower_height);
    let u = held(2.0 * v3 - 1.0 + 0.4);
    let core = frame.core_colour;
    t0 = core.x + u * (t0 - core.x);
    t1 = core.y + u * (t1 - core.y);
    t2 = core.z + u * (t2 - core.z);
    let sigma = (1.0 - 0.15 * kp) - 0.5 * e;
    t0 *= sigma;
    t1 *= sigma;
    t2 *= sigma;
    let nu = held((1.0 - min(kp, 1.0)) * e2);
    t0 = t0 + nu * (lam.x - t0);
    t1 = t1 + nu * (lam.y - t1);
    t2 = t2 + nu * (lam.z - t2);
    let rho = min(kp, 1.0);
    r = r + rho * (t0 - r);
    g = g + rho * (t1 - g);
    b = b + rho * (t2 - b);
  }
  var out: Col;
  out.rgb = vec3f(r, g, b);
  out.seen = seen;
  return out;
}

fn star_gain(d: vec3f, seen: f32) -> f32 {
  if seen < 0.08 || d.y < 0.04 { return 0.0; }
  let s = 70.0;
  let ix = i32(floor(d.x * s));
  let iy = i32(floor(d.y * s));
  let iz = i32(floor(d.z * s));
  let h = hash_xor(ix, iy, iz);
  if h < 0.985 { return 0.0; }
  let fx = d.x * s - f32(ix) - 0.5;
  let fy = d.y * s - f32(iy) - 0.5;
  let fz = d.z * s - f32(iz) - 0.5;
  let d2 = fx * fx + fy * fy + fz * fz;
  if d2 > 0.08 { return 0.0; }
  return seen * (0.45 + 0.55 * hash_xor(ix + 5, iy, iz)) * (1.0 - d2 / 0.08);
}

fn fog_depth(t: f32, dy: f32, eye_y: f32) -> f32 {
  return max(0.0, 1.0 - (t * dy + eye_y) / frame.fog_height);
}

fn air_over(d: vec3f, eye_y: f32, rgb: vec3f, length_in: f32) -> vec3f {
  var length = length_in;
  if length < 0.0 {
    if d.y != 0.0 {
      length = abs(frame.cloud_height / (d.y + d.y));
    } else {
      length = 1e20;
    }
  }
  var r = rgb.x;
  var g = rgb.y;
  var b = rgb.z;
  if frame.fog_on > 0.5 {
    let reach = length - FOG_START;
    if reach > 0.0 {
      let m = (fog_depth(FOG_START, d.y, eye_y) + fog_depth(length, d.y, eye_y)) * 0.5;
      var n = reach * m;
      if frame.fog_amount < 0.1 { n *= 10.0 * frame.fog_amount; }
      if n > 0.0 {
        let a = clamp(n / (FOG_BASE + (1.0 - FOG_BASE) * frame.fog_amount), 0.0, frame.fog_amount);
        r = toward(r, frame.fog_colour.x, a);
        g = toward(g, frame.fog_colour.y, a);
        b = toward(b, frame.fog_colour.z, a);
      }
    }
  }
  if frame.haze_on > 0.5 && d.y > 0.0 {
    let kappa = abs(frame.cloud_height / (d.y + d.y));
    if length >= kappa { length = kappa; }
  }
  if frame.haze_on > 0.5 {
    var reach = length - HAZE_START;
    if reach > 0.0 {
      let x = reach / frame.haze_scale;
      let wr = 1.0 - exp2(-frame.haze_rates.x * x * LOG2E);
      let wg = 1.0 - exp2(-frame.haze_rates.y * x * LOG2E);
      let wb = 1.0 - exp2(-frame.haze_rates.z * x * LOG2E);
      r = toward(r, frame.haze_colour.x, wr);
      g = toward(g, frame.haze_colour.y, wg);
      b = toward(b, frame.haze_colour.z, wb);
    }
  }
  return vec3f(r, g, b);
}

fn colour_ray(d: vec3f, ex: f32, ey: f32, ez: f32) -> vec3f {
  var col = colour_seen(d);
  col = clouds_over(d, ex, ey, ez, col);
  let stars = star_gain(d, col.seen);
  var rgb = col.rgb;
  if stars > 0.0 {
    rgb.x = rgb.x + stars * (0.92 - rgb.x);
    rgb.y = rgb.y + stars * (0.95 - rgb.y);
    rgb.z = rgb.z + stars * (1.0 - rgb.z);
  }
  return air_over(d, ey, rgb, -1.0);
}

fn smoothstep01(a: f32, b: f32, x: f32) -> f32 {
  if x <= a { return 0.0; }
  if x >= b { return 1.0; }
  let t = (x - a) / (b - a);
  return t * t * (3.0 - 2.0 * t);
}

fn strata_color(x: f32, y: f32, z: f32) -> vec3f {
  let freq = 0.25 + frame.earth_tex * 3.5;
  let warp = (noise_rock(x * 0.08 * freq, y * 0.03 * freq, z * 0.08 * freq) - 0.5) * 5.5;
  let bend = (noise_rock(x * 0.22 * freq, 2.1, z * 0.22 * freq) - 0.5) * 1.4;
  let t = y * (0.15 + frame.earth_tex * 0.9) + warp + bend;
  let i = i32(floor(t));
  let f = t - f32(i);
  let u = f * f * (3.0 - 2.0 * f);
  var strata = array<vec3f, 6>(
    vec3f(0.52, 0.34, 0.2),
    vec3f(0.28, 0.19, 0.13),
    vec3f(0.7, 0.54, 0.36),
    vec3f(0.36, 0.25, 0.16),
    vec3f(0.78, 0.7, 0.56),
    vec3f(0.22, 0.16, 0.12),
  );
  let ia = (i % 6 + 6) % 6;
  let ib = ((i + 1) % 6 + 6) % 6;
  return mix(strata[ia], strata[ib], u);
}

fn albedo(hit: Hit) -> vec3f {
  let x = hit.x;
  let y = hit.y;
  let z = hit.z;
  let h = clamp(y / frame.height_scale, 0.0, 1.0);
  let slope = 1.0 - clamp(hit.ny, 0.0, 1.0);
  let f = 0.6 + frame.earth_tex * 3.0;
  let fine = noise_rock(x * 2.1 * f, y * 1.3 * f, z * 2.1 * f);
  let grain = 0.84 + (0.12 + frame.earth_tex * 0.45) * fine;
  let rock = strata_color(x, y, z);
  var c: vec3f;
  let m = frame.material;
  if m < 0.5 {
    c = mix(vec3f(0.55, 0.4, 0.26), rock, smoothstep01(0.35, 0.82, slope) * 0.62);
    let snow = smoothstep01(0.72, 0.9, h) * (1.0 - smoothstep01(0.18, 0.52, slope));
    c = mix(c, vec3f(0.93, 0.94, 0.96), snow * (0.7 + 0.3 * fine));
  } else if m < 1.5 {
    let grass_n = noise_rock(x * 0.2, 0.4, z * 0.2);
    let grass = smoothstep01(0.04, 0.2, h)
      * (1.0 - smoothstep01(0.38, 0.7, h))
      * (1.0 - smoothstep01(0.28, 0.62, slope))
      * smoothstep01(0.42, 0.68, grass_n);
    c = mix(vec3f(0.46, 0.38, 0.26), rock, smoothstep01(0.4, 0.85, slope) * 0.55);
    c = mix(c, vec3f(0.32, 0.5, 0.22), grass);
    let snow = smoothstep01(0.66, 0.86, h) * (1.0 - smoothstep01(0.16, 0.48, slope));
    c = mix(c, vec3f(0.94, 0.95, 0.97), snow * (0.75 + 0.25 * fine));
  } else if m < 2.5 {
    let dune = smoothstep01(0.25, 0.7, h);
    c = mix(vec3f(0.76, 0.62, 0.38), vec3f(0.58, 0.4, 0.22), dune);
    c = mix(c, vec3f(0.42, 0.28, 0.16), smoothstep01(0.4, 0.9, slope) * 0.65);
    c = mix(c, vec3f(0.86, 0.74, 0.5), (fine - 0.5) * 0.35 + 0.15);
  } else {
    let pale = smoothstep01(0.2, 0.85, h);
    c = mix(vec3f(0.2, 0.2, 0.22), vec3f(0.55, 0.55, 0.58), pale);
    c = mix(c, rock, smoothstep01(0.3, 0.75, slope) * 0.45);
  }
  let dyed = c * grain;
  let luma = dot(dyed, vec3f(0.3, 0.59, 0.11));
  return luma * frame.earth * 2.1;
}

fn field_at(x: f32, y: f32, z: f32) -> f32 {
  let f = 0.7 + frame.earth_tex * 2.4;
  let grain = noise_rock(x * 1.6 * f, y * 1.1 * f, z * 1.6 * f);
  let fine = noise_rock(x * 4.4 * f, y * 3.2 * f, z * 4.4 * f);
  return (grain - 0.5) * 0.55 + (fine - 0.5) * 0.2;
}

fn perturb(n: vec3f, g: vec3f, factor: f32) -> vec3f {
  let along = dot(g, n);
  return safe_norm(n - factor * (g - along * n));
}

fn terrain_normal(hit: Hit) -> vec3f {
  let h = 0.18;
  let f0 = field_at(hit.x, hit.y, hit.z);
  let g = vec3f(
    (field_at(hit.x + h, hit.y, hit.z) - f0) / h,
    (field_at(hit.x, hit.y + h, hit.z) - f0) / h,
    (field_at(hit.x, hit.y, hit.z + h) - f0) / h,
  );
  let slope = 1.0 - max(hit.ny, 0.0);
  return perturb(vec3f(hit.nx, hit.ny, hit.nz), g, 0.05 + frame.earth_tex * 0.5 + slope * 0.22);
}

fn shade_terrain(hit: Hit, water_y: f32) -> vec3f {
  let n = terrain_normal(hit);
  let ndl = dot(n, frame.light_dir);
  let base = albedo(hit);
  let up = clamp(n.y * 0.65 + 0.2, 0.0, 1.0);
  let fill = mix(frame.horizon, frame.overhead, up);
  var direct = 0.0;
  var wrap = 0.35;
  if hit.ok == 2u {
    // shadowed: wrap stays 0.35, direct stays 0
  } else {
    direct = max(ndl, 0.0) * frame.light_intensity;
    wrap = max(ndl, 0.0) * 0.55 + 0.45;
  }
  var rgb = base * (fill * 0.62 + frame.light_colour * direct * wrap);
  if hit.y < water_y {
    rgb *= vec3f(0.75, 0.82, 0.8);
  }
  return rgb;
}

fn water_slope(x: f32, z: f32) -> vec2f {
  if !(frame.wave_amp > 0.0) { return vec2f(0.0); }
  let turn = array<f32, 5>(0.0, 0.26, -0.2, 0.1, -0.08);
  let kk = array<f32, 5>(0.48, 0.9, 1.25, 2.2, 3.5);
  let aa = array<f32, 5>(0.64, 0.2, 0.13, 0.06, 0.035);
  var gx = 0.0;
  var gz = 0.0;
  for (var i = 0; i < 5; i++) {
    let ang = frame.wave_heading + turn[i];
    let cx = cos(ang);
    let cz = sin(ang);
    let k = frame.wave_freq * kk[i];
    let phase = (x * cx + z * cz) * k + turn[i] * 1.7;
    let slope = cos(phase) * aa[i] * k * frame.wave_amp;
    gx += slope * cx;
    gz += slope * cz;
  }
  return vec2f(gx, gz);
}

fn water_normal(x: f32, z: f32, dist: f32) -> vec3f {
  let g = water_slope(x, z);
  let fade_w = 1.0 / (1.0 + dist * 0.035);
  let grad = vec3f(g.x, 0.0, g.y);
  var n = perturb(vec3f(0.0, 1.0, 0.0), grad, 0.72 * fade_w);
  if n.y < 0.45 {
    n = perturb(vec3f(0.0, 1.0, 0.0), grad, 0.32 * fade_w);
  }
  return n;
}

fn reflect_dir(d: vec3f, n: vec3f) -> vec3f {
  return d - 2.0 * dot(d, n) * n;
}

fn rim_fade(x: f32, z: f32) -> f32 {
  let half = frame.span * 0.5;
  let inset = min(half - abs(x), half - abs(z));
  let u = inset / 8.0;
  if !(u > 0.0) { return 0.0; }
  if u >= 1.0 { return 1.0; }
  return u * u * (3.0 - 2.0 * u);
}

fn water_share(ndv: f32) -> f32 {
  let p = pow(0.98 * ndv, 0.8);
  return 1.0 - WATER_E * (1.0 - p);
}

fn shade_hit(hit_in: Hit, water_y: f32) -> vec3f {
  var hit = hit_in;
  let lit = dot(vec3f(hit.nx, hit.ny, hit.nz), frame.light_dir);
  if lit > 0.0 {
    let shadow = trace(
      hit.x + hit.nx * 0.45,
      hit.y + hit.ny * 0.45,
      hit.z + hit.nz * 0.45,
      frame.light_dir,
      0.05,
      400.0,
      true,
    );
    if shadow.ok == 1u { hit.ok = 2u; }
  }
  return shade_terrain(hit, water_y);
}

fn outside_mask(x: f32, y: f32) -> bool {
  if frame.mask < 0.5 { return false; }
  let rad = frame.mask_r * 0.5 * min(frame.pix_w, frame.pix_h);
  let dx = x + 0.5 - frame.pix_w * 0.5;
  let dy = y + 0.5 - frame.pix_h * 0.5;
  return dx * dx + dy * dy > rad * rad;
}

fn pixel(x: f32, y: f32) -> vec3f {
  let d = safe_norm(camera_ray(x, y));
  let ex = frame.eye.x;
  let ey = frame.eye.y;
  let ez = frame.eye.z;
  let ground = trace(ex, ey, ez, d, 0.08, 1e7, false);
  if outside_mask(x, y) {
    if ground.ok == 0u { return vec3f(0.0); }
    let lit = shade_hit(ground, -1e9);
    return air_over(d, ey, lit, ground.t);
  }
  var water_t = -1.0;
  if frame.water_on > 0.5 && abs(d.y) > 1e-6 {
    let t = (frame.water_y - ey) / d.y;
    if t > 0.05 { water_t = t; }
  }
  let water_first = water_t > 0.0 && (ground.ok == 0u || water_t < ground.t);
  if !water_first && ground.ok == 0u {
    return colour_ray(d, ex, ey, ez);
  }
  let level = select(-1e9, frame.water_y, frame.water_on > 0.5);
  if !water_first {
    let lit = shade_hit(ground, level);
    return air_over(d, ey, lit, ground.t);
  }
  let wx = ex + water_t * d.x;
  let wz = ez + water_t * d.z;
  let n = water_normal(wx, wz, water_t);
  let ndv = max(0.0, -dot(d, n));
  let share = water_share(ndv);
  let through = share * WATER_T;
  let R = reflect_dir(d, n);
  let reflected = colour_ray(R, wx, frame.water_y, wz);
  let ndl = max(0.0, dot(n, frame.light_dir));
  let sun = 0.62 + 0.7 * ndl;
  let ink = frame.water_colour;
  var rgb = ink * sun + reflected * WATER_RHO;
  if ground.ok == 1u && ground.t > water_t {
    let under = shade_hit(ground, frame.water_y);
    let depth = max(0.0, frame.water_y - ground.y);
    let seen = through * exp(-depth * 1.15) * rim_fade(ground.x, ground.z);
    rgb += under * (vec3f(0.62) + 0.38 * ink) * seen;
  }
  let c_ref = max(0.0, dot(R, frame.light_dir));
  let spec = (pow(c_ref, 90.0) * 0.85 + pow(c_ref, 40.0) * 0.12) * frame.light_intensity;
  rgb += frame.light_colour * spec;
  return air_over(d, ey, rgb, water_t);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if f32(gid.x) >= frame.pix_w || f32(gid.y) >= frame.pix_h { return; }
  let rgb = pixel(f32(gid.x), f32(gid.y));
  textureStore(out_tex, vec2i(i32(gid.x), i32(gid.y)), vec4f(rgb, 1.0));
}
