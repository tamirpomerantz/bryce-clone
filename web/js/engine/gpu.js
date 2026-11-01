// WebGPU compute of the camera picture. The CPU workers remain the fallback.

const SLOTS = 26;

function put(u, slot, x, y, z, w) {
  const o = slot * 4;
  u[o] = x;
  u[o + 1] = y;
  u[o + 2] = z;
  u[o + 3] = w;
}

function vec(v, w) {
  return [v[0], v[1], v[2], w];
}

export async function createGpuBaker() {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const code = await fetch(new URL("./trace.wgsl?v=40", import.meta.url)).then((r) => r.text());
  const module = device.createShaderModule({ code });
  const compiled = await module.getCompilationInfo();
  const errors = compiled.messages.filter((m) => m.type === "error");
  if (errors.length) {
    console.error(errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join("\n"));
    return null;
  }

  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    ],
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: "main" },
  });

  const uniform = device.createBuffer({ size: SLOTS * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const uniforms = new Float32Array(SLOTS * 4);
  let heightsBuf = null;
  let normalsBuf = null;
  let hiBuf = null;
  let loBuf = null;
  let field = null;
  let tex = null;
  let staging = null;
  let sizeW = 0;
  let sizeH = 0;
  let bytesPerRow = 0;
  let inflight = false;
  let group = null;
  let tight = new Uint8Array(0);

  function fieldBuffers(side, cells) {
    const hBytes = side * side * 4;
    const nBytes = side * side * 16;
    const cBytes = Math.max(4, cells * cells * 4);
    const make = (bytes) => device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    if (heightsBuf) heightsBuf.destroy();
    if (normalsBuf) normalsBuf.destroy();
    if (hiBuf) hiBuf.destroy();
    if (loBuf) loBuf.destroy();
    heightsBuf = make(hBytes);
    normalsBuf = make(nBytes);
    hiBuf = make(cBytes);
    loBuf = make(cBytes);
    group = null;
  }

  function ensureImage(w, h) {
    const row = Math.ceil((w * 4) / 256) * 256;
    if (tex && w === sizeW && h === sizeH) return;
    if (inflight) return false;
    if (tex) tex.destroy();
    if (staging) staging.destroy();
    tex = device.createTexture({
      size: { width: w, height: h },
      format: "rgba8unorm",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    staging = device.createBuffer({
      size: row * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    sizeW = w;
    sizeH = h;
    bytesPerRow = row;
    tight = new Uint8Array(w * h * 4);
    group = null;
    return true;
  }

  function bind() {
    if (group || !tex || !heightsBuf) return group;
    group = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: tex.createView() },
        { binding: 1, resource: { buffer: uniform } },
        { binding: 2, resource: { buffer: heightsBuf } },
        { binding: 3, resource: { buffer: normalsBuf } },
        { binding: 4, resource: { buffer: hiBuf } },
        { binding: 5, resource: { buffer: loBuf } },
      ],
    });
    return group;
  }

  return {
    setField(heights, side, span, heightScale) {
      const cells = side - 1;
      const s = span / cells;
      const y = new Float32Array(side * side);
      let yMax = 0;
      for (let i = 0; i < y.length; i++) {
        const h = (heights[i] / 65535) * heightScale;
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
      const n = new Float32Array(side * side * 4);
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
          const len = Math.hypot(hx, 1, hz) || 1;
          const k = (j * side + i) * 4;
          n[k] = -hx / len;
          n[k + 1] = 1 / len;
          n[k + 2] = -hz / len;
        }
      }
      const same = field && field.side === side;
      if (!same) fieldBuffers(side, cells);
      device.queue.writeBuffer(heightsBuf, 0, y);
      device.queue.writeBuffer(normalsBuf, 0, n);
      device.queue.writeBuffer(hiBuf, 0, hi);
      device.queue.writeBuffer(loBuf, 0, lo);
      field = { side, cells, s, yMax, span, x0: -span * 0.5, z0: -span * 0.5 };
    },

    busy() {
      return inflight;
    },

    submit(sky, cam, ground, done) {
      if (inflight || !field) return false;
      if (ensureImage(cam.bw, cam.bh) === false) return false;
      const u = uniforms;
      const q = cam.quat;
      put(u, 0, cam.ex, cam.ey, cam.ez, cam.fovY);
      put(u, 1, q[0], q[1], q[2], q[3]);
      put(u, 2, cam.ox, cam.oz, cam.aspect, cam.bw);
      put(u, 3, cam.bh, ground.waterY, ground.waterOn ? 1 : 0, ground.waveAmp);
      const length = ground.waveLength > 0 ? ground.waveLength : 1.2;
      put(u, 4, 0.85 / length, (ground.waveHeading * Math.PI) / 180, ground.material, ground.heightScale);
      put(u, 5, field.span, field.side, field.cells, field.s);
      put(u, 6, field.x0, field.z0, field.yMax, 0);
      put(u, 7, ...vec(sky.sun, sky.power));
      put(u, 8, ...vec(sky.moon, sky.band));
      put(u, 9, ...vec(sky.overhead, sky.nu));
      put(u, 10, ...vec(sky.horizon, sky.sunEdge));
      put(u, 11, ...vec(sky.glow, sky.sunDisc));
      put(u, 12, ...vec(sky.sunColour, sky.moonDisc));
      put(u, 13, ...vec(sky.moonColour, sky.scale));
      put(u, 14, sky.cover, sky.amplitude, sky.lowerHeight, sky.upperHeight);
      put(u, 15, ...vec(sky.coreColour, sky.hazeAmount));
      put(u, 16, ...vec(sky.litBase, sky.hazeScale));
      put(u, 17, ...vec(sky.upperColour, sky.hazeOn ? 1 : 0));
      put(u, 18, ...vec(sky.lightColour, sky.lightIntensity));
      put(u, 19, ...vec(sky.lightDir, sky.fogAmount));
      put(u, 20, sky.hazeRates[0], sky.hazeRates[1], sky.hazeRates[2], sky.fogHeight);
      put(u, 21, ...vec(sky.hazeColour, sky.fogOn ? 1 : 0));
      put(u, 22, ...vec(sky.fogColour, sky.cloudHeight));
      put(u, 23, ground.waterColour[0], ground.waterColour[1], ground.waterColour[2], 0);
      const tint = ground.earthTint || [1, 0.85, 0.6];
      put(u, 24, tint[0], tint[1], tint[2], ground.earthTex || 0);
      put(u, 25, ground.mask ? 1 : 0, ground.maskR || 0, 0, 0);
      device.queue.writeBuffer(uniform, 0, u);

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind());
      pass.dispatchWorkgroups(Math.ceil(cam.bw / 8), Math.ceil(cam.bh / 8));
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: tex },
        { buffer: staging, bytesPerRow, rowsPerImage: cam.bh },
        { width: cam.bw, height: cam.bh },
      );
      device.queue.submit([encoder.finish()]);
      inflight = true;
      const w = cam.bw;
      const h = cam.bh;
      const row = bytesPerRow;
      staging.mapAsync(GPUMapMode.READ).then(() => {
        const src = new Uint8Array(staging.getMappedRange());
        const pixels = tight.length === w * h * 4 ? tight : new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) pixels.set(src.subarray(y * row, y * row + w * 4), y * w * 4);
        staging.unmap();
        inflight = false;
        done(pixels, w, h);
      }).catch(() => {
        inflight = false;
      });
      return true;
    },
  };
}
