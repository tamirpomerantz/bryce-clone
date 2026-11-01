// Shared sky, cloud, haze and water shading.
// Cloud cover and the haze/fog composite follow Bryce 3
// (stecyk3d src/sky/clouds.rs and src/sky/air.rs). The noise itself is a
// stand-in for Bryce's procedural lattice, which lives in the installed
// application rather than on the CD.

export const SKY_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * valueNoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uLightIntensity;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uCloudColor;
uniform vec3 uCloudCore;
uniform float uCloudCover;
uniform float uCloudAmp;
uniform float uCloudFreq;
uniform float uCloudHeight;
uniform vec2 uCloudOffset;
uniform float uTime;
uniform vec3 uHazeColor;
uniform vec3 uHazeRates;
uniform float uHazeScale;
uniform float uHazeAmount;
uniform vec3 uFogColor;
uniform float uFog;
uniform float uFogHeight;
uniform float uStarSeed;
uniform vec3 uCamPos;

vec3 applyFog(vec3 c, vec3 origin, vec3 dir, float dist) {
  if (!(uFog > 0.0) || !(uFogHeight > 0.0)) return c;
  float r = dist - 0.390625;
  if (!(r > 0.0)) return c;
  float depthAt = 1.0 - (origin.y + dir.y * dist) / uFogHeight;
  float depth0 = 1.0 - (origin.y + dir.y * 0.390625) / uFogHeight;
  depthAt = max(depthAt, 0.0);
  depth0 = max(depth0, 0.0);
  float m = (depth0 + depthAt) * 0.5;
  float n = r * m;
  if (uFog < 0.1) n *= 10.0 * uFog;
  if (!(n > 0.0)) return c;
  float a = n / (19.53125 + (1.0 - 19.53125) * uFog);
  a = clamp(a, 0.0, 1.0);
  return c + (uFogColor - c) * a;
}

vec3 applyHaze(vec3 c, vec3 dir, float dist) {
  if (!(uHazeAmount > 0.0)) return c;
  float l = dist;
  if (dir.y > 0.0) {
    float kappa = abs(uCloudHeight / (dir.y + dir.y));
    if (l > kappa) l = kappa;
  }
  float r = l - 4.8828125;
  if (!(r > 0.0)) return c;
  float x = r / uHazeScale;
  vec3 w = vec3(1.0) - exp(-uHazeRates * x);
  return c + (uHazeColor - c) * w;
}

float cloudShadeAt(vec2 worldXZ) {
  float scale = uCloudFreq * 0.00256;
  vec2 p = (worldXZ + uCloudOffset) * scale;
  float v = fbm(p + vec2(360.3));
  float kappa = (2.0 * v - 1.0) * uCloudAmp + uCloudCover;
  return clamp(kappa, 0.0, 1.0);
}

