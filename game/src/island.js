// Cloudhaven Air Rally — island world data.
//
// Coordinate system (matches flight-model.js):
//   x = east, z = south (north is -z), y = up, metres.
//   Heading 0 = north (-z); the forward vector for heading h is (sin h, 0, -cos h).
//
// The world is ~5200 m × 5200 m centred on (0, 0). Sea level is y = 0; offshore
// the sea floor falls smoothly to about -70 m.
//
// Everything here is deterministic: terrain is analytic and the town / trees
// come from a small seeded PRNG, so every load produces the same island.

const WORLD_SIZE = 5200;
const WATER_LEVEL = 0;

// ---- Coastline ---------------------------------------------------------------
const COAST_BASE = 1950;          // mean coast radius (m)
const POINT_ANGLE = -0.3;         // eastern point, slightly north of due east
const POINT_REACH = 420;          // how far the point juts out (m)
const POINT_WIDTH = 0.16;         // angular half-width of the point (rad)

// ---- Shore profile -------------------------------------------------------------
const SHORE_HEIGHT = 30;          // inland plain height the shore rises to (m)
const SHORE_SCALE = 107;          // inland e-folding distance (m)
const SEA_DEPTH = 70;             // asymptotic depth offshore (m)
const SEA_SCALE = 250;            // offshore e-folding distance (m) — slope matches the shore at s = 0
const INLAND_MASK = 350;          // features fade in over this distance from the coast (m)

// ---- Hill massif (north-west) ----------------------------------------------------
const MASSIF_X = -1100, MASSIF_Z = -950, MASSIF_H = 212, MASSIF_S2 = 2 * 480 * 480;
const SPUR_X = -650, SPUR_Z = -1380, SPUR_H = 140, SPUR_S2 = 2 * 300 * 300;

// ---- Runway (southern plain) -----------------------------------------------------
const RUNWAY = Object.freeze({
  x: -150,
  z: 1150,
  heading: 0.3,                   // radians, 0 = north (-z)
  length: 900,
  width: 45,
  y: 32,                          // strip elevation (m)
});
const RUNWAY_FLAT_PAD_L = 60;     // flat apron beyond each threshold (m)
const RUNWAY_FLAT_PAD_W = 25;     // flat shoulder either side (m)
const RUNWAY_BLEND = 200;         // blend distance back to natural terrain (m)
const RUNWAY_MARGIN_L = 10;       // isOnRunway tolerance along the strip (m)
const RUNWAY_MARGIN_W = 6;        // isOnRunway tolerance across the strip (m)

const RW_SIN = Math.sin(RUNWAY.heading);
const RW_COS = Math.cos(RUNWAY.heading);
const RW_HALF_L = RUNWAY.length / 2;
const RW_HALF_W = RUNWAY.width / 2;

// ---- Town plateau (east coast harbour) ----------------------------------------------
const TOWN_X = 1680, TOWN_Z = 300;
const TOWN_AX = 320, TOWN_AZ = 240; // flat core ellipse semi-axes (m)
const TOWN_Y = 14;                  // plateau elevation (m)
const TOWN_BLEND = 150;
const TOWN_MIN_AXIS = Math.min(TOWN_AX, TOWN_AZ);

