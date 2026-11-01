import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { applyEffect, blank, createRand, erode, fractal, newRelief, resize } from "./terrain.js?v=23";
import {
  cloudStep,
  hazeBryce30,
  mainLight,
  mix3,
  overhead,
  sunDirection,
} from "./skymath.js";
import {
  skyFragment,
  skyVertex,
  terrainFragment,
  terrainVertex,
  waterFragment,
  waterVertex,
} from "./shaders.js";
import { makeSky } from "./engine/sky.js?v=12";
import { fillBand, fillFrame } from "./engine/frame.js?v=40";
import { createGpuBaker } from "./engine/gpu.js?v=40";

const WIDTH = 100;
const HEIGHT_SCALE = 16;
const DISPLAY_SIDE = 256;

const SCENES = [
  { name: "Eroded coast", map: "erosion-3", seed: 1, skyC: 58, skyT: 28, earthC: 14, earthT: 8, waterC: 22, waterS: 32 },
  { name: "New island", kind: "new", seed: 1, skyC: 56, skyT: 45, earthC: 32, earthT: 37, waterC: 24, waterS: 16 },
  { name: "Fractal range", kind: "fractal-erode", seed: 11, skyC: 54, skyT: 48, earthC: 30, earthT: 40, waterC: 20, waterS: 22 },
  { name: "Dunes", map: "dunes", seed: 1, skyC: 12, skyT: 32, earthC: 10, earthT: 62, waterC: 16, waterS: 4 },
  { name: "Crater lake", map: "crater-lake", seed: 1, skyC: 55, skyT: 42, earthC: 28, earthT: 36, waterC: 20, waterS: 58 },
  { name: "Valley", map: "valley", seed: 1, skyC: 60, skyT: 34, earthC: 16, earthT: 10, waterC: 24, waterS: 28 },
  { name: "Night water", map: "lakes", seed: 1, skyC: 62, skyT: 2, earthC: 4, earthT: 88, waterC: 8, waterS: 40 },
];

const $ = (id) => document.getElementById(id);

const baseUniforms = {
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Vector3(1, 0.95, 0.8) },
  uLightDir: { value: new THREE.Vector3(0, 1, 0) },
  uLightColor: { value: new THREE.Vector3(1, 1, 1) },
  uLightIntensity: { value: 1.1 },
  uZenith: { value: new THREE.Vector3(0.35, 0.55, 0.85) },
  uHorizon: { value: new THREE.Vector3(0.9, 0.7, 0.5) },
  uCloudColor: { value: new THREE.Vector3(0.95, 0.95, 0.95) },
  uCloudCore: { value: new THREE.Vector3(0.8, 0.75, 0.7) },
  uCloudCover: { value: 0.2 },
  uCloudAmp: { value: 1 },
  uCloudFreq: { value: 80 },
  uCloudHeight: { value: 36 },
  uCloudOffset: { value: new THREE.Vector2() },
  uTime: { value: 0 },
  uHazeColor: { value: new THREE.Vector3(0.8, 0.75, 0.65) },
  uHazeRates: { value: new THREE.Vector3(0.4, 0.5, 0.7) },
  uHazeScale: { value: 320 },
  uHazeAmount: { value: 0.8 },
  uFogColor: { value: new THREE.Vector3(0.8, 0.85, 0.88) },
  uFog: { value: 0.04 },
  uFogHeight: { value: 5 },
  uStarSeed: { value: 3 },
  uCamPos: { value: new THREE.Vector3() },
};

const PAN_W = 320;
const PAN_H = 160;
const panoramaData = new Uint8Array(PAN_W * PAN_H * 4);
const skyTexture = new THREE.DataTexture(panoramaData, PAN_W, PAN_H);
skyTexture.colorSpace = THREE.LinearSRGBColorSpace;
skyTexture.wrapS = THREE.RepeatWrapping;
skyTexture.wrapT = THREE.ClampToEdgeWrapping;
skyTexture.magFilter = THREE.LinearFilter;
skyTexture.minFilter = THREE.LinearFilter;
skyTexture.generateMipmaps = false;
skyTexture.flipY = false;
skyTexture.needsUpdate = true;

let viewW = 2;
let viewH = 2;
let viewData = new Uint8Array(viewW * viewH * 4);
const skyView = new THREE.DataTexture(viewData, viewW, viewH);
skyView.colorSpace = THREE.LinearSRGBColorSpace;
skyView.wrapS = THREE.ClampToEdgeWrapping;
skyView.wrapT = THREE.ClampToEdgeWrapping;
skyView.magFilter = THREE.LinearFilter;
skyView.minFilter = THREE.LinearFilter;
skyView.generateMipmaps = false;
skyView.flipY = false;
skyView.needsUpdate = true;
const drawSize = new THREE.Vector2();