vec3 skyColour(vec3 dir) {
  vec3 n = normalize(dir);
  float up = n.y;
  float elev = clamp(up, 0.0, 1.0);
  float horizonW = pow(1.0 - elev, 1.35);
  vec3 col = mix(uZenith, uHorizon, horizonW);

  float sunDot = dot(n, normalize(uSunDir));
  float ang = acos(clamp(sunDot, -1.0, 1.0));
  float glow = exp(-ang * 4.2);
  float tight = exp(-ang * 28.0);
  col += uSunColor * (glow * 0.55 + tight * 1.15) * (1.0 - step(0.02, max(-uSunDir.y, 0.0)));
  float disc = 1.0 - smoothstep(0.0045, 0.012, ang);
  if (uSunDir.y > -0.02) col = mix(col, uSunColor * 1.35, disc);

  vec3 moonDir = -normalize(uSunDir);
  float moonAng = acos(clamp(dot(n, moonDir), -1.0, 1.0));
  float moon = 1.0 - smoothstep(0.018, 0.03, moonAng);
  float night = smoothstep(0.08, -0.12, uSunDir.y);
  col += vec3(0.75, 0.78, 0.85) * moon * night;
  col = mix(col, col * vec3(0.04, 0.055, 0.1), night * (1.0 - elev * 0.35));

  if (n.y > 0.02 && uCloudCover > -0.8) {
    float scale = uCloudFreq * 0.00256;
    float upperH = uCloudHeight + 24.4140625;
    float tUp = (upperH - uCamPos.y) / n.y;
    if (tUp > 0.0) {
      vec2 p = ((uCamPos.xz + n.xz * tUp) + uCloudOffset * 0.5) * scale;
      float vUp = fbm(p + vec2(p.y * 0.5, 0.0));
      float kUp = clamp(uCloudCover + ((2.0 * vUp - 1.0) * uCloudAmp) * 0.5, 0.0, 1.0);
      float q = 1.0 - abs(n.y);
      q = q * q;
      q = q * q;
      vec3 upperCol = mix(uLightColor, uHorizon, q);
      col = mix(col, upperCol, kUp * 0.85);
    }
    float tLow = (uCloudHeight - uCamPos.y) / n.y;
    if (tLow > 0.0) {
      vec2 p = ((uCamPos.xz + n.xz * tLow) + uCloudOffset) * scale;
      vec2 lowP = p + vec2(360.3);
      float v = fbm(lowP);
      v = mix(v, smoothstep(0.4, 0.78, v), 0.7);
      float kappa = (2.0 * v - 1.0) * uCloudAmp + uCloudCover;
      if (kappa > 0.0) {
        float kp = min(kappa, 4.0);
        float e = pow(clamp(dot(n, normalize(uSunDir)) * 0.5 + 0.5, 0.0, 1.0), 2.0);
        float v2 = fbm(lowP * 0.5 + 4.2);
        float lambda = clamp(e + (2.0 * v2 - 1.0) * 0.5, 0.0, 1.0);
        vec3 lit = mix(uCloudColor, uLightColor, lambda);
        float v3 = fbm(lowP + 9.0);
        float u = clamp((2.0 * v3 - 1.0) + 0.4, 0.0, 1.0);
        vec3 body = uCloudCore + u * (lit - uCloudCore);
        float sigma = clamp((1.0 - 0.15 * kp) - 0.5 * e, 0.15, 1.4);
        body *= sigma;
        float nu = clamp((1.0 - min(kp, 1.0)) * e, 0.0, 1.0);
        body = body + nu * (uLightColor - body);
        float rho = min(kp, 1.0);
        col = col + rho * (body - col);
      }
    }
  }

  if (night > 0.2 && n.y > 0.0) {
    vec2 sp = n.xz / max(n.y, 0.2) * 70.0;
    vec2 cell = floor(sp);
    vec2 f = fract(sp) - 0.5;
    float star = step(0.996, hash12(cell + uStarSeed));
    star *= 1.0 - smoothstep(0.02, 0.12, length(f));
    star *= smoothstep(0.05, 0.4, n.y);
    col += vec3(0.9, 0.93, 1.0) * star * night;
  }

  if (n.y < 0.0) {
    col = mix(uHorizon * 0.35, col, exp(n.y * 4.0));
  }
  return max(col, vec3(0.0));
}
`;

export const SKY_MAP_GLSL = /* glsl */ `
uniform sampler2D uSkyMap;
vec3 skyMap(vec3 dir) {
  vec3 n = normalize(dir);
  float lon = atan(n.z, n.x);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  return texture2D(uSkyMap, vec2(lon * 0.15915494309189535 + 0.5, lat * 0.3183098861837907 + 0.5)).rgb;
}
`;

export const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 view = inverse(projectionMatrix) * vec4(position.xy, 1.0, 1.0);
  vDir = normalize((inverse(viewMatrix) * vec4(view.xyz, 0.0)).xyz);
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

export const skyFragment = /* glsl */ `
precision highp float;
uniform sampler2D uSkyView;
uniform vec2 uResolution;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  gl_FragColor = vec4(texture2D(uSkyView, uv).rgb, 1.0);
}
`;

export const terrainVertex = /* glsl */ `
attribute float aHeight;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vHeight;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vHeight = aHeight;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const terrainFragment = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vHeight;
uniform float uMaterial;
uniform float uWaterY;
${SKY_GLSL}
void main() {
  vec3 n = normalize(vNormal);
  vec3 sun = normalize(uLightDir);
  float ndl = max(dot(n, sun), 0.0);
  float slope = clamp(1.0 - n.y, 0.0, 1.0);
  float h = vHeight;
  vec3 albedo;
  if (uMaterial < 0.5) {
    albedo = mix(vec3(0.62, 0.48, 0.30), vec3(0.55, 0.32, 0.18), smoothstep(0.12, 0.34, h));
    albedo = mix(albedo, vec3(0.46, 0.42, 0.38), smoothstep(0.38, 0.68, h));
    float snow = smoothstep(0.72, 0.9, h) * (1.0 - smoothstep(0.22, 0.58, slope));
    albedo = mix(albedo, vec3(0.93, 0.94, 0.96), snow);
    albedo = mix(albedo, vec3(0.36, 0.26, 0.20), smoothstep(0.28, 0.72, slope) * (1.0 - snow));
  } else if (uMaterial < 1.5) {
    albedo = mix(vec3(0.55, 0.46, 0.28), vec3(0.28, 0.40, 0.16), smoothstep(0.08, 0.28, h));
    albedo = mix(albedo, vec3(0.42, 0.40, 0.36), smoothstep(0.4, 0.66, h));
    float snow = smoothstep(0.62, 0.84, h) * (1.0 - smoothstep(0.2, 0.5, slope));
    albedo = mix(albedo, vec3(0.95, 0.96, 0.98), snow);
    albedo = mix(albedo, vec3(0.34, 0.32, 0.30), smoothstep(0.35, 0.8, slope) * (1.0 - snow));
  } else if (uMaterial < 2.5) {
    albedo = mix(vec3(0.74, 0.60, 0.36), vec3(0.62, 0.40, 0.22), smoothstep(0.25, 0.7, h));
    albedo = mix(albedo, vec3(0.45, 0.28, 0.16), smoothstep(0.4, 0.9, slope));
  } else {
    albedo = mix(vec3(0.22, 0.22, 0.24), vec3(0.55, 0.55, 0.58), smoothstep(0.2, 0.85, h));
    albedo = mix(albedo, vec3(0.16, 0.16, 0.18), smoothstep(0.3, 0.8, slope));
  }
  float ao = mix(0.72, 1.0, smoothstep(0.0, 0.45, n.y));
  float shade = 1.0 - 0.45 * cloudShadeAt(vWorld.xz);
  float wrap = clamp(dot(n, sun) * 0.55 + 0.45, 0.0, 1.0);
  vec3 skyFill = mix(uHorizon, uZenith, clamp(n.y * 0.65 + 0.2, 0.0, 1.0));
  vec3 lit = albedo * ao * (skyFill * 0.62 + uLightColor * wrap * uLightIntensity * shade);
  if (vWorld.y < uWaterY) {
    lit = mix(lit, lit * vec3(0.45, 0.55, 0.5), 0.45);
  }
  vec3 viewDir = normalize(vWorld - uCamPos);
  float dist = length(vWorld - uCamPos);
  lit = applyFog(lit, uCamPos, viewDir, dist);
  lit = applyHaze(lit, viewDir, dist);
  gl_FragColor = vec4(lit, 1.0);
}
`;

export const waterVertex = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const waterFragment = /* glsl */ `
precision highp float;
varying vec3 vWorld;
uniform float uWaterY;
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uLightIntensity;
${SKY_MAP_GLSL}
void main() {
  vec2 w = vWorld.xz;
  float t = uTime;
  float wx = sin(w.x * 0.31 + t * 0.7) * cos(w.y * 0.22 + t * 0.4);
  float wz = sin(w.y * 0.37 - t * 0.55) * cos(w.x * 0.18 + t * 0.33);
  wx += sin(w.x * 1.3 + w.y * 0.7 + t) * 0.25;
  wz += cos(w.y * 1.1 - w.x * 0.5 + t * 0.8) * 0.25;
  vec3 n = normalize(vec3(wx * 0.045, 1.0, wz * 0.045));
  vec3 I = normalize(vWorld - uCamPos);
  vec3 R = reflect(I, n);
  vec3 reflected = skyMap(R);
  float ndv = max(dot(-I, n), 0.0);
  float fres = 0.42 + 0.58 * pow(1.0 - ndv, 3.0);
  vec3 deep = vec3(0.04, 0.11, 0.1);
  vec3 sun = normalize(uLightDir);
  vec3 H = normalize(sun - I);
  float spec = pow(max(dot(n, H), 0.0), 280.0) * uLightIntensity;
  vec3 col = mix(deep, reflected, fres);
  col += uLightColor * spec * fres;
  float alpha = mix(0.9, 0.98, fres);
  gl_FragColor = vec4(col, alpha);
}
`;
