// Cloudhaven Air Rally — cockpit view overlay.
//
// Paints the cockpit structure and a working instrument panel over the 3D
// scene. The 3D camera sits at the pilot's eye in this view, so this file only
// draws what is physically in front of the pilot: windscreen pillars, the
// glareshield coaming, the panel, six lit instruments, and the control yoke.
//
// All instruments read the live FlightModel:
//   position.y → altimeter, speed → airspeed, heading → compass,
//   verticalSpeed → VSI, pitch/roll → artificial horizon,
//   throttle (+ speed, fuel) → RPM, fuel → fuel gauge.
//
// The FlightModel does not store pilot inputs, so the yoke position is
// estimated from the attitude rates (normalised by control authority), unless
// explicit inputs are supplied via setControls() or a flight.controls object.

import { FLIGHT_CONSTANTS } from './flight-model.js';

// ---- Units and constants ----------------------------------------------------

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const MS_TO_KT = 1.943844;
const M_TO_FT = 3.28084;
const MS_TO_FPM = 196.8504;

const STALL_KT = FLIGHT_CONSTANTS.STALL_SPEED * MS_TO_KT; // ≈ 50 kt
const CRUISE_MAX_KT = 70 * MS_TO_KT;                         // ≈ 136 kt, level top speed
const NEVER_EXCEED_KT = 90 * MS_TO_KT;                       // ≈ 175 kt, model hard cap

// Rates used to turn attitude changes back into estimated control inputs
// (must mirror flight-model.js).
const PITCH_RATE = 0.55;
const ROLL_RATE = 1.2;
const STALL_NOSE_DROP = 0.5;

const RPM_REDLINE = 2700;
const RPM_MAX = 3000;

// ---- Palette ----------------------------------------------------------------

const FONT = '"DejaVu Sans", "Segoe UI", Arial, sans-serif';
const AMBER = '#ffb340';
const AMBER_HI = '#ffd994';
const AMBER_DIM = 'rgba(255, 170, 70, 0.55)';
const GLOW = 'rgba(255, 140, 30, 0.75)';
const RED = '#ff4433';
const GREEN = '#5fd35a';
const YELLOW = '#ffcf3a';
const LABEL = 'rgba(210, 180, 130, 0.42)';

// ---- Small helpers ----------------------------------------------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

function nowSec() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now() / 1000;
  return Date.now() / 1000;
}

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
}

function rrect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Add a radial tick segment to the current path. */
function tick(ctx, cx, cy, a, r0, r1) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  ctx.moveTo(cx + c * r0, cy + s * r0);
  ctx.lineTo(cx + c * r1, cy + s * r1);
}

function arcBand(ctx, cx, cy, rad, width, a0, a1, color) {
  ctx.beginPath();
  ctx.arc(cx, cy, rad, a0, a1);
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = color;
  ctx.stroke();
}

function text(ctx, str, x, y, size, color, weight = 600, align = 'center') {
  ctx.font = `${weight} ${Math.max(6, Math.round(size))}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(str, x, y);
}

function glowOn(ctx, r) {
  ctx.shadowColor = GLOW;
  ctx.shadowBlur = Math.max(2, r * 0.07);
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function glowOff(ctx) {
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

/** Tapered needle from (cx,cy) along canvas angle a. */
function needle(ctx, cx, cy, a, len, w, color, tail = 0) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(a);
  ctx.beginPath();
  ctx.moveTo(-tail, -w * 0.5);
  ctx.lineTo(len * 0.8, -w * 0.32);
  ctx.lineTo(len, 0);
  ctx.lineTo(len * 0.8, w * 0.32);
  ctx.lineTo(-tail, w * 0.5);
  ctx.closePath();
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = w * 1.2;
  ctx.shadowOffsetX = w * 0.3;
  ctx.shadowOffsetY = w * 0.5;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function hubCap(ctx, cx, cy, r) {
  const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#6a6a70');
  g.addColorStop(1, '#141416');
  circle(ctx, cx, cy, r);
  ctx.fillStyle = g;
  ctx.fill();
}

function screw(ctx, x, y, r, a) {
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  g.addColorStop(0, '#85858c');
  g.addColorStop(1, '#2a2a2e');
  circle(ctx, x, y, r);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(0.5, r * 0.18);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.stroke();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.beginPath();
  ctx.moveTo(-r * 0.7, 0);
  ctx.lineTo(r * 0.7, 0);
  ctx.lineWidth = Math.max(0.6, r * 0.28);
  ctx.strokeStyle = '#151517';
  ctx.stroke();
  ctx.restore();
}

/** Mounting plate, screws, bezel, lit near-black face, and engraved label. */
function drawCase(ctx, cx, cy, r, label) {
  const p = r * 1.17;

  const pg = ctx.createLinearGradient(cx - p, cy - p, cx + p, cy + p);
  pg.addColorStop(0, '#2a2b30');
  pg.addColorStop(1, '#131417');
  rrect(ctx, cx - p, cy - p, p * 2, p * 2, r * 0.16);
  ctx.fillStyle = pg;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.015);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.stroke();

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      screw(ctx, cx + sx * p * 0.81, cy + sy * p * 0.81, r * 0.07, (sx * 3 + sy) * 0.7);
    }
  }

  const bg = ctx.createLinearGradient(cx, cy - r * 1.07, cx, cy + r * 1.07);
  bg.addColorStop(0, '#5a5a62');
  bg.addColorStop(0.5, '#25252a');
  bg.addColorStop(1, '#0c0c0e');
  circle(ctx, cx, cy, r * 1.07);
  ctx.fillStyle = bg;
  ctx.fill();
  circle(ctx, cx, cy, r * 1.012);
  ctx.fillStyle = '#040404';
  ctx.fill();

  // Near-black face with a warm backlight glow towards the rim.
  const fg = ctx.createRadialGradient(cx, cy - r * 0.12, r * 0.05, cx, cy, r);
  fg.addColorStop(0, '#18110a');
  fg.addColorStop(0.72, '#0b0907');
  fg.addColorStop(0.92, '#110b06');
  fg.addColorStop(1, '#3a2108');
  circle(ctx, cx, cy, r);
  ctx.fillStyle = fg;
  ctx.fill();

  if (label) {
    const size = Math.max(7, r * 0.16);
    ctx.save();
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(size * 0.18)}px`;
    // Engraved: dark offset under a dim light fill.
    text(ctx, label, cx, cy + p + size * 0.85 + 1, size, 'rgba(0,0,0,0.7)', 700);
    text(ctx, label, cx, cy + p + size * 0.85, size, LABEL, 700);
    ctx.restore();
  }
}

