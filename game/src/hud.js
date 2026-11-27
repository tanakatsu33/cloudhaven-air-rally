// Cloudhaven Air Rally — 2D heads-up display, painted over the 3D scene.
//
// hud.draw(ctx, flight, mission, view, targetInfo)
//   ctx        CanvasRenderingContext2D (already scaled so 1 unit = 1 CSS pixel)
//   flight     FlightModel
//   mission    Mission
//   view       { width, height, time? }  CSS-pixel size; time (s) drives flashing
//              (falls back to ctx.canvas size and performance.now()).
//   targetInfo { onScreen, angle, distance?, bearing? } or null
//              onScreen  true if mission.nextTarget() projects inside the viewport
//              angle     when off-screen: screen-space direction from the screen
//                        centre to the target, radians, Math.atan2(dy, dx) with
//                        y down (0 = right, +π/2 = down)
//              distance  optional metres, shown under the arrow
//              bearing   optional world bearing to the target (radians, 0 = north),
//                        marked on the compass ribbon
//
// Units: ALT feet (MSL), IAS knots, HDG degrees, VS feet per minute.

import { FLIGHT_CONSTANTS } from './flight-model.js';

const M_TO_FT = 3.28084;
const MS_TO_KT = 1.943844;
const MS_TO_FPM = 196.8504;
const DEG = 180 / Math.PI;

const WHITE = '#f4f6f8';
const AMBER = '#ffb627';
const GOLD = '#ffd24a';
const RED = '#ff4a3d';
const GREEN = '#6ee07a';
const DIM = 'rgba(244,246,248,0.55)';
const BACK = 'rgba(8,12,18,0.58)';
const EDGE = 'rgba(255,255,255,0.14)';

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const font = (px, weight = 'bold') => `${weight} ${px}px ${MONO}`;

const STALL_WARN_SPEED = FLIGHT_CONSTANTS.STALL_SPEED * 1.12; // m/s
const LOW_FUEL = FLIGHT_CONSTANTS.LOW_FUEL; // shared with the cockpit gauge
const LOW_TIME = 30;           // s — timer turns red and flashes
const MESSAGE_SECONDS = 2.5;   // mission pop-up duration

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const pad = (n, w) => String(n).padStart(w, '0');

export class Hud {
  constructor(options = {}) {
    this.margin = options.margin ?? 16;
  }

  draw(ctx, flight, mission, view = {}, targetInfo = null) {
    const W = view.width ?? ctx.canvas.clientWidth ?? ctx.canvas.width;
    const H = view.height ?? ctx.canvas.clientHeight ?? ctx.canvas.height;
    const t = view.time ?? performance.now() / 1000;
    const s = clamp(Math.min(W / 1280, H / 720), 0.7, 1.4); // UI scale

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    this._readouts(ctx, flight, s);
    this._compass(ctx, flight, W, s, targetInfo);
    this._bars(ctx, flight, H, s);
    if (mission) this._missionPanel(ctx, mission, W, H, s, t);
    this._warnings(ctx, flight, W, H, s, t);
    if (mission && targetInfo && !targetInfo.onScreen && Number.isFinite(targetInfo.angle) &&
        mission.state === 'running') {
      this._edgeArrow(ctx, mission, targetInfo, W, H, s, t);
    }
    if (mission) {
      this._messages(ctx, mission, W, H, s);
      if (mission.state !== 'running') this._resultPanel(ctx, mission, flight, W, H, s);
    }
    ctx.restore();
  }

  // ---- Top-left digital readouts --------------------------------------------------
  _readouts(ctx, f, s) {
    const m = this.margin;
    const rowH = Math.round(30 * s), w = Math.round(196 * s);
    const vsFpm = Math.round(f.verticalSpeed * MS_TO_FPM / 10) * 10;
    const rows = [
      ['ALT', String(Math.round(f.position.y * M_TO_FT)).padStart(5), 'FT'],
      ['IAS', String(Math.round(f.speed * MS_TO_KT)).padStart(5), 'KT'],
      ['HDG', pad(Math.round(f.heading * DEG) % 360, 3).padStart(5), '°'],
      ['VS', ((vsFpm > 0 ? '+' : vsFpm < 0 ? '−' : ' ') + Math.abs(vsFpm)).padStart(6), 'FPM'],
    ];
    panel(ctx, m, m, w, rowH * rows.length + 12 * s);
    rows.forEach(([label, value, unit], i) => {
      const y = m + 6 * s + rowH * (i + 0.5);
      text(ctx, label, m + 12 * s, y, AMBER, font(13 * s), 'left');
      text(ctx, value, m + 136 * s, y, WHITE, font(22 * s), 'right');
      text(ctx, unit, m + 142 * s, y, DIM, font(12 * s), 'left');
    });
  }

