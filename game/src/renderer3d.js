// Cloudhaven Air Rally — software 3D renderer on a 2D canvas.
//
// Coordinate system (matches island.js / flight-model.js):
//   x = east, z = south (north is -z), y = up, metres.
//   Heading 0 = north; forward for heading h is (sin h, 0, -cos h).
//   Positive pitch = nose up, positive roll = right wing down.
//
// Camera space: x = right, y = up, z = forward (depth). Screen: x right, y down.
//
// Frame order (everything except the sky goes through the polygon queue, so the
// scene sorts as one painter's-algorithm list):
//   r.setCamera(cam);
//   r.drawSkyAndWater(cam);          // immediate: sky, sun, sea backdrop
//   r.drawTerrain(island);           // queued
//   r.drawRunway(island);            // queued
//   r.drawTownAndTrees(island);      // queued
//   r.drawLighthouse(island);        // queued
//   for (const ring of rings) r.drawRing(ring, time);  // queued
//   r.drawClouds(clouds, time);      // queued, translucent
//   r.flush();                       // sort far → near and paint
//
// Everything is deterministic: no randomness, only hashes of world positions.

// ---- Tuning ---------------------------------------------------------------------
const NEAR = 0.5;                 // near plane (m)
const FOCAL_SCALE = 0.9;          // focal length = canvas height × this (~58° vertical FOV)
const VIEW_DIST = 4000;           // terrain draw distance (m)
const FOG_START = 400;            // fog begins here (m)
const FOG_END = VIEW_DIST * 0.97; // fully fogged here, so the terrain edge never pops

const OUTER_CELL = 160;           // coarse terrain cell (m)
const OUTER_HALF = 25;            // coarse grid half-size in cells (±4000 m)
const INNER_CELL = 40;            // fine terrain cell (m)
const INNER_HALF_OUTER = 5;       // fine grid covers ±5 coarse cells (±800 m)
const INNER_N = (2 * INNER_HALF_OUTER * OUTER_CELL) / INNER_CELL; // 40 fine cells across
const INNER_STEP = OUTER_CELL / INNER_CELL;                       // 4 fine cells per coarse cell
const DEEP_SKIP = 6;              // terrain cells deeper than this are left to the sea backdrop

const HOUSE_DIST = 2600;
const TREE_DIST = 1800;
const MAX_VERTS = 64;

// ---- Palette (RGB arrays) ----------------------------------------------------------
const ZENITH = [47, 111, 196];
const SKY_MID = [112, 168, 222];
const HORIZON = [204, 224, 238];  // also the fog colour
const SEA = [38, 104, 150];
const SHALLOW = [72, 170, 172];
const SAND = [222, 206, 152];
const MOOR = [112, 128, 82];
const ROCK = [128, 124, 118];
const PEAK = [228, 228, 222];
const PAVED = [170, 164, 150];
const MOWN = [128, 176, 88];
const FIELDS = [
  [96, 150, 64],
  [118, 166, 72],
  [84, 136, 58],
  [146, 172, 80],
  [178, 172, 92], // ripe field
];
const WALLS = [[238, 232, 216], [228, 214, 190], [242, 238, 230], [216, 202, 178]];
const TRUNK = [96, 70, 46];

// Sun: azimuth measured like heading (from north, clockwise), elevation above horizon.
const SUN_AZ = 2.4, SUN_EL = 0.5;
const SUN = {
  x: Math.sin(SUN_AZ) * Math.cos(SUN_EL),
  y: Math.sin(SUN_EL),
  z: -Math.cos(SUN_AZ) * Math.cos(SUN_EL),
};
const FLAT_LIGHT = 0.55 + 0.6 * SUN.y; // so flat ground has brightness 1

