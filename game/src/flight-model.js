// Cloudhaven Air Rally — aircraft flight model.
//
// Coordinate system: x east, z south, y up, all in metres.
// Heading is measured clockwise from north (north = -z), so the horizontal
// forward vector for heading h is ( sin h, 0, -cos h ).
// Positive pitch = nose up. Positive roll = right wing down (turns right,
// i.e. increases heading).
//
// Determinism: the model uses no randomness, no clock and no hidden state.
// update() splits large frames into equal fixed sub-steps, so the same dt and
// the same input sequence always produce exactly the same trajectory.

// ---- Tunable constants ------------------------------------------------------

const G = 9.81;                  // gravity, m/s²

const STALL_SPEED = 26;          // m/s — below this the wings stop carrying the plane
const ROTATE_SPEED = 31;         // m/s — minimum speed at which the nose can be raised for take-off
const MAX_THRUST_ACCEL = 9.0;    // m/s² of thrust at full throttle
const IDLE_THROTTLE = 0.05;      // throttle setting after resetOnRunway()
const DRAG_K = 0.0018;           // quadratic drag: a = DRAG_K·v²  (top speed ≈ sqrt(9/0.0018) ≈ 70 m/s)
const MAX_SPEED = 90;            // hard safety cap, m/s

const THROTTLE_RATE = 0.4;       // throttle change per second while W/S held
const FUEL_BURN_RATE = 1 / 315;  // fuel fraction per second at full throttle (~5¼ min; ∝ throttle,
                                 // so 65 % throttle stretches it to ~485 s)
const LOW_FUEL = 0.2;            // low-fuel warning: ~63 s at full throttle, ~97 s at 65 %

const PITCH_RATE = 0.55;         // rad/s of elevator authority
const PITCH_MIN = -0.6;          // rad
const PITCH_MAX = 0.6;           // rad
const ROLL_RATE = 1.2;           // rad/s of aileron authority
const ROLL_MAX = 1.0;            // rad (~57°)
// Wings-level return with no roll input: rate ∝ bank (ROLL_RECENTER_GAIN·|roll|),
// capped just below aileron authority so releasing never snaps harder than the
// stick, and floored so the last few degrees settle promptly instead of creeping.
const ROLL_RECENTER_GAIN = 2.6;  // 1/s
const ROLL_RECENTER_MAX = 1.1;   // rad/s
const ROLL_RECENTER_MIN = 0.3;   // rad/s
const ROLL_COUNTER_BOOST = 1.5;  // aileron rate multiplier when rolling back toward wings-level
const TURN_GAIN = 0.75;          // rad/s of heading change at sin(roll) = 1 and full lift
const RUDDER_AIR = 0.12;         // rad/s yaw from rudder in the air
const RUDDER_GROUND = 0.6;       // rad/s nose-wheel steering on the ground

const STALL_SINK_MAX = 18;       // m/s extra sink rate when lift is fully gone
const STALL_NOSE_DROP = 0.5;     // rad/s the nose falls at zero lift
const BANK_SINK = 4;             // m/s extra sink at 90° bank (lift tilted away from vertical)

const GROUND_FRICTION = 0.35;    // m/s² rolling resistance
const BRAKE_DECEL = 4.5;         // m/s² extra deceleration with KeyB
const GROUND_PITCH_MAX = 0.25;   // rad — tail strike limit while wheels are down
const OFF_RUNWAY_SAFE_SPEED = 12;// m/s — rolling onto rough ground faster than this is a crash

const TOUCHDOWN_MAX_SINK = 3.0;  // m/s — firmer than this is a hard landing
const TOUCHDOWN_MAX_SPEED = 46;  // m/s — faster than this is a crash on contact
const TOUCHDOWN_MAX_ROLL = 0.35; // rad — wing-tip strike beyond this
const TOUCHDOWN_MIN_PITCH = -0.12; // rad — nose-first contact below this

const MAX_SUBSTEP = 1 / 60;      // s — larger frames are split into equal sub-steps

// ---- Helpers ----------------------------------------------------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const TWO_PI = Math.PI * 2;

/** True if any of the given key codes is held. Accepts a string or an array. */
function held(input, codes) {
  if (!input) return false;
  if (Array.isArray(codes)) return codes.some((c) => input.pressed(c));
  return input.pressed(codes);
}