let prepared = null;
const lastEye = new THREE.Vector3(1e9, 0, 0);
const lastTarget = new THREE.Vector3();
const lastOff = new THREE.Vector2(1e9, 0);
const motionEye = new THREE.Vector3();
const motionTarget = new THREE.Vector3();
let viewDrag = false;
let liveUntil = 0;
let calmAt = 0;
let gpuHold = 0;
let shownLive = false;

function skyMaterial() {
  const uniforms = THREE.UniformsUtils.clone(baseUniforms);
  uniforms.uSkyView = { value: skyView };
  uniforms.uResolution = { value: new THREE.Vector2(window.innerWidth, window.innerHeight) };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: skyVertex,
    fragmentShader: skyFragment,
    depthTest: false,
    depthWrite: false,
  });
}

function terrainMaterial() {
  const uniforms = THREE.UniformsUtils.clone(baseUniforms);
  uniforms.uMaterial = { value: 0 };
  uniforms.uWaterY = { value: 2 };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: terrainVertex,
    fragmentShader: terrainFragment,
  });
}

function waterMaterial() {
  const uniforms = THREE.UniformsUtils.clone(baseUniforms);
  uniforms.uSkyMap = { value: skyTexture };
  uniforms.uWaterY = { value: 2 };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: waterVertex,
    fragmentShader: waterFragment,
    transparent: true,
    depthWrite: false,
  });
}

function setVec(uniform, rgb) {
  uniform.value.set(rgb[0], rgb[1], rgb[2]);
}

let grid = { heights: new Uint16Array(DISPLAY_SIDE * DISPLAY_SIDE), side: DISPLAY_SIDE };
let groundReady = false;
let maps = [];

const canvas = $("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.08, 8000);
camera.position.set(40, 11, 62);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 7, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 4;
controls.maxDistance = 220;
controls.autoRotateSpeed = 0.5;
controls.update();
canvas.addEventListener("pointerdown", () => {
  viewDrag = true;
});
window.addEventListener("pointerup", () => {
  viewDrag = false;
});
window.addEventListener("pointercancel", () => {
  viewDrag = false;
});

const sky = new THREE.Mesh(new THREE.BufferGeometry(), skyMaterial());
sky.frustumCulled = false;
sky.renderOrder = -1;
{
  const g = sky.geometry;
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
}
scene.add(sky);

const terrainMat = terrainMaterial();
const terrain = new THREE.Mesh(new THREE.BufferGeometry(), terrainMat);
terrain.visible = false;
scene.add(terrain);

const waterMat = waterMaterial();
const water = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), waterMat);
water.rotation.x = -Math.PI / 2;
water.renderOrder = 2;
water.visible = false;
scene.add(water);

const materials = [sky.material, terrainMat, waterMat];

function readNumber(id) {
  return Number($(id).value);
}