/** Glass reflection and inner rim shadow on top of an instrument. */
function drawGlass(ctx, cx, cy, r) {
  ctx.save();
  circle(ctx, cx, cy, r);
  ctx.clip();
  const s = ctx.createRadialGradient(cx, cy, r * 0.78, cx, cy, r);
  s.addColorStop(0, 'rgba(0,0,0,0)');
  s.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = s;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  const g = ctx.createLinearGradient(cx - r, cy - r, cx + r * 0.25, cy + r * 0.25);
  g.addColorStop(0, 'rgba(255,255,255,0.10)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.025)');
  g.addColorStop(0.5, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

// ---- Instruments ------------------------------------------------------------

/** Airspeed indicator: 0–200 kt over 330°, red line at stall, green/yellow arcs. */
function drawASI(ctx, cx, cy, r, kt) {
  drawCase(ctx, cx, cy, r, 'ASI');
  const MAX = 200;
  const A0 = -Math.PI / 2;
  const SWEEP = 330 * DEG;
  const ang = (v) => A0 + (clamp(v, 0, MAX) / MAX) * SWEEP;

  ctx.save();
  arcBand(ctx, cx, cy, r * 0.84, r * 0.07, ang(STALL_KT), ang(CRUISE_MAX_KT), GREEN);
  arcBand(ctx, cx, cy, r * 0.84, r * 0.07, ang(CRUISE_MAX_KT), ang(NEVER_EXCEED_KT), YELLOW);

  glowOn(ctx, r);
  ctx.lineCap = 'butt';
  for (let v = 0; v <= MAX; v += 5) {
    const major = v % 10 === 0;
    ctx.beginPath();
    tick(ctx, cx, cy, ang(v), major ? r * 0.76 : r * 0.83, r * 0.93);
    ctx.lineWidth = Math.max(1, r * (major ? 0.028 : 0.014));
    ctx.strokeStyle = major ? AMBER_HI : AMBER_DIM;
    ctx.stroke();
  }
  for (let v = 20; v <= MAX; v += 20) {
    const a = ang(v);
    text(ctx, String(v), cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6, r * 0.15, AMBER);
  }
  // Red line at the stall speed.
  ctx.beginPath();
  tick(ctx, cx, cy, ang(STALL_KT), r * 0.7, r * 0.97);
  ctx.lineWidth = Math.max(1.5, r * 0.04);
  ctx.strokeStyle = RED;
  ctx.stroke();

  text(ctx, 'KNOTS', cx, cy + r * 0.3, r * 0.11, AMBER_DIM, 700);
  text(ctx, 'AIRSPEED', cx, cy - r * 0.28, r * 0.09, AMBER_DIM, 700);
  glowOff(ctx);

  needle(ctx, cx, cy, ang(kt), r * 0.86, r * 0.07, AMBER_HI, r * 0.18);
  hubCap(ctx, cx, cy, r * 0.09);
  ctx.restore();
  drawGlass(ctx, cx, cy, r);
}

/** Artificial horizon: rolling/pitching ball with ladder, fixed aircraft symbol. */
function drawAttitude(ctx, cx, cy, r, pitch, roll) {
  drawCase(ctx, cx, cy, r, 'ATT');
  const ri = r * 0.97;
  const ppr = r * 1.55; // pixels per radian of pitch

  ctx.save();
  circle(ctx, cx, cy, ri);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-roll); // bank right → horizon rotates anticlockwise on the dial
  const off = clamp(pitch, -1.2, 1.2) * ppr; // nose up → horizon moves down
  const big = r * 2;

  let g = ctx.createLinearGradient(0, off - r * 1.5, 0, off);
  g.addColorStop(0, '#0a1626');
  g.addColorStop(1, '#2c5274');
  ctx.fillStyle = g;
  ctx.fillRect(-big, off - big * 2, big * 2, big * 2);
  g = ctx.createLinearGradient(0, off, 0, off + r * 1.5);
  g.addColorStop(0, '#5c3a1b');
  g.addColorStop(1, '#1a1007');
  ctx.fillStyle = g;
  ctx.fillRect(-big, off, big * 2, big * 2);

  ctx.beginPath();
  ctx.moveTo(-big, off);
  ctx.lineTo(big, off);
  ctx.lineWidth = Math.max(1, r * 0.028);
  ctx.strokeStyle = AMBER_HI;
  ctx.stroke();

  // Pitch ladder, every 5°, numbered every 10°.
  ctx.strokeStyle = 'rgba(255, 228, 185, 0.9)';
  ctx.lineWidth = Math.max(1, r * 0.018);
  for (let p = -30; p <= 30; p += 5) {
    if (p === 0) continue;
    const y = off - p * DEG * ppr;
    if (Math.abs(y) > ri * 1.1) continue;
    const hw = p % 10 === 0 ? r * 0.26 : r * 0.12;
    ctx.beginPath();
    ctx.moveTo(-hw, y);
    ctx.lineTo(hw, y);
    ctx.stroke();
    if (p % 10 === 0) {
      const lbl = String(Math.abs(p));
      text(ctx, lbl, -hw - r * 0.11, y, r * 0.11, 'rgba(255,228,185,0.9)', 700);
      text(ctx, lbl, hw + r * 0.11, y, r * 0.11, 'rgba(255,228,185,0.9)', 700);
    }
  }

  // Bank pointer on the ball.
  ctx.beginPath();
  ctx.moveTo(0, -ri * 0.85);
  ctx.lineTo(-r * 0.065, -ri * 0.73);
  ctx.lineTo(r * 0.065, -ri * 0.73);
  ctx.closePath();
  ctx.fillStyle = AMBER;
  ctx.fill();
  ctx.restore();

  // Fixed bank scale on the case.
  ctx.save();
  glowOn(ctx, r);
  ctx.lineCap = 'round';
  for (const b of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const a = -Math.PI / 2 + b * DEG;
    const ab = Math.abs(b);
    ctx.beginPath();
    tick(ctx, cx, cy, a, ab === 30 || ab === 60 ? ri * 0.84 : ri * 0.89, ri * 0.97);
    ctx.lineWidth = Math.max(1, r * (ab === 30 || ab === 60 ? 0.035 : 0.022));
    ctx.strokeStyle = AMBER_HI;
    ctx.stroke();
  }
  // Fixed index at the top.
  ctx.beginPath();
  ctx.moveTo(cx, cy - ri * 0.87);
  ctx.lineTo(cx - r * 0.07, cy - ri * 0.99);
  ctx.lineTo(cx + r * 0.07, cy - ri * 0.99);
  ctx.closePath();
  ctx.fillStyle = AMBER_HI;
  ctx.fill();

  // Fixed miniature aircraft.
  ctx.translate(cx, cy);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const wings = () => {
    ctx.beginPath();
    ctx.moveTo(-r * 0.6, 0);
    ctx.lineTo(-r * 0.22, 0);
    ctx.lineTo(-r * 0.12, r * 0.1);
    ctx.moveTo(r * 0.6, 0);
    ctx.lineTo(r * 0.22, 0);
    ctx.lineTo(r * 0.12, r * 0.1);
  };
  glowOff(ctx);
  wings();
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineWidth = r * 0.09;
  ctx.stroke();
  glowOn(ctx, r);
  wings();
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = r * 0.05;
  ctx.stroke();
  circle(ctx, 0, 0, r * 0.04);
  ctx.fillStyle = AMBER;
  ctx.fill();
  ctx.restore();
  drawGlass(ctx, cx, cy, r);
}

/** One rolling digit drum (value may be fractional; it scrolls between digits). */
function drumDigit(ctx, x, y, w, h, value, size, color) {
  const d = ((Math.floor(value) % 10) + 10) % 10;
  const frac = value - Math.floor(value);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const mid = y + h / 2;
  text(ctx, String(d), x + w / 2, mid - frac * h, size, color, 700);
  text(ctx, String((d + 1) % 10), x + w / 2, mid + (1 - frac) * h, size, color, 700);
  ctx.restore();
}

/** Altimeter: hundreds needle, thousands hand, and a rolling drum readout. */
function drawAltimeter(ctx, cx, cy, r, ft) {
  drawCase(ctx, cx, cy, r, 'ALT');
  const show = Math.max(0, ft);
  const A0 = -Math.PI / 2;

  ctx.save();
  glowOn(ctx, r);
  for (let i = 0; i < 50; i++) {
    const major = i % 5 === 0;
    ctx.beginPath();
    tick(ctx, cx, cy, A0 + (i / 50) * TAU, major ? r * 0.77 : r * 0.85, r * 0.93);
    ctx.lineWidth = Math.max(1, r * (major ? 0.03 : 0.014));
    ctx.strokeStyle = major ? AMBER_HI : AMBER_DIM;
    ctx.stroke();
  }
  for (let i = 0; i < 10; i++) {
    const a = A0 + (i / 10) * TAU;
    text(ctx, String(i), cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62, r * 0.18, AMBER);
  }
  text(ctx, 'FEET', cx, cy - r * 0.3, r * 0.1, AMBER_DIM, 700);

  // Drum window: thousands drums roll only as the hundreds drum passes 9 → 0.
  const ww = r * 0.66;
  const wh = r * 0.22;
  const wx = cx - ww / 2;
  const wy = cy + r * 0.24;
  glowOff(ctx);
  rrect(ctx, wx - r * 0.02, wy - r * 0.02, ww + r * 0.04, wh + r * 0.04, r * 0.04);
  ctx.fillStyle = '#2b2b30';
  ctx.fill();
  rrect(ctx, wx, wy, ww, wh, r * 0.03);
  ctx.fillStyle = '#050403';
  ctx.fill();
  glowOn(ctx, r);
  const hundreds = show / 100;
  const hFrac = hundreds % 10;
  const carry = hFrac > 9 ? hFrac - 9 : 0;
  const thousands = Math.floor(show / 1000);
  const tens = thousands % 10;
  const tenThousands = Math.floor(thousands / 10) + (tens === 9 ? carry : 0);
  const cw = ww / 5;
  const ds = r * 0.17;
  drumDigit(ctx, wx, wy, cw, wh, tenThousands, ds, AMBER_HI);
  drumDigit(ctx, wx + cw, wy, cw, wh, thousands + carry, ds, AMBER_HI);
  drumDigit(ctx, wx + cw * 2, wy, cw, wh, hundreds, ds, AMBER_HI);
  text(ctx, '00', wx + cw * 3.75, wy + wh / 2, r * 0.12, AMBER_DIM, 700);
  glowOff(ctx);

  // Thousands hand (short, broad) then hundreds needle (long).
  needle(ctx, cx, cy, A0 + ((show % 10000) / 10000) * TAU, r * 0.5, r * 0.11, AMBER, r * 0.1);
  needle(ctx, cx, cy, A0 + ((show % 1000) / 1000) * TAU, r * 0.86, r * 0.065, AMBER_HI, r * 0.16);
  hubCap(ctx, cx, cy, r * 0.09);
  ctx.restore();
  drawGlass(ctx, cx, cy, r);
}

/** Heading indicator: rotating compass card under a fixed lubber line. */
function drawHeading(ctx, cx, cy, r, headingRad) {
  drawCase(ctx, cx, cy, r, 'HDG');
  const hdgDeg = ((headingRad / DEG) % 360 + 360) % 360;

  ctx.save();
  glowOn(ctx, r);
  ctx.translate(cx, cy);
  ctx.rotate(-hdgDeg * DEG);
  for (let d = 0; d < 360; d += 5) {
    const major = d % 10 === 0;
    const a = -Math.PI / 2 + d * DEG;
    ctx.beginPath();
    tick(ctx, 0, 0, a, major ? r * 0.76 : r * 0.84, r * 0.92);
    ctx.lineWidth = Math.max(1, r * (major ? 0.026 : 0.014));
    ctx.strokeStyle = major ? AMBER_HI : AMBER_DIM;
    ctx.stroke();
  }
  const card = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let d = 0; d < 360; d += 30) {
    ctx.save();
    ctx.rotate(d * DEG);
    const lbl = card[d] || String(d / 10);
    const cardinal = !!card[d];
    text(ctx, lbl, 0, -r * 0.6, r * (cardinal ? 0.2 : 0.15), d === 0 ? AMBER_HI : AMBER, cardinal ? 800 : 600);
    ctx.restore();
  }
  ctx.restore();

  ctx.save();
  // Fixed 45° reference marks on the bezel.
  ctx.lineCap = 'round';
  for (let k = 1; k < 8; k++) {
    if (k === 4) continue;
    ctx.beginPath();
    tick(ctx, cx, cy, -Math.PI / 2 + k * 45 * DEG, r * 0.94, r * 1.0);
    ctx.lineWidth = Math.max(1, r * 0.03);
    ctx.strokeStyle = 'rgba(255,215,150,0.7)';
    ctx.stroke();
  }
  glowOn(ctx, r);
  // Lubber line.
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.74);
  ctx.lineTo(cx - r * 0.07, cy - r * 0.98);
  ctx.lineTo(cx + r * 0.07, cy - r * 0.98);
  ctx.closePath();
  ctx.fillStyle = AMBER_HI;
  ctx.fill();
  // Fixed aircraft silhouette pointing up.
  ctx.translate(cx, cy);
  const s = r * 0.32;
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(s * 0.1, -s * 0.55);
  ctx.lineTo(s * 0.1, -s * 0.15);
  ctx.lineTo(s * 0.85, s * 0.05);
  ctx.lineTo(s * 0.85, s * 0.2);
  ctx.lineTo(s * 0.1, s * 0.12);
  ctx.lineTo(s * 0.08, s * 0.6);
  ctx.lineTo(s * 0.32, s * 0.75);
  ctx.lineTo(s * 0.32, s * 0.87);
  ctx.lineTo(0, s * 0.8);
  ctx.lineTo(-s * 0.32, s * 0.87);
  ctx.lineTo(-s * 0.32, s * 0.75);
  ctx.lineTo(-s * 0.08, s * 0.6);
  ctx.lineTo(-s * 0.1, s * 0.12);
  ctx.lineTo(-s * 0.85, s * 0.2);
  ctx.lineTo(-s * 0.85, s * 0.05);
  ctx.lineTo(-s * 0.1, -s * 0.15);
  ctx.lineTo(-s * 0.1, -s * 0.55);
  ctx.closePath();
  ctx.fillStyle = AMBER;
  ctx.fill();
  ctx.restore();
  drawGlass(ctx, cx, cy, r);
}