/** Wrap an angle into [0, 2π). */
function wrapAngle(a) {
  a %= TWO_PI;
  return a < 0 ? a + TWO_PI : a;
}

/** Hands-off wings-level return rate (rad/s, ≥ 0) for a given bank angle. */
export function rollRecenterRate(roll) {
  return clamp(ROLL_RECENTER_GAIN * Math.abs(roll), ROLL_RECENTER_MIN, ROLL_RECENTER_MAX);
}

/** Aileron rate multiplier: counter-steer (input opposing the bank) bites harder. */
export function rollInputGain(rollInput, roll) {
  return rollInput * roll < 0 ? ROLL_COUNTER_BOOST : 1;
}

// ---- Flight model -----------------------------------------------------------

export class FlightModel {
  constructor() {
    this.position = { x: 0, y: 0, z: 0 };
    this.velocity = { x: 0, y: 0, z: 0 }; // world-space velocity, m/s (handy for cameras/effects)
    this.heading = 0;
    this.pitch = 0;
    this.roll = 0;
    this.speed = 0;              // airspeed along the flight path, m/s
    this.throttle = 0;
    this.fuel = 1;
    this.onGround = true;
    this.crashed = false;
    this.crashReason = null;
    this.verticalSpeed = 0;      // m/s, positive = climbing
    this.liftFactor = 0;         // 0..1, exposed for a stall warning
    this.stalled = false;
    this.groundHeight = 0;       // terrain height under the plane after the last update
    this.touchdownSink = null;   // m/s sink rate at the last touchdown
    this.touchdownSpeed = null;  // m/s speed at the last touchdown
    this.touchedDown = false;    // true only for the update in which a touchdown happened
    this.time = 0;               // simulated seconds since reset
  }

  /** Place the plane at the threshold of a runway, aligned with it, engine idling. */
  resetOnRunway(runway) {
    // The runway object gives its centre (x, z), heading, length and width.
    // Start a little in from the threshold: go back half a length minus a margin.
    const back = Math.max(0, runway.length / 2 - 20);
    const fx = Math.sin(runway.heading);
    const fz = -Math.cos(runway.heading);
    this.position.x = runway.x - fx * back;
    this.position.z = runway.z - fz * back;
    this.position.y = runway.y ?? 0; // corrected to terrain height on the first update
    this._snapToGroundOnNextUpdate = true;

    this.velocity.x = this.velocity.y = this.velocity.z = 0;
    this.heading = wrapAngle(runway.heading);
    this.pitch = 0;
    this.roll = 0;
    this.speed = 0;
    this.throttle = IDLE_THROTTLE;
    this.fuel = 1;
    this.onGround = true;
    this.crashed = false;
    this.crashReason = null;
    this.verticalSpeed = 0;
    this.liftFactor = 0;
    this.stalled = false;
    this.touchdownSink = null;
    this.touchdownSpeed = null;
    this.touchedDown = false;
    this.time = 0;
  }

