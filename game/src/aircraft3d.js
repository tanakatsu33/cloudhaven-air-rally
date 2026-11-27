// Cloudhaven Air Rally — 3D model of the player's plane, the Kestrel K-1.
//
// A small high-wing bush plane: ~8 m long, 11 m span, fixed gear. All geometry
// goes through Renderer3D's polygon queue (addPoly / addLine / addEllipse), so
// it sorts together with the rest of the scene.
//
// Body frame (metres): x = right, y = up, z = forward (nose at +z).
// The origin is the ground-contact point under the main wheels, which matches
// FlightModel.position (on the ground position.y === terrain height), so the
// wheels sit on the runway and pitching rotates about the main gear.
//
// World frame (matches renderer3d.js / flight-model.js): x east, z south, y up.
// Heading 0 = north; positive pitch = nose up; positive roll = right wing down.
//
// Usage, once per frame between setCamera() and flush():
//   drawAircraft(renderer, flight, time);
//
// Control-surface deflections: if flight.controls = { elevator, aileron, rudder }
// (each -1..1) exists it is used directly; otherwise they are estimated from the
// pitch / roll / heading rates between calls.

import { FLIGHT_CONSTANTS, rollRecenterRate, rollInputGain } from './flight-model.js';

// ---- Lighting (mirrors renderer3d.js; keep in sync) -----------------------------
const SUN_AZ = 2.4, SUN_EL = 0.5;
const SUN = {
  x: Math.sin(SUN_AZ) * Math.cos(SUN_EL),
  y: Math.sin(SUN_EL),
  z: -Math.cos(SUN_AZ) * Math.cos(SUN_EL),
};
const FLAT_LIGHT = 0.55 + 0.6 * SUN.y;
const HORIZON = [204, 224, 238];
const FOG_START = 400, FOG_END = 4000 * 0.97;

// ---- Palette: slightly muted, warm --------------------------------------------
const CREAM = [234, 222, 196];
const RED = [176, 60, 48];
const GLASS = [178, 208, 226];
const DARK = [64, 64, 68];
const TYRE = [42, 40, 40];
const HUB = [150, 146, 138];
const PROP = [58, 56, 54];
const PROP_TIP = [226, 190, 82];
const DISC = [196, 196, 188];
const STRUT = [120, 114, 104];
const NAV_RED = [255, 70, 56];
const NAV_GREEN = [80, 255, 130];
const NAV_WHITE = [255, 250, 232];

// ---- Control tuning (rates mirror flight-model.js) --------------------------------
const PITCH_RATE = 0.55, ROLL_RATE = 1.2;
const TURN_GAIN = 0.75, RUDDER_AIR = 0.12, RUDDER_GROUND = 0.6, STALL_NOSE_DROP = 0.5;
const MAX_ELEVATOR = 0.42;  // rad
const MAX_AILERON = 0.35;   // rad
const MAX_RUDDER = 0.45;    // rad
const CONTROL_SMOOTH = 12;  // 1/s response of the visible surfaces

// ---- Propeller -------------------------------------------------------------------
const PROP_Z = 2.7, PROP_Y = 1.22, PROP_R = 0.95;

// ---- Helpers ----------------------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const V = (x, y, z) => ({ x, y, z });