/** Vertical speed indicator: ±2000 fpm, zero at 9 o'clock, climb clockwise. */
function drawVSI(ctx, cx, cy, r, fpm) {
  drawCase(ctx, cx, cy, r, 'VSI');
  const MAX = 2000;
  const ang = (v) => Math.PI + (clamp(v, -MAX, MAX) / MAX) * 0.94 * Math.PI;

  ctx.save();
  glowOn(ctx, r);
  for (let v = -MAX; v <= MAX; v += 100) {
    const major = v % 500 === 0;
    ctx.beginPath();
    tick(ctx, cx, cy, ang(v), major ? r * 0.76 : r * 0.85, r * 0.93);
    ctx.lineWidth = Math.max(1, r * (major ? 0.03 : 0.014));
    ctx.strokeStyle = major ? AMBER_HI : AMBER_DIM;
    ctx.stroke();
  }
  for (let v = -MAX; v <= MAX; v += 500) {
    const a = ang(v);
    const lbl = v === 0 ? '0' : String(Math.abs(v) / 100);
    text(ctx, lbl, cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6, r * 0.16, AMBER);
  }
  text(ctx, 'UP', cx - r * 0.3, cy - r * 0.3, r * 0.11, AMBER_DIM, 700);
  text(ctx, 'DN', cx - r * 0.3, cy + r * 0.3, r * 0.11, AMBER_DIM, 700);
  text(ctx, 'VERT SPEED', cx + r * 0.1, cy - r * 0.08, r * 0.085, AMBER_DIM, 700);
  text(ctx, '100 FT/MIN', cx + r * 0.1, cy + r * 0.08, r * 0.085, AMBER_DIM, 700);
  glowOff(ctx);

  needle(ctx, cx, cy, ang(fpm), r * 0.86, r * 0.07, AMBER_HI, r * 0.18);
  hubCap(ctx, cx, cy, r * 0.09);
  ctx.restore();
  drawGlass(ctx, cx, cy, r);
}