  /**
   * Advance the simulation by dt seconds.
   * input: Input instance (pressed(code)); island: { heightAt(x,z), isOnRunway(x,z), waterLevel? }.
   */
  update(dt, input, island) {
    this.touchedDown = false;
    if (this.crashed || !(dt > 0)) return;

    if (this._snapToGroundOnNextUpdate) {
      this.position.y = island.heightAt(this.position.x, this.position.z);
      this._snapToGroundOnNextUpdate = false;
    }

    // Split into equal sub-steps so behaviour does not depend on frame rate
    // spikes, while staying exactly reproducible for a given dt.
    const steps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP));
    const h = dt / steps;
    for (let i = 0; i < steps && !this.crashed; i++) this._step(h, input, island);
  }

  _step(dt, input, island) {
    this.time += dt;
    const waterLevel = island.waterLevel ?? 0;

    // ---- Engine: throttle slews at a limited rate, fuel burns ∝ throttle ----
    if (held(input, 'KeyW')) this.throttle += THROTTLE_RATE * dt;
    if (held(input, 'KeyS')) this.throttle -= THROTTLE_RATE * dt;
    this.throttle = clamp(this.throttle, 0, 1);
    this.fuel = Math.max(0, this.fuel - FUEL_BURN_RATE * this.throttle * dt);
    const thrust = this.fuel > 0 ? MAX_THRUST_ACCEL * this.throttle : 0;

    // ---- Lift factor --------------------------------------------------------
    // Lift ∝ v², so (v / v_stall)² is the fraction of weight the wings can carry
    // in level flight. Clamped to 1: above stall speed the plane is fully supported.
    const ratio = this.speed / STALL_SPEED;
    this.liftFactor = clamp(ratio * ratio, 0, 1);
    const lift = this.liftFactor;

    // ---- Control inputs ---------------------------------------------------
    // Control surfaces lose authority at low speed, but keep a little so the
    // pilot can still push the nose down to recover from a stall.
    const authority = clamp(ratio, 0.3, 1);
    let pitchInput = 0;
    if (held(input, 'ArrowUp')) pitchInput += 1;
    if (held(input, 'ArrowDown')) pitchInput -= 1;
    let rollInput = 0;
    if (held(input, 'ArrowRight')) rollInput += 1;
    if (held(input, 'ArrowLeft')) rollInput -= 1;
    let yawInput = 0;
    if (held(input, 'KeyD')) yawInput += 1;
    if (held(input, 'KeyA')) yawInput -= 1;
    const braking = held(input, 'KeyB');

    if (this.onGround) {
      this._groundStep(dt, island, thrust, pitchInput, yawInput, braking, waterLevel);
      return;
    }

    // ---- Airborne attitude --------------------------------------------------
    this.pitch += pitchInput * PITCH_RATE * authority * dt;

    if (rollInput !== 0) {
      // Counter-steer toward level is boosted, but only until the wings pass
      // level (clamped at zero), so a reversal into the new bank starts at the
      // normal, smooth rate.
      const gain = rollInputGain(rollInput, this.roll);
      const next = this.roll + rollInput * ROLL_RATE * gain * authority * dt;
      this.roll = gain > 1 && next * this.roll < 0 ? 0 : next;
    } else {
      // Return to wings-level, never overshooting zero.
      const r = rollRecenterRate(this.roll) * dt;
      this.roll = Math.abs(this.roll) <= r ? 0 : this.roll - Math.sign(this.roll) * r;
    }
    this.roll = clamp(this.roll, -ROLL_MAX, ROLL_MAX);

    // Stall: as lift fades, the nose drops on its own.
    this.stalled = lift < 1;
    this.pitch -= STALL_NOSE_DROP * (1 - lift) * dt;
    this.pitch = clamp(this.pitch, PITCH_MIN, PITCH_MAX);

    // Banked turn: the horizontal component of lift (∝ sin roll) turns the
    // flight path, so heading rate ∝ sin(roll)·lift. Rudder adds a little yaw.
    this.heading = wrapAngle(
      this.heading + (TURN_GAIN * Math.sin(this.roll) * lift + RUDDER_AIR * yawInput * authority) * dt,
    );

    // ---- Speed along the flight path ---------------------------------------
    // Gravity component along the path is −g·sin(pitch): climbing bleeds speed,
    // diving gains it. Drag is quadratic in speed.
    const accel = thrust - G * Math.sin(this.pitch) - DRAG_K * this.speed * this.speed;
    this.speed = clamp(this.speed + accel * dt, 0, MAX_SPEED);

    // ---- Velocity and integration ------------------------------------------
    // The path climb rate is speed·sin(pitch). On top of that the plane sinks
    // when the wings cannot carry its weight: (1 − lift) of the stall sink, plus
    // a bank penalty because only cos(roll) of the lift points upward.
    const sink = STALL_SINK_MAX * (1 - lift) + BANK_SINK * (1 - Math.cos(this.roll)) * lift;
    const horiz = this.speed * Math.cos(this.pitch);
    this.velocity.x = horiz * Math.sin(this.heading);
    this.velocity.z = -horiz * Math.cos(this.heading);
    this.velocity.y = this.speed * Math.sin(this.pitch) - sink;
    this.verticalSpeed = this.velocity.y;

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    // ---- Contact checks -----------------------------------------------------
    const ground = island.heightAt(this.position.x, this.position.z);
    this.groundHeight = ground;
    const overWater = ground < waterLevel;
    const surface = overWater ? waterLevel : ground;
    if (this.position.y > surface) return;

    this.position.y = surface;
    if (overWater) return this._crash('water');
    if (!island.isOnRunway(this.position.x, this.position.z)) return this._crash('terrain');

    const sinkRate = Math.max(0, -this.verticalSpeed);
    if (sinkRate > TOUCHDOWN_MAX_SINK) return this._crash('hard landing');
    if (this.speed > TOUCHDOWN_MAX_SPEED) return this._crash('too fast');
    if (Math.abs(this.roll) > TOUCHDOWN_MAX_ROLL) return this._crash('wing strike');
    if (this.pitch < TOUCHDOWN_MIN_PITCH) return this._crash('nose first');

    // Good touchdown on the strip: record it for scoring and start rolling.
    this.touchdownSink = sinkRate;
    this.touchdownSpeed = this.speed;
    this.touchedDown = true;
    this.onGround = true;
    this.roll = 0;
    this.pitch = clamp(this.pitch, 0, GROUND_PITCH_MAX);
    this.verticalSpeed = 0;
    this.velocity.y = 0;
    this.stalled = false;
  }

  _groundStep(dt, island, thrust, pitchInput, yawInput, braking, waterLevel) {
    this.roll = 0;
    this.stalled = false;

    // Nose-wheel steering: effective once the plane is rolling, full at 8 m/s.
    const steer = clamp(this.speed / 8, 0, 1);
    this.heading = wrapAngle(this.heading + RUDDER_GROUND * yawInput * steer * dt);

    // Rotation: the nose can only come up once past rotation speed; below it
    // the nose wheel stays down and any raised nose settles back.
    if (this.speed >= ROTATE_SPEED && pitchInput > 0) {
      this.pitch += PITCH_RATE * dt;
    } else if (pitchInput < 0 || this.speed < ROTATE_SPEED) {
      this.pitch -= PITCH_RATE * dt;
    }
    this.pitch = clamp(this.pitch, 0, GROUND_PITCH_MAX);

    // Ground roll: thrust minus drag, rolling friction and brakes. Friction and
    // brakes only oppose motion, so they cannot push the plane backwards.
    let accel = thrust - DRAG_K * this.speed * this.speed;
    let resist = GROUND_FRICTION + (braking ? BRAKE_DECEL : 0);
    this.speed += accel * dt;
    this.speed = Math.max(0, this.speed - resist * dt);
    this.speed = Math.min(this.speed, MAX_SPEED);

    this.velocity.x = this.speed * Math.sin(this.heading);
    this.velocity.z = -this.speed * Math.cos(this.heading);
    this.velocity.y = 0;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    const ground = island.heightAt(this.position.x, this.position.z);
    this.groundHeight = ground;
    if (ground < waterLevel) {
      this.position.y = waterLevel;
      return this._crash('water');
    }

    // Lift-off: past rotation speed with the nose raised, the wings take over.
    if (this.speed >= ROTATE_SPEED && this.pitch > 0.02 && pitchInput > 0) {
      this.onGround = false;
      this.position.y = ground + 0.05;
      this.verticalSpeed = this.speed * Math.sin(this.pitch);
      this.velocity.y = this.verticalSpeed;
      return;
    }

    // Wheels follow the terrain. Vertical speed reports the terrain slope rate.
    this.verticalSpeed = (ground - this.position.y) / dt;
    this.position.y = ground;

    // Running off the strip at speed wrecks the undercarriage.
    if (this.speed > OFF_RUNWAY_SAFE_SPEED && !island.isOnRunway(this.position.x, this.position.z)) {
      this._crash('terrain');
    }
  }

  _crash(reason) {
    this.crashed = true;
    this.crashReason = reason;
    this.speed = 0;
    this.throttle = 0;
    this.velocity.x = this.velocity.y = this.velocity.z = 0;
    this.verticalSpeed = 0;
  }
}

export const FLIGHT_CONSTANTS = Object.freeze({
  STALL_SPEED, ROTATE_SPEED, TOUCHDOWN_MAX_SINK, TOUCHDOWN_MAX_SPEED, IDLE_THROTTLE,
  ROLL_RATE, ROLL_COUNTER_BOOST, FUEL_BURN_RATE, LOW_FUEL,
});