function unit(id) {
  return Math.min(1, Math.max(0, readNumber(id) / 100));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mixc(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function hsl(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

function palette(t, hue0) {
  if (t <= 0.06) return mixc([0.02, 0.02, 0.025], hsl(hue0, 0.5, 0.14), t / 0.06);
  if (t >= 0.94) return mixc(hsl(hue0 + 300, 0.35, 0.7), [0.97, 0.97, 0.96], (t - 0.94) / 0.06);
  const u = (t - 0.06) / 0.88;
  const light = 0.2 + 0.5 * (0.5 - 0.5 * Math.cos(u * Math.PI * 2));
  return hsl(hue0 + u * 360, 0.62, light);
}

function skyColors(t) {
  if (t <= 0.06) {
    const k = t / 0.06;
    const dark = [0.015, 0.016, 0.02];
    return {
      sky: mixc(dark, hsl(222, 0.45, 0.16), k),
      horizon: mixc(dark, hsl(18, 0.35, 0.14), k),
      sun: mixc([0.04, 0.04, 0.06], hsl(32, 0.25, 0.32), k),
      haze: mixc(dark, hsl(220, 0.2, 0.14), k),
      fog: mixc(dark, hsl(210, 0.08, 0.1), k),
      cloud: mixc([0.03, 0.03, 0.04], hsl(220, 0.06, 0.28), k),
    };
  }
  if (t >= 0.94) {
    const k = (t - 0.94) / 0.06;
    const white = [0.98, 0.98, 0.97];
    return {
      sky: mixc(hsl(48, 0.16, 0.86), white, k),
      horizon: mixc(hsl(36, 0.22, 0.9), white, k),
      sun: mixc([1, 0.97, 0.88], [1, 1, 1], k),
      haze: mixc(hsl(40, 0.1, 0.88), white, k),
      fog: mixc([0.9, 0.9, 0.88], white, k),
      cloud: white,
    };
  }
  const u = (t - 0.06) / 0.88;
  const h = u * 360;
  return {
    sky: hsl(h, 0.48, 0.46),
    horizon: hsl(h + 150, 0.55, 0.7),
    sun: hsl(h + 140, 0.55, 0.82),
    haze: hsl(h + 18, 0.34, 0.64),
    fog: hsl(h + 190, 0.16, 0.74),
    cloud: hsl(h + 42, 0.14, 0.92),
  };
}

function terrainFloor() {
  const heights = grid.heights;
  let min = 65535;
  for (let i = 0; i < heights.length; i++) if (heights[i] < min) min = heights[i];
  return (min / 65535) * HEIGHT_SCALE;
}

function waterLevel(waveT) {
  const floorY = terrainFloor();
  const highY = Math.max(floorY, 0.72 * HEIGHT_SCALE);
  return floorY + (highY - floorY) * waveT;
}

function readLook() {
  const colorT = unit("sky-c");
  const toneT = unit("sky-t");
  const earthT = unit("earth-c");
  const texT = unit("earth-t");
  const waterT = unit("water-c");
  const waveT = unit("water-s");
  const colors = skyColors(colorT);
  const cover = lerp(-0.2, 1.2, Math.pow(toneT, 0.75));
  const ink = palette(waterT, 150).map((c, i) => c * (i === 2 ? 0.8 : 0.62));
  return {
    alt: lerp(-12, 80, toneT),
    az: (toneT * 360 + 200) % 360,
    colors,
    haze: lerp(0.02, 1.5, toneT),
    fog: toneT * 0.4,
    fogH: lerp(0.5, 30, toneT),
    cover,
    amp: lerp(0.15, 2, toneT),
    freq: lerp(4, 160, toneT),
    cheight: lerp(8, 80, toneT),
    wind: lerp(0, 2, toneT),
    disc: lerp(0.6, 8, toneT),
    material: Math.min(3, Math.floor(texT * 4)),
    earthTint: palette(earthT, 24),
    earthTex: texT,
    waterOn: true,
    waterY: waterLevel(waveT),
    waterColour: ink,
    waveAmp: lerp(0, 2, waveT),
    waveLength: lerp(3, 0.4, waveT),
    waveHeading: waveT * 360,
  };
}

let sceneLook = null;

function applyLook() {
  const look = readLook();
  sceneLook = look;
  $("sky-c-v").textContent = Math.round(unit("sky-c") * 100) + "%";
  $("sky-t-v").textContent = Math.round(unit("sky-t") * 100) + "%";
  $("earth-c-v").textContent = Math.round(unit("earth-c") * 100) + "%";
  $("earth-t-v").textContent = Math.round(unit("earth-t") * 100) + "%";
  $("water-c-v").textContent = Math.round(unit("water-c") * 100) + "%";
  $("water-s-v").textContent = Math.round(unit("water-s") * 100) + "%";
  $("mask-r-v").textContent = Math.round(readNumber("mask-r")) + "%";
  $("material").value = String(look.material);

  const sunDir = sunDirection(look.az, look.alt);
  const userSun = look.colors.sun;
  const skyCol = look.colors.sky;
  const horizon = look.colors.horizon;
  const over = overhead(sunDir[1]);
  const zenith = mix3(over, skyCol, 0.45);
  const hazeCol = look.colors.haze;
  const haze = hazeBryce30(look.haze, hazeCol, Math.max(sunDir[1], 0));
  const cloudCol = look.colors.cloud;
  const step = cloudStep(sunDir[1], cloudCol);
  const light = mainLight(sunDir, [1, 1, 1]);

  water.position.y = look.waterY;
  water.visible = false;
  terrainMat.uniforms.uMaterial.value = look.material;
  terrainMat.uniforms.uWaterY.value = look.waterY;
  waterMat.uniforms.uWaterY.value = look.waterY;

  for (const m of materials) {
    const u = m.uniforms;
    setVec(u.uSunDir, sunDir);
    setVec(u.uSunColor, userSun);
    setVec(u.uLightDir, light.direction);
    setVec(u.uLightColor, light.colour.map((c, i) => c * userSun[i]));
    u.uLightIntensity.value = light.night ? 0.85 : light.intensity * 1.15;
    setVec(u.uZenith, zenith);
    setVec(u.uHorizon, horizon);
    setVec(u.uCloudColor, mix3(cloudCol, step.hue, 0.35));
    setVec(u.uCloudCore, step.colour);
    u.uCloudCover.value = look.cover;
    u.uCloudAmp.value = look.amp;
    u.uCloudFreq.value = look.freq;
    u.uCloudHeight.value = look.cheight;
    setVec(u.uHazeColor, hazeCol);
    setVec(u.uHazeRates, haze.rates);
    u.uHazeScale.value = haze.scale;
    u.uHazeAmount.value = look.haze;
    setVec(u.uFogColor, look.colors.fog);
    u.uFog.value = look.fog;
    u.uFogHeight.value = look.fogH;
  }

  prepared = makeSky({
    stored: true,
    sunDir,
    sunColour: userSun,
    skyColour: skyCol,
    horizonColour: horizon,
    haze: look.haze,
    hazeColour: hazeCol,
    fog: look.fog,
    fogColour: look.colors.fog,
    fogHeight: look.fogH,
    cover: look.cover,
    amplitude: look.amp,
    frequency: look.freq,
    cloudHeight: look.cheight,
    cloudColour: cloudCol,
    ambient: [0.62, 0.68, 0.78],
    discSize: look.disc,
  });
  scheduleBake();
}

let gpuBaker = null;
let gpuSeen = false;
let gpuDirty = true;

function gpuLive() {
  return viewDrag || performance.now() < liveUntil || performance.now() < calmAt;
}

function viewSize(preview) {
  renderer.getDrawingBufferSize(drawSize);
  const cap = gpuBaker ? Math.min(drawSize.x, preview ? 320 : 640) : (preview ? 320 : 640);
  const bw = Math.min(cap, Math.max(2, drawSize.x));
  const bh = Math.max(2, Math.round(bw * drawSize.y / Math.max(1, drawSize.x)));
  return { bw, bh, dw: drawSize.x, dh: drawSize.y };
}

function cameraBake(preview) {
  const eye = camera.position;
  const off = baseUniforms.uCloudOffset.value;
  const q = camera.quaternion;
  const size = viewSize(preview);
  return {
    ex: eye.x,
    ey: eye.y,
    ez: eye.z,
    ox: off.x,
    oz: off.y,
    fovY: (camera.fov * Math.PI) / 180,
    aspect: size.dw / Math.max(1, size.dh),
    quat: [q.x, q.y, q.z, q.w],
    bw: size.bw,
    bh: size.bh,
    dw: size.dw,
    dh: size.dh,
  };
}

function useView(data, w, h, dw, dh) {
  const image = skyView.image;
  if (image.width !== w || image.height !== h) skyView.dispose();
  viewData = data;
  viewW = w;
  viewH = h;
  skyView.image = { data, width: w, height: h };
  skyView.needsUpdate = true;
  sky.material.uniforms.uResolution.value.set(dw, dh);
}

function groundState() {
  const look = sceneLook || readLook();
  return {
    heights: grid.heights,
    side: grid.side,
    span: WIDTH,
    heightScale: HEIGHT_SCALE,
    material: look.material,
    earthTint: look.earthTint,
    earthTex: look.earthTex,
    waterOn: look.waterOn,
    waterY: look.waterY,
    waterColour: look.waterColour,
    waveAmp: look.waveAmp,
    waveLength: look.waveLength,
    waveHeading: look.waveHeading,
    mask: $("mask").checked,
    maskR: readNumber("mask-r") / 100,
  };
}

function gpuKick() {
  if (!gpuBaker || !prepared || !groundReady || gpuBaker.busy()) return;
  const off = baseUniforms.uCloudOffset.value;
  const now = performance.now();
  const live = gpuLive();
  const eps = live ? 0.015 : 0.08;
  const moved = camera.position.distanceTo(lastEye) > eps || controls.target.distanceTo(lastTarget) > eps;
  const windDue = !live && now - lastBakeAt > 700 && off.distanceTo(lastOff) > 0.15;
  if (!moved && !windDue && !gpuDirty && gpuSeen) return;
  const s = cameraBake(live);
  const eye = camera.position.clone();
  const target = controls.target.clone();
  const offAt = off.clone();
  const started = gpuBaker.submit(prepared, s, groundState(), (bytes, w, h) => {
    useView(bytes, w, h, s.dw, s.dh);
    lastEye.copy(eye);
    lastTarget.copy(target);
    lastOff.copy(offAt);
    lastBakeAt = now;
    gpuSeen = true;
  });
  if (!started) return;
  gpuDirty = false;
  if (live) gpuHold = 1;
}

function showQuickPreview() {
  if (gpuBaker) return;
  if (!prepared || !groundReady) return;
  const s = cameraBake(true);
  const view = new Uint8Array(s.bw * s.bh * 4);
  fillBand(view, s.bw, s.bh, 0, s.bh, prepared, s.ex, s.ey, s.ez, s.ox, s.oz, s.fovY, s.aspect, s.quat, groundState(), false);
  useView(view, s.bw, s.bh, s.dw, s.dh);
}

function bakeSky(preview) {
  if (!prepared) return;
  bakeGen += 1;
  const s = cameraBake(preview);
  const view = new Uint8Array(s.bw * s.bh * 4);
  fillFrame(view, s.bw, s.bh, prepared, s.ex, s.ey, s.ez, s.ox, s.oz, s.fovY, s.aspect, s.quat, groundState());
  useView(view, s.bw, s.bh, s.dw, s.dh);
  lastEye.set(s.ex, s.ey, s.ez);
  lastOff.set(s.ox, s.oz);
}

let baking = false;
let lastBakeAt = 0;
let bakeWaiting = false;
let queuedPreview = false;
let bakeGen = 0;
let bakeJob = null;
const pool = [];
const threads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));

function dropBake() {
  bakeGen += 1;
  bakeJob = null;
  baking = false;
  bakeWaiting = false;
}

function onPart(ev) {
  const part = ev.data;
  if (!bakeJob || part.id !== bakeJob.id) return;
  const src = new Uint8Array(part.view);
  bakeJob.image.set(src, part.y0 * part.vw * 4);
  bakeJob.left -= 1;
  if (bakeJob.left > 0) return;
  useView(bakeJob.image, bakeJob.w, bakeJob.h, bakeJob.dw, bakeJob.dh);
  lastEye.set(bakeJob.ex, bakeJob.ey, bakeJob.ez);
  lastOff.copy(baseUniforms.uCloudOffset.value);
  lastBakeAt = performance.now();
  bakeJob = null;
  baking = false;
  if (bakeWaiting) scheduleBake(queuedPreview);
}

try {
  for (let i = 0; i < threads; i++) {
    const worker = new Worker(new URL("./engine/bake-worker.js?v=40", import.meta.url), { type: "module" });
    worker.onmessage = onPart;
    worker.onerror = () => {
      pool.length = 0;
      baking = false;
      bakeJob = null;
      bakeSky(false);
    };
    pool.push(worker);
  }
} catch {
  pool.length = 0;
}

function scheduleBake(preview) {
  if (!prepared || !groundReady) return;
  if (gpuBaker) {
    gpuDirty = true;
    liveUntil = performance.now() + 220;
    return;
  }
  if (!pool.length) {
    bakeSky(preview);
    return;
  }
  if (baking) {
    bakeWaiting = true;
    if (!preview) queuedPreview = false;
    return;
  }
  baking = true;
  bakeWaiting = false;
  queuedPreview = true;
  lastBakeAt = performance.now();
  const s = cameraBake(!!preview);
  const id = ++bakeGen;
  const image = new Uint8Array(s.bw * s.bh * 4);
  bakeJob = {
    id,
    left: pool.length,
    image,
    w: s.bw,
    h: s.bh,
    dw: s.dw,
    dh: s.dh,
    ex: s.ex,
    ey: s.ey,
    ez: s.ez,
    ox: s.ox,
    oz: s.oz,
  };
  const ground = groundState();
  for (let i = 0; i < pool.length; i++) {
    const y0 = Math.floor((s.bh * i) / pool.length);
    const y1 = Math.floor((s.bh * (i + 1)) / pool.length);
    pool[i].postMessage({
      id,
      y0,
      y1,
      sky: prepared,
      ex: s.ex,
      ey: s.ey,
      ez: s.ez,
      ox: s.ox,
      oz: s.oz,
      fovY: s.fovY,
      aspect: s.aspect,
      quat: s.quat,
      vw: s.bw,
      vh: s.bh,
      ground,
      refine: !preview,
    });
  }
}

function buildMesh() {
  const { heights, side } = grid;
  const seg = side - 1;
  const pos = new Float32Array(side * side * 3);
  const ah = new Float32Array(side * side);
  for (let r = 0; r < side; r++) {
    for (let c = 0; c < side; c++) {
      const i = r * side + c;
      const h = heights[i] / 65535;
      pos[i * 3] = (c / seg - 0.5) * WIDTH;
      pos[i * 3 + 1] = h * HEIGHT_SCALE;
      pos[i * 3 + 2] = (r / seg - 0.5) * WIDTH;
      ah[i] = h;
    }
  }
  const idx = new Uint32Array(seg * seg * 6);
  let k = 0;
  for (let r = 0; r < seg; r++) {
    for (let c = 0; c < seg; c++) {
      const i = r * side + c;
      idx[k++] = i;
      idx[k++] = i + side;
      idx[k++] = i + 1;
      idx[k++] = i + 1;
      idx[k++] = i + side;
      idx[k++] = i + side + 1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aHeight", new THREE.BufferAttribute(ah, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  terrain.geometry.dispose();
  terrain.geometry = geo;
  groundReady = true;
  if (gpuBaker) gpuBaker.setField(grid.heights, grid.side, WIDTH, HEIGHT_SCALE);
  drawHeight();
  dropBake();
  showQuickPreview();
  scheduleBake();
}

function setStatus(text) {
  $("status").textContent = text;
}

function fitDisplay(result) {
  if (result.side === DISPLAY_SIDE) return result;
  return { heights: resize(result.heights, result.side, DISPLAY_SIDE), side: DISPLAY_SIDE };
}

async function paintSoon() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function useNew() {
  setStatus("Building New relief…");
  await paintSoon();
  const seed = readNumber("seed") || 1;
  const t0 = performance.now();
  grid = fitDisplay(newRelief(seed));
  buildMesh();
  setStatus(`New · seed ${seed} · ${Math.round(performance.now() - t0)} ms`);
}

async function useFractal() {
  setStatus("Fractal…");
  await paintSoon();
  const seed = readNumber("seed") || 1;
  const t0 = performance.now();
  grid = fractal(grid.heights, grid.side, seed);
  buildMesh();
  setStatus(`Fractal · seed ${seed} · ${Math.round(performance.now() - t0)} ms`);
}

async function useErode() {
  setStatus("Eroding…");
  await paintSoon();
  const seed = readNumber("seed") || 1;
  const t0 = performance.now();
  grid = erode(grid.heights, grid.side, seed);
  buildMesh();
  setStatus(`Erode · ${Math.round(performance.now() - t0)} ms`);
}

const ELEVATION_TOOLS = [
  ["new", "New"],
  ["invert", "Invert"],
  ["raise", "Raise"],
  ["lower", "Lower"],
  ["undo", "Undo"],
  ["erode", "Erode"],
  ["fractal", "Fractal"],
  ["eroded", "Eroded"],
  ["basic-noise", "Basic noise"],
  ["slope-noise", "Slope noise"],
  ["height-noise", "Height noise"],
  ["gaussian", "Gaussian edges"],
  ["square", "Square edges"],
  ["round", "Round edges"],
  ["spikes", "Spikes"],
  ["dampen", "Dampen"],
  ["subplateaus", "Subplateaus"],
  ["posterize", "Posterize"],
  ["sawtooth", "Sawtooth"],
  ["subcontours", "Subcontours"],
  ["blob", "Blob maker"],
  ["mounds", "Mounds"],
  ["raise-edges", "Raise edges"],
  ["cross", "Cross ridges"],
  ["cross2", "Cross ridges 2"],
  ["bubbles", "Bubble ridges"],
  ["relief", "Relief noise"],
  ["equalize", "Equalize"],
];

const FILTERING_TOOLS = [
  ["smoothing", "Smoothing"],
  ["sharpen", "Sharpening"],
];

const TOOL_NAMES = Object.fromEntries([...ELEVATION_TOOLS, ...FILTERING_TOOLS]);
const undoStack = [];
let editorRand = createRand(1);
let brushDown = false;

function resetRand() {
  editorRand = createRand(readNumber("seed") || 1);
}

function drawHeight() {
  const canvas = $("height-view");
  if (!canvas) return;
  const { heights, side } = grid;
  if (canvas.width !== side) {
    canvas.width = side;
    canvas.height = side;
  }
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(side, side);
  const data = image.data;
  for (let i = 0; i < heights.length; i++) {
    const g = heights[i] >> 8;
    const o = i * 4;
    data[o] = g;
    data[o + 1] = g;
    data[o + 2] = g;
    data[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

function remember() {
  undoStack.push(grid.heights.slice());
  if (undoStack.length > 16) undoStack.shift();
}

function paintCell(x, y, lower) {
  const { heights, side } = grid;
  const radius = Math.max(4, (side / 32) | 0);
  const r2 = radius * radius;
  const c0 = Math.round(x);
  const r0 = Math.round(y);
  for (let r = r0 - radius; r <= r0 + radius; r++) {
    if (r < 0 || r >= side) continue;
    for (let c = c0 - radius; c <= c0 + radius; c++) {
      if (c < 0 || c >= side) continue;
      const d2 = (r - y) * (r - y) + (c - x) * (c - x);
      if (d2 > r2) continue;
      const w = Math.exp(-d2 / (r2 * 0.45));
      const i = r * side + c;
      const delta = (lower ? -2200 : 2200) * w;
      let v = heights[i] + delta;
      if (v < 0) v = 0;
      else if (v > 65535) v = 65535;
      heights[i] = v;
    }
  }
}

async function runTool(name) {
  if (name === "undo") {
    const prev = undoStack.pop();
    if (!prev) return;
    grid = { heights: prev, side: grid.side };
    buildMesh();
    setStatus("Undo");
    return;
  }
  if (name === "new") {
    remember();
    resetRand();
    await useNew();
    return;
  }
  remember();
  setStatus(TOOL_NAMES[name] || name);
  await paintSoon();
  const t0 = performance.now();
  if (name === "fractal") grid = fractal(grid.heights, grid.side, readNumber("seed") || 1, editorRand);
  else if (name === "erode") grid = erode(grid.heights, grid.side, readNumber("seed") || 1, editorRand);
  else grid = { heights: applyEffect(name, grid.heights, grid.side, editorRand), side: grid.side };
  buildMesh();
  setStatus(`${TOOL_NAMES[name] || name} · ${Math.round(performance.now() - t0)} ms`);
}

function showToolTab(which) {
  $("elevation-tools").hidden = which !== "elevation";
  $("filtering-tools").hidden = which !== "filtering";
  $("tab-elevation").setAttribute("aria-pressed", String(which === "elevation"));
  $("tab-filtering").setAttribute("aria-pressed", String(which === "filtering"));
}

function fillTools(id, tools) {
  const box = $(id);
  for (const [name, label] of tools) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => runTool(name));
    box.appendChild(button);
  }
}

function bindBrush() {
  const canvas = $("height-view");
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * grid.side,
      y: ((event.clientY - rect.top) / rect.height) * grid.side,
      lower: event.shiftKey || event.button === 2,
    };
  };
  canvas.addEventListener("pointerdown", (event) => {
    brushDown = true;
    canvas.setPointerCapture(event.pointerId);
    remember();
    const p = point(event);
    paintCell(p.x, p.y, p.lower);
    drawHeight();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!brushDown) return;
    const p = point(event);
    paintCell(p.x, p.y, p.lower);
    drawHeight();
  });
  const finish = () => {
    if (!brushDown) return;
    brushDown = false;
    buildMesh();
    setStatus("Brush");
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(url));
    img.src = url;
  });
}