/** Combined tachometer (upper arc) and fuel gauge (lower sub-dial). */
function drawEngineCluster(ctx, cx, cy, r, rpm, fuel, blinkOn) {
  drawCase(ctx, cx, cy, r, 'RPM · FUEL');

  // Tachometer: 0–3000 rpm over the upper 220°, pivot slightly above centre.
  const tcx = cx;
  const tcy = cy + r * 0.08;
  const tr = r * 0.84;
  const TA0 = 160 * DEG;
  const TSW = 220 * DEG;
  const tAng = (v) => TA0 + (clamp(v, 0, RPM_MAX) / RPM_MAX) * TSW;

  ctx.save();
  arcBand(ctx, tcx, tcy, tr * 0.97, r * 0.06, tAng(2100), tAng(2600), GREEN);
  glowOn(ctx, r);
  for (let v = 0; v <= RPM_MAX; v += 100) {
    const major = v % 500 === 0;
    ctx.beginPath();
    tick(ctx, tcx, tcy, tAng(v), major ? tr * 0.86 : tr * 0.93, tr * 1.03);
    ctx.lineWidth = Math.max(1, r * (major ? 0.028 : 0.013));
    ctx.strokeStyle = major ? AMBER_HI : AMBER_DIM;
    ctx.stroke();
  }
  for (let v = 0; v <= RPM_MAX; v += 500) {
    const a = tAng(v);
    text(ctx, String(v / 100), tcx + Math.cos(a) * tr * 0.7, tcy + Math.sin(a) * tr * 0.7, r * 0.13, AMBER);
  }
  ctx.beginPath();
  tick(ctx, tcx, tcy, tAng(RPM_REDLINE), tr * 0.8, tr * 1.08);
  ctx.lineWidth = Math.max(1.5, r * 0.04);
  ctx.strokeStyle = RED;
  ctx.stroke();
  text(ctx, 'RPM', tcx, tcy - r * 0.32, r * 0.12, AMBER, 700);
  text(ctx, '×100', tcx, tcy - r * 0.18, r * 0.08, AMBER_DIM, 700);

  // Fuel sub-dial: E (left) to F (right) across the top of a small arc.
  const fcx = cx;
  const fcy = cy + r * 0.66;
  const fr = r * 0.34;
  const FA0 = 215 * DEG;
  const FSW = 110 * DEG;
  const fAng = (f) => FA0 + clamp(f, 0, 1) * FSW;
  glowOff(ctx);
  arcBand(ctx, fcx, fcy, fr, r * 0.045, fAng(0), fAng(FLIGHT_CONSTANTS.LOW_FUEL), RED);
  glowOn(ctx, r);
  for (let i = 0; i <= 8; i++) {
    const major = i % 4 === 0;
    ctx.beginPath();
    tick(ctx, fcx, fcy, fAng(i / 8), major ? fr * 0.78 : fr * 0.88, fr * 1.06);
    ctx.lineWidth = Math.max(1, r * (major ? 0.025 : 0.013));
    ctx.strokeStyle = major ? AMBER_HI : AMBER_DIM;
    ctx.stroke();
  }
  const low = fuel < FLIGHT_CONSTANTS.LOW_FUEL;
  const fuelColor = low && blinkOn ? RED : AMBER;
  text(ctx, 'E', fcx + Math.cos(fAng(0)) * fr * 1.32, fcy + Math.sin(fAng(0)) * fr * 1.32, r * 0.12, low ? RED : AMBER, 800);
  text(ctx, 'F', fcx + Math.cos(fAng(1)) * fr * 1.32, fcy + Math.sin(fAng(1)) * fr * 1.32, r * 0.12, AMBER, 800);
  text(ctx, 'FUEL', fcx, fcy - fr * 0.3, r * 0.09, fuelColor, 700);
  glowOff(ctx);

  needle(ctx, fcx, fcy, fAng(fuel), fr * 1.0, r * 0.05, AMBER_HI, fr * 0.15);
  hubCap(ctx, fcx, fcy, r * 0.06);
  needle(ctx, tcx, tcy, tAng(rpm), tr * 0.92, r * 0.065, AMBER_HI, r * 0.14);
  hubCap(ctx, tcx, tcy, r * 0.085);
  ctx.restore();
  drawGlass(ctx, cx, cy, r);
}

