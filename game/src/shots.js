// Cloudhaven Air Rally — deterministic screenshot scenes.
//
// main.js calls stageShot(name, world) when the page URL has ?shot=<name>,
// instead of starting interactive play. stageShot resets the plane on the
// runway and the mission, then flies the simulation forward at a fixed
// dt = 1/60 under a simple autopilot that "presses keys" on a fake input
// object (same pressed()/consumePress() interface the flight model reads).
//
//   world = { island, flight, mission, input }   (input is never touched)
//   returns { screen: 'title' } or { screen: 'play', view: 'chase' | 'cockpit' }
//
// Scenes:
//   title   — plane idling on the runway threshold (main.js draws the title).
//   chase   — take-off and first leg; airborne, wings level, first ring ahead.
//   cockpit — same leg, closer in: ring a few hundred metres ahead, land beyond.
//   final   — mission in its landing phase, plane on short final, gentle descent,
//             a few seconds from touchdown (the aircraft has fixed gear).
//
// Robustness: each attempt is capped in steps. While flying, every step is
// scored against the scene's "photogenic" criteria; the best step is then
// reproduced by re-running the same attempt exactly to that step (the model is
// fully deterministic). If an attempt crashes or never produces a valid frame,
// the next, gentler profile (less climb, less bank, more speed margin) is
// tried. If no attempt meets the criteria, the best airborne step seen in any
// attempt (loose score: wings level, target ahead) is replayed instead, with a
// console warning; only if nothing ever got airborne is the plane left parked.
// Determinism: no Math.random, no clock — only the fixed-dt simulation.

import { FLIGHT_CONSTANTS } from './flight-model.js';

const DT = 1 / 60;
const { STALL_SPEED, ROTATE_SPEED } = FLIGHT_CONSTANTS;

// Mirrors of flight-model.js internals, used only for feed-forward estimates.
const G = 9.81;
const MAX_THRUST_ACCEL = 9.0;
const DRAG_K = 0.0018;
const BANK_SINK = 4;

const TWO_PI = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = (a) => {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
};
const headingTo = (dx, dz) => Math.atan2(dx, -dz);

// Autopilot profiles, from brisk to very gentle. Retries move down the list.
const PROFILES = [
  { cruise: 42, approach: 34, maxVS: 6.0, maxBank: 0.55, climbPitch: 0.14 },
  { cruise: 44, approach: 35, maxVS: 4.0, maxBank: 0.45, climbPitch: 0.10 },
  { cruise: 46, approach: 36, maxVS: 3.0, maxBank: 0.38, climbPitch: 0.08 },
  { cruise: 48, approach: 37, maxVS: 2.2, maxBank: 0.30, climbPitch: 0.06 },
];

// ---- Fake input ---------------------------------------------------------------------

class AutoInput {
  constructor() { this.keys = new Set(); }
  pressed(code) { return this.keys.has(code); }
  consumePress() { return false; } // the autopilot never toggles anything
  endFrame() {}
  clear() { this.keys.clear(); }
  hold(code) { this.keys.add(code); }
}

// ---- Runway geometry ------------------------------------------------------------------

function runwayFrame(runway) {
  const fx = Math.sin(runway.heading), fz = -Math.cos(runway.heading);
  const rx = -fz, rz = fx; // right of the landing direction
  return {
    runway, fx, fz, rx, rz,
    /** World point from runway-local (along the heading, to the right). */
    point(along, across) {
      return { x: runway.x + fx * along + rx * across, z: runway.z + fz * along + rz * across };
    },
    /** Runway-local coordinates of a world point. */
    local(x, z) {
      const dx = x - runway.x, dz = z - runway.z;
      return { along: dx * fx + dz * fz, across: dx * rx + dz * rz };
    },
  };
}

// ---- Autopilot ------------------------------------------------------------------------

/** Height of whatever the plane would hit below it: terrain or the sea. */
function surfaceAt(island, x, z) {
  return Math.max(island.heightAt(x, z), island.waterLevel ?? 0);
}

