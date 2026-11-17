import { BOUNDS, GEM, ROCK_ALBEDO, SHAFT, SUN_DIR, cells, clamp, fbm, mix, rng, smoothstep } from "./shared";

// The cave as a field over space: negative in the air, positive in the rock, and roughly the distance (m) to the
// nearest wall. It is worked out once on a grid; the walls, their shading and the light that bounces all come from it.

const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);

function ellipsoid(x: number, y: number, z: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number) {
  const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
  const k0 = Math.sqrt(px * px + py * py + pz * pz), k1 = Math.sqrt((px * px) / (rx * rx) + (py * py) / (ry * ry) + (pz * pz) / (rz * rz));
  return k1 > 1e-6 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
}

function capsule(x: number, y: number, z: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, ra: number, rb: number) {
  const px = x - ax, py = y - ay, pz = z - az;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const h = clamp((px * dx + py * dy + pz * dz) / (dx * dx + dy * dy + dz * dz), 0, 1);
  const qx = px - dx * h, qy = py - dy * h, qz = pz - dz * h;
  return Math.sqrt(qx * qx + qy * qy + qz * qz) - (ra + (rb - ra) * h);
}

const hole = (x: number, y: number, z: number) => capsule(x, y, z, SHAFT.foot.x, SHAFT.foot.y - 0.6, SHAFT.foot.z, SHAFT.top.x, SHAFT.top.y, SHAFT.top.z, 1.75, 3.3);

// the chamber and what opens off it, before the rock is roughened
const CHAMBER = { x: 0, y: 3.0, z: -0.5, rx: 7.2, ry: 4.7, rz: 7.6 };
function hollow(x: number, y: number, z: number) {
  let a = ellipsoid(x, y, z, CHAMBER.x, CHAMBER.y, CHAMBER.z, CHAMBER.rx, CHAMBER.ry, CHAMBER.rz);
  // the way in, coming down from behind the visitor
  a = smin(a, capsule(x, y, z, 0.3, 2.0, 5.0, 1.0, 2.5, 11.5, 2.5, 2.1), 1.6);
  a = smin(a, capsule(x, y, z, 1.0, 2.5, 11.5, -0.6, 3.25, 25, 2.1, 2.0), 1.0);
  // a second room behind the crystals, and a low one off to the left
  a = smin(a, ellipsoid(x, y, z, 3.0, 2.6, -9.6, 4.6, 3.1, 4.2), 1.8);
  a = smin(a, ellipsoid(x, y, z, -7.4, 1.9, 1.8, 3.0, 2.3, 3.3), 1.4);
  // where the roof has fallen in: a hole up to the daylight, wider at the top
  a = smin(a, hole(x, y, z), 0.9);
  return a;
}

// where the sun's line down the hole meets the floor
export const PILE = { x: SHAFT.foot.x + (SUN_DIR.x * SHAFT.foot.y) / -SUN_DIR.y, z: SHAFT.foot.z + (SUN_DIR.z * SHAFT.foot.y) / -SUN_DIR.y };

const floorRaw = (x: number, z: number) =>
  0.2 +
  1.15 * (fbm(x * 0.21 + 4.2, 0.5, z * 0.21 + 1.7, 3) - 0.46) -
  // the pool in front of the crystals, and a smaller one off to the right
  0.62 * Math.exp(-(((x + 0.4) / 3.3) ** 2 + ((z - 4.4) / 2.1) ** 2)) -
  0.5 * Math.exp(-(((x - 3.9) / 1.7) ** 2 + ((z - 0.2) / 2.3) ** 2)) +
  // what fell from the roof lies in a heap under the hole
  0.75 * Math.exp(-(((x - PILE.x) / 2.3) ** 2 + ((z - PILE.z) / 2.3) ** 2)) +
  // the way in comes down into the chamber
  1.0 * smoothstep(6.5, 13.5, z);
const MOUND = 1.02 - floorRaw(0, 0);
// the height of the floor (m): the crystals stand on a mound in the middle of it
export const floorAt = (x: number, z: number) => floorRaw(x, z) + MOUND * Math.exp(-(x * x + z * z) / (1.2 * 1.2));

// where the visitor walks in: nothing grows from the floor there
export const pathX = (z: number) => mix(-0.95, 0.9, smoothstep(5.5, 10.5, z));