function annunciator(ctx, x, y, w, h, label, on, color) {
  ctx.save();
  rrect(ctx, x - w / 2 - 2, y - h / 2 - 2, w + 4, h + 4, h * 0.2);
  ctx.fillStyle = '#2a2b30';
  ctx.fill();
  rrect(ctx, x - w / 2, y - h / 2, w, h, h * 0.15);
  if (on) {
    ctx.shadowColor = color;
    ctx.shadowBlur = h * 0.9;
    ctx.fillStyle = color;
  } else {
    ctx.fillStyle = '#17120d';
  }
  ctx.fill();
  glowOff(ctx);
  text(ctx, label, x, y + 0.5, h * 0.52, on ? '#1a0b00' : 'rgba(255,190,120,0.22)', 800);
  ctx.restore();
}

// ---- Cockpit ----------------------------------------------------------------

export class Cockpit {
  constructor() {
    this._yokePitch = 0;  // smoothed, −1 (push) .. 1 (pull)
    this._yokeRoll = 0;   // smoothed, −1 (left) .. 1 (right)
    this._rpm = 0;
    this._prev = null;    // { pitch, roll, time } from the last frame
    this._lastT = null;
    this._controls = null;
  }

  /** Optional: feed the true control inputs (−1..1) instead of estimating them. */
  setControls(pitch, roll) {
    this._controls = { pitch: num(pitch), roll: num(roll) };
  }

