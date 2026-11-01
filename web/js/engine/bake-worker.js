import { fillBand } from "./frame.js?v=40";

self.onmessage = (ev) => {
  const m = ev.data;
  const rows = m.y1 - m.y0;
  const view = new Uint8Array(m.vw * rows * 4);
  if (rows > 0) {
    fillBand(
      view, m.vw, m.vh, m.y0, m.y1,
      m.sky, m.ex, m.ey, m.ez, m.ox, m.oz, m.fovY, m.aspect, m.quat, m.ground,
      m.refine,
    );
  }
  self.postMessage({
    id: m.id,
    y0: m.y0,
    y1: m.y1,
    ex: m.ex,
    ey: m.ey,
    ez: m.ez,
    ox: m.ox,
    oz: m.oz,
    vw: m.vw,
    vh: m.vh,
    view: view.buffer,
  }, [view.buffer]);
};