async function useMap(id) {
  const entry = maps.find((m) => m.id === id);
  if (!entry) return;
  setStatus(`Loading ${entry.name}…`);
  const img = await loadImage("maps/" + entry.file);
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  const side = img.width;
  const heights = new Uint16Array(side * side);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const s = (y * side + x) * 4;
      const lum = (0.299 * data[s] + 0.587 * data[s + 1] + 0.114 * data[s + 2]) / 255;
      heights[(side - 1 - y) * side + x] = Math.round(lum * 65535);
    }
  }
  grid = side === DISPLAY_SIDE ? { heights, side } : fitDisplay({ heights, side });
  buildMesh();
  setStatus(`${entry.name} · from the CD`);
}

function fillScene(sceneDef) {
  $("seed").value = sceneDef.seed;
  $("map").value = sceneDef.map || "";
  $("sky-c").value = sceneDef.skyC;
  $("sky-t").value = sceneDef.skyT;
  $("earth-c").value = sceneDef.earthC;
  $("earth-t").value = sceneDef.earthT;
  $("water-c").value = sceneDef.waterC;
  $("water-s").value = sceneDef.waterS;
  applyLook();
}

async function applyScene(sceneDef) {
  fillScene(sceneDef);
  if (sceneDef.map) await useMap(sceneDef.map);
  else if (sceneDef.kind === "fractal-erode") {
    setStatus("Fractal, then erode…");
    await paintSoon();
    const seed = sceneDef.seed;
    let g = fractal(blank(DISPLAY_SIDE).heights, DISPLAY_SIDE, seed);
    g = erode(g.heights, g.side, seed);
    grid = g;
    buildMesh();
    setStatus("Fractal range");
  } else {
    await useNew();
  }
}