  /** Smoothed engine RPM as shown on the tachometer. */
  get rpm() {
    return this._rpm;
  }

  draw(ctx, flight, width, height) {
    if (!ctx || !flight || !(width > 0) || !(height > 0)) return;

    const now = nowSec();
    const dt = this._lastT === null ? 0 : clamp(now - this._lastT, 0, 0.25);
    this._lastT = now;
    this._update(flight, dt);

    const w = width;
    const h = height;
    const panelH = h / 3;
    const panelTop = h - panelH;

    ctx.save();
    glowOff(ctx);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.setLineDash?.([]);

    this._drawFrame(ctx, w, h, panelTop);
    this._drawPanel(ctx, w, h, panelTop);

    // Instrument layout: three left, a centre gap for the yoke column, three right.
    const slotW = Math.min((w * 0.94) / 7, panelH * 0.8);
    const r = Math.min(slotW * 0.42, panelH * 0.3);
    const rowY = panelTop + panelH * 0.44;
    const cx = w / 2;

    const pos = num(flight.position?.y);
    const kt = Math.max(0, num(flight.speed)) * MS_TO_KT;
    const fuel = clamp(num(flight.fuel, 1), 0, 1);
    const blinkOn = Math.floor(now * 2.5) % 2 === 0;

    drawASI(ctx, cx - slotW * 3, rowY, r, kt);
    drawAttitude(ctx, cx - slotW * 2, rowY, r, num(flight.pitch), num(flight.roll));
    drawAltimeter(ctx, cx - slotW, rowY, r, pos * M_TO_FT);
    drawHeading(ctx, cx + slotW, rowY, r, num(flight.heading));
    drawVSI(ctx, cx + slotW * 2, rowY, r, num(flight.verticalSpeed) * MS_TO_FPM);
    drawEngineCluster(ctx, cx + slotW * 3, rowY, r, this._rpm, fuel, blinkOn);

    // Warning lights in the centre gap.
    const aw = slotW * 0.62;
    const ah = Math.max(9, r * 0.24);
    const stallOn = !!flight.stalled && !flight.onGround && !flight.crashed;
    annunciator(ctx, cx, rowY - r * 0.55, aw, ah, 'STALL', stallOn && blinkOn, RED);
    annunciator(ctx, cx, rowY - r * 0.55 + ah * 1.5, aw, ah, 'LOW FUEL', fuel < FLIGHT_CONSTANTS.LOW_FUEL && (fuel > 0 || blinkOn), AMBER);

    this._drawYoke(ctx, w, h, panelH, slotW);
    ctx.restore();
  }