// ---- Small helpers ------------------------------------------------------------------
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(e0, e1, v) {
  const t = clamp((v - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Integer hash of two ints → [0, 1). */
function hash2(i, j) {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Fog amount 0..1 at distance d (m). */
function fogAt(d) {
  return smoothstep(FOG_START, FOG_END, d);
}

/** Colour × light, blended toward the fog colour by f, as a CSS string. */
function rgbString(r, g, b, light, f) {
  r = clamp(r * light, 0, 255);
  g = clamp(g * light, 0, 255);
  b = clamp(b * light, 0, 255);
  r += (HORIZON[0] - r) * f;
  g += (HORIZON[1] - g) * f;
  b += (HORIZON[2] - b) * f;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function shade(rgb, light, dist) {
  return rgbString(rgb[0], rgb[1], rgb[2], light, fogAt(dist));
}

/** Lambert lighting for a face normal (need not be normalised). */
function faceLight(nx, ny, nz) {
  const len = Math.hypot(nx, ny, nz) || 1;
  const lam = (nx * SUN.x + ny * SUN.y + nz * SUN.z) / len;
  return (0.55 + 0.6 * Math.max(0, lam)) / FLAT_LIGHT;
}

function hexToRgb(c) {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

function mix3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function css(rgb) {
  return `rgb(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0})`;
}

function makeGrid(n) {
  const nv = (n + 1) * (n + 1);
  return {
    h: new Float64Array(nv),
    x: new Float64Array(nv),
    y: new Float64Array(nv),
    z: new Float64Array(nv),
  };
}

// Queue item kinds.
const POLY = 0, LINE = 1, ELLIPSE = 2;

// ---- Renderer -------------------------------------------------------------------------
export class Renderer3D {
  constructor(ctx) {
    this.ctx = ctx;
    this.camera = { position: { x: 0, y: 100, z: 0 }, heading: 0, pitch: 0, roll: 0 };
    this.focalScale = FOCAL_SCALE;
    this.queue = [];
    // Scratch camera-space vertex buffers (input and clipped output).
    this._cx = new Float64Array(MAX_VERTS);
    this._cy = new Float64Array(MAX_VERTS);
    this._cz = new Float64Array(MAX_VERTS);
    this._kx = new Float64Array(MAX_VERTS);
    this._ky = new Float64Array(MAX_VERTS);
    this._kz = new Float64Array(MAX_VERTS);
    this._tmp = { x: 0, y: 0, z: 0 };
    this._outer = makeGrid(OUTER_HALF * 2);
    this._inner = makeGrid(INNER_N);
    this._treeBase = new WeakMap(); // island → Float64Array of tree base heights
    this._updateFrame();
  }

  /** Copy the camera for this frame and cache its trig. */
  setCamera(camera) {
    const c = this.camera;
    const p = camera.position;
    c.position.x = p.x;
    c.position.y = p.y;
    c.position.z = p.z;
    c.heading = camera.heading || 0;
    c.pitch = camera.pitch || 0;
    c.roll = camera.roll || 0;
    this._updateFrame();
  }

  _updateFrame() {
    const canvas = this.ctx.canvas;
    this.W = canvas.width;
    this.H = canvas.height;
    this.cxs = this.W / 2;
    this.cys = this.H / 2;
    this.focal = this.H * this.focalScale;
    const c = this.camera;
    this._sh = Math.sin(c.heading); this._ch = Math.cos(c.heading);
    this._sp = Math.sin(c.pitch);   this._cp = Math.cos(c.pitch);
    this._sr = Math.sin(c.roll);    this._cr = Math.cos(c.roll);
  }

  /**
   * World → camera space, written into `out` ({x, y, z}).
   * 1. Translate by the camera position.
   * 2. Yaw: project onto the horizontal right (cos h, 0, sin h) and forward
   *    (sin h, 0, -cos h) axes.
   * 3. Pitch: rotate the (forward, up) pair by -pitch, so a nose-up camera
   *    sees the world tilt down.
   * 4. Roll: rotate the (right, up) pair by +roll, so with the right wing down
   *    the world on the right appears to rise.
   */
  _toCam(x, y, z, out) {
    const p = this.camera.position;
    const dx = x - p.x, dy = y - p.y, dz = z - p.z;
    const x1 = dx * this._ch + dz * this._sh;
    const z1 = dx * this._sh - dz * this._ch;
    const z2 = z1 * this._cp + dy * this._sp;
    const y2 = dy * this._cp - z1 * this._sp;
    out.x = x1 * this._cr - y2 * this._sr;
    out.y = y2 * this._cr + x1 * this._sr;
    out.z = z2;
    return out;
  }

  /**
   * Project a world point {x, y, z} to the screen. Perspective divide:
   * sx = cx + f·x/z, sy = cy − f·y/z. Returns {x, y, depth} or null if the
   * point is behind the near plane.
   */
  project(point) {
    const c = this._toCam(point.x, point.y, point.z, this._tmp);
    if (c.z < NEAR) return null;
    const k = this.focal / c.z;
    return { x: this.cxs + c.x * k, y: this.cys - c.y * k, depth: c.z };
  }

  // ---- Polygon queue ------------------------------------------------------------

  /**
   * Queue a filled polygon. worldPoints: [{x, y, z}, ...].
   * depth: sort key override (camera-space z); null = average vertex depth.
   * opts: { clip: clip at the near plane instead of skipping (ground polygons),
   *         far: sort by the farthest vertex, bias: subtract from the sort key,
   *         alpha, seam: stroke with the fill colour to hide anti-alias cracks }.
   */
  addPoly(worldPoints, fillStyle, depth = null, opts = null) {
    const n = Math.min(worldPoints.length, MAX_VERTS);
    if (n < 3) return false;
    const t = this._tmp;
    for (let i = 0; i < n; i++) {
      const p = worldPoints[i];
      this._toCam(p.x, p.y, p.z, t);
      this._cx[i] = t.x; this._cy[i] = t.y; this._cz[i] = t.z;
    }
    const o = opts || {};
    return this._queue(n, fillStyle, !!o.clip, !!o.far, o.bias || 0, o.alpha ?? 1, !!o.seam, depth);
  }

  /** Queue a line between two world points; width in metres (min 1 px). */
  addLine(a, b, strokeStyle, width, depth = null, alpha = 1) {
    const t = this._tmp;
    this._toCam(a.x, a.y, a.z, t);
    const ax = t.x, ay = t.y, az = t.z;
    this._toCam(b.x, b.y, b.z, t);
    if (az < NEAR || t.z < NEAR) return false;
    const f = this.focal;
    const zm = (az + t.z) / 2;
    this.queue.push({
      kind: LINE,
      x0: this.cxs + (ax * f) / az, y0: this.cys - (ay * f) / az,
      x1: this.cxs + (t.x * f) / t.z, y1: this.cys - (t.y * f) / t.z,
      w: Math.max(1, (width * f) / zm),
      fill: strokeStyle, alpha, depth: depth ?? zm,
    });
    return true;
  }

  /** Queue a screen-facing ellipse at a world point (radii in metres). */
  addEllipse(center, rx, ry, fillStyle, alpha = 1, bias = 0, minRadius = 0) {
    const t = this._toCam(center.x, center.y, center.z, this._tmp);
    if (t.z < NEAR) return false;
    const k = this.focal / t.z;
    const sx = this.cxs + t.x * k, sy = this.cys - t.y * k;
    const srx = Math.max(minRadius, rx * k), sry = Math.max(minRadius, ry * k);
    if (sx + srx < 0 || sx - srx > this.W || sy + srx < 0 || sy - srx > this.H) return false;
    this.queue.push({
      kind: ELLIPSE, x: sx, y: sy, rx: srx, ry: sry, rot: -this.camera.roll,
      fill: fillStyle, alpha, depth: t.z - bias,
    });
    return true;
  }

  /** Queue the polygon held in the camera-space scratch buffers. */
  _queue(n, fill, clip, far, bias, alpha, seam, depthOverride) {
    let xs = this._cx, ys = this._cy, zs = this._cz;
    let behind = 0;
    for (let i = 0; i < n; i++) if (zs[i] < NEAR) behind++;
    if (behind === n) return false;
    if (behind > 0) {
      if (!clip) return false;
      n = this._clipNear(n);
      if (n < 3) return false;
      xs = this._kx; ys = this._ky; zs = this._kz;
    }
    const f = this.focal, cx = this.cxs, cy = this.cys;
    const pts = new Array(n * 2);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let zSum = 0, zMax = 0;
    for (let i = 0; i < n; i++) {
      const k = f / zs[i];
      const sx = cx + xs[i] * k, sy = cy - ys[i] * k;
      pts[i * 2] = sx; pts[i * 2 + 1] = sy;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
      zSum += zs[i];
      if (zs[i] > zMax) zMax = zs[i];
    }
    if (maxX < 0 || minX > this.W || maxY < 0 || minY > this.H) return false;
    const depth = depthOverride ?? ((far ? zMax : zSum / n) - bias);
    this.queue.push({ kind: POLY, pts, fill, alpha, depth, seam });
    return true;
  }

  /** Sutherland–Hodgman clip of the scratch polygon against z >= NEAR. */
  _clipNear(n) {
    const xs = this._cx, ys = this._cy, zs = this._cz;
    const ox = this._kx, oy = this._ky, oz = this._kz;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ain = zs[i] >= NEAR, bin = zs[j] >= NEAR;
      if (ain) { ox[m] = xs[i]; oy[m] = ys[i]; oz[m] = zs[i]; m++; }
      if (ain !== bin && m < MAX_VERTS) {
        const t = (NEAR - zs[i]) / (zs[j] - zs[i]);
        ox[m] = xs[i] + (xs[j] - xs[i]) * t;
        oy[m] = ys[i] + (ys[j] - ys[i]) * t;
        oz[m] = NEAR;
        m++;
      }
      if (m >= MAX_VERTS - 1) break;
    }
    return m;
  }

  /** Sort the queue far → near (stable, so ties keep insertion order) and paint it. */
  flush() {
    const ctx = this.ctx;
    const q = this.queue;
    q.sort((a, b) => b.depth - a.depth);
    ctx.save();
    ctx.lineJoin = 'bevel';
    ctx.lineCap = 'round';
    let alpha = 1;
    ctx.globalAlpha = 1;
    for (let i = 0; i < q.length; i++) {
      const it = q[i];
      if (it.alpha !== alpha) { alpha = it.alpha; ctx.globalAlpha = alpha; }
      if (it.kind === POLY) {
        const p = it.pts;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k], p[k + 1]);
        ctx.closePath();
        ctx.fillStyle = it.fill;
        ctx.fill();
        if (it.seam) {
          ctx.strokeStyle = it.fill;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      } else if (it.kind === LINE) {
        ctx.beginPath();
        ctx.moveTo(it.x0, it.y0);
        ctx.lineTo(it.x1, it.y1);
        ctx.strokeStyle = it.fill;
        ctx.lineWidth = it.w;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.ellipse(it.x, it.y, it.rx, it.ry, it.rot, 0, Math.PI * 2);
        ctx.fillStyle = it.fill;
        ctx.fill();
      }
    }
    ctx.restore();
    q.length = 0;
  }

  // ---- Sky, sun and sea ------------------------------------------------------------

  /** Immediate: gradient sky, sun with glow and the sea backdrop below the horizon. */
  drawSkyAndWater(camera, waterLevel = 0) {
    if (camera) this.setCamera(camera);
    const { ctx, W, H, focal } = this;
    const { pitch, roll, position } = this.camera;

    // The level direction straight ahead is (0, -sin p, cos p) after pitch, i.e.
    // y/z = -tan p; roll then rotates it about the screen centre. The horizon
    // line runs through that point at a screen angle of -roll.
    const tp = Math.tan(clamp(pitch, -1.45, 1.45));
    const hx = this.cxs + focal * tp * this._sr;
    const hy = this.cys + focal * tp * this._cr;
    const L = Math.hypot(W, H) + Math.hypot(hx - this.cxs, hy - this.cys);

    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(-roll);

    const sky = ctx.createLinearGradient(0, 0, 0, -focal * 1.6);
    sky.addColorStop(0, css(HORIZON));
    sky.addColorStop(0.1, css(mix3(HORIZON, SKY_MID, 0.5)));
    sky.addColorStop(0.45, css(SKY_MID));
    sky.addColorStop(1, css(ZENITH));
    ctx.fillStyle = sky;
    ctx.fillRect(-L, -L, 2 * L, L + 1);

    // Sea: a point s pixels below the horizon is roughly at distance f·alt/s,
    // so gradient stops use the same fog curve as the terrain.
    const alt = Math.max(1, position.y - waterLevel);
    const sea = ctx.createLinearGradient(0, 0, 0, L);
    sea.addColorStop(0, css(HORIZON));
    for (const d of [5000, FOG_END, 3000, 2200, 1500, 1000, 600, 300, 100]) {
      const s = (focal * alt) / d;
      if (s >= L) break;
      sea.addColorStop(s / L, rgbString(SEA[0], SEA[1], SEA[2], 1, fogAt(d)));
    }
    sea.addColorStop(1, rgbString(SEA[0], SEA[1], SEA[2], 1, fogAt((focal * alt) / L)));
    ctx.fillStyle = sea;
    ctx.fillRect(-L, 0, 2 * L, L);
    ctx.restore();

    // Sun: project a point far along the sun direction.
    const t = this._toCam(position.x + SUN.x * 1e5, position.y + SUN.y * 1e5, position.z + SUN.z * 1e5, this._tmp);
    if (t.z > NEAR) {
      const sx = this.cxs + (t.x * focal) / t.z, sy = this.cys - (t.y * focal) / t.z;
      const glowR = focal * 0.35;
      if (sx > -glowR && sx < W + glowR && sy > -glowR && sy < H + glowR) {
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR);
        g.addColorStop(0, 'rgba(255,252,232,0.85)');
        g.addColorStop(0.12, 'rgba(255,246,214,0.45)');
        g.addColorStop(0.4, 'rgba(255,240,200,0.12)');
        g.addColorStop(1, 'rgba(255,240,200,0)');
        ctx.fillStyle = g;
        ctx.fillRect(sx - glowR, sy - glowR, glowR * 2, glowR * 2);
        ctx.beginPath();
        ctx.arc(sx, sy, focal * 0.022, 0, Math.PI * 2);
        ctx.fillStyle = '#fffbea';
        ctx.fill();
      }
    }
  }

  // ---- Terrain ------------------------------------------------------------------------

  /**
   * Queue terrain quads around the camera: a fine 40 m grid within ±800 m and a
   * coarse 160 m grid out to VIEW_DIST, both snapped to world-aligned cells so
   * the mesh never swims. Fine-grid border vertices are interpolated from the
   * coarse vertices so the two grids meet without cracks.
   */
  drawTerrain(island, camera) {
    if (camera) this.setCamera(camera);
    const cam = this.camera.position;
    const wl = island.waterLevel ?? 0;
    const ocx = Math.floor(cam.x / OUTER_CELL);
    const ocz = Math.floor(cam.z / OUTER_CELL);
    const lo = OUTER_HALF - INNER_HALF_OUTER, hi = OUTER_HALF + INNER_HALF_OUTER;
    this._terrainGrid(
      island, this._outer,
      (ocx - OUTER_HALF) * OUTER_CELL, (ocz - OUTER_HALF) * OUTER_CELL,
      OUTER_CELL, OUTER_HALF * 2, lo, hi, 0, wl,
    );
    this._terrainGrid(
      island, this._inner,
      (ocx - INNER_HALF_OUTER) * OUTER_CELL, (ocz - INNER_HALF_OUTER) * OUTER_CELL,
      INNER_CELL, INNER_N, -1, -1, INNER_STEP, wl,
    );
  }

  _terrainGrid(island, g, x0, z0, cell, n, skipLo, skipHi, step, wl) {
    const heightAt = island.heightAt;
    const nv = n + 1;
    const t = this._tmp;
    const cam = this.camera.position;
    const townY = island.townLevel;
    const runwayY = island.runway ? island.runway.y : NaN;

    // Vertices: height + camera-space position (water clamped to sea level).
    for (let j = 0; j <= n; j++) {
      const z = z0 + j * cell;
      for (let i = 0; i <= n; i++) {
        const x = x0 + i * cell;
        let h;
        if (step && (j === 0 || j === n) && i % step !== 0) {
          const i0 = i - (i % step);
          const u = (i - i0) / step;
          h = heightAt(x0 + i0 * cell, z) * (1 - u) + heightAt(x0 + (i0 + step) * cell, z) * u;
        } else if (step && (i === 0 || i === n) && j % step !== 0) {
          const j0 = j - (j % step);
          const u = (j - j0) / step;
          h = heightAt(x, z0 + j0 * cell) * (1 - u) + heightAt(x, z0 + (j0 + step) * cell) * u;
        } else {
          h = heightAt(x, z);
        }
        const k = j * nv + i;
        g.h[k] = h;
        this._toCam(x, h > wl ? h : wl, z, t);
        g.x[k] = t.x; g.y[k] = t.y; g.z[k] = t.z;
      }
    }

    const cx = this._cx, cy = this._cy, cz = this._cz;
    const maxD2 = VIEW_DIST * VIEW_DIST;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (i >= skipLo && i < skipHi && j >= skipLo && j < skipHi) continue;
        const xc = x0 + (i + 0.5) * cell, zc = z0 + (j + 0.5) * cell;
        const dx = xc - cam.x, dz = zc - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > maxD2) continue;
        const k00 = j * nv + i, k10 = k00 + 1, k01 = k00 + nv, k11 = k01 + 1;
        const z00 = g.z[k00], z10 = g.z[k10], z01 = g.z[k01], z11 = g.z[k11];
        if (z00 < NEAR && z10 < NEAR && z01 < NEAR && z11 < NEAR) continue;
        const h00 = g.h[k00], h10 = g.h[k10], h01 = g.h[k01], h11 = g.h[k11];
        const deep = wl - DEEP_SKIP;
        if (h00 < deep && h10 < deep && h01 < deep && h11 < deep) continue;

        const avg = (h00 + h10 + h01 + h11) * 0.25;
        const dy = Math.max(avg, wl) - cam.y;
        const fog = fogAt(Math.sqrt(d2 + dy * dy));
        let r, gr, b, light = 1;

        if (avg < wl + 0.3) {
          // Shallow water fades to the open-sea colour by DEEP_SKIP metres.
          const u = clamp((wl - Math.min(h00, h10, h01, h11)) / DEEP_SKIP, 0, 1);
          r = SHALLOW[0] + (SEA[0] - SHALLOW[0]) * u;
          gr = SHALLOW[1] + (SEA[1] - SHALLOW[1]) * u;
          b = SHALLOW[2] + (SEA[2] - SHALLOW[2]) * u;
        } else {
          const sx = ((h10 - h00) + (h11 - h01)) / (2 * cell);
          const sz = ((h01 - h00) + (h11 - h10)) / (2 * cell);
          const slope = Math.sqrt(sx * sx + sz * sz);
          let c;
          if (h00 === townY && h10 === townY && h01 === townY && h11 === townY) {
            c = PAVED;
          } else if (h00 === runwayY && h10 === runwayY && h01 === runwayY && h11 === runwayY) {
            c = MOWN;
          } else {
            // Field patchwork: ~130 m × 100 m fields chosen by a hash.
            const field = FIELDS[Math.floor(hash2(Math.floor(xc / 130), Math.floor(zc / 100)) * FIELDS.length)];
            c = field;
            const sand = 1 - smoothstep(wl + 3, wl + 6, avg);
            if (sand > 0) c = mix3(c, SAND, sand);
            const moor = smoothstep(90, 150, avg);
            if (moor > 0) c = mix3(c, MOOR, moor);
            const rock = smoothstep(0.45, 0.8, slope);
            if (rock > 0) c = mix3(c, ROCK, rock);
            const peak = smoothstep(165, 205, avg);
            if (peak > 0) c = mix3(c, PEAK, peak);
          }
          r = c[0]; gr = c[1]; b = c[2];
          // Per-cell brightness jitter plus sun lighting from the cell normal.
          const jitter = 0.95 + 0.1 * hash2(Math.floor(xc / cell) + 7919, Math.floor(zc / cell));
          light = faceLight(-sx, 1, -sz) * jitter;
        }

        cx[0] = g.x[k00]; cy[0] = g.y[k00]; cz[0] = z00;
        cx[1] = g.x[k10]; cy[1] = g.y[k10]; cz[1] = z10;
        cx[2] = g.x[k11]; cy[2] = g.y[k11]; cz[2] = z11;
        cx[3] = g.x[k01]; cy[3] = g.y[k01]; cz[3] = z01;
        // Sort terrain by its farthest corner so anything standing on a cell
        // (runway, houses, trees) is painted after it.
        this._queue(4, rgbString(r, gr, b, light, fog), true, true, 0, 1, true, null);
      }
    }
  }

  // ---- Runway -------------------------------------------------------------------------

  drawRunway(island) {
    const rw = island.runway;
    if (!rw) return;
    const cam = this.camera.position;
    const fx = Math.sin(rw.heading), fz = -Math.cos(rw.heading); // along
    const rx = Math.cos(rw.heading), rz = Math.sin(rw.heading);  // across (right)
    const hl = rw.length / 2, hw = rw.width / 2;
    const y = rw.y + 0.25;
    const ym = y + 0.1;
    const P = (along, across, yy) => ({
      x: rw.x + fx * along + rx * across,
      y: yy,
      z: rw.z + fz * along + rz * across,
    });
    const dist = (along) => {
      const p = P(along, 0, y);
      return Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
    };
    const SEG = 30;
    const MARK_BIAS = SEG; // markings sort after the strip segment beneath them
    const ground = { clip: true };
    const mark = { clip: true, bias: MARK_BIAS };

    // Asphalt strip and side stripes, cut into segments so they sort well.
    const segs = Math.ceil(rw.length / SEG);
    for (let s = 0; s < segs; s++) {
      const a0 = -hl + s * SEG, a1 = Math.min(hl, a0 + SEG);
      const d = dist((a0 + a1) / 2);
      const asphalt = shade([58, 61, 66], 0.96 + 0.08 * hash2(s, 31), d);
      this.addPoly([P(a0, -hw, y), P(a1, -hw, y), P(a1, hw, y), P(a0, hw, y)], asphalt, null, ground);
      const white = shade([232, 232, 226], 1, d);
      for (const side of [-1, 1]) {
        const c0 = side * (hw - 1.2), c1 = side * (hw - 2.1);
        this.addPoly([P(a0, c0, ym), P(a1, c0, ym), P(a1, c1, ym), P(a0, c1, ym)], white, null, mark);
      }
    }

    // Centreline dashes: 25 m dash, 25 m gap.
    for (let a = -hl + 70; a + 25 <= hl - 70; a += 50) {
      const white = shade([236, 236, 230], 1, dist(a));
      this.addPoly([P(a, -0.45, ym), P(a + 25, -0.45, ym), P(a + 25, 0.45, ym), P(a, 0.45, ym)], white, null, mark);
    }

    // Threshold "piano keys" at both ends.
    for (const end of [-1, 1]) {
      const a0 = end * (hl - 6), a1 = end * (hl - 36);
      const white = shade([236, 236, 230], 1, dist(a0));
      for (let k = 0; k < 4; k++) {
        for (const side of [-1, 1]) {
          const c = side * (3 + k * 4.5);
          this.addPoly([P(a0, c - 0.9, ym), P(a1, c - 0.9, ym), P(a1, c + 0.9, ym), P(a0, c + 0.9, ym)], white, null, mark);
        }
      }
    }

    // Edge lights every 60 m, green at the start threshold, red at the far end.
    const ly = y + 0.6;
    for (let a = -hl; a <= hl + 0.01; a += 60) {
      const col = shade([255, 248, 220], 1.1, dist(a) * 0.5);
      this.addEllipse(P(a, -hw - 1.5, ly), 0.5, 0.5, col, 1, MARK_BIAS, 1.2);
      this.addEllipse(P(a, hw + 1.5, ly), 0.5, 0.5, col, 1, MARK_BIAS, 1.2);
    }
    for (let c = -hw; c <= hw + 0.01; c += 5) {
      this.addEllipse(P(-hl - 3, c, ly), 0.5, 0.5, shade([80, 230, 110], 1, dist(-hl) * 0.5), 1, MARK_BIAS, 1.2);
      this.addEllipse(P(hl + 3, c, ly), 0.5, 0.5, shade([240, 70, 60], 1, dist(hl) * 0.5), 1, MARK_BIAS, 1.2);
    }
  }

  // ---- Town and trees -------------------------------------------------------------------

  drawTownAndTrees(island) {
    const cam = this.camera.position;
    const t = this._tmp;
    const base = island.townLevel ?? 0;

    for (const hs of island.town || []) {
      const dx = hs.x - cam.x, dz = hs.z - cam.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > HOUSE_DIST * HOUSE_DIST) continue;
      this._toCam(hs.x, base + hs.h * 0.5, hs.z, t);
      if (t.z < -Math.max(hs.w, hs.d)) continue;
      this._drawHouse(hs, base, Math.sqrt(d2 + (base - cam.y) ** 2));
    }

    const trees = island.trees || [];
    let bases = this._treeBase.get(island);
    if (!bases || bases.length !== trees.length) {
      bases = new Float64Array(trees.length);
      for (let i = 0; i < trees.length; i++) bases[i] = island.heightAt(trees[i].x, trees[i].z);
      this._treeBase.set(island, bases);
    }
    const halfW = this.W / (2 * this.focal);
    const halfH = this.H / (2 * this.focal);
    const rx = this._ch, rz = this._sh; // camera's horizontal right vector
    for (let i = 0; i < trees.length; i++) {
      const tr = trees[i];
      const dx = tr.x - cam.x, dz = tr.z - cam.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > TREE_DIST * TREE_DIST) continue;
      const y0 = bases[i], h = tr.h;
      this._toCam(tr.x, y0 + h * 0.5, tr.z, t);
      if (t.z < NEAR + h * 0.3) continue;
      const m = h; // margin for the crown's size
      if (Math.abs(t.x) > t.z * halfW + m || Math.abs(t.y) > t.z * halfH + m) continue;
      const zc = t.z;
      const dist = Math.sqrt(d2 + (y0 - cam.y) ** 2);
      const v = hash2(Math.round(tr.x * 10), Math.round(tr.z * 10));

      this.addLine({ x: tr.x, y: y0, z: tr.z }, { x: tr.x, y: y0 + h * 0.4, z: tr.z },
        shade(TRUNK, 1, dist), 0.2 + h * 0.03, zc + 0.3);

      if (v < 0.45) {
        // Conifer: billboard triangle, sunlit and shaded halves.
        const green = [40 + v * 30, 88 + v * 30, 50];
        const r = h * 0.28, yb = y0 + h * 0.2, yt = y0 + h;
        const left = { x: tr.x - rx * r, y: yb, z: tr.z - rz * r };
        const mid = { x: tr.x, y: yb, z: tr.z };
        const right = { x: tr.x + rx * r, y: yb, z: tr.z + rz * r };
        const top = { x: tr.x, y: yt, z: tr.z };
        this.addPoly([left, mid, top], shade(green, 1.12, dist), zc);
        this.addPoly([mid, right, top], shade(green, 0.82, dist), zc);
      } else {
        // Broadleaf: a round crown with a sunlit highlight.
        const green = [62 + v * 40, 112 + v * 30, 52];
        const r = h * 0.34, cy = y0 + h * 0.66;
        this.addEllipse({ x: tr.x, y: cy, z: tr.z }, r, r * 0.9, shade(green, 0.85, dist), 1, 0, 0.8);
        this.addEllipse({ x: tr.x - rx * r * 0.25, y: cy + r * 0.25, z: tr.z - rz * r * 0.25 },
          r * 0.62, r * 0.55, shade(green, 1.12, dist), 1, 0.01, 0.5);
      }
    }
  }

  /** A house: four walls (two gabled) and a pitched roof. Convex, so back-face culling is enough. */
  _drawHouse(hs, base, dist) {
    const cam = this.camera.position;
    const x0 = hs.x - hs.w / 2, x1 = hs.x + hs.w / 2;
    const z0 = hs.z - hs.d / 2, z1 = hs.z + hs.d / 2;
    const yb = base - 0.5, yt = base + hs.h;
    const rh = Math.min(hs.w, hs.d) * 0.4;
    const yr = yt + rh;
    const v = hash2(Math.round(hs.x * 10), Math.round(hs.z * 10));
    const wall = WALLS[Math.floor(v * WALLS.length)];
    const roof = hexToRgb(hs.roof ?? 0xb5502f);

    const face = (pts, nx, ny, nz, rgb) => {
      const p = pts[0];
      // Back-face cull: the camera must be on the outward side of the face.
      if ((cam.x - p.x) * nx + (cam.y - p.y) * ny + (cam.z - p.z) * nz <= 0) return;
      this.addPoly(pts, shade(rgb, faceLight(nx, ny, nz), dist));
    };
    const V = (x, y, z) => ({ x, y, z });

    if (hs.w >= hs.d) {
      // Ridge runs east–west.
      const zm = hs.z, hd = hs.d / 2;
      face([V(x0, yb, z0), V(x1, yb, z0), V(x1, yt, z0), V(x0, yt, z0)], 0, 0, -1, wall);
      face([V(x1, yb, z1), V(x0, yb, z1), V(x0, yt, z1), V(x1, yt, z1)], 0, 0, 1, wall);
      face([V(x0, yb, z1), V(x0, yb, z0), V(x0, yt, z0), V(x0, yr, zm), V(x0, yt, z1)], -1, 0, 0, wall);
      face([V(x1, yb, z0), V(x1, yb, z1), V(x1, yt, z1), V(x1, yr, zm), V(x1, yt, z0)], 1, 0, 0, wall);
      face([V(x0, yt, z0), V(x1, yt, z0), V(x1, yr, zm), V(x0, yr, zm)], 0, hd, -rh, roof);
      face([V(x1, yt, z1), V(x0, yt, z1), V(x0, yr, zm), V(x1, yr, zm)], 0, hd, rh, roof);
    } else {
      // Ridge runs north–south.
      const xm = hs.x, hw = hs.w / 2;
      face([V(x0, yb, z1), V(x0, yb, z0), V(x0, yt, z0), V(x0, yt, z1)], -1, 0, 0, wall);
      face([V(x1, yb, z0), V(x1, yb, z1), V(x1, yt, z1), V(x1, yt, z0)], 1, 0, 0, wall);
      face([V(x0, yb, z0), V(x1, yb, z0), V(x1, yt, z0), V(xm, yr, z0), V(x0, yt, z0)], 0, 0, -1, wall);
      face([V(x1, yb, z1), V(x0, yb, z1), V(x0, yt, z1), V(xm, yr, z1), V(x1, yt, z1)], 0, 0, 1, wall);
      face([V(x0, yt, z1), V(x0, yt, z0), V(xm, yr, z0), V(xm, yr, z1)], -rh, hw, 0, roof);
      face([V(x1, yt, z0), V(x1, yt, z1), V(xm, yr, z1), V(xm, yr, z0)], rh, hw, 0, roof);
    }
  }

  // ---- Lighthouse ----------------------------------------------------------------------

  drawLighthouse(island) {
    const L = island.lighthouse;
    if (!L) return;
    const cam = this.camera.position;
    const base = island.heightAt(L.x, L.z);
    const H = L.h || 24;
    const dist = Math.hypot(L.x - cam.x, base + H / 2 - cam.y, L.z - cam.z);
    if (dist > VIEW_DIST + 500) return;
    const SIDES = 10, BANDS = 6;
    const rb = 3.4, rt = 2.2;
    const V = (a, r, y) => ({ x: L.x + Math.cos(a) * r, y, z: L.z + Math.sin(a) * r });
    const step = (Math.PI * 2) / SIDES;

    // Frustum band: back-face culled side quads between radii r0 (y0) and r1 (y1).
    const band = (y0, y1, r0, r1, rgb, lit = true, depthBias = 0) => {
      const flare = (r0 - r1) / (y1 - y0);
      for (let s = 0; s < SIDES; s++) {
        const a0 = s * step, a1 = a0 + step, am = a0 + step / 2;
        const nx = Math.cos(am), nz = Math.sin(am);
        const px = L.x + nx * r0, pz = L.z + nz * r0;
        if ((cam.x - px) * nx + (cam.y - y0) * flare + (cam.z - pz) * nz <= 0) continue;
        const col = lit ? shade(rgb, faceLight(nx, flare, nz), dist) : shade(rgb, 1, dist * 0.4);
        this.addPoly([V(a0, r0, y0), V(a1, r0, y0), V(a1, r1, y1), V(a0, r1, y1)], col, null, { bias: depthBias });
      }
    };

    for (let b = 0; b < BANDS; b++) {
      const u0 = b / BANDS, u1 = (b + 1) / BANDS;
      band(base - 1 + u0 * (H + 1), base - 1 + u1 * (H + 1),
        rb + (rt - rb) * u0, rb + (rt - rb) * u1,
        b % 2 === 0 ? [244, 244, 240] : [200, 40, 38]);
    }
    const yg = base + H;
    band(yg, yg + 0.7, 3.0, 3.0, [52, 56, 60], true, 0.5);     // gallery
    if (cam.y > yg + 0.7) {
      const lid = [];
      for (let s = SIDES - 1; s >= 0; s--) lid.push(V(s * step, 3.0, yg + 0.7));
      this.addPoly(lid, shade([70, 74, 78], 1, dist), null, { bias: 1 });
    }
    band(yg + 0.7, yg + 3.0, 1.6, 1.6, [255, 236, 160], false, 1.5); // lantern glass
    // Cap: a cone of triangles.
    const apex = { x: L.x, y: yg + 4.8, z: L.z };
    const capY = yg + 3.0;
    for (let s = 0; s < SIDES; s++) {
      const a0 = s * step, a1 = a0 + step, am = a0 + step / 2;
      const nx = Math.cos(am), nz = Math.sin(am);
      if ((cam.x - (L.x + nx * 2)) * nx + (cam.y - capY) * (2.1 / 1.8) + (cam.z - (L.z + nz * 2)) * nz <= 0) continue;
      this.addPoly([V(a0, 2.1, capY), V(a1, 2.1, capY), apex],
        shade([150, 30, 30], faceLight(nx, 2.1 / 1.8, nz), dist), null, { bias: 2 });
    }
    this.addEllipse({ x: L.x, y: yg + 1.8, z: L.z }, 5, 5, 'rgb(255,240,180)', 0.25, 3, 1.5);
  }

  // ---- Mission rings ----------------------------------------------------------------------

  /**
   * ring: { x, y, z } (or { position }), radius (m, default 15), heading (the
   * ring faces along this heading), passed, and next/active/isNext for the
   * current target. Drawn as an annulus of quads (a core band plus a wider
   * translucent glow band) in the ring's vertical plane.
   *
   * Fuel rings (kind 'fuel' or gold: true) that are still unused get their own
   * look: slightly larger, two deep-gold bands with a warm amber glow, so the
   * refuelling detour reads at a distance. Used fuel rings dim like passed ones.
   */
  drawRing(ring, time = 0) {
    const p = ring.position || ring;
    const cam = this.camera.position;
    const R = ring.radius || 15;
    const head = ring.heading || 0;
    const ax = Math.cos(head), az = Math.sin(head); // in-plane horizontal axis
    const isNext = !!(ring.next || ring.active || ring.isNext || ring.state === 'next');
    const passed = !!(ring.passed || ring.state === 'passed');
    const dist = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
    const fog = fogAt(dist) * 0.3;
    const isFuel = !passed && (ring.kind === 'fuel' || !!ring.gold);

    if (isFuel) {
      this._drawFuelRing(p, R * 1.1, ax, az, fog, time + (ring.index || 0));
      return;
    }

    let core, glow, coreAlpha, glowAlpha;
    if (isNext) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 4);
      core = rgbString(255, 196 + 40 * pulse, 60 + 90 * pulse, 1, fog);
      glow = rgbString(255, 220, 120, 1, fog);
      coreAlpha = 1;
      glowAlpha = 0.18 + 0.2 * pulse;
    } else if (passed) {
      core = rgbString(150, 170, 180, 1, fog);
      glow = core;
      coreAlpha = 0.35;
      glowAlpha = 0;
    } else {
      core = rgbString(255, 150, 70, 1, fog);
      glow = rgbString(255, 190, 120, 1, fog);
      coreAlpha = 0.8;
      glowAlpha = 0.1;
    }

    const thick = R * 0.12;
    const SEGS = 28;
    const pt = (a, r) => ({
      x: p.x + ax * Math.cos(a) * r,
      y: p.y + Math.sin(a) * r,
      z: p.z + az * Math.cos(a) * r,
    });
    for (let s = 0; s < SEGS; s++) {
      const a0 = (s / SEGS) * Math.PI * 2, a1 = ((s + 1) / SEGS) * Math.PI * 2;
      if (glowAlpha > 0) {
        this.addPoly([pt(a0, R + thick * 2.5), pt(a1, R + thick * 2.5), pt(a1, R - thick * 2.5), pt(a0, R - thick * 2.5)],
          glow, null, { alpha: glowAlpha, bias: -0.5 });
      }
      this.addPoly([pt(a0, R + thick), pt(a1, R + thick), pt(a1, R - thick), pt(a0, R - thick)],
        core, null, { alpha: coreAlpha });
    }
  }

  /**
   * Gold double ring for an unused fuel ring: a wide warm glow spanning both
   * bands, an outer gold band at R and an inner one at 0.8 R, with a slow pulse
   * (deeper and more amber than the white-gold next-target ring).
   */
  _drawFuelRing(p, R, ax, az, fog, time) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.5);
    const outer = rgbString(255, 196 + 24 * pulse, 30 + 30 * pulse, 1, fog);
    const inner = rgbString(235, 165 + 20 * pulse, 20, 1, fog);
    const glow = rgbString(255, 170, 50, 1, fog);
    const glowAlpha = 0.16 + 0.14 * pulse;
    const thick = R * 0.075;
    const rIn = R * 0.8;
    const SEGS = 28;
    const pt = (a, r) => ({
      x: p.x + ax * Math.cos(a) * r,
      y: p.y + Math.sin(a) * r,
      z: p.z + az * Math.cos(a) * r,
    });
    for (let s = 0; s < SEGS; s++) {
      const a0 = (s / SEGS) * Math.PI * 2, a1 = ((s + 1) / SEGS) * Math.PI * 2;
      const gOut = R + thick * 3, gIn = rIn - thick * 3;
      this.addPoly([pt(a0, gOut), pt(a1, gOut), pt(a1, gIn), pt(a0, gIn)],
        glow, null, { alpha: glowAlpha, bias: -0.5 });
      this.addPoly([pt(a0, R + thick), pt(a1, R + thick), pt(a1, R - thick), pt(a0, R - thick)],
        outer, null, { alpha: 1 });
      this.addPoly([pt(a0, rIn + thick), pt(a1, rIn + thick), pt(a1, rIn - thick), pt(a0, rIn - thick)],
        inner, null, { alpha: 1 });
    }
  }

  // ---- Clouds ------------------------------------------------------------------------------

  /**
   * clouds: [{ x, y, z, size }] (or { position, size|radius }). Each cloud is a
   * cluster of billboard ellipses at fixed world offsets derived from a hash of
   * its position, translucent and fading with fog and when very close.
   */
  drawClouds(clouds, time = 0) {
    if (!clouds) return;
    const cam = this.camera.position;
    for (let c = 0; c < clouds.length; c++) {
      const cl = clouds[c];
      const p = cl.position || cl;
      const size = cl.size || cl.radius || 120;
      const dist = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      if (dist > VIEW_DIST * 1.5) continue;
      const seedX = Math.round(p.x), seedZ = Math.round(p.z);
      const puffs = 5 + Math.floor(hash2(seedX, seedZ) * 4);
      const farFade = 1 - 0.75 * fogAt(dist * 0.7);
      for (let i = 0; i < puffs; i++) {
        const h1 = hash2(seedX + i * 131, seedZ - i * 71);
        const h2 = hash2(seedX - i * 37, seedZ + i * 193);
        const h3 = hash2(seedX + i * 17, seedZ + i * 29);
        const ox = (h1 - 0.5) * size * 1.6;
        const oz = (h2 - 0.5) * size * 1.0;
        const oy = (h3 - 0.4) * size * 0.35;
        const breathe = 1 + 0.04 * Math.sin(time * 0.3 + i * 1.7 + c);
        const r = size * (0.32 + 0.22 * h3) * breathe;
        const center = { x: p.x + ox, y: p.y + oy, z: p.z + oz };
        const t = this._toCam(center.x, center.y, center.z, this._tmp);
        const nearFade = clamp((t.z - 15) / (r * 1.5), 0, 1);
        const alpha = 0.55 * farFade * nearFade;
        if (alpha < 0.02) continue;
        const bright = 0.86 + 0.14 * h3; // higher puffs are brighter
        const col = rgbString(250 * bright, 252 * bright, 255 * bright, 1, fogAt(dist) * 0.5);
        // Grey underside first, then the white body slightly above it.
        this.addEllipse({ x: center.x, y: center.y - r * 0.2, z: center.z }, r * 1.05, r * 0.5,
          rgbString(196, 204, 214, 1, fogAt(dist) * 0.5), alpha * 0.8, 0);
        this.addEllipse(center, r, r * 0.62, col, alpha, 0.02);
      }
    }
  }
}
