// Cloudhaven Air Rally — entry point.
//
// Boots the game on <canvas id="game">, owns the screen state machine
//   'title' → 'play' ⇄ 'paused' → 'over' (crash / out of time) | 'complete'
// and runs a fixed-step simulation (dt = 1/60, accumulator, clamped frame time)
// from requestAnimationFrame.
//
// Screenshot mode: ?shot=<name> stages a deterministic scene via shots.js and
// re-renders that frozen state every frame (no audio, no interactive input).

import { createIsland } from './island.js';
import { FlightModel } from './flight-model.js';
import { Mission } from './mission.js';
import { Input } from './input.js';
import { Renderer3D } from './renderer3d.js';
import { Hud } from './hud.js';
import { Cockpit } from './cockpit.js';
import { GameAudio } from './audio.js';
import { drawAircraft } from './aircraft3d.js';
import { stageShot } from './shots.js';

// ---- Tuning ---------------------------------------------------------------------
const DT = 1 / 60;               // fixed simulation step (s)
const MAX_FRAME = 0.25;          // clamp on real frame time (s) to avoid spirals
const MAX_DPR = 1.5;             // software renderer: cap the backing-store density

const BASE_FOCAL = 0.9;          // renderer default: focal = canvas height × this
const REF_ASPECT = 16 / 9;       // narrower windows widen the FOV to keep this horizontal view
const MAX_ASPECT = 2.4;          // wider windows stop widening the horizontal view
const MIN_FOCAL_FACTOR = 0.5;    // limit on widening for very tall windows

const CHASE_BACK = 18;           // m behind the plane, along its flight path
const CHASE_UP = 5.5;            // m above it
const CHASE_LOOK_DOWN = 0.12;    // rad: tilt so the plane sits a little below centre
const CHASE_PITCH_FOLLOW = 0.8;  // fraction of the plane's pitch the camera follows
const CHASE_ROLL = 0.3;          // fraction of the plane's roll the camera inherits
const CHASE_POS_RATE = 8;        // 1/s position smoothing
const CHASE_ANG_RATE = 5;        // 1/s angle smoothing
const CAMERA_CLEARANCE = 2;      // m above terrain / sea for the chase camera
const END_ORBIT_RATE = 0.06;     // rad/s slow camera drift round the frozen plane on end screens
const END_ORBIT_R = 22;          // m
const END_ORBIT_UP = 6;          // m

const EYE = { x: 0, y: 1.65, z: 0.15 }; // pilot's eye in the aircraft body frame (m)

const TITLE_ORBIT_R = 34;        // m
const TITLE_ORBIT_UP = 7;        // m
const TITLE_ORBIT_RATE = 0.07;   // rad/s
const TITLE_SHOT_ANGLE = 0.75;   // rad from the nose (front-right three-quarter)

const MESSAGE_SECONDS = 2.5;     // mission pop-up duration in the cockpit strip

const HORIZON = [204, 224, 238]; // renderer fog colour (for the gold fuel rings)
const FOG_START = 400, FOG_END = 4000 * 0.97;

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const SANS = '"Trebuchet MS", "Segoe UI", system-ui, -apple-system, sans-serif';
const WHITE = '#f4f6f8', AMBER = '#ffb627', GOLD = '#ffd24a', RED = '#ff4a3d', GREEN = '#6ee07a';
const DIM = 'rgba(244,246,248,0.6)';
const BACK = 'rgba(8,12,18,0.72)';
const M_TO_FT = 3.28084, MS_TO_KT = 1.943844, MS_TO_FPM = 196.8504;

const CRASH_TEXT = {
  water: 'Ditched in the sea',
  terrain: 'Flew into the terrain',
  'hard landing': 'Hard landing — sink rate too high',
  'too fast': 'Touched down too fast',
  'wing strike': 'Wing tip struck the runway',
  'nose first': 'Landed nose first',
};