  // ---- State --------------------------------------------------------------

  _update(flight, dt) {
    const pitch = num(flight.pitch);
    const roll = num(flight.roll);
    const time = num(flight.time);
    const prev = this._prev;
    let target = null;

    const c = this._controls || flight.controls;
    if (c && (Number.isFinite(c.pitch) || Number.isFinite(c.roll))) {
      target = { pitch: clamp(num(c.pitch), -1, 1), roll: clamp(num(c.roll), -1, 1) };
    } else if (prev && time > prev.time && time - prev.time < 0.5) {
      // Invert the flight model's attitude rates back into stick inputs.
      const st = time - prev.time;
      const ratio = Math.max(0, num(flight.speed)) / FLIGHT_CONSTANTS.STALL_SPEED;
      const authority = clamp(ratio, 0.3, 1);
      const lift = clamp(num(flight.liftFactor, 1), 0, 1);
      if (flight.onGround || flight.crashed) {
        target = { pitch: 0, roll: 0 };
      } else {
        const pRate = (pitch - prev.pitch) / st + STALL_NOSE_DROP * (1 - lift);
        const rRate = (roll - prev.roll) / st;
        target = {
          pitch: clamp(pRate / (PITCH_RATE * authority), -1, 1),
          roll: clamp(rRate / (ROLL_RATE * authority), -1, 1),
        };
      }
    } else if (prev && time < prev.time) {
      target = { pitch: 0, roll: 0 }; // reset
    }
    // else: paused — hold the yoke where it is.
    this._prev = { pitch, roll, time };

    if (target) {
      const k = dt > 0 ? 1 - Math.exp(-dt * 12) : 1;
      this._yokePitch += (target.pitch - this._yokePitch) * k;
      this._yokeRoll += (target.roll - this._yokeRoll) * k;
    }

    // Engine RPM: follows throttle, plus some windmilling with airspeed.
    const thr = clamp(num(flight.throttle), 0, 1);
    const spd = Math.max(0, num(flight.speed));
    const fuel = num(flight.fuel, 1);
    let rpmTarget;
    if (flight.crashed) rpmTarget = 0;
    else if (fuel > 0) rpmTarget = 600 + 1800 * thr + spd * 3;
    else rpmTarget = Math.min(900, spd * 9);
    rpmTarget = clamp(rpmTarget, 0, RPM_MAX - 50);
    const kr = dt > 0 ? 1 - Math.exp(-dt * 3) : 1;
    this._rpm += (rpmTarget - this._rpm) * kr;
  }

  // ---- Structure ----------------------------------------------------------

