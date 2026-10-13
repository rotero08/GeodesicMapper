// A static star field on two canvases that twinkle out of step through a CSS animation, so the
// sky costs nothing per frame (the map canvas only redraws when something changes).

const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export class Stars {
  constructor(host) {
    this.host = host;
    this.layers = [0, 1].map((i) => {
      const canvas = document.createElement('canvas');
      canvas.className = `stars stars-${i}`;
      canvas.setAttribute('aria-hidden', 'true');
      host.append(canvas);
      return canvas;
    });
  }

  resize(width, height, dpr) {
    const random = mulberry32(20240611);
    const count = Math.round((width * height) / 5200);
    this.layers.forEach((canvas, layer) => {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < count; i++) {
        const x = random() * width;
        const y = random() * height;
        const r = random() * 1.1 + 0.2;
        const a = random() * 0.5 + 0.2;
        if (i % 2 !== layer) continue;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(210, 228, 238, ${a})`;
        ctx.fill();
      }
    });
  }

  /** How visible the sky is: full over a globe, gone over a flat map. */
  setVisibility(amount) {
    this.host.style.opacity = String(Math.max(0, Math.min(1, amount)));
  }

  drawInto(ctx, width, height) {
    for (const canvas of this.layers) ctx.drawImage(canvas, 0, 0, width, height);
  }
}
