// Camera over the isometric world. World coordinates are native sprite pixels as produced by
// tileToScreen(); the camera maps them to CSS pixels with a zoom factor (pixel-art friendly:
// the preferred zoom levels are integers, plus a half-size overview).

export const ZOOMS = [0.5, 1, 2, 3, 4] as const;

export class Camera {
  /** world point at the centre of the view */
  x = 0;
  y = 0;
  zoom = 2;
  /** CSS size of the viewport */
  w = 800;
  h = 600;
  /** smooth pan target (for "show on map") */
  private target: { x: number; y: number } | null = null;
  /** world bounds the centre may move within */
  bounds = { x0: -2000, y0: -500, x1: 2000, y1: 1500 };

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.zoom + this.w / 2, y: (wy - this.y) * this.zoom + this.h / 2 };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.w / 2) / this.zoom + this.x, y: (sy - this.h / 2) / this.zoom + this.y };
  }

  /** Visible world rectangle (with a margin in world px). */
  view(margin = 0): { x0: number; y0: number; x1: number; y1: number } {
    const hw = this.w / 2 / this.zoom;
    const hh = this.h / 2 / this.zoom;
    return { x0: this.x - hw - margin, y0: this.y - hh - margin, x1: this.x + hw + margin, y1: this.y + hh + margin };
  }

  panBy(dxScreen: number, dyScreen: number): void {
    this.target = null;
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
    this.clamp();
  }

  /** Zoom one step in (+1) or out (-1), keeping the world point under (sx, sy) fixed. */
  zoomStep(dir: number, sx = this.w / 2, sy = this.h / 2): void {
    const i = ZOOMS.indexOf(this.zoom as (typeof ZOOMS)[number]);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 1 : i) + dir))];
    this.setZoom(next, sx, sy);
  }

  setZoom(z: number, sx = this.w / 2, sy = this.h / 2): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom = z;
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  centerOn(wx: number, wy: number, smooth = true): void {
    if (smooth) this.target = { x: wx, y: wy };
    else {
      this.x = wx;
      this.y = wy;
      this.target = null;
      this.clamp();
    }
  }

  update(dt: number): void {
    if (!this.target) return;
    const k = 1 - Math.exp(-dt * 7);
    this.x += (this.target.x - this.x) * k;
    this.y += (this.target.y - this.y) * k;
    if (Math.abs(this.target.x - this.x) < 0.5 && Math.abs(this.target.y - this.y) < 0.5) this.target = null;
    this.clamp();
  }

  private clamp(): void {
    const b = this.bounds;
    this.x = Math.max(b.x0, Math.min(b.x1, this.x));
    this.y = Math.max(b.y0, Math.min(b.y1, this.y));
  }
}