function resetView() {
  camera.position.set(40, 11, 62);
  controls.target.set(0, 7, 0);
  controls.update();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  const size = viewSize();
  sky.material.uniforms.uResolution.value.set(size.dw, size.dh);
  scheduleBake();
}

const clock = new THREE.Clock();
let settleTimer = 0;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  controls.update(dt);
  if (camera.position.distanceTo(motionEye) > 0.0008 || controls.target.distanceTo(motionTarget) > 0.0008) {
    calmAt = performance.now() + 220;
  }
  motionEye.copy(camera.position);
  motionTarget.copy(controls.target);
  const live = gpuLive();
  if (shownLive && !live) gpuDirty = true;
  shownLive = live;
  const wind = sceneLook ? sceneLook.wind : 0.28;
  const off = baseUniforms.uCloudOffset.value;
  off.x += wind * 0.35 * dt;
  off.y += wind * 0.12 * dt;
  const t = baseUniforms.uTime.value + dt;
  for (const m of materials) {
    m.uniforms.uCloudOffset.value.copy(off);
    m.uniforms.uTime.value = t;
    m.uniforms.uCamPos.value.copy(camera.position);
  }
  baseUniforms.uTime.value = t;
  if (gpuBaker) {
    if (!gpuBaker.busy()) {
      renderer.render(scene, camera);
      if (gpuHold > 0) gpuHold -= 1;
      else gpuKick();
    }
  } else {
    const moved = camera.position.distanceTo(lastEye) > 0.5;
    const drifted = off.distanceTo(lastOff) > 0.2 && performance.now() - lastBakeAt > 900;
    if (moved) {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => scheduleBake(false), 180);
      scheduleBake(true);
    } else if (drifted) {
      scheduleBake(false);
    }
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