// ---- Helpers ------------------------------------------------------------------------
function smoothstep(e0, e1, v) {
  const t = v <= e0 ? 0 : v >= e1 ? 1 : (v - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}

/** mulberry32: tiny, fast, seeded 32-bit PRNG returning floats in [0, 1). */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Coast radius (m) in direction theta = atan2(z, x). */
function coastRadius(theta) {
  const dp = (theta - POINT_ANGLE) / POINT_WIDTH;
  return (
    COAST_BASE +
    120 * Math.sin(3 * theta + 0.7) +
    70 * Math.sin(5 * theta + 2.1) +
    35 * Math.sin(9 * theta + 4.0) +
    POINT_REACH * Math.exp(-dp * dp)
  );
}

/** Natural terrain before the runway / town are levelled. */
function naturalHeight(x, z) {
  const r = Math.sqrt(x * x + z * z);
  const s = coastRadius(Math.atan2(z, x)) - r; // metres inland (negative offshore)

  if (s <= 0) {
    // Offshore: smooth fall to the sea floor.
    return -SEA_DEPTH * (1 - Math.exp(s / SEA_SCALE));
  }

  let h = SHORE_HEIGHT * (1 - Math.exp(-s / SHORE_SCALE));
  const m = smoothstep(0, INLAND_MASK, s);

  // Rolling fields everywhere inland (gives ~20-60 m on the southern plain).
  const rolling =
    15 * Math.sin(x * 0.004 + 1.0) * Math.cos(z * 0.0035 - 0.4) +
    8 * Math.sin((x + z) * 0.009 + 2.3) +
    5 * Math.cos((x - 0.6 * z) * 0.017);

  // North-west massif with a ridged texture and a secondary spur.
  let dx = x - MASSIF_X, dz = z - MASSIF_Z;
  let massif = MASSIF_H * Math.exp(-(dx * dx + dz * dz) / MASSIF_S2) *
    (1 + 0.12 * Math.sin(x * 0.006 + 0.5) * Math.cos(z * 0.005 - 1.2));
  dx = x - SPUR_X; dz = z - SPUR_Z;
  massif += SPUR_H * Math.exp(-(dx * dx + dz * dz) / SPUR_S2);

  h += m * (rolling + massif);
  return h;
}

/** Runway-local coordinates: along the heading and to the right of it. */
function runwayLocal(x, z) {
  const dx = x - RUNWAY.x, dz = z - RUNWAY.z;
  return {
    along: dx * RW_SIN - dz * RW_COS,
    across: dx * RW_COS + dz * RW_SIN,
  };
}

/** Distance (m) outside the town plateau's flat core; 0 inside. Approximate outside. */
function townOutside(x, z) {
  const ex = (x - TOWN_X) / TOWN_AX, ez = (z - TOWN_Z) / TOWN_AZ;
  const q = Math.sqrt(ex * ex + ez * ez);
  return q <= 1 ? 0 : (q - 1) * TOWN_MIN_AXIS;
}

/**
 * Terrain height (m) at world (x, z). Pure and allocation-free.
 * Inside the runway's flat zone it returns exactly RUNWAY.y; inside the town
 * plateau's core it returns exactly TOWN_Y.
 */
function heightAt(x, z) {
  // Runway flat zone (checked first; it has priority and the zones don't overlap).
  const dx = x - RUNWAY.x, dz = z - RUNWAY.z;
  const along = dx * RW_SIN - dz * RW_COS;
  const across = dx * RW_COS + dz * RW_SIN;
  const ea = Math.abs(along) - (RW_HALF_L + RUNWAY_FLAT_PAD_L);
  const ew = Math.abs(across) - (RW_HALF_W + RUNWAY_FLAT_PAD_W);
  if (ea <= 0 && ew <= 0) return RUNWAY.y;

  // Town plateau core.
  const td = townOutside(x, z);
  if (td === 0) return TOWN_Y;

  let h = naturalHeight(x, z);

  // Blend down from the town plateau.
  if (td < TOWN_BLEND) {
    const w = 1 - smoothstep(0, TOWN_BLEND, td);
    h += (TOWN_Y - h) * w;
  }

  // Blend down from the runway flat zone.
  const ax = ea > 0 ? ea : 0, aw = ew > 0 ? ew : 0;
  const rd2 = ax * ax + aw * aw;
  if (rd2 < RUNWAY_BLEND * RUNWAY_BLEND) {
    const w = 1 - smoothstep(0, RUNWAY_BLEND, Math.sqrt(rd2));
    h += (RUNWAY.y - h) * w;
  }
  return h;
}

/** True if (x, z) is on the paved strip (with a small tolerance). */
function isOnRunway(x, z) {
  const dx = x - RUNWAY.x, dz = z - RUNWAY.z;
  const along = dx * RW_SIN - dz * RW_COS;
  const across = dx * RW_COS + dz * RW_SIN;
  return (
    Math.abs(along) <= RW_HALF_L + RUNWAY_MARGIN_L &&
    Math.abs(across) <= RW_HALF_W + RUNWAY_MARGIN_W
  );
}

// ---- Town ---------------------------------------------------------------------------
const ROOF_COLOURS = [0xb5502f, 0xc4623a, 0x9e4a32, 0x5b6d7a, 0x7a3b2e, 0xd08a4a];

function buildTown(rng) {
  const houses = [];
  const GAP = 4;
  const EDGE = 12; // keep houses this far inside the flat core's edge
  let attempts = 0;
  while (houses.length < 90 && attempts < 6000) {
    attempts++;
    // Bias towards the seaward (east) side: the harbour front is busiest.
    const u = Math.sqrt(rng());
    const x = TOWN_X - TOWN_AX + u * 2 * TOWN_AX;
    const z = TOWN_Z + (rng() * 2 - 1) * TOWN_AZ;
    const big = rng() < 0.15;
    const w = big ? 18 + rng() * 14 : 8 + rng() * 8;
    const d = big ? 12 + rng() * 10 : 8 + rng() * 6;
    const h = big ? 8 + rng() * 6 : 4.5 + rng() * 4;

    // All four corners (plus the edge margin) must sit on the flat core.
    const hw = w / 2 + EDGE, hd = d / 2 + EDGE;
    if (
      townOutside(x - hw, z - hd) > 0 || townOutside(x + hw, z - hd) > 0 ||
      townOutside(x - hw, z + hd) > 0 || townOutside(x + hw, z + hd) > 0
    ) continue;

    let clash = false;
    for (const o of houses) {
      if (
        Math.abs(x - o.x) < (w + o.w) / 2 + GAP &&
        Math.abs(z - o.z) < (d + o.d) / 2 + GAP
      ) { clash = true; break; }
    }
    if (clash) continue;

    const roof = ROOF_COLOURS[Math.floor(rng() * ROOF_COLOURS.length)];
    houses.push({
      x: round1(x), z: round1(z), w: round1(w), d: round1(d), h: round1(h), roof,
    });
  }
  return houses;
}

// ---- Trees --------------------------------------------------------------------------
function treeAllowed(x, z) {
  // Keep the strip, its shoulders and the approach / climb-out corridors clear.
  const { along, across } = runwayLocal(x, z);
  if (Math.abs(across) < RW_HALF_W + 90 && Math.abs(along) < RW_HALF_L + 900) return false;
  if (Math.abs(across) < RW_HALF_W + RUNWAY_FLAT_PAD_W + 40 &&
      Math.abs(along) < RW_HALF_L + RUNWAY_FLAT_PAD_L + 60) return false;
  // Not in town or on its slopes.
  if (townOutside(x, z) < TOWN_BLEND) return false;
  // On land, above the beach, below the high massif.
  const h = heightAt(x, z);
  return h > 4 && h < 140;
}

function buildTrees(rng) {
  const trees = [];
  const push = (x, z, big) => {
    if (!treeAllowed(x, z)) return;
    trees.push({ x: round1(x), z: round1(z), h: round1(big ? 9 + rng() * 7 : 5 + rng() * 6) });
  };

  // Groves scattered over the fields (mostly the south and centre of the island).
  for (let g = 0; g < 45; g++) {
    const cx = -1700 + rng() * 3200;
    const cz = -500 + rng() * 2100;
    const n = 6 + Math.floor(rng() * 14);
    const spread = 25 + rng() * 60;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, r = spread * Math.sqrt(rng());
      push(cx + Math.cos(a) * r, cz + Math.sin(a) * r, rng() < 0.3);
    }
  }
  // Hedgerow lines along field boundaries.
  for (let l = 0; l < 14; l++) {
    const x0 = -1600 + rng() * 3000, z0 = -300 + rng() * 1900;
    const a = rng() * Math.PI;
    const len = 150 + rng() * 300;
    for (let t = 0; t < len; t += 12 + rng() * 8) {
      push(x0 + Math.cos(a) * t, z0 + Math.sin(a) * t, false);
    }
  }
  // Lone trees everywhere on the island.
  for (let i = 0; i < 260; i++) {
    push(-2300 + rng() * 4600, -2300 + rng() * 4600, rng() < 0.4);
  }
  return trees;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// ---- Lighthouse ---------------------------------------------------------------------
function buildLighthouse() {
  const r = coastRadius(POINT_ANGLE) - 45;
  const x = r * Math.cos(POINT_ANGLE);
  const z = r * Math.sin(POINT_ANGLE);
  return { x: round1(x), z: round1(z), h: 24 };
}

// ---- Public API ---------------------------------------------------------------------
/**
 * Build the Cloudhaven island.
 * Returns {
 *   size, waterLevel,
 *   heightAt(x, z)      terrain height in metres (pure, fast),
 *   runway              { x, z, heading, length, width, y },
 *   isOnRunway(x, z)    point-on-strip test with a small margin,
 *   town                [{ x, z, w, d, h, roof }]  axis-aligned blocks; w along x,
 *                       d along z, h wall height, roof = 0xRRGGBB colour; base y = town plateau,
 *   townLevel           plateau elevation (m),
 *   trees               [{ x, z, h }],
 *   lighthouse          { x, z, h },
 * }
 */
export function createIsland(seed = 0xc10d4a7e) {
  const rng = makeRng(seed);
  const town = buildTown(rng);
  const trees = buildTrees(rng);
  return {
    size: WORLD_SIZE,
    waterLevel: WATER_LEVEL,
    heightAt,
    runway: { ...RUNWAY },
    isOnRunway,
    town,
    townLevel: TOWN_Y,
    trees,
    lighthouse: buildLighthouse(),
  };
}