/**
 * One step of attitude / speed control. cmd = { heading, altitude, speed,
 * maxBank, maxVS, maxSink, minAGL }. Writes held keys into `inp`.
 */
function steer(flight, island, inp, cmd) {
  const p = flight.position;
  const agl = p.y - surfaceAt(island, p.x, p.z);

  // Lateral: bank toward the desired heading, roll via bang-bang ailerons.
  const hdgErr = wrapPi(cmd.heading - flight.heading);
  const wantRoll = clamp(hdgErr * 1.6, -cmd.maxBank, cmd.maxBank);
  if (flight.roll < wantRoll - 0.015) inp.hold('ArrowRight');
  else if (flight.roll > wantRoll + 0.015) inp.hold('ArrowLeft');

  // Vertical: altitude error → climb rate → path pitch (+ bank-sink compensation).
  let vs = clamp((cmd.altitude - p.y) * 0.25 + (cmd.vsBias ?? 0), -cmd.maxSink, cmd.maxVS);
  if (agl < cmd.minAGL) vs = Math.max(vs, 2.5);                  // terrain floor
  if (flight.speed < STALL_SPEED + 5) vs = Math.min(vs, 0.5);     // trade climb for speed
  const v = Math.max(flight.speed, 1);
  const bankSink = BANK_SINK * (1 - Math.cos(flight.roll)) * flight.liftFactor;
  const wantPitch = Math.asin(clamp((vs + bankSink) / v, -0.45, 0.45));
  if (flight.pitch < wantPitch - 0.006) inp.hold('ArrowUp');
  else if (flight.pitch > wantPitch + 0.006) inp.hold('ArrowDown');

  // Speed: feed-forward throttle for drag and climb, plus a proportional trim.
  const need = (DRAG_K * v * v + G * Math.sin(flight.pitch)) / MAX_THRUST_ACCEL;
  const wantThr = clamp(need + 0.08 * (cmd.speed - flight.speed), 0, 1);
  if (flight.throttle < wantThr - 0.01) inp.hold('KeyW');
  else if (flight.throttle > wantThr + 0.01) inp.hold('KeyS');
}

/** Take-off roll and initial climb. Returns true while still in this phase (latched off in st). */
function takeoff(flight, island, inp, rw, prof, st) {
  if (st.airborne) return false;
  const p = flight.position;
  const agl = p.y - surfaceAt(island, p.x, p.z);
  if (!flight.onGround && agl > 18) {
    st.airborne = true;
    return false;
  }

  inp.hold('KeyW'); // full power
  if (flight.onGround) {
    // Keep the centreline with the nose wheel: heading error plus cross-track.
    const { across } = rw.local(p.x, p.z);
    const want = rw.runway.heading - clamp(across * 0.02, -0.1, 0.1);
    const err = wrapPi(want - flight.heading);
    if (err > 0.003) inp.hold('KeyD');
    else if (err < -0.003) inp.hold('KeyA');
    if (flight.speed >= ROTATE_SPEED + 2) inp.hold('ArrowUp');
  } else {
    // Wings level, steady climb attitude.
    if (flight.roll > 0.015) inp.hold('ArrowLeft');
    else if (flight.roll < -0.015) inp.hold('ArrowRight');
    if (flight.pitch < prof.climbPitch - 0.006) inp.hold('ArrowUp');
    else if (flight.pitch > prof.climbPitch + 0.006) inp.hold('ArrowDown');
  }
  return true;
}

/**
 * Aim point for a ring: back along its normal on the plane's side, so the
 * approach lines up with the ring rather than clipping it edge-on.
 */
function ringAim(ring, p) {
  const nx = Math.sin(ring.heading), nz = -Math.cos(ring.heading);
  const side = (p.x - ring.x) * nx + (p.z - ring.z) * nz;
  const s = side >= 0 ? 1 : -1;
  const back = clamp(Math.abs(side) * 0.35, 0, 250);
  return { x: ring.x + nx * back * s, z: ring.z + nz * back * s };
}