  // ---- Compass ribbon -------------------------------------------------------------
  _compass(ctx, f, W, s, targetInfo) {
    const w = Math.round(Math.min(520 * s, W * 0.42)), h = Math.round(38 * s);
    const x0 = Math.round((W - w) / 2), y0 = this.margin;
    const span = 90;                         // degrees visible across the ribbon
    const pxPerDeg = w / span;
    const hdg = ((f.heading * DEG) % 360 + 360) % 360;

    panel(ctx, x0, y0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.clip();
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = Math.max(1, s);
    const first = Math.ceil((hdg - span / 2) / 5) * 5;
    for (let d = first; d <= hdg + span / 2; d += 5) {
      const x = Math.round(x0 + w / 2 + (d - hdg) * pxPerDeg) + 0.5;
      const major = d % 30 === 0, mid = d % 10 === 0;
      const len = major ? 11 * s : mid ? 7 * s : 4 * s;
      ctx.globalAlpha = major ? 1 : 0.6;
      ctx.beginPath();
      ctx.moveTo(x, y0 + h - len);
      ctx.lineTo(x, y0 + h);
      ctx.stroke();
      if (major) {
        const n = ((d % 360) + 360) % 360;
        const lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[n] ?? pad(n / 10, 2);
        text(ctx, lbl, x, y0 + 12 * s, lbl.length === 1 ? AMBER : WHITE, font(13 * s), 'center');
      }
    }
    ctx.globalAlpha = 1;
    // Target bearing caret (optional).
    if (targetInfo && Number.isFinite(targetInfo.bearing)) {
      let d = ((targetInfo.bearing * DEG - hdg) % 360 + 540) % 360 - 180;
      const clamped = Math.abs(d) > span / 2 - 2;
      d = clamp(d, -span / 2 + 2, span / 2 - 2);
      const x = x0 + w / 2 + d * pxPerDeg;
      ctx.fillStyle = clamped ? 'rgba(110,224,122,0.6)' : GREEN;
      tri(ctx, x, y0 + h - 2 * s, 6 * s, -Math.PI / 2);
    }
    ctx.restore();

    // Centre marker and heading box.
    ctx.fillStyle = AMBER;
    tri(ctx, x0 + w / 2, y0 + h + 1, 7 * s, -Math.PI / 2);
    const bw = 54 * s, bh = 22 * s, by = y0 + h + 9 * s;
    panel(ctx, x0 + w / 2 - bw / 2, by, bw, bh, AMBER);
    text(ctx, pad(Math.round(hdg) % 360, 3) + '°', x0 + w / 2, by + bh / 2, WHITE, font(16 * s), 'center');
  }

  // ---- Bottom-left fuel and throttle bars -----------------------------------------
  _bars(ctx, f, H, s) {
    const m = this.margin;
    const barW = 22 * s, barH = 120 * s, gap = 40 * s;
    const pw = barW * 2 + gap + 44 * s, ph = barH + 58 * s;
    const px = m, py = H - m - ph;
    panel(ctx, px, py, pw, ph);
    const fuelCol = f.fuel <= 0 ? RED : f.fuel < LOW_FUEL ? RED : f.fuel < LOW_FUEL * 2 ? AMBER : GREEN;
    const bars = [
      ['FUEL', f.fuel, fuelCol],
      ['THR', f.throttle, WHITE],
    ];
    bars.forEach(([label, v, col], i) => {
      const bx = px + 22 * s + i * (barW + gap), by = py + 24 * s;
      text(ctx, label, bx + barW / 2, py + 12 * s, AMBER, font(12 * s), 'center');
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(bx, by, barW, barH);
      const fh = barH * clamp(v, 0, 1);
      ctx.fillStyle = col;
      ctx.fillRect(bx, by + barH - fh, barW, fh);
      ctx.strokeStyle = EDGE;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(bx) + 0.5, Math.round(by) + 0.5, Math.round(barW), Math.round(barH));
      // quarter ticks
      ctx.fillStyle = 'rgba(8,12,18,0.7)';
      for (let q = 1; q < 4; q++) ctx.fillRect(bx, Math.round(by + barH * q / 4), barW * 0.35, Math.max(1, s));
      text(ctx, `${Math.round(clamp(v, 0, 1) * 100)}%`, bx + barW / 2, by + barH + 16 * s, WHITE, font(13 * s), 'center');
    });
  }