// Dripstone: stone that hangs from the roof where water drips, and stone that stands under it. [x, z, tip height, how
// fast it widens, 1 hanging / -1 standing]
type Spike = [number, number, number, number, number];
export const spikes: Spike[] = [];
const BUCKET = 2;
const buckets = new Map<number, number[]>();
// the tips that drip into a pool: [x, tip height, z]
export const drips: [number, number, number][] = [];
{
  const r = rng(23);
  const roof = (x: number, z: number) => {
    const u = 1 - ((x - CHAMBER.x) / CHAMBER.rx) ** 2 - ((z - CHAMBER.z) / CHAMBER.rz) ** 2;
    return u > 0 ? CHAMBER.y + CHAMBER.ry * Math.sqrt(u) : -1;
  };
  for (let c = 0; c < 26; c++) {
    const ca = r() * Math.PI * 2, cr = Math.sqrt(r()) * 0.88;
    const cx = CHAMBER.x + Math.cos(ca) * cr * CHAMBER.rx, cz = CHAMBER.z + Math.sin(ca) * cr * CHAMBER.rz;
    const n = 3 + Math.floor(r() * 7);
    for (let i = 0; i < n; i++) {
      const x = cx + (r() + r() - 1) * 1.1, z = cz + (r() + r() - 1) * 1.1;
      const top = roof(x, z);
      if (top < 0) continue;
      const len = 0.35 + 2.7 * Math.pow(r(), 2.4);
      const tip = top - len;
      // none hangs across the way in, or down the shaft
      if (tip < 3.4 && z > 1 && Math.abs(x - pathX(z)) < 1.8) continue;
      if (Math.hypot(x - SHAFT.foot.x, z - SHAFT.foot.z) < 2.6) continue;
      const widen = 0.045 + 0.06 * r();
      // nor where there is no roof left above it to hang from (the hole leans, so that is not straight over its foot)
      let roofless = false;
      for (let y = tip; y < BOUNDS.max.y + 1; y += 0.4) roofless ||= hole(x, y, z) < 0.9;
      if (!roofless) spikes.push([x, z, tip, widen, 1]);
      if (!roofless && floorAt(x, z) < -0.08 && len > 0.8) drips.push([x, tip, z]);
      r();
    }
  }
  // three that have met and grown into columns
  for (const [x, z] of [[-4.6, -1.2], [4.9, -3.4], [4.3, 3.0]]) {
    const top = roof(x, z), mid = mix(floorAt(x, z), top, 0.42);
    spikes.push([x, z, mid - 0.5, 0.075, 1], [x, z, mid + 0.5, 0.13, -1]);
  }
  spikes.forEach(([x, z], i) => {
    for (let bz = Math.floor((z - 1.5) / BUCKET); bz <= Math.floor((z + 1.5) / BUCKET); bz++)
      for (let bx = Math.floor((x - 1.5) / BUCKET); bx <= Math.floor((x + 1.5) / BUCKET); bx++) {
        const key = (bz + 512) * 1024 + bx + 512;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(i);
      }
  });
}

