// Hand tracker: MediaPipe Hands, max 3. Snapshots every 1.5s, then slowly lerps.

const MAX_HANDS = 3;
const SNAPSHOT_MS = 1500;
const BASE_LERP_MS = 1500;

let landmarkerPromise = null;

async function loadHandLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm"
      );
      const { HandLandmarker, FilesetResolver } = vision;
      const fileset = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
      );
      return HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: MAX_HANDS,
        minHandDetectionConfidence: 0.45,
        minHandPresenceConfidence: 0.45,
        minTrackingConfidence: 0.45,
      });
    })().catch((err) => {
      landmarkerPromise = null;
      throw err;
    });
  }
  return landmarkerPromise;
}

function handCenter(landmarks) {
  // Palm-ish: average of wrist (0) + index/middle/ring/pinky MCP (5,9,13,17).
  const ids = [0, 5, 9, 13, 17];
  let x = 0;
  let y = 0;
  for (const id of ids) {
    x += landmarks[id].x;
    y += landmarks[id].y;
  }
  const n = ids.length;
  return { x: x / n, y: y / n };
}

function handBounds(landmarks, width, height) {
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const p of landmarks) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  const pad = 0.04;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(1, x1 + pad);
  y1 = Math.min(1, y1 + pad);
  return {
    x0: Math.round(x0 * (width - 1)),
    y0: Math.round(y0 * (height - 1)),
    x1: Math.round(x1 * (width - 1)),
    y1: Math.round(y1 * (height - 1)),
  };
}

function easeOutCubic(t) {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

/**
 * @param {number} width preview width
 * @param {number} height preview height
 */
export function createTracker(width, height) {
  const tracks = [
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 0.5 },
  ];
  const from = tracks.map((t) => ({ x: t.x, y: t.y }));
  const target = tracks.map((t) => ({ x: t.x, y: t.y }));
  /** @type {{ x: number, y: number, x0: number, y0: number, x1: number, y1: number, track: number }[]} */
  let hands = [];
  let landmarker = null;
  let loadError = null;
  let lastVideoTime = -1;
  let lastSnapshotAt = 0;
  let lerpStart = 0;
  let ready = false;

  async function ensureModel() {
    if (landmarker || loadError) return;
    try {
      landmarker = await loadHandLandmarker();
      ready = true;
    } catch (err) {
      loadError = err?.message || "Hand model failed";
      ready = false;
    }
  }

  void ensureModel();

  function applySnapshot(now, detections) {
    const usedT = [false, false, false];
    const usedH = detections.map(() => false);
    const assigned = [-1, -1, -1];

    for (let pass = 0; pass < Math.min(MAX_HANDS, detections.length); pass++) {
      let best = 1e9;
      let bt = -1;
      let bh = -1;
      for (let t = 0; t < MAX_HANDS; t++) {
        if (usedT[t]) continue;
        for (let h = 0; h < detections.length; h++) {
          if (usedH[h]) continue;
          const dx = detections[h].x - tracks[t].x;
          const dy = detections[h].y - tracks[t].y;
          const d = dx * dx + dy * dy;
          if (d < best) {
            best = d;
            bt = t;
            bh = h;
          }
        }
      }
      if (bt < 0) break;
      usedT[bt] = true;
      usedH[bh] = true;
      assigned[bt] = bh;
    }

    for (let t = 0; t < MAX_HANDS; t++) {
      from[t].x = tracks[t].x;
      from[t].y = tracks[t].y;
      const h = assigned[t];
      if (h >= 0) {
        target[t].x = detections[h].x;
        target[t].y = detections[h].y;
        detections[h].track = t;
      }
    }
    lerpStart = now;
    lastSnapshotAt = now;
    hands = detections;
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {{ bright?: number, low?: number, high?: number, smooth?: number }} opts
   * @param {number} now performance.now()
   * @param {ImageData} preview ImageData buffer to fill (grayscale preview)
   */
  function step(video, opts, now, preview) {
    void ensureModel();
    if (!landmarker || !video || video.readyState < 2) return loadError;

    // Preview levels (display only — detection uses the raw video).
    const w = width;
    const h = height;
    if (preview && preview.data.length === w * h * 4) {
      // Caller draws video into a canvas; we only need levels on that RGBA.
      // Kept for API parity; paint happens in main after drawImage.
    }

    const t = video.currentTime;
    if (t !== lastVideoTime) {
      lastVideoTime = t;
      let result;
      try {
        result = landmarker.detectForVideo(video, now);
      } catch {
        return loadError;
      }
      const detections = [];
      const list = result?.landmarks || [];
      for (let i = 0; i < Math.min(MAX_HANDS, list.length); i++) {
        const lm = list[i];
        const c = handCenter(lm);
        const b = handBounds(lm, width, height);
        detections.push({
          x: Math.min(1, Math.max(0, c.x)),
          y: Math.min(1, Math.max(0, c.y)),
          x0: b.x0,
          y0: b.y0,
          x1: b.x1,
          y1: b.y1,
          track: -1,
        });
      }

      const due = !lastSnapshotAt || now - lastSnapshotAt >= SNAPSHOT_MS;
      const first = !lastSnapshotAt && detections.length > 0;
      if (due || first) {
        applySnapshot(now, detections);
      } else {
        // Keep latest boxes for overlay; tracks still ease toward last snapshot.
        for (const d of detections) {
          let best = 1e9;
          let bt = -1;
          for (let tIdx = 0; tIdx < MAX_HANDS; tIdx++) {
            const dx = d.x - target[tIdx].x;
            const dy = d.y - target[tIdx].y;
            const dist = dx * dx + dy * dy;
            if (dist < best) {
              best = dist;
              bt = tIdx;
            }
          }
          d.track = bt;
        }
        hands = detections;
      }
    }

    const smooth = Math.max(0, Math.min(1, opts?.smooth ?? 0.7));
    // Higher smooth → longer ease (up to ~2.5× base).
    const duration = BASE_LERP_MS * (0.55 + smooth * 1.45);
    const u = easeOutCubic((now - lerpStart) / duration);
    for (let i = 0; i < MAX_HANDS; i++) {
      tracks[i].x = from[i].x + (target[i].x - from[i].x) * u;
      tracks[i].y = from[i].y + (target[i].y - from[i].y) * u;
    }
    return loadError;
  }

  return {
    width,
    height,
    tracks,
    step,
    ensureModel,
    get ready() {
      return ready;
    },
    get error() {
      return loadError;
    },
    get handN() {
      return hands.length;
    },
    get hands() {
      return hands;
    },
    // Compatibility aliases for older paint helpers.
    get blobN() {
      return hands.length;
    },
    get blobTrack() {
      return hands.map((h) => h.track);
    },
    get x0s() {
      return hands.map((h) => h.x0);
    },
    get y0s() {
      return hands.map((h) => h.y0);
    },
    get x1s() {
      return hands.map((h) => h.x1);
    },
    get y1s() {
      return hands.map((h) => h.y1);
    },
  };
}
