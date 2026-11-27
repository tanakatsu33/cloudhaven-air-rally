// Cloudhaven Air Rally — one sortie over the island.
//
// Coordinates match island.js / flight-model.js: x east, z south, y up (metres);
// heading 0 = north (-z), forward vector for heading h = (sin h, 0, -cos h).
//
// Course (clockwise tour, ~11 km):
//   take-off from the runway → climb-out gate → round Lighthouse Point →
//   low pass over the town harbour → back across the island's spine →
//   east shoulder of the hill massif → over the summit ridge → dive to the
//   western fields → base-leg gate south-west of the runway → land.
// Two gold fuel rings sit off the loop as optional detours.
//
// Usage (each frame, AFTER flight.update so the plane's movement is known):
//   mission.update(dt, flight, island);
//   mission.rings / mission.fuelRings  → renderer.drawRing(ring, time)
//   mission.nextTarget()               → HUD arrow / guidance

import { FLIGHT_CONSTANTS } from './flight-model.js';

// ---- Tunables -------------------------------------------------------------------
const RING_RADIUS = 28;           // m
const START_TIME = 300;           // s on the clock at the start
const RING_TIME_ADD = 20;         // s added per course ring
const RING_POINTS = 500;
const FUEL_POINTS = 150;
const RING_BONUS_MAX = 250;       // max speed bonus per ring
const RING_BONUS_RATE = 10;       // bonus points per second under par
const PAR_SPEED = 45;             // m/s — par leg time = leg length / PAR_SPEED × PAR_SLACK
const PAR_SLACK = 1.15;
const FINISH_TIME_RATE = 5;       // points per second left on the clock at completion
const LANDING_POINTS_MAX = 1000;
const LANDING_SPEED_IDEAL = FLIGHT_CONSTANTS.STALL_SPEED + 3;  // m/s — full marks at or below
const LANDING_SPEED_MAX = FLIGHT_CONSTANTS.TOUCHDOWN_MAX_SPEED; // m/s — zero marks
const LANDING_SINK_MAX = FLIGHT_CONSTANTS.TOUCHDOWN_MAX_SINK;   // m/s — zero marks
const MAX_FRAME_JUMP = 250;       // m — ignore crossings across teleports / resets
// Landing guidance: first an approach gate on the extended centreline, then the
// touchdown zone. Distances are along the runway heading from the threshold.
const APPROACH_GATE_DIST = 350;   // m before the threshold
const APPROACH_GATE_AGL = 45;     // m above the runway surface
const TOUCHDOWN_ZONE_DIST = 150;  // m past the threshold, at runway height
const FINAL_CAPTURE_WIDTH = 200;  // m either side of the centreline that counts as passing the gate
const FINAL_CAPTURE_RANGE = 400;  // m from the threshold that always counts as on final
const FINAL_LOSE_WIDTH = 600;     // m off the centreline — beyond this, guidance reverts to the gate
const FINAL_LOSE_BEHIND = 300;    // m back past the gate — beyond this, guidance reverts to the gate
const FINAL_LOSE_OVERRUN = 200;   // m past the far end of the runway (go-around) — reverts to the gate

// Course rings: positions/altitudes only; headings are computed from the legs.
const COURSE = [
  { name: 'Climb-out',        x:   180, z:   100, y: 110 },
  { name: 'Lighthouse Point', x:  2560, z:  -560, y:  90 }, // offshore, rounding the point
  { name: 'Town Harbour',     x:  2080, z:   330, y:  60 }, // low pass off the harbour front
  { name: 'Island Spine',     x:   700, z:  -450, y: 140 },
  { name: 'Massif Shoulder',  x:  -450, z: -1000, y: 250 },
  { name: 'Summit Ridge',     x:  -950, z: -1150, y: 355 },
  { name: 'West Fields',      x: -1250, z:   650, y: 120 },
  { name: 'Base Gate',        x:  -968, z:  2101, y: 120 }, // offshore, base leg to the runway
];