// Boulders: blocks that have come away from the roof and walls, each a lump with a few flat faces where it broke.
// [x, y, z, rx, ry, rz, cos, sin of its turn, then four faces as (nx, ny, nz, how far out)]
const BOULDER = 24;
const boulders: number[] = [];
const boulderBuckets = new Map<number, number[]>();
{
  const r = rng(57);
  const add = (x: number, z: number, size: number, lift: number) => {
    if (Math.hypot(x, z) < 1.7 + size || (z > 1.4 && Math.abs(x - pathX(z)) < 1.3 + size)) return;
    const rx = size * (0.75 + 0.6 * r()), ry = size * (0.5 + 0.4 * r()), rz = size * (0.75 + 0.6 * r());
    const turn = r() * Math.PI;
    const i = boulders.length / BOULDER;
    boulders.push(x, floorAt(x, z) + ry * (0.25 + 0.5 * r()) + lift, z, rx, ry, rz, Math.cos(turn), Math.sin(turn));
    for (let f = 0; f < 4; f++) {
      const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      boulders.push(s * Math.cos(a), u, s * Math.sin(a), size * (0.42 + 0.3 * r()));
    }
    const reach = size * 1.4 + 0.4;
    for (let bz = Math.floor((z - reach) / BUCKET); bz <= Math.floor((z + reach) / BUCKET); bz++)
      for (let bx = Math.floor((x - reach) / BUCKET); bx <= Math.floor((x + reach) / BUCKET); bx++) {
        const key = (bz + 512) * 1024 + bx + 512;
        if (!boulderBuckets.has(key)) boulderBuckets.set(key, []);
        boulderBuckets.get(key)!.push(i);
      }
  };
  // the heap under the hole: the biggest at the bottom
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2, d = Math.pow(r(), 0.7) * 3.1;
    add(PILE.x + Math.cos(a) * d, PILE.z + Math.sin(a) * d, 0.3 + 0.75 * r() * (1 - d / 4.5), i < 9 ? 0.35 * r() : 0);
  }
  // and loose ones about the floor, mostly near the walls
  for (let i = 0; i < 34; i++) {
    const a = r() * Math.PI * 2, d = 0.35 + 0.6 * Math.sqrt(r());
    add(CHAMBER.x + Math.cos(a) * d * CHAMBER.rx, CHAMBER.z + Math.sin(a) * d * CHAMBER.rz, 0.18 + 0.5 * r() * r(), 0);
  }
  for (let i = 0; i < 10; i++) add(pathX(6 + i) + (r() < 0.5 ? -1 : 1) * (1.5 + 0.7 * r()), 6 + i + r(), 0.2 + 0.35 * r(), 0);
}
const boulderBucketAt = (x: number, z: number) => boulderBuckets.get((Math.floor(z / BUCKET) + 512) * 1024 + Math.floor(x / BUCKET) + 512);

// How the rock stands in or out of the smooth hollow (m): first its broad swellings, then the finer breaking of its face.
const swell = (x: number, y: number, z: number) => 1.5 * (fbm(x * 0.17, y * 0.21 + 5, z * 0.17, 3) - 0.44);
function broken(x: number, y: number, z: number) {
  const warp = fbm(x * 0.13 + 7, y * 0.13, z * 0.13 + 3, 2);
  // beds of rock lying one on another, each standing a little proud of the one under it
  const s = y * 1.15 + warp * 5 + x * 0.07;
  const f = s - Math.floor(s);
  let d = 0.26 * (f < 0.85 ? f / 0.85 : (1 - f) / 0.15) - 0.13;
  // hollows scooped by water, with sharp edges where two meet
  d += 0.46 * (cells(x * 0.6 + 1.3, y * 0.78, z * 0.6) - 0.55);
  d += 0.15 * (cells(x * 1.75, y * 2.1 + 4, z * 1.75) - 0.55);
  d += 0.1 * (fbm(x * 1.3, y * 1.3, z * 1.3, 2) - 0.37);
  return d;
}
const SWELL_MOST = 0.7, BROKEN_MOST = 0.55;

const bucketAt = (x: number, z: number) => buckets.get((Math.floor(z / BUCKET) + 512) * 1024 + Math.floor(x / BUCKET) + 512);