// ---- Final-approach circuit (runway-local waypoints, right-hand pattern) -------------

const TOUCHDOWN_ALONG = -300;           // aim point, 150 m past the threshold
const GLIDE = Math.tan(3 * Math.PI / 180);
const CIRCUIT = [
  { along:   800, across:    0, agl: 120 }, // climb-out past the far end
  { along:   950, across:  650, agl: 120 }, // crosswind
  { along: -1300, across:  650, agl: 120 }, // downwind
  { along: -2100, across:  280, agl: 100 }, // base, then join final
];

// ---- Attempt runner -------------------------------------------------------------------

function resetWorld(world) {
  const { island, flight, mission } = world;
  flight.resetOnRunway(island.runway);
  mission.reset();
}

/** Put the mission straight into its landing phase (all rings flown). */
function skipToLanding(mission) {
  if (typeof mission._passRing === 'function') {
    while (mission.phase === 'rings' && mission.currentRing < mission.rings.length) {
      mission._passRing(mission.rings[mission.currentRing]);
    }
  } else {
    for (const r of mission.rings) { r.passed = true; r.next = false; }
    mission.currentRing = mission.ringsPassed = mission.rings.length;
    mission.phase = 'landing';
  }
  mission.message = null;
  mission.messageTime = -Infinity;
}

/**
 * Fly one attempt. If stopAt is a step count, stop exactly there (replay).
 * Otherwise score every step with scene.score and return the best one.
 */
function runAttempt(world, scene, prof, stopAt = null) {
  const { island, flight, mission } = world;
  const rw = runwayFrame(island.runway);
  const inp = new AutoInput();
  resetWorld(world);
  if (scene.landing) skipToLanding(mission);

  const st = { wp: 0, final: false, airborne: false };
  const maxSteps = stopAt ?? Math.round(scene.maxTime / DT);
  let best = null;
  let rough = null; // best airborne step by roughScore, for the fallback

  for (let step = 1; step <= maxSteps; step++) {
    inp.clear();
    if (!takeoff(flight, island, inp, rw, prof, st)) {
      if (scene.landing) flyCircuit(flight, island, inp, rw, prof, st);
      else flyToTarget(flight, island, inp, mission, prof);
    }
    flight.update(DT, inp, island);
    mission.update(DT, flight, island);

    if (flight.crashed || mission.state === 'failed') return { crashed: true, best, rough };
    if (stopAt !== null) continue;

    const s = scene.score(world, rw, st);
    if (s !== null && (best === null || s < best.score)) best = { step, score: s };
    const r = roughScore(world);
    if (r !== null && (rough === null || r < rough.score)) rough = { step, score: r };
    if (scene.done(world, rw, st)) break;
  }
  return { crashed: false, best, rough };
}

/**
 * Loose "presentable frame" score for the fallback (lower is better), or null
 * if not airborne: wings near level, target roughly ahead, nose near level,
 * not stalled, some height above the surface.
 */
function roughScore(world) {
  const { flight: f, mission } = world;
  if (f.onGround || f.crashed) return null;
  const p = f.position;
  const t = mission.nextTarget();
  const bearing = t ? Math.abs(wrapPi(headingTo(t.x - p.x, t.z - p.z) - f.heading)) : 0;
  return Math.abs(f.roll) * 10 + bearing * 4 + Math.abs(f.pitch) * 3
    + (f.stalled ? 5 : 0) + (aglOf(world) < 30 ? 3 : 0);
}

function flyToTarget(flight, island, inp, mission, prof) {
  const t = mission.nextTarget();
  const aim = t.kind === 'landing' ? t : ringAim(t, flight.position);
  steer(flight, island, inp, {
    heading: headingTo(aim.x - flight.position.x, aim.z - flight.position.z),
    altitude: t.y,
    speed: prof.cruise,
    maxBank: prof.maxBank,
    maxVS: prof.maxVS,
    maxSink: 4,
    minAGL: 35,
  });
}