// Gold fuel rings, off the loop. Headings are explicit.
const FUEL = [
  { name: 'North Fuel', x:  1100, z: -1150, y: 150, heading: 1.25 },  // north of leg 1→2
  { name: 'West Fuel',  x: -1850, z:  -350, y: 120, heading: Math.PI }, // off the west cliffs, leg 6→7
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const headingOf = (dx, dz) => Math.atan2(dx, -dz);

export class Mission {
  /** @param island object from createIsland() */
  constructor(island) {
    this.island = island;
    const rw = island.runway;
    const fx = Math.sin(rw.heading), fz = -Math.cos(rw.heading);
    // Runway reference points: centre, approach threshold (landing toward rw.heading).
    this.runwayCentre = { x: rw.x, y: rw.y, z: rw.z };
    const threshold = { x: rw.x - fx * rw.length / 2, z: rw.z - fz * rw.length / 2 };
    this._runwayAxis = { fx, fz, threshold };
    this.approachGate = {
      kind: 'landing', name: 'Approach gate',
      x: threshold.x - fx * APPROACH_GATE_DIST, y: rw.y + APPROACH_GATE_AGL, z: threshold.z - fz * APPROACH_GATE_DIST,
      heading: rw.heading, radius: RING_RADIUS,
    };
    this.touchdownZone = {
      kind: 'landing', name: 'Touchdown zone',
      x: threshold.x + fx * TOUCHDOWN_ZONE_DIST, y: rw.y, z: threshold.z + fz * TOUCHDOWN_ZONE_DIST,
      heading: rw.heading, radius: RING_RADIUS,
    };

    // Build course rings. Each faces mostly along its incoming leg, leaning a
    // little toward the outgoing one (2:1 weighting of the unit vectors), so the
    // ring is never edge-on at sharp corners. The loop starts at the runway and
    // ends at its approach threshold.
    this.rings = COURSE.map((c, i) => {
      const prev = i === 0 ? this.runwayCentre : COURSE[i - 1];
      const next = i === COURSE.length - 1 ? threshold : COURSE[i + 1];
      const ix = c.x - prev.x, iz = c.z - prev.z, il = Math.hypot(ix, iz) || 1;
      const ox = next.x - c.x, oz = next.z - c.z, ol = Math.hypot(ox, oz) || 1;
      return {
        index: i,
        kind: 'course',
        name: c.name,
        x: c.x, y: c.y, z: c.z,
        heading: headingOf(2 * ix / il + ox / ol, 2 * iz / il + oz / ol),
        radius: RING_RADIUS,
        passed: false,
        next: false,
      };
    });

    this.fuelRings = FUEL.map((f, i) => ({
      index: i,
      kind: 'fuel',
      name: f.name,
      x: f.x, y: f.y, z: f.z,
      heading: f.heading,
      radius: RING_RADIUS,
      passed: false,          // true once used (renderer greys it out)
      used: false,
      next: false,
      gold: true,
      color: '#ffcc33',
    }));

    // Par time per leg, for the speed bonus.
    this._par = this.rings.map((r, i) => {
      const p = i === 0 ? this.runwayCentre : this.rings[i - 1];
      return (Math.hypot(r.x - p.x, r.z - p.z) / PAR_SPEED) * PAR_SLACK;
    });

    this.reset();
  }

  reset() {
    this.currentRing = 0;
    this.ringsPassed = 0;
    this.score = 0;
    this.timer = START_TIME;
    this.elapsed = 0;
    this.started = false;       // clock starts when the plane first moves
    this.state = 'running';     // 'running' | 'complete' | 'failed'
    this.phase = 'rings';       // 'rings' | 'landing'
    this.onFinal = false;       // landing phase: past the approach gate → target the touchdown zone
    this.failReason = null;
    this.ringPoints = 0;
    this.fuelPoints = 0;
    this.timeBonus = 0;         // accumulated ring speed bonuses (+ clock bonus at the end)
    this.landingPoints = 0;
    this.landing = null;        // { sink, speed, rating 0..1, grade }
    this.result = null;         // breakdown once complete
    this.message = null;        // last event text, for a HUD pop-up
    this.messageTime = -Infinity;
    this._legTime = 0;
    this._prev = null;
    for (const r of this.rings) { r.passed = false; r.next = false; }
    for (const f of this.fuelRings) { f.passed = false; f.used = false; }
    this._markNext();
  }

  get totalRings() { return this.rings.length; }

  /**
   * Current target: the next ring; while landing, the approach gate on the
   * extended centreline, then (once past it) the touchdown zone.
   */
  nextTarget() {
    if (this.phase === 'rings' && this.currentRing < this.rings.length) {
      return this.rings[this.currentRing];
    }
    return this.onFinal ? this.touchdownZone : this.approachGate;
  }

  /** Latch / release the final-approach state from the plane's position (with hysteresis). */
  _updateFinal(p) {
    const { fx, fz, threshold } = this._runwayAxis;
    const dx = p.x - threshold.x, dz = p.z - threshold.z;
    const along = dx * fx + dz * fz;          // m past the threshold (negative = before it)
    const lateral = Math.abs(dx * fz - dz * fx); // m off the centreline
    if (!this.onFinal) {
      const pastGate = along >= -APPROACH_GATE_DIST && along <= 0 && lateral <= FINAL_CAPTURE_WIDTH;
      this.onFinal = pastGate || Math.hypot(dx, dz) <= FINAL_CAPTURE_RANGE;
    } else if (lateral > FINAL_LOSE_WIDTH || along < -(APPROACH_GATE_DIST + FINAL_LOSE_BEHIND)
      || along > this.island.runway.length + FINAL_LOSE_OVERRUN) {
      this.onFinal = false; // went around or wandered off: fly the gate again
    }
  }

  update(dt, flight, island = this.island) {
    const p = flight.position;
    const prev = this._prev;
    this._prev = { x: p.x, y: p.y, z: p.z };
    if (this.state !== 'running' || !(dt > 0)) return;

    // Clock starts on the take-off roll.
    if (!this.started && (flight.speed > 0.5 || !flight.onGround)) this.started = true;
    if (this.started) {
      this.elapsed += dt;
      this._legTime += dt;
      this.timer = Math.max(0, this.timer - dt);
    }

    if (flight.crashed) return this._fail(`Crashed: ${flight.crashReason || 'impact'}`);

    // Ring crossings use the straight segment flown this frame.
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z) <= MAX_FRAME_JUMP) {
      if (this.phase === 'rings') {
        const ring = this.rings[this.currentRing];
        if (crossesRing(prev, p, ring)) this._passRing(ring);
      }
      for (const f of this.fuelRings) {
        if (!f.used && crossesRing(prev, p, f)) {
          f.used = f.passed = true;
          flight.fuel = 1;
          this.fuelPoints += FUEL_POINTS;
          this.score += FUEL_POINTS;
          this._say(`FUEL REFILLED  +${FUEL_POINTS}`);
        }
      }
    }

    if (this.phase === 'landing') this._updateFinal(p);

    // Landing phase: a recorded touchdown on the strip completes the sortie.
    if (this.phase === 'landing' && flight.touchedDown && island.isOnRunway(p.x, p.z)) {
      return this._complete(flight);
    }

    if (this.timer <= 0) this._fail('Out of time');
  }

  // ---- Internals --------------------------------------------------------------------

  _passRing(ring) {
    ring.passed = true;
    ring.next = false;
    const par = this._par[ring.index];
    const bonus = Math.round(clamp((par - this._legTime) * RING_BONUS_RATE, 0, RING_BONUS_MAX));
    this.ringPoints += RING_POINTS;
    this.timeBonus += bonus;
    this.score += RING_POINTS + bonus;
    this.timer += RING_TIME_ADD;
    this.ringsPassed++;
    this.currentRing++;
    this._legTime = 0;
    if (this.currentRing >= this.rings.length) {
      this.phase = 'landing';
      this._say(`ALL RINGS!  +${RING_POINTS + bonus}  — LAND`);
    } else {
      this._say(`RING ${this.ringsPassed}/${this.rings.length}  +${RING_POINTS + bonus}  +${RING_TIME_ADD}s`);
    }
    this._markNext();
  }

  _complete(flight) {
    const sink = flight.touchdownSink ?? 0;
    const speed = flight.touchdownSpeed ?? 0;
    // Gentle: 0 m/s sink = full marks, TOUCHDOWN_MAX_SINK = none (eased so firm hurts more).
    const sinkScore = Math.pow(clamp(1 - sink / LANDING_SINK_MAX, 0, 1), 1.5);
    // Slow: at or below stall + 3 m/s = full marks, crash speed = none.
    const speedScore = clamp(
      (LANDING_SPEED_MAX - speed) / (LANDING_SPEED_MAX - LANDING_SPEED_IDEAL), 0, 1);
    const rating = 0.6 * sinkScore + 0.4 * speedScore;
    const grade = rating >= 0.9 ? 'BUTTER' : rating >= 0.7 ? 'SMOOTH' : rating >= 0.45 ? 'FIRM' : 'HARD';
    this.landing = { sink, speed, rating, grade };
    this.landingPoints = Math.round(LANDING_POINTS_MAX * rating);

    const clockBonus = Math.round(this.timer * FINISH_TIME_RATE);
    this.timeBonus += clockBonus;
    this.score += this.landingPoints + clockBonus;

    this.result = {
      ringPoints: this.ringPoints,
      fuelPoints: this.fuelPoints,
      timeBonus: this.timeBonus,
      landingPoints: this.landingPoints,
      total: this.ringPoints + this.fuelPoints + this.timeBonus + this.landingPoints,
    };
    this.score = this.result.total;
    this.state = 'complete';
    this._say(`${grade} LANDING  +${this.landingPoints}`);
  }

  _fail(reason) {
    this.state = 'failed';
    this.failReason = reason;
    this._say(reason.toUpperCase());
    this._markNext();
  }

  _markNext() {
    for (const r of this.rings) r.next = false;
    if (this.state === 'running' && this.phase === 'rings') {
      this.rings[this.currentRing].next = true;
    }
  }

  _say(text) {
    this.message = text;
    this.messageTime = this.elapsed;
  }
}

/**
 * True if the segment a→b crosses the ring's vertical plane with the crossing
 * point inside the ring radius. Either direction counts.
 */
function crossesRing(a, b, ring) {
  const nx = Math.sin(ring.heading), nz = -Math.cos(ring.heading); // plane normal (horizontal)
  const da = (a.x - ring.x) * nx + (a.z - ring.z) * nz;
  const db = (b.x - ring.x) * nx + (b.z - ring.z) * nz;
  if (da === db || (da > 0 && db > 0) || (da < 0 && db < 0)) return false;
  const t = da / (da - db);
  const qx = a.x + (b.x - a.x) * t - ring.x;
  const qy = a.y + (b.y - a.y) * t - ring.y;
  const qz = a.z + (b.z - a.z) * t - ring.z;
  return qx * qx + qy * qy + qz * qz <= ring.radius * ring.radius;
}

export const MISSION_CONSTANTS = Object.freeze({
  RING_RADIUS, START_TIME, RING_TIME_ADD, RING_POINTS, FUEL_POINTS, LANDING_POINTS_MAX,
});