export function field(x: number, y: number, z: number, floor = floorAt(x, z), list = bucketAt(x, z), rocks = boulderBucketAt(x, z)) {
  let a = hollow(x, y, z);
  // far inside the rock nothing else can matter
  if (a > SWELL_MOST + BROKEN_MOST + 0.6) return a;
  const above = y - floor;
  if (a > -SWELL_MOST - BROKEN_MOST) {
    const calm = mix(0.3, 1, smoothstep(0.1, 1.7, above));
    a += calm * swell(x, y, z);
    // the fine breaking is only worked out near the face, where it can be seen
    if (Math.abs(a) < BROKEN_MOST + 0.25) a += calm * broken(x, y, z);
  }
  if (above < 1.2) a = smax(a, floor + 0.07 * (fbm(x * 1.9, 1.5, z * 1.9, 2) - 0.37) - y, 0.5);
  if (list)
    for (const i of list) {
      const sp = spikes[i];
      const rx = x - sp[0], rz = z - sp[1];
      const r2 = rx * rx + rz * rz;
      if (r2 > 2.25) continue;
      const r = Math.sqrt(r2);
      const up = (y - sp[2]) * sp[4];
      // a little crooked, never quite round, and built up in rings as the lime was laid down
      const turn = Math.atan2(rz, rx);
      const wob = 0.02 * Math.sin(y * 9 + sp[0] * 5) + 0.018 * Math.sin(turn * 3 + sp[1] + y * 2) + 0.012 * Math.sin(turn * 7 + y * 5);
      const rings = sp[4] < 0 ? 0.035 * Math.sin(up * 11 + sp[0] * 3) * Math.min(1, up * 2) : 0.012 * Math.sin(up * 6 + sp[1]);
      // (never thinner than the grid can hold, and never narrowing on the way up: a neck too thin to be drawn would
      // leave whatever hangs below it cut off in mid-air)
      const s = (up > 0 ? r - up * sp[3] * (1 + 0.12 * Math.sin(up * 2.3 + sp[0])) : Math.sqrt(r2 + up * up)) - 0.075 - wob * 0.6 - rings * 0.6;
      if (-s > a - 0.22) a = smax(a, -s, 0.22);
    }
  if (rocks)
    for (const i of rocks) {
      const o = i * BOULDER;
      const px = x - boulders[o], py = y - boulders[o + 1], pz = z - boulders[o + 2];
      const size = boulders[o + 3] + boulders[o + 5];
      if (px * px + py * py + pz * pz > size * size) continue;
      const lx = px * boulders[o + 6] + pz * boulders[o + 7], lz = pz * boulders[o + 6] - px * boulders[o + 7];
      const ex = lx / boulders[o + 3], ey = py / boulders[o + 4], ez = lz / boulders[o + 5];
      const k0 = Math.sqrt(ex * ex + ey * ey + ez * ez);
      const k1 = Math.sqrt((ex * ex) / (boulders[o + 3] * boulders[o + 3]) + (ey * ey) / (boulders[o + 4] * boulders[o + 4]) + (ez * ez) / (boulders[o + 5] * boulders[o + 5]));
      let s = k1 > 1e-6 ? (k0 * (k0 - 1)) / k1 : -1;
      // the flat faces it broke along
      for (let f = 8; f < BOULDER; f += 4) s = Math.max(s, lx * boulders[o + f] + py * boulders[o + f + 1] + lz * boulders[o + f + 2] - boulders[o + f + 3]);
      // and worn a little uneven since
      if (s < 0.3) s += 0.09 * (fbm(x * 2.4 + i, y * 2.4, z * 2.4, 2) - 0.37) + 0.05 * (cells(x * 3.1, y * 3.1 + i, z * 3.1) - 0.5);
      if (-s > a - 0.07) a = smax(a, -s, 0.07);
    }
  return a;
}

// ---------------------------------------------------------------- the grid

export type Grid = { nx: number; ny: number; nz: number; voxel: number; data: Float32Array };

// asks to be let go of now and then, so the page can draw
type Breath = (done: number) => Promise<void> | void;

export async function buildGrid(voxel: number, breath: Breath): Promise<Grid> {
  const nx = Math.ceil((BOUNDS.max.x - BOUNDS.min.x) / voxel) + 1;
  const ny = Math.ceil((BOUNDS.max.y - BOUNDS.min.y) / voxel) + 1;
  const nz = Math.ceil((BOUNDS.max.z - BOUNDS.min.z) / voxel) + 1;
  const data = new Float32Array(nx * ny * nz);
  const floor = new Float32Array(nx);
  const lists: (number[] | undefined)[] = new Array(nx), rocks: (number[] | undefined)[] = new Array(nx);
  let last = performance.now();
  for (let k = 0; k < nz; k++) {
    const z = BOUNDS.min.z + k * voxel;
    for (let i = 0; i < nx; i++) {
      floor[i] = floorAt(BOUNDS.min.x + i * voxel, z);
      lists[i] = bucketAt(BOUNDS.min.x + i * voxel, z);
      rocks[i] = boulderBucketAt(BOUNDS.min.x + i * voxel, z);
    }
    for (let j = 0; j < ny; j++) {
      const y = BOUNDS.min.y + j * voxel;
      let o = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++, o++) {
        // the block is closed all round, except at the top where the shaft comes out
        const edge = i === 0 || i === nx - 1 || j === 0 || k === 0 || k === nz - 1;
        data[o] = edge ? 1 : field(BOUNDS.min.x + i * voxel, y, z, floor[i], lists[i], rocks[i]);
      }
    }
    if (performance.now() - last > 24) {
      await breath(k / nz);
      last = performance.now();
    }
  }
  return { nx, ny, nz, voxel, data };
}