function flyCircuit(flight, island, inp, rw, prof, st) {
  const p = flight.position;
  const ry = rw.runway.y;

  if (!st.final) {
    const w = CIRCUIT[st.wp];
    const wp = rw.point(w.along, w.across);
    if (Math.hypot(wp.x - p.x, wp.z - p.z) < 180) {
      if (st.wp < CIRCUIT.length - 1) st.wp++;
      else st.final = true;
    }
    if (!st.final) {
      steer(flight, island, inp, {
        heading: headingTo(wp.x - p.x, wp.z - p.z),
        altitude: ry + w.agl,
        speed: st.wp >= 2 ? (prof.cruise + prof.approach) / 2 : prof.cruise,
        maxBank: prof.maxBank,
        maxVS: prof.maxVS,
        maxSink: 3,
        minAGL: 40,
      });
      return;
    }
  }

  // Final: converge on the extended centreline and ride a 3° glide path.
  const { along, across } = rw.local(p.x, p.z);
  const toGo = Math.max(0, TOUCHDOWN_ALONG - along);
  steer(flight, island, inp, {
    heading: rw.runway.heading - clamp(across * 0.006, -0.5, 0.5),
    altitude: ry + 1 + toGo * GLIDE,
    vsBias: toGo > 0 ? -flight.speed * GLIDE : 0, // feed-forward: ride the slope, not below it
    speed: prof.approach,
    maxBank: Math.min(prof.maxBank, 0.35),
    maxVS: 2,
    maxSink: 3,
    minAGL: 0,
  });
}

// ---- Scene definitions ----------------------------------------------------------------

function aglOf(world) {
  const p = world.flight.position;
  return p.y - surfaceAt(world.island, p.x, p.z);
}

/** Distance and bearing error from the plane to the current course ring. */
function ringView(world) {
  const { flight, mission } = world;
  if (mission.phase !== 'rings' || mission.currentRing !== 0) return null;
  const r = mission.rings[0];
  const p = flight.position;
  const dx = r.x - p.x, dz = r.z - p.z;
  const dist = Math.hypot(dx, dz);
  const bearing = Math.abs(wrapPi(headingTo(dx, dz) - flight.heading));
  const elev = Math.atan2(r.y - p.y, dist) - flight.pitch; // vs. nose direction
  return { dist, bearing, elev };
}

/** Common "stable, photogenic attitude" score, or null if not acceptable. */
function attitudeScore(f, maxRoll, maxPitch) {
  if (f.onGround || f.crashed || f.stalled) return null;
  if (Math.abs(f.roll) > maxRoll || Math.abs(f.pitch) > maxPitch) return null;
  if (Math.abs(f.verticalSpeed) > 6) return null;
  return Math.abs(f.roll) * 20 + Math.abs(f.pitch) * 5;
}