  _drawFrame(ctx, w, h, panelTop) {
    // Canopy header bar.
    const hh = h * 0.018;
    let g = ctx.createLinearGradient(0, 0, 0, hh);
    g.addColorStop(0, '#0a0a0b');
    g.addColorStop(1, '#1c1d21');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, hh);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, hh - 1, w, 1);

    // Side pillars, slanting inward towards the coaming.
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? 0 : w;
      const topIn = x0 - side * w * 0.05;
      const botIn = x0 - side * w * 0.11;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(topIn, 0);
      ctx.lineTo(botIn, panelTop + 4);
      ctx.lineTo(x0, panelTop + 4);
      ctx.closePath();
      g = ctx.createLinearGradient(x0, 0, botIn, 0);
      g.addColorStop(0, '#08080a');
      g.addColorStop(0.75, '#1a1b1f');
      g.addColorStop(1, '#25262b');
      ctx.fillStyle = g;
      ctx.fill();
      // Rubber seal and a faint edge highlight along the glass.
      ctx.beginPath();
      ctx.moveTo(topIn, 0);
      ctx.lineTo(botIn, panelTop + 4);
      ctx.lineWidth = Math.max(2, w * 0.004);
      ctx.strokeStyle = '#050505';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(topIn - side * 2, 0);
      ctx.lineTo(botIn - side * 2, panelTop + 4);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.stroke();
    }
  }

  _drawPanel(ctx, w, h, panelTop) {
    const bulge = h * 0.06; // quadratic control offset → peak rises by bulge / 2
    const body = () => {
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, panelTop);
      ctx.quadraticCurveTo(w / 2, panelTop - bulge, w, panelTop);
      ctx.lineTo(w, h);
      ctx.closePath();
    };

    body();
    let g = ctx.createLinearGradient(0, panelTop - bulge / 2, 0, h);
    g.addColorStop(0, '#1f2024');
    g.addColorStop(0.35, '#131417');
    g.addColorStop(1, '#070708');
    ctx.fillStyle = g;
    ctx.fill();

    // Shadow cast by the glareshield onto the upper panel.
    body();
    g = ctx.createLinearGradient(0, panelTop - bulge / 2, 0, panelTop + (h - panelTop) * 0.28);
    g.addColorStop(0, 'rgba(0,0,0,0.6)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fill();

    // Padded coaming lip with a soft top highlight.
    const th = h * 0.024;
    ctx.beginPath();
    ctx.moveTo(0, panelTop);
    ctx.quadraticCurveTo(w / 2, panelTop - bulge, w, panelTop);
    ctx.lineWidth = th;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = '#0b0b0d';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, panelTop - th * 0.42);
    ctx.quadraticCurveTo(w / 2, panelTop - bulge - th * 0.42, w, panelTop - th * 0.42);
    ctx.lineWidth = Math.max(1, th * 0.14);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.stroke();

    // Panel corner screws.
    const sr = Math.max(2, h * 0.006);
    const inset = Math.max(10, w * 0.015);
    screw(ctx, inset, h - inset, sr, 0.4);
    screw(ctx, w - inset, h - inset, sr, 1.1);
    screw(ctx, inset, panelTop + th * 1.4, sr, 2.0);
    screw(ctx, w - inset, panelTop + th * 1.4, sr, 0.9);
  }

  _drawYoke(ctx, w, h, panelH, slotW) {
    const pin = clamp(this._yokePitch, -1, 1); // pull (nose up) → yoke comes towards the eye
    const rin = clamp(this._yokeRoll, -1, 1);
    const s = 1 + pin * 0.1;
    const cx = w / 2;
    const cy = h - panelH * 0.1 + pin * panelH * 0.07;
    const half = slotW * 0.62 * s;

    ctx.save();
    // Control column disappearing into the panel through a boot.
    const entryY = h - panelH * 0.42;
    const cw0 = slotW * 0.11 * s;
    const cw1 = slotW * 0.075;
    let g = ctx.createLinearGradient(cx - cw0, 0, cx + cw0, 0);
    g.addColorStop(0, '#0d0d0f');
    g.addColorStop(0.45, '#3a3b40');
    g.addColorStop(1, '#0d0d0f');
    ctx.beginPath();
    ctx.moveTo(cx - cw1 / 2, entryY);
    ctx.lineTo(cx + cw1 / 2, entryY);
    ctx.lineTo(cx + cw0 / 2, cy);
    ctx.lineTo(cx - cw0 / 2, cy);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx, entryY, cw1 * 1.1, cw1 * 0.45, 0, 0, TAU);
    ctx.fillStyle = '#060607';
    ctx.fill();

    // Yoke wheel (ram's-horn), rotated with roll input.
    ctx.translate(cx, cy);
    ctx.rotate(rin * 0.45);
    const lw = half * 0.17;
    const horns = () => {
      ctx.beginPath();
      ctx.moveTo(-half, -half * 0.5);
      ctx.lineTo(-half, -half * 0.05);
      ctx.quadraticCurveTo(-half, half * 0.14, -half * 0.7, half * 0.14);
      ctx.lineTo(half * 0.7, half * 0.14);
      ctx.quadraticCurveTo(half, half * 0.14, half, -half * 0.05);
      ctx.lineTo(half, -half * 0.5);
    };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = lw;
    ctx.shadowOffsetY = lw * 0.4;
    horns();
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#141416';
    ctx.stroke();
    glowOff(ctx);
    ctx.save();
    ctx.translate(0, -lw * 0.22);
    horns();
    ctx.lineWidth = lw * 0.25;
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.stroke();
    ctx.restore();

    // Rubber grips with a push-to-talk button.
    for (const side of [-1, 1]) {
      const gx = side * half;
      rrect(ctx, gx - lw * 0.68, -half * 0.56, lw * 1.36, half * 0.5, lw * 0.6);
      g = ctx.createLinearGradient(gx - lw, 0, gx + lw, 0);
      g.addColorStop(0, '#060607');
      g.addColorStop(0.5, '#26262a');
      g.addColorStop(1, '#060607');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 5; i++) {
        const y = -half * 0.56 + (half * 0.5 * i) / 5;
        ctx.beginPath();
        ctx.moveTo(gx - lw * 0.55, y);
        ctx.lineTo(gx + lw * 0.55, y);
        ctx.stroke();
      }
      circle(ctx, gx, -half * 0.6, lw * 0.22);
      ctx.fillStyle = side < 0 ? '#7a1a12' : '#2a2a2e';
      ctx.fill();
    }

    // Centre hub with an amber-lit emblem.
    const hw = half * 0.46;
    const hh = half * 0.3;
    rrect(ctx, -hw / 2, half * 0.14 - hh / 2, hw, hh, hh * 0.3);
    g = ctx.createLinearGradient(0, half * 0.14 - hh / 2, 0, half * 0.14 + hh / 2);
    g.addColorStop(0, '#34353a');
    g.addColorStop(1, '#0d0d0f');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.shadowColor = GLOW;
    ctx.shadowBlur = hh * 0.3;
    text(ctx, 'CLOUDHAVEN', 0, half * 0.14, hh * 0.26, AMBER_DIM, 800);
    ctx.restore();
  }
}