// the field between the points of the grid
export function sample(g: Grid, x: number, y: number, z: number) {
  const fx = clamp((x - BOUNDS.min.x) / g.voxel, 0, g.nx - 1.001), fy = clamp((y - BOUNDS.min.y) / g.voxel, 0, g.ny - 1.001), fz = clamp((z - BOUNDS.min.z) / g.voxel, 0, g.nz - 1.001);
  const ix = fx | 0, iy = fy | 0, iz = fz | 0;
  const tx = fx - ix, ty = fy - iy, tz = fz - iz;
  const d = g.data, sx = 1, sy = g.nx, sz = g.nx * g.ny;
  const o = iz * sz + iy * sy + ix;
  const a = d[o] + (d[o + sx] - d[o]) * tx, b = d[o + sy] + (d[o + sy + sx] - d[o + sy]) * tx;
  const c = d[o + sz] + (d[o + sz + sx] - d[o + sz]) * tx, e = d[o + sz + sy] + (d[o + sz + sy + sx] - d[o + sz + sy]) * tx;
  const lo = a + (b - a) * ty, hi = c + (e - c) * ty;
  return lo + (hi - lo) * tz;
}

// the nearest point of the grid: rougher, and several times quicker
function near(g: Grid, x: number, y: number, z: number) {
  const ix = clamp(((x - BOUNDS.min.x) / g.voxel + 0.5) | 0, 0, g.nx - 1), iy = clamp(((y - BOUNDS.min.y) / g.voxel + 0.5) | 0, 0, g.ny - 1), iz = clamp(((z - BOUNDS.min.z) / g.voxel + 0.5) | 0, 0, g.nz - 1);
  return g.data[(iz * g.ny + iy) * g.nx + ix];
}

// which way is out of the rock, at a point on its face
export function outward(g: Grid, x: number, y: number, z: number, out: number[]) {
  const h = g.voxel;
  const dx = sample(g, x - h, y, z) - sample(g, x + h, y, z), dy = sample(g, x, y - h, z) - sample(g, x, y + h, z), dz = sample(g, x, y, z - h) - sample(g, x, y, z + h);
  const l = Math.hypot(dx, dy, dz) || 1;
  out[0] = dx / l;
  out[1] = dy / l;
  out[2] = dz / l;
  return out;
}

// how far a ray gets before it meets rock (m)
export function reach(g: Grid, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, most: number) {
  let t = 0.12;
  while (t < most) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    if (y > BOUNDS.max.y - 0.2) return most;
    const a = sample(g, x, y, z);
    if (a > 0) return t;
    t += Math.max(0.05, -a * 0.6);
  }
  return most;
}

// ---------------------------------------------------------------- the walls