const CONTROLS = [
  ['W / S', 'Throttle up / down'],
  ['↑ / ↓', 'Nose up / down'],
  ['← / →', 'Roll left / right'],
  ['A / D', 'Rudder · nose-wheel steering'],
  ['B', 'Wheel brakes'],
  ['C', 'Chase / cockpit view'],
  ['P', 'Pause'],
  ['M', 'Mute'],
  ['R', 'Restart'],
];

// ---- Helpers --------------------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, k) => a + (b - a) * k;
const TWO_PI = Math.PI * 2;
const wrapPi = (a) => {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
};
const lerpAngle = (a, b, k) => a + wrapPi(b - a) * k;
const smoothstep = (e0, e1, v) => {
  const t = clamp((v - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Body-frame direction → world (same convention as aircraft3d.js). */
function bodyToWorld(f, x, y, z) {
  const sh = Math.sin(f.heading), ch = Math.cos(f.heading);
  const sp = Math.sin(f.pitch), cp = Math.cos(f.pitch);
  const sr = Math.sin(f.roll), cr = Math.cos(f.roll);
  const x1 = x * cr + y * sr, y1 = y * cr - x * sr;
  const y2 = y1 * cp + z * sp, z2 = z * cp - y1 * sp;
  return { x: x1 * ch + z2 * sh, y: y2, z: x1 * sh - z2 * ch };
}

/** World → camera space (mirrors Renderer3D._toCam), for off-screen arrows behind the camera. */
function cameraSpace(cam, p) {
  const sh = Math.sin(cam.heading), ch = Math.cos(cam.heading);
  const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
  const sr = Math.sin(cam.roll), cr = Math.cos(cam.roll);
  const dx = p.x - cam.position.x, dy = p.y - cam.position.y, dz = p.z - cam.position.z;
  const x1 = dx * ch + dz * sh;
  const z1 = dx * sh - dz * ch;
  const z2 = z1 * cp + dy * sp;
  const y2 = dy * cp - z1 * sp;
  return { x: x1 * cr - y2 * sr, y: y2 * cr + x1 * sr, z: z2 };
}

function surfaceAt(island, x, z) {
  return Math.max(island.heightAt(x, z), island.waterLevel ?? 0);
}

/** Fixed, deterministic cloud field (seeded LCG), above the course altitudes. */
function makeClouds() {
  let s = 0x5eed1234;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const clouds = [];
  for (let i = 0; i < 42; i++) {
    clouds.push({
      x: (rnd() - 0.5) * 7000,
      z: (rnd() - 0.5) * 7000,
      y: 430 + rnd() * 280,
      size: 90 + rnd() * 120,
    });
  }
  return clouds;
}

// ---- World ------------------------------------------------------------------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false });

const island = createIsland();
const flight = new FlightModel();
const mission = new Mission(island);
const input = new Input();
const renderer = new Renderer3D(ctx);
const hud = new Hud();
const cockpit = new Cockpit();
const audio = new GameAudio();
const CLOUDS = makeClouds();

const IDLE_INPUT = { pressed: () => false, consumePress: () => false };

const state = {
  screen: 'title',
  view: 'chase',          // 'chase' | 'cockpit'
  shot: null,             // screenshot scene name, or null
  userMuted: false,
  appliedMute: null,
  audioStarted: false,
  acc: 0,
  last: null,
  clock: 0,               // display time (s): rings pulse, clouds, title orbit
  camSnap: true,          // next chase-camera update jumps straight to its target
  endOrbit: 0,            // rad of camera drift since the sortie ended
  W: 1, H: 1, dpr: 1,
};

const camera = { position: { x: 0, y: 0, z: 0 }, heading: 0, pitch: 0, roll: 0 };

function resetFlight() {
  flight.resetOnRunway(island.runway);
  flight.update(DT, IDLE_INPUT, island); // settle the wheels on the strip
  mission.reset();
  cockpit.setControls(0, 0);
  state.acc = 0;
  state.camSnap = true;
}

function startGame() {
  resetFlight();
  setScreen('play');
}

function setScreen(screen) {
  state.screen = screen;
  state.acc = 0;
  state.endOrbit = 0;
}

// ---- Canvas sizing -----------------------------------------------------------------
function resize() {
  const w = Math.max(1, window.innerWidth || canvas.clientWidth || 1280);
  const h = Math.max(1, window.innerHeight || canvas.clientHeight || 720);
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  state.W = w;
  state.H = h;
  state.dpr = pw / w;

  // The renderer's FOV is vertical (focal ∝ height). Narrow windows would lose
  // most of the horizontal view, so widen it to keep a 16:9 horizontal FOV;
  // ultra-wide windows keep their horizontal FOV from growing without limit.
  const aspect = w / h;
  let factor = 1;
  if (aspect < REF_ASPECT) factor = Math.max(aspect / REF_ASPECT, MIN_FOCAL_FACTOR);
  else if (aspect > MAX_ASPECT) factor = aspect / MAX_ASPECT;
  renderer.focalScale = BASE_FOCAL * factor;
}
window.addEventListener('resize', resize);

// ---- Audio ------------------------------------------------------------------------
function startAudio() {
  if (state.shot || state.audioStarted) return;
  if (audio.start()) {
    state.audioStarted = true;
    state.appliedMute = null; // force the mute state to be applied to the new graph
    window.removeEventListener('keydown', startAudio);
    window.removeEventListener('pointerdown', startAudio);
  }
}

function updateAudio() {
  if (!state.audioStarted) return;
  const mute = state.userMuted || state.screen === 'paused';
  if (mute !== state.appliedMute) {
    audio.setMuted(mute);
    state.appliedMute = mute;
  }
  const s = state.screen;
  if (s === 'play') audio.setFlight(flight.throttle, flight.speed, flight.onGround);
  else if (s === 'title' || s === 'complete') audio.setFlight(s === 'title' ? flight.throttle : 0, 0, true);
  // 'over': leave the engine ducked by audio.crash(); 'paused': muted.
}

// ---- Simulation ---------------------------------------------------------------------
// Only called while state.screen === 'play'. Once the sortie is complete or has
// failed, the flight model and mission are frozen until restart (resetFlight).
function step(dt) {
  const ringsBefore = mission.ringsPassed;
  const fuelBefore = mission.fuelPoints;
  const crashedBefore = flight.crashed;

  flight.update(dt, input, island);
  mission.update(dt, flight, island);

  if (mission.ringsPassed > ringsBefore) audio.ringChime();
  if (mission.fuelPoints > fuelBefore) audio.fuelChime();
  if (flight.touchedDown && !flight.crashed) audio.touchdown();
  if (flight.crashed && !crashedBefore) audio.crash();

  if (mission.state === 'complete') setScreen('complete');
  else if (flight.crashed || mission.state === 'failed') setScreen('over');
}

function controlInputs() {
  const k = (c) => (input.pressed(c) ? 1 : 0);
  return {
    pitch: k('ArrowUp') - k('ArrowDown'),
    roll: k('ArrowRight') - k('ArrowLeft'),
  };
}

function handleKeys() {
  if (input.consumePress('KeyM')) {
    state.userMuted = !state.userMuted;
    if (!state.userMuted) audio.click();
  }
  const s = state.screen;
  if (s === 'title') {
    if (input.consumePress('Enter')) { audio.click(); startGame(); }
    return;
  }
  if (input.consumePress('KeyR')) { audio.click(); startGame(); return; }
  if (s === 'play' || s === 'paused') {
    if (input.consumePress('KeyP')) {
      setScreen(s === 'play' ? 'paused' : 'play');
      if (s === 'paused') audio.click();
    }
    if (input.consumePress('KeyC')) {
      state.view = state.view === 'chase' ? 'cockpit' : 'chase';
      state.camSnap = true;
      audio.click();
    }
  }
}

// ---- Cameras --------------------------------------------------------------------------
function drawnView() {
  const s = state.screen;
  return (s === 'play' || s === 'paused') ? state.view : 'chase';
}

function setCam(x, y, z, heading, pitch, roll) {
  camera.position.x = x; camera.position.y = y; camera.position.z = z;
  camera.heading = heading; camera.pitch = pitch; camera.roll = roll;
}

function titleCamera() {
  const p = flight.position;
  const a = flight.heading + (state.shot ? TITLE_SHOT_ANGLE : TITLE_SHOT_ANGLE + state.clock * TITLE_ORBIT_RATE);
  const x = p.x + Math.sin(a) * TITLE_ORBIT_R;
  const z = p.z - Math.cos(a) * TITLE_ORBIT_R;
  const y = Math.max(p.y + TITLE_ORBIT_UP, surfaceAt(island, x, z) + CAMERA_CLEARANCE);
  // Aim a little above the plane so it sits below the title text.
  const dx = p.x - x, dy = p.y + 4 - y, dz = p.z - z;
  setCam(x, y, z, Math.atan2(dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), 0);
  state.camSnap = true;
}

function cockpitCamera() {
  const p = flight.position;
  const e = { x: 0, y: 0, z: 0 };
  for (const [axis, k] of [[bodyToWorld(flight, 1, 0, 0), EYE.x], [bodyToWorld(flight, 0, 1, 0), EYE.y],
    [bodyToWorld(flight, 0, 0, 1), EYE.z]]) {
    e.x += axis.x * k; e.y += axis.y * k; e.z += axis.z * k;
  }
  setCam(p.x + e.x, p.y + e.y, p.z + e.z, flight.heading, flight.pitch, flight.roll);
  state.camSnap = true; // switching back to chase starts from a clean frame
}

function chaseCamera(dt) {
  const f = flight, p = f.position;
  const cp = Math.cos(f.pitch);
  const fx = Math.sin(f.heading) * cp, fy = Math.sin(f.pitch), fz = -Math.cos(f.heading) * cp;
  const tx = p.x - fx * CHASE_BACK;
  const tz = p.z - fz * CHASE_BACK;
  const ty = p.y - fy * CHASE_BACK + CHASE_UP;
  const tPitch = f.pitch * CHASE_PITCH_FOLLOW - CHASE_LOOK_DOWN;
  const tRoll = f.roll * CHASE_ROLL;

  if (state.camSnap) {
    setCam(tx, ty, tz, f.heading, tPitch, tRoll);
    state.camSnap = false;
  } else {
    const kp = 1 - Math.exp(-dt * CHASE_POS_RATE);
    const ka = 1 - Math.exp(-dt * CHASE_ANG_RATE);
    const c = camera.position;
    setCam(lerp(c.x, tx, kp), lerp(c.y, ty, kp), lerp(c.z, tz, kp),
      lerpAngle(camera.heading, f.heading, ka), lerp(camera.pitch, tPitch, ka), lerp(camera.roll, tRoll, ka));
  }
  const floor = surfaceAt(island, camera.position.x, camera.position.z) + CAMERA_CLEARANCE;
  if (camera.position.y < floor) camera.position.y = floor;
}

/** End screens: the scene is frozen; the camera drifts slowly round the plane. */
function endCamera(dt) {
  const p = flight.position;
  state.endOrbit += END_ORBIT_RATE * dt;
  const a = flight.heading + Math.PI + state.endOrbit; // starts behind the plane, like the chase view
  const x = p.x + Math.sin(a) * END_ORBIT_R;
  const z = p.z - Math.cos(a) * END_ORBIT_R;
  const y = Math.max(p.y + END_ORBIT_UP, surfaceAt(island, x, z) + CAMERA_CLEARANCE);
  const dx = p.x - x, dy = p.y + 1 - y, dz = p.z - z;
  const heading = Math.atan2(dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
  if (state.camSnap) {
    setCam(x, y, z, heading, pitch, 0);
    state.camSnap = false;
    return;
  }
  // Ease in from wherever the chase camera was when the sortie ended.
  const kp = 1 - Math.exp(-dt * CHASE_POS_RATE * 0.25);
  const ka = 1 - Math.exp(-dt * CHASE_ANG_RATE * 0.5);
  const c = camera.position;
  setCam(lerp(c.x, x, kp), lerp(c.y, y, kp), lerp(c.z, z, kp),
    lerpAngle(camera.heading, heading, ka), lerp(camera.pitch, pitch, ka), lerp(camera.roll, 0, ka));
  const floor = surfaceAt(island, camera.position.x, camera.position.z) + CAMERA_CLEARANCE;
  if (camera.position.y < floor) camera.position.y = floor;
}

function updateCamera(dt) {
  if (state.screen === 'title') return titleCamera();
  if ((state.screen === 'complete' || state.screen === 'over') && !state.shot) return endCamera(dt);
  if (drawnView() === 'cockpit') return cockpitCamera();
  chaseCamera(state.screen === 'paused' ? 0 : dt);
}

// ---- 3D scene ---------------------------------------------------------------------------
function fogged(rgb, dist) {
  const f = smoothstep(FOG_START, FOG_END, dist) * 0.3;
  const c = rgb.map((v, i) => (v + (HORIZON[i] - v) * f) | 0);
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function drawScene(view, time) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  renderer.setCamera(camera);
  renderer.drawSkyAndWater(camera, island.waterLevel ?? 0);
  renderer.drawTerrain(island);
  renderer.drawRunway(island);
  renderer.drawTownAndTrees(island);
  renderer.drawLighthouse(island);
  // Renderer picks the style from kind/state: next bright, fuel gold, passed/used dim.
  for (const ring of mission.rings) renderer.drawRing(ring, time);
  for (const ring of mission.fuelRings) renderer.drawRing(ring, time);
  renderer.drawClouds(CLOUDS, time);
  if (view === 'chase') drawAircraft(renderer, flight, time);
  renderer.flush();
}

/** Where the mission target is on screen, in the form Hud.draw expects. */
function targetInfo() {
  const t = mission.nextTarget();
  if (!t) return null;
  const p = flight.position;
  const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z;
  const info = {
    onScreen: false,
    angle: NaN,
    distance: Math.hypot(dx, dy, dz),
    bearing: Math.atan2(dx, -dz),
  };
  const W = state.W, H = state.H;
  const s = renderer.project(t);
  if (s) {
    const sx = s.x / state.dpr, sy = s.y / state.dpr;
    info.onScreen = sx >= 0 && sx <= W && sy >= 0 && sy <= H;
    info.angle = Math.atan2(sy - H / 2, sx - W / 2);
  } else {
    // Behind the camera: point the arrow toward the side the target lies on.
    const c = cameraSpace(renderer.camera, t);
    info.angle = Math.abs(c.x) + Math.abs(c.y) < 1e-6 ? Math.PI / 2 : Math.atan2(-c.y, c.x);
  }
  return info;
}

// ---- 2D drawing helpers ------------------------------------------------------------------
function uiScale() {
  return clamp(Math.min(state.W / 1280, state.H / 720), 0.6, 1.6);
}

function panel(x, y, w, h, stroke = 'rgba(255,255,255,0.16)', fill = BACK) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(8, h / 4));
  else ctx.rect(x, y, w, h);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function text(str, x, y, color, font, align = 'left', shadow = false) {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  if (shadow) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, parseFloat(font.match(/(\d+(\.\d+)?)px/)?.[1] || 12) / 7);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(str, Math.round(x), Math.round(y));
  }
  ctx.fillStyle = color;
  ctx.fillText(str, Math.round(x), Math.round(y));
}

/** Font size (px) that fits str into maxWidth, starting from size. */
function fitSize(str, size, maxWidth, family, weight = 'bold') {
  ctx.font = `${weight} ${size}px ${family}`;
  const w = ctx.measureText(str).width;
  return w > maxWidth ? size * maxWidth / w : size;
}

function dim(alpha) {
  ctx.fillStyle = `rgba(4,8,14,${alpha})`;
  ctx.fillRect(0, 0, state.W, state.H);
}

/** Pulsing prompt; never fully hidden so a screenshot always shows it. */
function prompt(str, y, s, time, color = WHITE) {
  const a = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(time * 4));
  ctx.save();
  ctx.globalAlpha = a;
  text(str, state.W / 2, y, color, `bold ${Math.round(24 * s)}px ${MONO}`, 'center', true);
  ctx.restore();
}