function randomizeLook() {
  for (const id of ["sky-c", "sky-t", "earth-c", "earth-t", "water-c", "water-s"]) {
    $(id).value = String((Math.random() * 101) | 0);
  }
  dropBake();
  applyLook();
  showQuickPreview();
  setStatus("Mixed");
}

function bind() {
  for (const id of ["sky-c", "sky-t", "earth-c", "earth-t", "water-c", "water-s", "mask-r"]) {
    $(id).addEventListener("input", applyLook);
  }
  $("mask").addEventListener("change", applyLook);
  $("material").addEventListener("change", () => {
    $("earth-t").value = String([8, 37, 62, 88][Number($("material").value)] || 8);
    applyLook();
  });
  fillTools("elevation-tools", ELEVATION_TOOLS);
  fillTools("filtering-tools", FILTERING_TOOLS);
  $("tab-elevation").addEventListener("click", () => showToolTab("elevation"));
  $("tab-filtering").addEventListener("click", () => showToolTab("filtering"));
  bindBrush();
  $("seed").addEventListener("change", resetRand);
  $("map").addEventListener("change", () => {
    if ($("map").value) useMap($("map").value);
  });
  $("scene").addEventListener("change", () => {
    const def = SCENES[Number($("scene").value)];
    if (def) applyScene(def);
  });
  $("randomize").addEventListener("click", randomizeLook);
  $("orbit").addEventListener("change", () => {
    controls.autoRotate = $("orbit").checked;
  });
  window.addEventListener("resize", onResize);
  window.addEventListener("keydown", (event) => {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key !== "i" && event.key !== "I") return;
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    document.body.classList.toggle("ui-hidden");
  });
}

async function main() {
  createGpuBaker().then((gpu) => {
    if (!gpu) return;
    gpuBaker = gpu;
    dropBake();
    if (groundReady) gpuBaker.setField(grid.heights, grid.side, WIDTH, HEIGHT_SCALE);
    gpuDirty = true;
    gpuSeen = false;
    gpuKick();
  });
  const sel = $("scene");
  SCENES.forEach((s, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = s.name;
    sel.appendChild(o);
  });
  const index = await fetch("maps/index.json").then((r) => r.json());
  maps = index;
  const mapSel = $("map");
  for (const entry of maps) {
    const o = document.createElement("option");
    o.value = entry.id;
    o.textContent = entry.name;
    mapSel.appendChild(o);
  }
  bind();
  await applyScene(SCENES[0]);
  resetView();
  lastEye.copy(camera.position);
  lastTarget.copy(controls.target);
  motionEye.copy(camera.position);
  motionTarget.copy(controls.target);
  lastOff.copy(baseUniforms.uCloudOffset.value);
  if (pool.length) showQuickPreview();
  frame();
}

main().catch((err) => {
  console.error(err);
  setStatus(String(err.message || err));
});