// The face of the rock as a mesh: one corner in every cell of the grid the face passes through, set where the face
// crosses the cell's edges, and joined to its neighbours.
export async function buildMesh(g: Grid, breath: Breath) {
  const { nx, ny, nz, voxel, data } = g;
  let pos = new Float32Array(1 << 20);
  let idx = new Uint32Array(1 << 21);
  let nv = 0, ni = 0;
  // the corner made in each cell of this layer and of the one before
  let here = new Int32Array(nx * ny), before = new Int32Array(nx * ny);
  const v = new Float32Array(8);
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (ni + 6 > idx.length) {
      const grown = new Uint32Array(idx.length * 2);
      grown.set(idx);
      idx = grown;
    }
    idx[ni++] = a;
    idx[ni++] = flip ? d : b;
    idx[ni++] = c;
    idx[ni++] = a;
    idx[ni++] = c;
    idx[ni++] = flip ? b : d;
  };
  let last = performance.now();
  for (let k = 0; k < nz - 1; k++) {
    [here, before] = [before, here];
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const o = (k * ny + j) * nx + i;
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = data[o + (c & 1) + ((c >> 1) & 1) * nx + (c >> 2) * nx * ny];
          if (v[c] > 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let x = 0, y = 0, z = 0, n = 0;
        for (let c = 0; c < 8; c++)
          for (let axis = 0; axis < 3; axis++) {
            const c2 = c | (1 << axis);
            if (c2 === c || v[c] > 0 === v[c2] > 0) continue;
            const t = v[c] / (v[c] - v[c2]);
            x += (c & 1) + (axis === 0 ? t : 0);
            y += ((c >> 1) & 1) + (axis === 1 ? t : 0);
            z += (c >> 2) + (axis === 2 ? t : 0);
            n++;
          }
        if (nv * 3 + 3 > pos.length) {
          const grown = new Float32Array(pos.length * 2);
          grown.set(pos);
          pos = grown;
        }
        pos[nv * 3] = BOUNDS.min.x + (i + x / n) * voxel;
        pos[nv * 3 + 1] = BOUNDS.min.y + (j + y / n) * voxel;
        pos[nv * 3 + 2] = BOUNDS.min.z + (k + z / n) * voxel;
        const me = (here[j * nx + i] = nv++);
        const solid = v[0] > 0;
        // the three edges that leave this cell's first corner, each shared by four cells
        if (solid !== v[1] > 0 && j > 0 && k > 0) quad(me, here[(j - 1) * nx + i], before[(j - 1) * nx + i], before[j * nx + i], !solid);
        if (solid !== v[2] > 0 && i > 0 && k > 0) quad(me, before[j * nx + i], before[j * nx + i - 1], here[j * nx + i - 1], !solid);
        if (solid !== v[4] > 0 && i > 0 && j > 0) quad(me, here[j * nx + i - 1], here[(j - 1) * nx + i - 1], here[(j - 1) * nx + i], !solid);
      }
    if (performance.now() - last > 24) {
      await breath(k / nz);
      last = performance.now();
    }
  }
  // Whatever came out as a loose piece joined to nothing (a tip the grid was too coarse to hold on to, a stone lying
  // clear of the floor) is left out: only faces that belong to a big enough whole are kept.
  const whole = new Int32Array(nv).map((_, i) => i);
  const root = (i: number) => {
    while (whole[i] !== i) i = whole[i] = whole[whole[i]];
    return i;
  };
  for (let f = 0; f < ni; f += 3) {
    const a = root(idx[f]);
    whole[root(idx[f + 1])] = a;
    whole[root(idx[f + 2])] = a;
  }
  const size = new Int32Array(nv);
  for (let i = 0; i < nv; i++) size[root(i)]++;
  let kept = 0;
  for (let f = 0; f < ni; f += 3) {
    if (size[root(idx[f])] < 600) continue;
    idx[kept++] = idx[f];
    idx[kept++] = idx[f + 1];
    idx[kept++] = idx[f + 2];
  }
  ni = kept;
  // The faces were made from the far end of the cave to the near one, and are drawn in the order they are kept in.
  // Turned round, the nearest are drawn first, so whatever they hide is never shaded: the visitor always looks the
  // same way down the cave.
  for (let a = 0, b = ni - 3; a < b; a += 3, b -= 3)
    for (let k = 0; k < 3; k++) {
      const swap = idx[a + k];
      idx[a + k] = idx[b + k];
      idx[b + k] = swap;
    }

  const normal = new Float32Array(nv * 3);
  const n3 = [0, 0, 0];
  for (let i = 0; i < nv; i++) {
    outward(g, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], n3);
    normal.set(n3, i * 3);
  }
  return { position: pos.slice(0, nv * 3), normal, index: idx.slice(0, ni), count: nv };
}

// ---------------------------------------------------------------- the light that is worked out beforehand

// mirrored from shaftLight in shared.ts
const shaftDir = SHAFT.foot.clone().sub(SHAFT.top).normalize();
const shaftProfile = (off: number) => smoothstep(SHAFT.spread, SHAFT.spread * 0.35, off);
function shaftLight(x: number, y: number, z: number) {
  const dx = x - SHAFT.top.x, dy = y - SHAFT.top.y, dz = z - SHAFT.top.z;
  const along = dx * shaftDir.x + dy * shaftDir.y + dz * shaftDir.z;
  if (along <= 0) return 0;
  const off = Math.hypot(dx - shaftDir.x * along, dy - shaftDir.y * along, dz - shaftDir.z * along) / Math.max(along, 0.1);
  const far = Math.max(along, 2) / 10;
  return shaftProfile(off) / (far * far);
}