function clockText(seconds) {
  const secs = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/** Rows of [label, value] (null = divider) in a centred panel with a title. */
function resultPanel(title, titleColor, rows, s) {
  const W = state.W, H = state.H;
  const w = Math.min(440 * s, W * 0.92), rowH = 30 * s;
  const h = 76 * s + rowH * rows.length + 56 * s;
  const x = W / 2 - w / 2, y = Math.max(8, H / 2 - h / 2);
  panel(x, y, w, h, titleColor, 'rgba(8,12,18,0.82)');
  text(title, W / 2, y + 34 * s, titleColor, `bold ${Math.round(30 * s)}px ${SANS}`, 'center');
  rows.forEach((row, i) => {
    const ry = y + 76 * s + rowH * (i + 0.5);
    if (!row) {
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(x + 22 * s, ry, w - 44 * s, 1);
      return;
    }
    const big = row[2] === 'big';
    if (row[1] === '') {
      text(String(row[0]), W / 2, ry, row[3] || WHITE, `bold ${Math.round(17 * s)}px ${MONO}`, 'center');
      return;
    }
    text(String(row[0]), x + 24 * s, ry, AMBER, `bold ${Math.round((big ? 17 : 15) * s)}px ${MONO}`, 'left');
    text(String(row[1]), x + w - 24 * s, ry, WHITE, `bold ${Math.round((big ? 24 : 19) * s)}px ${MONO}`, 'right');
  });
  return y + h;
}

// ---- Overlays ------------------------------------------------------------------------------
function drawTitle(time) {
  const W = state.W, H = state.H, s = uiScale();
  const top = ctx.createLinearGradient(0, 0, 0, H * 0.42);
  top.addColorStop(0, 'rgba(6,14,28,0.62)');
  top.addColorStop(1, 'rgba(6,14,28,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, H * 0.42);

  const title = 'CLOUDHAVEN AIR RALLY';
  const ts = fitSize(title, 72 * s, W * 0.9, SANS);
  text(title, W / 2, H * 0.14, '#fff6dc', `bold ${Math.round(ts)}px ${SANS}`, 'center', true);
  const sub = 'Thread the rings around the island · refuel at the gold ones · land it smooth';
  const ss = fitSize(sub, 20 * s, W * 0.86, SANS, '600');
  text(sub, W / 2, H * 0.14 + ts * 0.62 + 8 * s, '#dcecff', `600 ${Math.round(ss)}px ${SANS}`, 'center', true);

  // Controls list, lower left.
  const rowH = 25 * s, pw = 330 * s, ph = 46 * s + rowH * CONTROLS.length;
  const px = Math.max(12, 28 * s), py = Math.max(H * 0.36, H - ph - 92 * s);
  panel(px, py, pw, ph);
  text('CONTROLS', px + 18 * s, py + 22 * s, AMBER, `bold ${Math.round(14 * s)}px ${MONO}`);
  CONTROLS.forEach(([key, what], i) => {
    const y = py + 44 * s + rowH * (i + 0.5);
    text(key, px + 18 * s, y, WHITE, `bold ${Math.round(15 * s)}px ${MONO}`);
    text(what, px + 108 * s, y, DIM, `${Math.round(14 * s)}px ${MONO}`);
  });

  prompt('PRESS ENTER', H - 44 * s, s, time, GOLD);
}

function drawPaused() {
  const s = uiScale();
  dim(0.45);
  text('PAUSED', state.W / 2, state.H * 0.42, WHITE, `bold ${Math.round(56 * s)}px ${SANS}`, 'center', true);
  text('P resume  ·  R restart  ·  C view  ·  M mute', state.W / 2, state.H * 0.42 + 52 * s, DIM,
    `bold ${Math.round(17 * s)}px ${MONO}`, 'center', true);
}

function drawOver(time) {
  const s = uiScale();
  dim(0.4);
  const crashed = flight.crashed;
  const title = crashed ? 'CRASHED' : (mission.failReason === 'Out of time' ? 'OUT OF TIME' : 'MISSION FAILED');
  const reason = crashed ? (CRASH_TEXT[flight.crashReason] || flight.crashReason || 'Impact')
    : (mission.failReason || 'Mission failed');
  const rows = [
    [reason, '', '', '#ffd0c8'],
    null,
    ['RINGS', `${mission.ringsPassed}/${mission.totalRings}`],
    ['FLIGHT TIME', clockText(mission.elapsed)],
    ['SCORE', String(Math.round(mission.score)), 'big'],
  ];
  const bottom = resultPanel(title, RED, rows, s);
  prompt('PRESS R TO RETRY', bottom - 30 * s, s, time);
}

function drawComplete(time) {
  const s = uiScale();
  dim(0.35);
  const r = mission.result || { ringPoints: mission.ringPoints, fuelPoints: mission.fuelPoints,
    timeBonus: mission.timeBonus, landingPoints: mission.landingPoints, total: mission.score };
  const rows = [];
  if (mission.landing) {
    const l = mission.landing;
    rows.push([`${l.grade} LANDING  ${Math.round(l.sink * MS_TO_FPM)} fpm · ${Math.round(l.speed * MS_TO_KT)} kt`, '', '', GOLD]);
  }
  rows.push(
    ['RINGS', `${r.ringPoints}`],
    ['FUEL RINGS', `${r.fuelPoints}`],
    ['TIME BONUS', `${r.timeBonus}`],
    ['LANDING', `${r.landingPoints}`],
    ['FLIGHT TIME', clockText(mission.elapsed)],
    null,
    ['TOTAL', `${r.total}`, 'big'],
  );
  const bottom = resultPanel('MISSION COMPLETE', GREEN, rows, s);
  prompt('PRESS R TO FLY AGAIN', bottom - 30 * s, s, time);
}

/** Compact strip for the cockpit view: the panel already shows the flight instruments. */
function drawCockpitStrip(info) {
  const W = state.W, s = uiScale();
  const w = Math.min(640 * s, W * 0.96), h = 40 * s;
  const x = W / 2 - w / 2, y = 10 * s;
  panel(x, y, w, h);
  const cy = y + h / 2;
  const lab = `bold ${Math.round(12 * s)}px ${MONO}`, val = `bold ${Math.round(18 * s)}px ${MONO}`;
  const col = w / 4;

  text('SCORE', x + 12 * s, cy, AMBER, lab);
  text(String(Math.round(mission.score)), x + col - 10 * s, cy, WHITE, val, 'right');

  const low = mission.timer < 30;
  text('TIME', x + col + 12 * s, cy, AMBER, lab);
  text(clockText(mission.timer), x + 2 * col - 10 * s, cy, low ? RED : WHITE, val, 'right');

  const objective = mission.phase === 'landing' ? 'LAND'
    : `RING ${Math.min(mission.currentRing + 1, mission.totalRings)}/${mission.totalRings}`;
  text(objective, x + 2.5 * col, cy, mission.phase === 'landing' ? GREEN : WHITE, val, 'center');

  if (info) {
    // Arrow shows the target's bearing relative to the nose (up = straight ahead).
    const rel = wrapPi(info.bearing - flight.heading);
    const ax = x + 3 * col + 18 * s;
    ctx.save();
    ctx.translate(ax, cy);
    ctx.rotate(rel);
    ctx.beginPath();
    ctx.moveTo(0, -11 * s);
    ctx.lineTo(8 * s, 8 * s);
    ctx.lineTo(0, 3 * s);
    ctx.lineTo(-8 * s, 8 * s);
    ctx.closePath();
    ctx.fillStyle = mission.phase === 'landing' ? GREEN : AMBER;
    ctx.fill();
    ctx.restore();
    const d = info.distance >= 1000 ? `${(info.distance / 1000).toFixed(1)} km` : `${Math.round(info.distance)} m`;
    text(d, x + w - 12 * s, cy, WHITE, val, 'right');
  }

  const age = mission.elapsed - mission.messageTime;
  if (mission.message && age >= 0 && age < MESSAGE_SECONDS) {
    ctx.save();
    ctx.globalAlpha = clamp((MESSAGE_SECONDS - age) / 0.5, 0, 1);
    const gold = mission.message.startsWith('FUEL');
    text(mission.message, W / 2, y + h + 22 * s, gold ? GOLD : WHITE, `bold ${Math.round(18 * s)}px ${MONO}`, 'center', true);
    ctx.restore();
  }
}

function drawMuteTag() {
  if (!state.userMuted || state.shot) return;
  const s = uiScale();
  text('SOUND OFF (M)', state.W / 2, state.H - 14 * s, DIM, `bold ${Math.round(12 * s)}px ${MONO}`, 'center', true);
}

// ---- Frame ----------------------------------------------------------------------------------
function render() {
  const time = state.clock;
  const view = drawnView();
  drawScene(view, time);

  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.globalAlpha = 1;
  const W = state.W, H = state.H, scr = state.screen;

  if (scr === 'play' || scr === 'paused') {
    const info = targetInfo();
    if (view === 'cockpit') {
      cockpit.draw(ctx, flight, W, H);
      drawCockpitStrip(info);
    } else if (mission.state === 'running') {
      hud.draw(ctx, flight, mission, { width: W, height: H, time }, info);
    }
  }
  if (scr === 'title') drawTitle(time);
  else if (scr === 'paused') drawPaused();
  else if (scr === 'over') drawOver(time);
  else if (scr === 'complete') drawComplete(time);
  drawMuteTag();
}

function frame(now) {
  requestAnimationFrame(frame);
  resize();

  if (state.shot) {
    // Frozen state: same camera, same display time, every frame.
    render();
    document.documentElement.dataset.shotReady = '1';
    return;
  }

  const ft = state.last === null ? 0 : clamp((now - state.last) / 1000, 0, MAX_FRAME);
  state.last = now;

  handleKeys();
  if (state.screen === 'play') {
    const c = controlInputs();
    cockpit.setControls(c.pitch, c.roll);
  }

  // Simulation steps only while playing: paused, complete and over are frozen.
  if (state.screen === 'play') {
    state.acc += ft;
    while (state.acc >= DT) {
      const before = state.screen;
      step(DT);
      state.acc -= DT;
      if (state.screen !== before) { state.acc = 0; break; }
    }
  } else {
    state.acc = 0;
  }
  if (state.screen !== 'paused') state.clock += ft;

  updateCamera(ft);
  updateAudio();
  render();
  input.endFrame();
}

// ---- Boot ---------------------------------------------------------------------------------
function boot() {
  resize();
  const shot = new URLSearchParams(window.location.search).get('shot');
  if (shot !== null) {
    state.shot = shot || 'title';
    const res = stageShot(state.shot, { island, flight, mission, input }) || { screen: 'title' };
    state.screen = res.screen || 'title';
    state.view = res.view === 'cockpit' ? 'cockpit' : 'chase';
    state.clock = flight.time;
    state.camSnap = true;
    updateCamera(0); // snapped: chase camera jumps straight to its target
  } else {
    input.attach(canvas);
    window.addEventListener('keydown', startAudio);
    window.addEventListener('pointerdown', startAudio);
    resetFlight();
    state.screen = 'title';
    updateCamera(0);
    canvas.tabIndex = 0;
    canvas.focus();
  }
  requestAnimationFrame(frame);
}

boot();
