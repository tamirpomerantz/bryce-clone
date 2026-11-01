// Bryce 3.0 / 3.1 sky colours and haze rates.
// Arithmetic follows the MIT-licensed description in
// https://github.com/tatleoat/stecyk3d (src/sky/colours.rs, src/sky/air.rs).

const B = 1 / 255;
// Exact bits of the cloud hue weight constant (about 10 log2(e)).
const CLOUD_K = new Float64Array(new BigUint64Array([0x402cda993e7663ben]).buffer)[0];

/** Hexcone HLS as Bryce 3.0 / 3.1. A hue of 1 yields no colour. */
export function hls(h, l, s) {
  const v = l <= 0.5 ? (s + 1) * l : l + s - l * s;
  if (!(v > 0)) return [0, 0, 0];
  const bigV = Math.fround(v);
  const vd = bigV;
  const mu = l + l - vd;
  const six = 6 * h;
  const n = Math.trunc(six);
  const f = six - n;
  const m = Math.fround(mu);
  const ramp = ((vd - mu) / vd) * f * vd;
  const x = Math.fround(ramp + mu);
  const y = Math.fround(vd - ramp);
  switch (n) {
    case 0: return [bigV, x, m];
    case 1: return [y, bigV, m];
    case 2: return [m, bigV, x];
    case 3: return [m, y, bigV];
    case 4: return [x, m, bigV];
    case 5: return [bigV, m, y];
    default: return null;
  }
}

function hlsColour(h, l, s) {
  return hls(h, l, s) || [0, 0, 0];
}

/** Z, the colour overhead, from the sun's height y in -1..1. */
export function overhead(y) {
  const yc = Math.max(-1, Math.min(1, y));
  if (!(yc < 0)) {
    const h = Math.fround((200 - 55 * yc) * B);
    const l = Math.fround(64 * (yc + 1) * B);
    return hlsColour(h, l, Math.fround(240 / 255));
  }
  const tau = 64 * (1 + 2 * yc);
  if (tau > 0) {
    const h = Math.fround((200 + 55 * yc) * B);
    const l = Math.fround(tau * B);
    return hlsColour(h, l, Math.fround(240 / 255));
  }
  return [0, 0, 0];
}

/** Glow hue that follows the sun (sky switch bit 0x2). */
export function glowBase(y) {
  const yc = Math.max(-1, Math.min(1, y));
  if (!(yc < 0)) {
    return hlsColour(Math.fround((160 + 60 * (1 - yc)) * B), Math.fround(200 / 255), 1);
  }
  return hlsColour(
    Math.fround(220 / 255),
    Math.fround((200 + 128 * yc) * B),
    Math.fround(255 * (yc + 1) * B),
  );
}

/** Step 3: cloud colour drawn toward a hue that follows the sun. */
export function cloudStep(y, cloudColour) {
  const j = Math.trunc(255 + 150 * y);
  const i = ((j % 255) + 255) % 255;
  const hc = hlsColour(Math.fround(i * B), Math.fround(130 / 255), 1);
  const weight = 2 ** (-Math.abs(y) * CLOUD_K);
  const omega = Math.fround(weight);
  const colour = [0, 1, 2].map((k) => {
    const pre = Math.fround(cloudColour[k] + (hc[k] - cloudColour[k]) * omega);
    if (-y < 0.125) return Math.fround(pre * (1 + 3 * y));
    return Math.fround(pre * 0.625);
  });
  return { hue: hc, weight, colour };
}

/**
 * Haze rates and scale as Bryce 3.0.
 * haze and lightHeight are the sky's haze amount and the sun's y.
 */
export function hazeBryce30(haze, hazeColour, lightHeight) {
  const theta = 1 - Math.exp(haze * 0.2 * -12);
  const gamma = (hazeColour[0] + hazeColour[1] + hazeColour[2]) * 0.333333;
  const q = 4 * lightHeight;
  const low = 2 - q > 0.5 ? 2 - q : 0.5;
  const high = q > 0.5 ? q : 0.5;
  const rate = (m) => Math.fround(theta * Math.fround((m - 1) * gamma + 1));
  return {
    rates: [rate(low), Math.fround(theta), rate(high)],
    scale: 390.625 - 76.171875 * haze,
  };
}

export function sunDirection(azimuthDeg, altitudeDeg) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (altitudeDeg * Math.PI) / 180;
  const cy = Math.sin(el);
  const horiz = Math.cos(el);
  return [Math.sin(az) * horiz, cy, Math.cos(az) * horiz];
}

/** Main light as 3.0: below the horizon it becomes the moon, opposite the sun. */
export function mainLight(direction, colour) {
  const y = direction[1];
  if (y < 0) {
    const u = -y;
    const rg = Math.min(u * 0.5, 0.374);
    const b = Math.min(u * 0.625, 0.438);
    return {
      direction: [-direction[0], -direction[1], -direction[2]],
      colour: [rg, rg, b],
      intensity: 1,
      night: true,
    };
  }
  return {
    direction,
    colour,
    intensity: 1.1255,
    night: false,
  };
}

export function mix3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function parseHex(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