// For every corner of the mesh: how open it is to the cave around it (0–1), the crystals' light that reaches it off
// the other walls, the light of the sky through the hole (straight, and off the walls), and the sun's light off the
// walls (the sun itself is worked out as the picture is drawn). The last three are for a light of strength 1, and are
// multiplied by the lights as they are in the shader.
export async function bakeLight(g: Grid, position: Float32Array, normal: Float32Array, count: number, breath: Breath) {
  const out = new Float32Array(count * 4);
  // Where the light lands it becomes a small lamp of its own. [x, y, z, nx, ny, nz, strength, 0 crystals / 1 sky / 2 sun]
  const lamps: number[] = [];
  const n3 = [0, 0, 0];
  const GEM_RAYS = 288, SKY_RAYS = 96, SUN_RAYS = 160;
  for (let i = 0; i < GEM_RAYS; i++) {
    const u = 1 - (2 * (i + 0.5)) / GEM_RAYS, a = i * 2.39996323;
    const r = Math.sqrt(1 - u * u);
    const dx = r * Math.cos(a), dy = u, dz = r * Math.sin(a);
    const t = reach(g, GEM.x, GEM.y, GEM.z, dx, dy, dz, 40);
    if (t >= 40) continue;
    const x = GEM.x + dx * (t - 0.06), y = GEM.y + dy * (t - 0.06), z = GEM.z + dz * (t - 0.06);
    outward(g, x, y, z, n3);
    lamps.push(x, y, z, n3[0], n3[1], n3[2], (4 * ROCK_ALBEDO) / GEM_RAYS, 0);
  }
  // two directions square to the shaft
  const sx = [shaftDir.y, -shaftDir.x, 0], sl = Math.hypot(sx[0], sx[1]);
  sx[0] /= sl;
  sx[1] /= sl;
  const sy = [shaftDir.y * sx[2] - shaftDir.z * sx[1], shaftDir.z * sx[0] - shaftDir.x * sx[2], shaftDir.x * sx[1] - shaftDir.y * sx[0]];
  // rays from the sky start where they come into the block of ground, in the mouth of the hole
  for (let i = 0; i < SKY_RAYS; i++) {
    const off = Math.sqrt((i + 0.5) / SKY_RAYS) * SHAFT.spread, a = i * 2.39996323;
    const ox = Math.cos(a) * off, oy = Math.sin(a) * off;
    let dx = shaftDir.x + sx[0] * ox + sy[0] * oy, dy = shaftDir.y + sx[1] * ox + sy[1] * oy, dz = shaftDir.z + sx[2] * ox + sy[2] * oy;
    const l = Math.hypot(dx, dy, dz);
    dx /= l;
    dy /= l;
    dz /= l;
    const t0 = (SHAFT.top.y - (BOUNDS.max.y - 0.3)) / -dy;
    const bx = SHAFT.top.x + dx * t0, by = SHAFT.top.y + dy * t0, bz = SHAFT.top.z + dz * t0;
    if (sample(g, bx, by, bz) > 0) continue;
    const t = reach(g, bx, by, bz, dx, dy, dz, 40);
    if (t >= 40) continue;
    const x = bx + dx * (t - 0.06), y = by + dy * (t - 0.06), z = bz + dz * (t - 0.06);
    outward(g, x, y, z, n3);
    lamps.push(x, y, z, n3[0], n3[1], n3[2], (ROCK_ALBEDO * 100 * shaftProfile(off) * SHAFT.spread * SHAFT.spread) / SKY_RAYS, 1);
  }
  // the sun: straight rays, all one way, as many as fit through the hole
  const SUN_R = 3.6;
  for (let i = 0; i < SUN_RAYS; i++) {
    const off = Math.sqrt((i + 0.5) / SUN_RAYS) * SUN_R, a = i * 2.39996323;
    const ox = Math.cos(a) * off, oy = Math.sin(a) * off;
    const qx = SHAFT.top.x + sx[0] * ox + sy[0] * oy, qy = SHAFT.top.y + sx[1] * ox + sy[1] * oy, qz = SHAFT.top.z + sx[2] * ox + sy[2] * oy;
    const t0 = (qy - (BOUNDS.max.y - 0.3)) / -shaftDir.y;
    const bx = qx + shaftDir.x * t0, by = qy + shaftDir.y * t0, bz = qz + shaftDir.z * t0;
    if (sample(g, bx, by, bz) > 0) continue;
    const t = reach(g, bx, by, bz, shaftDir.x, shaftDir.y, shaftDir.z, 40);
    if (t >= 40) continue;
    const x = bx + shaftDir.x * (t - 0.06), y = by + shaftDir.y * (t - 0.06), z = bz + shaftDir.z * (t - 0.06);
    outward(g, x, y, z, n3);
    lamps.push(x, y, z, n3[0], n3[1], n3[2], (ROCK_ALBEDO * SUN_R * SUN_R) / SUN_RAYS, 2);
  }
  const L = lamps.length / 8;
  const lamp = new Float32Array(lamps);
  const r = rng(5);
  const AO = [0.18, 0.2, 0.42, 0.28, 0.95, 0.3, 2.0, 0.22];
  let last = performance.now();
  for (let i = 0; i < count; i++) {
    const x = position[i * 3], y = position[i * 3 + 1], z = position[i * 3 + 2];
    const nx = normal[i * 3], ny = normal[i * 3 + 1], nz = normal[i * 3 + 2];
    // rock close by, out along the way the face looks, shuts the light out
    let shut = 0;
    for (let k = 0; k < 8; k += 2) {
      const d = AO[k];
      shut += AO[k + 1] * clamp(1 + sample(g, x + nx * d, y + ny * d, z + nz * d) / d, 0, 1);
    }
    const open = 1 - shut;
    let gem = 0, sky = 0, sun = 0;
    const px = x + nx * 0.12, py = y + ny * 0.12, pz = z + nz * 0.12;
    for (let k = 0; k < L; k++) {
      const o = k * 8;
      const dx = lamp[o] - px, dy = lamp[o + 1] - py, dz = lamp[o + 2] - pz;
      const mine = dx * nx + dy * ny + dz * nz;
      if (mine <= 0) continue;
      const theirs = -(dx * lamp[o + 3] + dy * lamp[o + 4] + dz * lamp[o + 5]);
      if (theirs <= 0) continue;
      const d2 = dx * dx + dy * dy + dz * dz;
      // (two cosines, each over the distance, and the square of the distance: never nearer than a metre and a half)
      const e = (lamp[o + 6] * mine * theirs) / (d2 * Math.max(d2, 2.25));
      if (e < 2e-6) continue;
      // is there rock between the two?
      if (near(g, px + dx * 0.25, py + dy * 0.25, pz + dz * 0.25) > 0.2 || near(g, px + dx * 0.5, py + dy * 0.5, pz + dz * 0.5) > 0.2 || near(g, px + dx * 0.75, py + dy * 0.75, pz + dz * 0.75) > 0.2) continue;
      if (lamp[o + 7] === 2) sun += e;
      else if (lamp[o + 7]) sky += e;
      else gem += e;
    }
    // the daylight itself, where the top of the shaft can be seen
    const day = shaftLight(x, y, z);
    if (day > 1e-4) {
      let seen = 0;
      for (let s = 0; s < 3; s++) {
        const tx = SHAFT.top.x + (r() - 0.5) * 2.2 - px, ty = SHAFT.top.y - py, tz = SHAFT.top.z + (r() - 0.5) * 2.2 - pz;
        const l = Math.sqrt(tx * tx + ty * ty + tz * tz);
        const facing = (tx * nx + ty * ny + tz * nz) / l;
        if (facing <= 0) continue;
        if (reach(g, px, py, pz, tx / l, ty / l, tz / l, l - 1) >= l - 1) seen += facing / 3;
      }
      sky += day * seen;
    }
    // (light goes on bouncing after the first time; this is the rest of it, roughly)
    const more = 1.35 * (0.35 + 0.65 * open);
    out[i * 4] = open;
    out[i * 4 + 1] = gem * more;
    out[i * 4 + 2] = sky * more;
    // (the camera is set for the dark of the cave, where the sun's light off the heap counts for more than its share)
    out[i * 4 + 3] = sun * more * 2.5;
    if ((i & 1023) === 0 && performance.now() - last > 24) {
      await breath(i / count);
      last = performance.now();
    }
  }
  return out;
}