const SCENES = {
  chase: {
    view: 'chase',
    maxTime: 60,
    tMin: 25, tMax: 35,
    score(world) {
      const f = world.flight;
      if (f.time < this.tMin || f.time > this.tMax) return null;
      const a = attitudeScore(f, 0.06, 0.16);
      const rv = ringView(world);
      if (a === null || !rv || aglOf(world) < 30) return null;
      if (rv.dist < 250 || rv.dist > 1100 || rv.bearing > 0.2 || Math.abs(rv.elev) > 0.25) return null;
      return a + rv.bearing * 10 + Math.abs(rv.dist - 550) / 400 + Math.abs(f.time - 30) / 10;
    },
    done(world) { return world.flight.time > this.tMax || world.mission.currentRing > 0; },
  },

  cockpit: {
    view: 'cockpit',
    maxTime: 70,
    tMin: 24, tMax: 45,
    score(world) {
      const { flight: f, island } = world;
      if (f.time < this.tMin || f.time > this.tMax) return null;
      const a = attitudeScore(f, 0.08, 0.16);
      const rv = ringView(world);
      if (a === null || !rv || aglOf(world) < 30) return null;
      if (rv.dist < 150 || rv.dist > 500 || rv.bearing > 0.15 || Math.abs(rv.elev) > 0.2) return null;
      // Terrain ahead: land (not sea) under the line of sight beyond the ring.
      const p = f.position, hx = Math.sin(f.heading), hz = -Math.cos(f.heading);
      let land = 0;
      for (let d = 400; d <= 1600; d += 300) {
        if (island.heightAt(p.x + hx * d, p.z + hz * d) > (island.waterLevel ?? 0) + 2) land++;
      }
      if (land < 3) return null;
      return a + rv.bearing * 10 + Math.abs(rv.dist - 300) / 200 + (5 - land) * 0.2;
    },
    done(world) { return world.flight.time > this.tMax || world.mission.currentRing > 0; },
  },

  final: {
    view: 'chase',
    landing: true,
    maxTime: 300,
    score(world, rw, st) {
      const f = world.flight;
      if (!st.final) return null;
      const a = attitudeScore(f, 0.08, 0.15);
      if (a === null) return null;
      const p = f.position;
      const { along, across } = rw.local(p.x, p.z);
      const toGo = TOUCHDOWN_ALONG - along;
      const agl = p.y - rw.runway.y;
      const sink = -f.verticalSpeed;
      const hdg = Math.abs(wrapPi(rw.runway.heading - f.heading));
      if (toGo < 110 || toGo > 320 || agl < 4 || agl > 22) return null;
      if (sink < 0.3 || sink > 2.8 || Math.abs(across) > 12 || hdg > 0.1) return null;
      return a + hdg * 10 + Math.abs(across) / 10 + Math.abs(toGo - 190) / 100;
    },
    done(world, rw, st) {
      if (!st.final) return false;
      const f = world.flight;
      return f.onGround || rw.local(f.position.x, f.position.z).along > TOUCHDOWN_ALONG;
    },
  },
};

// ---- Entry point ----------------------------------------------------------------------

/**
 * Stage a deterministic screenshot scene. Mutates world.flight and
 * world.mission; never touches world.input.
 */
export function stageShot(name, world) {
  const { island, flight } = world;

  if (name === 'title' || !SCENES[name]) {
    // Parked at the threshold, engine idling; a couple of seconds of idle creep
    // settles the wheels on the strip without starting the mission clock.
    resetWorld(world);
    const inp = new AutoInput();
    for (let i = 0; i < 120; i++) flight.update(DT, inp, island);
    return { screen: 'title' };
  }

  const scene = SCENES[name];
  let fallback = null; // best frame from an attempt that later crashed
  let rough = null;    // best airborne step across all attempts (loose criteria)
  for (let i = 0; i < PROFILES.length; i++) {
    const res = runAttempt(world, scene, PROFILES[i]);
    if (res.best && !res.crashed) {
      runAttempt(world, scene, PROFILES[i], res.best.step);
      return { screen: 'play', view: scene.view };
    }
    if (res.best && !fallback) fallback = { prof: PROFILES[i], step: res.best.step };
    if (res.rough && (!rough || res.rough.score < rough.score)) {
      rough = { prof: PROFILES[i], step: res.rough.step, score: res.rough.score };
    }
  }

  // A crashed attempt still produced a valid frame before the crash: replay to it.
  if (fallback) {
    const res = runAttempt(world, scene, fallback.prof, fallback.step);
    if (!res.crashed) return { screen: 'play', view: scene.view };
  }

  // No attempt met the scene's criteria: replay the best airborne state reached.
  if (rough) {
    const res = runAttempt(world, scene, rough.prof, rough.step);
    if (!res.crashed) {
      console.warn(`stageShot('${name}'): no attempt met the scene criteria; ` +
        `using best airborne fallback (step ${rough.step}, score ${rough.score.toFixed(2)}).`);
      return { screen: 'play', view: scene.view };
    }
  }

  // Last resort: never return a wreck — leave the plane ready on the runway.
  console.warn(`stageShot('${name}'): no airborne state reached; falling back to the plane parked on the runway.`);
  resetWorld(world);
  flight.update(DT, new AutoInput(), island);
  return { screen: 'play', view: scene.view };
}