  // ---- Bottom-right mission panel -------------------------------------------------
  _missionPanel(ctx, mission, W, H, s, t) {
    const m = this.margin;
    const w = 236 * s, h = 100 * s;
    const x = W - m - w, y = H - m - h;
    panel(ctx, x, y, w, h);
    const lx = x + 12 * s, rx = x + w - 12 * s;

    text(ctx, 'SCORE', lx, y + 18 * s, AMBER, font(12 * s), 'left');
    text(ctx, String(Math.round(mission.score)).padStart(6, ' '), rx, y + 18 * s, WHITE, font(22 * s), 'right');

    const secs = Math.max(0, Math.ceil(mission.timer));
    const low = mission.state === 'running' && mission.timer < LOW_TIME;
    const timeCol = low ? (flash(t, 2) ? RED : WHITE) : WHITE;
    text(ctx, 'TIME', lx, y + 46 * s, AMBER, font(12 * s), 'left');
    text(ctx, `${Math.floor(secs / 60)}:${pad(secs % 60, 2)}`, rx, y + 46 * s, timeCol, font(22 * s), 'right');

    let objective, col = WHITE;
    if (mission.state === 'complete') { objective = 'MISSION COMPLETE'; col = GREEN; }
    else if (mission.state === 'failed') { objective = 'MISSION FAILED'; col = RED; }
    else if (mission.phase === 'landing') { objective = 'LAND ON THE RUNWAY'; col = flash(t, 1.2) ? AMBER : WHITE; }
    else {
      const total = mission.totalRings ?? mission.rings.length;
      objective = `RING ${Math.min(mission.currentRing + 1, total)}/${total}`;
    }
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x + 8 * s, y + 62 * s, w - 16 * s, 1);
    text(ctx, objective, x + w / 2, y + 81 * s, col, font(16 * s), 'center');
  }

  // ---- Stall / low-fuel warnings --------------------------------------------------
  _warnings(ctx, f, W, H, s, t) {
    const warns = [];
    if (!f.onGround && !f.crashed && (f.stalled || f.speed < STALL_WARN_SPEED)) {
      warns.push({ label: 'STALL', col: RED, on: flash(t, 3) });
    }
    if (!f.crashed && f.fuel < LOW_FUEL) {
      warns.push({ label: f.fuel <= 0 ? 'FUEL EMPTY' : 'LOW FUEL', col: AMBER, on: f.fuel <= 0 || flash(t, 1) });
    }
    let y = Math.round(H * 0.27);
    for (const w of warns) {
      ctx.font = font(26 * s);
      const tw = ctx.measureText(w.label).width + 36 * s, th = 40 * s;
      const x = W / 2 - tw / 2;
      if (w.on) {
        panel(ctx, x, y, tw, th, w.col, 'rgba(30,6,4,0.72)');
        text(ctx, w.label, W / 2, y + th / 2, w.col, font(26 * s), 'center');
      } else {
        panel(ctx, x, y, tw, th, 'rgba(255,255,255,0.1)', 'rgba(8,12,18,0.35)');
      }
      y += th + 8 * s;
    }
  }

  // ---- Off-screen target arrow ----------------------------------------------------
  _edgeArrow(ctx, mission, info, W, H, s, t) {
    const target = mission.nextTarget();
    const col = target && target.kind === 'landing' ? GREEN : AMBER;
    const inset = 56 * s;
    const cx = W / 2, cy = H / 2;
    const dx = Math.cos(info.angle), dy = Math.sin(info.angle);
    // Intersect the ray from the centre with the inset rectangle.
    const hx = W / 2 - inset, hy = H / 2 - inset;
    const k = Math.min(dx ? hx / Math.abs(dx) : Infinity, dy ? hy / Math.abs(dy) : Infinity);
    const x = cx + dx * k, y = cy + dy * k;
    const pulse = 1 + 0.12 * Math.sin(t * 6);

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 22 * s, 0, Math.PI * 2);
    ctx.fillStyle = BACK;
    ctx.fill();
    ctx.lineWidth = 1.5 * s;
    ctx.strokeStyle = col;
    ctx.stroke();
    ctx.fillStyle = col;
    tri(ctx, x + dx * 4 * s, y + dy * 4 * s, 13 * s * pulse, info.angle);
    ctx.restore();

    if (Number.isFinite(info.distance)) {
      const d = info.distance >= 1000 ? `${(info.distance / 1000).toFixed(1)} km` : `${Math.round(info.distance)} m`;
      // Put the label on the inward side of the arrow so it stays on screen.
      text(ctx, d, x - dx * 40 * s, y - dy * 34 * s, WHITE, font(13 * s), 'center', true);
    }
  }

  // ---- Event pop-up ---------------------------------------------------------------
  _messages(ctx, mission, W, H, s) {
    if (!mission.message || mission.state !== 'running') return; // result panel covers it
    const age = mission.elapsed - mission.messageTime;
    if (!(age >= 0 && age < MESSAGE_SECONDS)) return;
    const a = clamp((MESSAGE_SECONDS - age) / 0.5, 0, 1);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = font(20 * s);
    const tw = ctx.measureText(mission.message).width + 32 * s, th = 34 * s;
    const y = Math.round(H * 0.17);
    const gold = mission.message.startsWith('FUEL');
    panel(ctx, W / 2 - tw / 2, y, tw, th, gold ? GOLD : AMBER);
    text(ctx, mission.message, W / 2, y + th / 2, gold ? GOLD : WHITE, font(20 * s), 'center');
    ctx.restore();
  }

  // ---- Completion / failure panel -------------------------------------------------
  _resultPanel(ctx, mission, flight, W, H, s) {
    const complete = mission.state === 'complete';
    const lines = [];
    if (complete && mission.result) {
      const r = mission.result;
      if (mission.landing) {
        const l = mission.landing;
        lines.push([`${l.grade} LANDING`, `${Math.round(l.sink * MS_TO_FPM)} fpm  ${Math.round(l.speed * MS_TO_KT)} kt`]);
      }
      lines.push(['RINGS', r.ringPoints], ['FUEL RINGS', r.fuelPoints], ['TIME BONUS', r.timeBonus],
        ['LANDING', r.landingPoints], null, ['TOTAL', r.total]);
    } else {
      lines.push([mission.failReason || 'Mission failed', ''],
        ['RINGS', `${mission.ringsPassed}/${mission.totalRings ?? mission.rings.length}`], ['SCORE', mission.score]);
    }
    const w = 380 * s, rowH = 28 * s, h = 64 * s + rowH * lines.length;
    const x = W / 2 - w / 2, y = H / 2 - h / 2;
    panel(ctx, x, y, w, h, complete ? GREEN : RED, 'rgba(8,12,18,0.78)');
    text(ctx, complete ? 'MISSION COMPLETE' : 'MISSION FAILED', W / 2, y + 26 * s,
      complete ? GREEN : RED, font(24 * s), 'center');
    lines.forEach((ln, i) => {
      const ly = y + 60 * s + rowH * (i + 0.5);
      if (!ln) {
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect(x + 20 * s, ly, w - 40 * s, 1);
        return;
      }
      const total = ln[0] === 'TOTAL';
      text(ctx, String(ln[0]), x + 22 * s, ly, AMBER, font((total ? 16 : 14) * s), 'left');
      text(ctx, String(ln[1]), x + w - 22 * s, ly, WHITE, font((total ? 22 : 18) * s), 'right');
    });
  }
}

// ---- Drawing helpers --------------------------------------------------------------

function flash(t, hz) {
  return (t * hz) % 1 < 0.6;
}

function panel(ctx, x, y, w, h, stroke = EDGE, fill = BACK) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  const r = Math.min(6, h / 4);
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function text(ctx, str, x, y, color, f, align = 'left', shadow = false) {
  ctx.font = f;
  ctx.textAlign = align;
  if (shadow) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(str, Math.round(x), Math.round(y));
  }
  ctx.fillStyle = color;
  ctx.fillText(str, Math.round(x), Math.round(y));
}

/** Filled triangle centred at (x, y) pointing along angle (screen radians, 0 = right). */
function tri(ctx, x, y, size, angle) {
  const c = Math.cos(angle), sn = Math.sin(angle);
  const pt = (fx, fy) => [x + fx * c - fy * sn, y + fx * sn + fy * c];
  const [ax, ay] = pt(size, 0), [bx, by] = pt(-size * 0.7, size * 0.75), [qx, qy] = pt(-size * 0.7, -size * 0.75);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(qx, qy);
  ctx.closePath();
  ctx.fill();
}