function smoothstep(e0, e1, v) {
  const t = clamp((v - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function colour(rgb, light, dist) {
  const f = smoothstep(FOG_START, FOG_END, dist);
  let r = clamp(rgb[0] * light, 0, 255);
  let g = clamp(rgb[1] * light, 0, 255);
  let b = clamp(rgb[2] * light, 0, 255);
  r += (HORIZON[0] - r) * f;
  g += (HORIZON[1] - g) * f;
  b += (HORIZON[2] - b) * f;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function faceLight(n) {
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  const lam = (n.x * SUN.x + n.y * SUN.y + n.z * SUN.z) / len;
  return (0.55 + 0.6 * Math.max(0, lam)) / FLAT_LIGHT;
}

function sub(a, b) { return V(a.x - b.x, a.y - b.y, a.z - b.z); }
function cross(a, b) { return V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

function centroid(pts) {
  let x = 0, y = 0, z = 0;
  for (const p of pts) { x += p.x; y += p.y; z += p.z; }
  return V(x / pts.length, y / pts.length, z / pts.length);
}

/** Newell normal of a planar-ish polygon. */
function polyNormal(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return V(nx / l, ny / l, nz / l);
}

/** Face whose normal points away from `inside` (outward for closed solids). */
function face(pts, inside, rgb, extra) {
  let n = polyNormal(pts);
  if (dot(n, sub(centroid(pts), inside)) < 0) {
    pts = pts.slice().reverse();
    n = V(-n.x, -n.y, -n.z);
  }
  return { pts, n, rgb, ...extra };
}

/**
 * Hexahedron from 8 corners: b = bottom quad, t = top quad, both ordered
 * [left-aft, right-aft, right-fore, left-fore]. Returns 6 outward faces.
 */
function hexa(b, t, rgb, extra) {
  const c = centroid([...b, ...t]);
  return [
    face([b[0], b[1], b[2], b[3]], c, rgb, extra),
    face([t[0], t[1], t[2], t[3]], c, rgb, extra),
    face([b[0], b[1], t[1], t[0]], c, rgb, extra), // aft
    face([b[3], b[2], t[2], t[3]], c, rgb, extra), // fore
    face([b[0], b[3], t[3], t[0]], c, rgb, extra), // left
    face([b[1], b[2], t[2], t[1]], c, rgb, extra), // right
  ];
}

/** Flat slab in the x/z plane: x0..x1, aft..fore, centred on y with thickness th. */
function slab(x0, x1, zAft0, zFore0, zAft1, zFore1, y0, y1, th, rgb, extra) {
  const h = th / 2;
  return hexa(
    [V(x0, y0 - h, zAft0), V(x1, y1 - h, zAft1), V(x1, y1 - h, zFore1), V(x0, y0 - h, zFore0)],
    [V(x0, y0 + h, zAft0), V(x1, y1 + h, zAft1), V(x1, y1 + h, zFore1), V(x0, y0 + h, zFore0)],
    rgb, extra,
  );
}

// ---- Mesh -------------------------------------------------------------------------

// Fuselage cross-sections: hexagonal (bottom, sill, top) with separate half-widths.
//            z      hwB   yB    hwS   yS    hwT   yT
const SECTIONS = [
  [ 2.55, 0.36, 0.95, 0.42, 1.25, 0.34, 1.50], // cowl front
  [ 1.50, 0.48, 0.78, 0.56, 1.30, 0.46, 1.62], // firewall / windshield base
  [ 0.75, 0.50, 0.75, 0.58, 1.30, 0.48, 2.05], // windshield top, wing leading edge
  [-0.70, 0.50, 0.75, 0.58, 1.30, 0.48, 2.05], // cabin rear, wing trailing edge
  [-1.50, 0.42, 0.85, 0.50, 1.35, 0.36, 1.90], // rear window end
  [-2.60, 0.30, 1.05, 0.34, 1.40, 0.24, 1.75], // livery band start
  [-3.10, 0.26, 1.12, 0.30, 1.42, 0.20, 1.72], // livery band end
  [-4.70, 0.08, 1.38, 0.10, 1.50, 0.06, 1.58], // tail cone end
];
// Per segment: [lower sides + bottom, upper sides, top]
const SEGMENT_STYLE = [
  [RED, RED, RED],         // nose / cowl
  [CREAM, GLASS, GLASS],   // windshield + front side windows
  [CREAM, GLASS, CREAM],   // cabin (roof under the wing)
  [CREAM, GLASS, CREAM],   // rear side windows
  [CREAM, CREAM, CREAM],   // tail cone
  [RED, RED, RED],         // red band
  [CREAM, CREAM, CREAM],   // tail cone
];

function ring(s) {
  const [z, hwB, yB, hwS, yS, hwT, yT] = s;
  // bottom-left, bottom-right, sill-right, top-right, top-left, sill-left
  return [V(-hwB, yB, z), V(hwB, yB, z), V(hwS, yS, z), V(hwT, yT, z), V(-hwT, yT, z), V(-hwS, yS, z)];
}

function buildFuselage() {
  const faces = [];
  const rings = SECTIONS.map(ring);
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], B = rings[i + 1];
    const [lower, upper, top] = SEGMENT_STYLE[i];
    // Inside reference: the segment's axis midpoint (convex per segment).
    const c = centroid([...A, ...B]);
    const glass = (rgb) => (rgb === GLASS ? { glass: true } : null);
    faces.push(face([A[0], A[1], B[1], B[0]], c, lower));                         // bottom
    faces.push(face([A[1], A[2], B[2], B[1]], c, lower));                         // lower right
    faces.push(face([A[5], A[0], B[0], B[5]], c, lower));                         // lower left
    faces.push(face([A[2], A[3], B[3], B[2]], c, upper, glass(upper)));           // upper right
    faces.push(face([A[4], A[5], B[5], B[4]], c, upper, glass(upper)));           // upper left
    faces.push(face([A[3], A[4], B[4], B[3]], c, top, glass(top)));               // top
  }
  // End caps: dark engine face behind the spinner, cream tail end.
  const front = rings[0], back = rings[rings.length - 1];
  faces.push(face(front, V(0, 1.2, 0), DARK));
  faces.push(face(back, V(0, 1.4, 0), CREAM));
  // Spinner: four-sided pyramid.
  const s = 0.2, tip = V(0, PROP_Y, 3.0);
  const base = [V(-s, PROP_Y - s, 2.55), V(s, PROP_Y - s, 2.55), V(s, PROP_Y + s, 2.55), V(-s, PROP_Y + s, 2.55)];
  const sc = V(0, PROP_Y, 2.6);
  for (let i = 0; i < 4; i++) faces.push(face([base[i], base[(i + 1) % 4], tip], sc, CREAM));
  return { name: 'fuselage', kind: 'mesh', faces };
}

function buildWing() {
  const faces = [];
  const y = 2.11, th = 0.12, dihedral = 0.03; // rise per metre of span
  const LE = 0.75, TE = -0.55, ROOT = 0.0, MID = 4.7, TIP = 5.5;
  for (const sgn of [-1, 1]) {
    const yr = y, ym = y + MID * dihedral, yt = y + TIP * dihedral;
    // Inner panel (cream), red tip panel with a slightly rounded leading edge.
    faces.push(...slab(sgn * ROOT, sgn * MID, TE, LE, TE, LE, yr, ym, th, CREAM));
    faces.push(...slab(sgn * MID, sgn * TIP, TE, LE, TE + 0.12, LE - 0.18, ym, yt, th * 0.85, RED));
  }
  return { name: 'wing', kind: 'mesh', faces };
}

function buildAilerons() {
  const parts = [];
  const y = 2.11, dihedral = 0.03, x0 = 2.4, x1 = 4.7, hingeZ = -0.55, chord = 0.32;
  for (const sgn of [-1, 1]) {
    const y0 = y + x0 * dihedral, y1 = y + x1 * dihedral;
    const faces = slab(sgn * x0, sgn * x1, hingeZ - chord, hingeZ, hingeZ - chord, hingeZ, y0, y1, 0.06, CREAM);
    parts.push({
      name: sgn > 0 ? 'aileronR' : 'aileronL', kind: 'mesh', faces,
      hinge: { origin: V(0, (y0 + y1) / 2, hingeZ), axis: V(1, 0, 0), control: 'aileron', sign: sgn, max: MAX_AILERON },
    });
  }
  return parts;
}

function buildTail() {
  const parts = [];
  // Horizontal stabiliser (fixed) and split elevator.
  const yH = 1.5, hingeH = -4.45;
  parts.push({ name: 'stabilizer', kind: 'mesh', faces: slab(-1.75, 1.75, hingeH, -3.95, hingeH, -4.15, yH, yH, 0.07, CREAM) });
  const elev = [];
  for (const sgn of [-1, 1]) {
    elev.push(...slab(sgn * 0.12, sgn * 1.7, hingeH - 0.45, hingeH, hingeH - 0.32, hingeH, yH, yH, 0.05, RED));
  }
  parts.push({
    name: 'elevator', kind: 'mesh', faces: elev,
    hinge: { origin: V(0, yH, hingeH), axis: V(1, 0, 0), control: 'elevator', sign: 1, max: MAX_ELEVATOR },
  });
  // Vertical fin (swept leading edge) and rudder.
  const hingeV = -4.55, w = 0.05;
  const fin = hexa(
    [V(-w, 1.5, hingeV), V(w, 1.5, hingeV), V(w, 1.5, -3.3), V(-w, 1.5, -3.3)],
    [V(-w, 2.85, hingeV), V(w, 2.85, hingeV), V(w, 2.85, -4.15), V(-w, 2.85, -4.15)],
    CREAM,
  );
  parts.push({ name: 'fin', kind: 'mesh', faces: fin });
  const rw = 0.035;
  const rudder = hexa(
    [V(-rw, 1.4, -5.0), V(rw, 1.4, -5.0), V(rw, 1.4, hingeV), V(-rw, 1.4, hingeV)],
    [V(-rw, 2.85, -4.85), V(rw, 2.85, -4.85), V(rw, 2.85, hingeV), V(-rw, 2.85, hingeV)],
    RED,
  );
  // Right rudder (positive yaw) swings the trailing edge to the right (+x),
  // i.e. a negative rotation about +y.
  parts.push({
    name: 'rudder', kind: 'mesh', faces: rudder,
    hinge: { origin: V(0, 2.1, hingeV), axis: V(0, 1, 0), control: 'rudder', sign: -1, max: MAX_RUDDER },
  });
  return parts;
}

function buildGear() {
  const faces = [];
  const R = 0.32, W = 0.16, N = 6, zc = 0.35;
  const yc = R * Math.cos(Math.PI / N); // hexagonal tyre: flat bottom sits on y = 0
  for (const sgn of [-1, 1]) {
    const xc = sgn * 1.0;
    const outer = [], inner = [];
    for (let i = 0; i < N; i++) {
      const a = ((i + 0.5) / N) * Math.PI * 2;
      const y = yc + Math.cos(a) * R, z = zc + Math.sin(a) * R;
      outer.push(V(xc + sgn * W / 2, y, z));
      inner.push(V(xc - sgn * W / 2, y, z));
    }
    const c = V(xc, yc, zc);
    faces.push(face(outer, c, HUB));
    faces.push(face(inner, c, HUB));
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      faces.push(face([outer[i], outer[j], inner[j], inner[i]], c, TYRE));
    }
  }
  const lines = [];
  for (const sgn of [-1, 1]) {
    const hub = V(sgn * 0.92, yc, zc);
    lines.push({ a: V(sgn * 0.42, 0.78, 0.75), b: hub, rgb: STRUT, w: 0.07 });  // front leg
    lines.push({ a: V(sgn * 0.42, 0.78, -0.15), b: hub, rgb: STRUT, w: 0.06 }); // rear leg
    lines.push({ a: V(sgn * 0.5, 0.95, 0.1), b: V(sgn * 2.9, 2.06 + 2.9 * 0.03, 0.15), rgb: STRUT, w: 0.07 }); // wing strut
  }
  return [
    { name: 'wheels', kind: 'mesh', faces },
    { name: 'struts', kind: 'lines', lines },
  ];
}

function buildLights() {
  const lights = [
    { name: 'navLeft', pos: V(-5.53, 2.11 + 5.5 * 0.03, 0.15), rgb: NAV_RED },
    { name: 'navRight', pos: V(5.53, 2.11 + 5.5 * 0.03, 0.15), rgb: NAV_GREEN },
    { name: 'navTail', pos: V(0, 1.5, -4.76), rgb: NAV_WHITE },
  ];
  return lights.map(({ name, pos, rgb }) => {
    const s = 0.07, { x, y, z } = pos;
    // Three orthogonal squares, two-sided, so the light reads from any angle.
    const faces = [
      [V(x - s, y - s, z), V(x + s, y - s, z), V(x + s, y + s, z), V(x - s, y + s, z)],
      [V(x, y - s, z - s), V(x, y - s, z + s), V(x, y + s, z + s), V(x, y + s, z - s)],
      [V(x - s, y, z - s), V(x + s, y, z - s), V(x + s, y, z + s), V(x - s, y, z + s)],
    ].map((pts) => ({ pts, n: polyNormal(pts), rgb, twoSided: true, emissive: true }));
    return { name, kind: 'light', pos, rgb, faces };
  });
}

let cachedMesh = null;

/**
 * The Kestrel K-1 in body space. Each part:
 *   { name, kind: 'mesh' | 'lines' | 'light' | 'propeller', faces?, lines?, hinge? }
 * Faces are { pts: [{x,y,z}], n: outward normal, rgb, glass?, twoSided?, emissive? }.
 * Hinged parts rotate about hinge.axis through hinge.origin by
 * controls[hinge.control] · hinge.sign · hinge.max.
 */
export function buildAircraftMesh() {
  return [
    buildFuselage(),
    buildWing(),
    ...buildAilerons(),
    ...buildTail(),
    ...buildGear(),
    ...buildLights(),
    { name: 'propeller', kind: 'propeller', hub: V(0, PROP_Y, PROP_Z), radius: PROP_R },
  ];
}

function getMesh() {
  if (!cachedMesh) cachedMesh = buildAircraftMesh();
  return cachedMesh;
}

// ---- Per-flight animation state ----------------------------------------------------

const animState = new WeakMap();

function wrapPi(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  return (a < 0 ? a + Math.PI * 2 : a) - Math.PI;
}

/** Estimate control inputs from attitude rates, smoothed; advance the propeller. */
function updateAnim(flight, time) {
  let st = animState.get(flight);
  const t = Number.isFinite(time) ? time : (flight.time || 0);
  if (!st) {
    st = { t, pitch: flight.pitch, roll: flight.roll, heading: flight.heading,
      elevator: 0, aileron: 0, rudder: 0, prop: 0 };
    animState.set(flight, st);
    return st;
  }
  let dt = t - st.t;
  if (!(dt > 0) || dt > 0.5) {
    // Paused, rewound or a long hitch: resync without inventing rates.
    if (dt !== 0) { st.t = t; st.pitch = flight.pitch; st.roll = flight.roll; st.heading = flight.heading; }
    return st;
  }

  // Propeller: visual spin rate grows with throttle (stopped when crashed or dry).
  const spin = flight.crashed ? 0 : (flight.fuel ?? 1) > 0 ? clamp(flight.throttle || 0, 0, 1) : 0;
  const windmill = flight.crashed ? 0 : clamp((flight.speed || 0) / 60, 0, 0.15);
  st.spin = Math.max(spin, windmill);
  st.prop = (st.prop + dt * Math.PI * 2 * (st.spin > 0 ? 2 + 14 * st.spin : 0)) % (Math.PI * 2);

  let elev = 0, ail = 0, rud = 0;
  const c = flight.controls;
  if (c && (Number.isFinite(c.elevator) || Number.isFinite(c.aileron) || Number.isFinite(c.rudder))) {
    elev = c.elevator || 0; ail = c.aileron || 0; rud = c.rudder || 0;
  } else if (!flight.crashed) {
    const speed = flight.speed || 0;
    const auth = clamp(speed / FLIGHT_CONSTANTS.STALL_SPEED, 0.3, 1);
    const lift = flight.liftFactor ?? 1;
    const pitchRate = (flight.pitch - st.pitch) / dt;
    const rollRate = (flight.roll - st.roll) / dt;
    const headRate = wrapPi(flight.heading - st.heading) / dt;
    if (flight.onGround) {
      elev = clamp(pitchRate / PITCH_RATE, -1, 1);
      const steer = clamp(speed / 8, 0, 1);
      rud = steer > 0.05 ? clamp(headRate / (RUDDER_GROUND * steer), -1, 1) : st.rudder;
    } else {
      elev = clamp((pitchRate + STALL_NOSE_DROP * (1 - lift)) / (PITCH_RATE * auth), -1, 1);
      // Ignore the hands-off wings-level return (rolling toward zero no faster
      // than the model's recentre rate); counter-steer rolls back faster.
      const towardLevel = rollRate * st.roll < 0;
      const handsOff = towardLevel && Math.abs(rollRate) <= rollRecenterRate(st.roll) * 1.1;
      const gain = rollInputGain(Math.sign(rollRate), st.roll);
      ail = handsOff ? 0 : clamp(rollRate / (ROLL_RATE * gain * auth), -1, 1);
      rud = clamp((headRate - TURN_GAIN * Math.sin(flight.roll) * lift) / (RUDDER_AIR * auth), -1, 1);
    }
    if (Math.abs(elev) < 0.08) elev = 0;
    if (Math.abs(rud) < 0.08) rud = 0;
  }
  const k = 1 - Math.exp(-dt * CONTROL_SMOOTH);
  st.elevator += (clamp(elev, -1, 1) - st.elevator) * k;
  st.aileron += (clamp(ail, -1, 1) - st.aileron) * k;
  st.rudder += (clamp(rud, -1, 1) - st.rudder) * k;

  st.t = t; st.pitch = flight.pitch; st.roll = flight.roll; st.heading = flight.heading;
  return st;
}

// ---- Drawing -------------------------------------------------------------------------

/** Rodrigues rotation of v about unit axis k by angle a. */
function rotateAxis(v, k, ca, sa) {
  const kv = cross(k, v), d = dot(k, v) * (1 - ca);
  return V(v.x * ca + kv.x * sa + k.x * d, v.y * ca + kv.y * sa + k.y * d, v.z * ca + kv.z * sa + k.z * d);
}

/**
 * Submit the plane's polygons in world space.
 * flight: FlightModel (position, heading, pitch, roll, throttle, ...).
 * time: seconds (drives the propeller and rate-based control estimates).
 * Returns the number of polygons queued.
 */
export function drawAircraft(renderer, flight, time) {
  const mesh = getMesh();
  const st = updateAnim(flight, time);
  const P = flight.position;
  const cam = renderer.camera.position;

  // Body axes in world space: world = P + R·x + U·y + F·z.
  const sh = Math.sin(flight.heading || 0), ch = Math.cos(flight.heading || 0);
  const sp = Math.sin(flight.pitch || 0), cp = Math.cos(flight.pitch || 0);
  const sr = Math.sin(flight.roll || 0), cr = Math.cos(flight.roll || 0);
  const dir = (x, y, z) => {
    const x1 = x * cr + y * sr, y1 = y * cr - x * sr;      // roll (right wing down)
    const y2 = y1 * cp + z * sp, z2 = z * cp - y1 * sp;    // pitch (nose up)
    return V(x1 * ch + z2 * sh, y2, x1 * sh - z2 * ch);    // heading
  };
  const R = dir(1, 0, 0), U = dir(0, 1, 0), F = dir(0, 0, 1);
  const toWorld = (p) => V(
    P.x + R.x * p.x + U.x * p.y + F.x * p.z,
    P.y + R.y * p.x + U.y * p.y + F.y * p.z,
    P.z + R.z * p.x + U.z * p.y + F.z * p.z,
  );
  const dirWorld = (n) => V(
    R.x * n.x + U.x * n.y + F.x * n.z,
    R.y * n.x + U.y * n.y + F.y * n.z,
    R.z * n.x + U.z * n.y + F.z * n.z,
  );
  const dist = Math.hypot(P.x - cam.x, P.y - cam.y, P.z - cam.z);
  let count = 0;

  const emit = (f, xf) => {
    let pts = f.pts, n = f.n;
    if (xf) { pts = pts.map(xf.p); n = xf.n(n); }
    const wp = pts.map(toWorld);
    let wn = dirWorld(n);
    const toCam = sub(cam, wp[0]);
    if (dot(wn, toCam) <= 0) {
      if (!f.twoSided) return; // back face
      wn = V(-wn.x, -wn.y, -wn.z);
    }
    let fill, opts = null;
    if (f.emissive) {
      fill = colour(f.rgb, 1, dist * 0.5);
      opts = { bias: 0.02 };
    } else if (f.glass) {
      // Pale, lightly lit glass with a touch of transparency.
      fill = colour(f.rgb, 0.25 + 0.85 * faceLight(wn), dist);
      opts = { alpha: 0.82 };
    } else {
      fill = colour(f.rgb, faceLight(wn), dist);
    }
    if (renderer.addPoly(wp, fill, null, opts)) count++;
  };

  for (const part of mesh) {
    if (part.kind === 'mesh' || part.kind === 'light') {
      let xf = null;
      if (part.hinge) {
        const h = part.hinge;
        const a = (st[h.control] || 0) * h.sign * h.max;
        if (Math.abs(a) > 1e-4) {
          const ca = Math.cos(a), sa = Math.sin(a), o = h.origin, k = h.axis;
          xf = {
            p: (p) => { const r = rotateAxis(sub(p, o), k, ca, sa); return V(r.x + o.x, r.y + o.y, r.z + o.z); },
            n: (n) => rotateAxis(n, k, ca, sa),
          };
        }
      }
      for (const f of part.faces) emit(f, xf);
      if (part.kind === 'light') {
        renderer.addEllipse(toWorld(part.pos), 0.35, 0.35, colour(part.rgb, 1, dist * 0.5), 0.3, 0.05, 1.5);
      }
    } else if (part.kind === 'lines') {
      for (const l of part.lines) {
        renderer.addLine(toWorld(l.a), toWorld(l.b), colour(l.rgb, 1, dist), l.w);
      }
    } else if (part.kind === 'propeller') {
      count += drawPropeller(renderer, part, st, toWorld, dirWorld, cam, dist);
    }
  }
  return count;
}

function drawPropeller(renderer, part, st, toWorld, dirWorld, cam, dist) {
  const { hub, radius } = part;
  const spin = st.spin || 0;
  let count = 0;
  const lightN = dirWorld(V(0, 0, 1));
  const at = (r, a, w) => {
    // Point at radius r along angle a, offset w across the blade.
    const ca = Math.cos(a), sa = Math.sin(a);
    return toWorld(V(hub.x + ca * r - sa * w, hub.y + sa * r + ca * w, hub.z));
  };

  // Blurred disc: fades in with rpm.
  if (spin > 0.02) {
    const disc = [];
    for (let i = 0; i < 14; i++) disc.push(at(radius, (i / 14) * Math.PI * 2, 0));
    if (renderer.addPoly(disc, colour(DISC, 1.05, dist), null, { alpha: 0.1 + 0.22 * spin })) count++;
  }

  // Two blades, ghostly at high rpm.
  const facing = dot(lightN, sub(cam, toWorld(hub))) > 0 ? lightN : V(-lightN.x, -lightN.y, -lightN.z);
  const lit = faceLight(facing);
  const alpha = 1 - 0.65 * smoothstep(0.05, 0.6, spin);
  const opts = { alpha, bias: 0.01 };
  for (const a of [st.prop, st.prop + Math.PI]) {
    const blade = [
      at(0.1, a, -0.05), at(0.55, a, -0.09), at(0.82, a, -0.07),
      at(0.82, a, 0.07), at(0.55, a, 0.09), at(0.1, a, 0.05),
    ];
    if (renderer.addPoly(blade, colour(PROP, lit, dist), null, opts)) count++;
    const tip = [at(0.82, a, -0.07), at(radius, a, -0.04), at(radius, a, 0.04), at(0.82, a, 0.07)];
    if (renderer.addPoly(tip, colour(PROP_TIP, lit, dist), null, opts)) count++;
  }
  return count;
}
