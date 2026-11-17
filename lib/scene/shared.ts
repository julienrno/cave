import { Color, Data3DTexture, DataUtils, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType, Vector3 } from "three";

// metres; the pools lie at y = 0 and the crystals stand at the middle of the chamber
export const WATER_Y = 0;
// the heart of the crystals: where their light comes from, and how large a lamp they make
export const GEM = new Vector3(0, 1.38, 0);
export const GEM_R = 0.3;
// the colour of that light, and how strong it is (what falls on a wall one metre away)
export const GEM_COLOR = new Color(0.4, 1.0, 0.47);
export const GEM_POWER = 16;
// The roof has fallen in at one place, behind the crystals and to the left: the sun comes down through the hole, along
// the line from top to foot, and with it the paler light of the sky (spread: how wide that falls, as a slope).
export const SHAFT = { top: new Vector3(-6.17, 13, -7.98), foot: new Vector3(-3.85, 6.2, -5.12), spread: 0.5 };
export const SUN_DIR = SHAFT.foot.clone().sub(SHAFT.top).normalize();
export const SUN_COLOR = new Color(1.0, 0.94, 0.82);
export const SUN_POWER = 26;
// the sun's view of the hole: how far to each side of that line it is recorded (m)
export const SUN_SPAN = 4.6;
export const SKY_COLOR = new Color(0.66, 0.8, 1.0);
export const SKY_POWER = 9;
// what the rock gives back of the light that falls on it, on average (used when working out the light that bounces)
export const ROCK_ALBEDO = 0.24;
// A click sends a shell of light out from the crystals through the whole cave: how fast it travels (m/s), how long it
// lasts (s), and its colour.
export const PULSE = { speed: 6.5, life: 3.4, color: new Color(0.45, 1.0, 0.6) };

// the block of ground the cave is cut from
export const BOUNDS = { min: new Vector3(-10.5, -1.7, -15.5), max: new Vector3(10.5, 10.6, 21) };

// plant: what sways (it is drawn, and mirrored in the pools, but left out of the views taken once for the shadows)
// sky: seen by the eye and the pools, but no part of the rock
export const LAYER = { world: 0, gem: 1, air: 2, plant: 3, sky: 4 };

export const CAM = { fov: 40 };

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

function ihash(x: number, y: number, z: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// smooth noise in space, 0–1
export function vnoise(x: number, y: number, z: number) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const a = ihash(ix, iy, iz), b = ihash(ix + 1, iy, iz), c = ihash(ix, iy + 1, iz), d = ihash(ix + 1, iy + 1, iz);
  const e = ihash(ix, iy, iz + 1), f = ihash(ix + 1, iy, iz + 1), g = ihash(ix, iy + 1, iz + 1), h = ihash(ix + 1, iy + 1, iz + 1);
  const lo = (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
  const hi = (e + (f - e) * ux) * (1 - uy) + (g + (h - g) * ux) * uy;
  return lo + (hi - lo) * uz;
}

export function fbm(x: number, y: number, z: number, octaves = 4) {
  let v = 0, a = 0.5;
  for (let i = 0; i < octaves; i++) {
    v += a * vnoise(x, y, z);
    const nx = x * 1.62 + z * 1.18 + 17.1, nz = z * 1.62 - x * 1.18 + 9.2;
    x = nx;
    y = y * 2.03 + 31.7;
    z = nz;
    a *= 0.5;
  }
  return v;
}

// distance to the nearest of a scatter of points, one to a cell: rock broken into blocks
export function cells(x: number, y: number, z: number) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let best = 9;
  for (let k = -1; k <= 1; k++)
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const cx = ix + i, cy = iy + j, cz = iz + k;
        // one number, cut into three
        let h = Math.imul(cx, 374761393) ^ Math.imul(cy, 668265263) ^ Math.imul(cz, 1440662683);
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        h ^= h >>> 16;
        const dx = cx + (h & 1023) / 1024 - x, dy = cy + ((h >>> 10) & 1023) / 1024 - y, dz = cz + ((h >>> 20) & 1023) / 1024 - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
  return Math.sqrt(best);
}

// ---------------------------------------------------------------- noise for the shaders

const NOISE_N = 64;
// lattice cells across the texture: one turn of the texture holds this many lumps
export const NOISE_CELLS = 8;

// Smooth noise that tiles, with its slope: rgb is how fast it changes along x, y and z (per turn of the texture), a its
// value (about -1 to 1). Every surface reads its grain from this one block.
function noiseTexture() {
  const n = NOISE_N, c = NOISE_CELLS;
  const grad = (ix: number, iy: number, iz: number, out: number[]) => {
    const x = ((ix % c) + c) % c, y = ((iy % c) + c) % c, z = ((iz % c) + c) % c;
    const u = ihash(x, y, z) * 2 - 1, a = ihash(z + 57, x, y) * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    out[0] = r * Math.cos(a);
    out[1] = r * Math.sin(a);
    out[2] = u;
  };
  const g = [0, 0, 0];
  const value = new Float32Array(n * n * n);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = (i / n) * c, y = (j / n) * c, z = (k / n) * c;
        const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
        const fx = x - ix, fy = y - iy, fz = z - iz;
        const ux = fade(fx), uy = fade(fy), uz = fade(fz);
        let v = 0;
        for (let c8 = 0; c8 < 8; c8++) {
          const ox = c8 & 1, oy = (c8 >> 1) & 1, oz = c8 >> 2;
          grad(ix + ox, iy + oy, iz + oz, g);
          const d = g[0] * (fx - ox) + g[1] * (fy - oy) + g[2] * (fz - oz);
          v += d * (ox ? ux : 1 - ux) * (oy ? uy : 1 - uy) * (oz ? uz : 1 - uz);
        }
        value[(k * n + j) * n + i] = v * 1.9;
      }
  const data = new Uint16Array(n * n * n * 4);
  const at = (i: number, j: number, k: number) => value[((((k + n) % n) * n + ((j + n) % n)) * n + ((i + n) % n))];
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const o = ((k * n + j) * n + i) * 4;
        data[o] = DataUtils.toHalfFloat((at(i + 1, j, k) - at(i - 1, j, k)) * n * 0.5);
        data[o + 1] = DataUtils.toHalfFloat((at(i, j + 1, k) - at(i, j - 1, k)) * n * 0.5);
        data[o + 2] = DataUtils.toHalfFloat((at(i, j, k + 1) - at(i, j, k - 1)) * n * 0.5);
        data[o + 3] = DataUtils.toHalfFloat(at(i, j, k));
      }
  const tex = new Data3DTexture(data, n, n, n);
  tex.format = RGBAFormat;
  tex.type = HalfFloatType;
  // (with smaller copies of itself for when its grain is finer than a pixel: read at full size from far off, every pixel
  // lands somewhere else in the block, which is by far the slowest thing a graphics card can be asked to do)
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

const BREAK_N = 96;

// Rock broken into blocks, tiling: every point belongs to the nearest of a scatter of centres. rgb is a direction that
// block's face leans (the same all over the block, so its face is flat), a how far the point is from the crack round it
// (0 in the crack, 1 well inside the block).
function breakTexture() {
  const n = BREAK_N, c = NOISE_CELLS;
  const px = new Float32Array(c * c * c * 3), lean = new Float32Array(c * c * c * 3);
  const r = rng(909);
  for (let i = 0; i < c * c * c; i++) {
    px.set([r(), r(), r()], i * 3);
    const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    lean.set([s * Math.cos(a), s * Math.sin(a), u], i * 3);
  }
  const data = new Uint8Array(n * n * n * 4);
  const wrap = (v: number) => ((v % c) + c) % c;
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = ((i + 0.5) / n) * c, y = ((j + 0.5) / n) * c, z = ((k + 0.5) / n) * c;
        const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
        let first = 9, second = 9, who = 0;
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const id = (wrap(iz + dz) * c + wrap(iy + dy)) * c + wrap(ix + dx);
              const ex = ix + dx + px[id * 3] - x, ey = iy + dy + px[id * 3 + 1] - y, ez = iz + dz + px[id * 3 + 2] - z;
              const d = ex * ex + ey * ey + ez * ez;
              if (d < first) {
                second = first;
                first = d;
                who = id;
              } else if (d < second) second = d;
            }
        const o = ((k * n + j) * n + i) * 4;
        data[o] = 127.5 + 127.5 * lean[who * 3];
        data[o + 1] = 127.5 + 127.5 * lean[who * 3 + 1];
        data[o + 2] = 127.5 + 127.5 * lean[who * 3 + 2];
        data[o + 3] = Math.min(255, (Math.sqrt(second) - Math.sqrt(first)) * 2.2 * 255);
      }
  const tex = new Data3DTexture(data, n, n, n);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

export const shared = {
  uTime: { value: 0 },
  tNoise: { value: typeof document === "undefined" ? null : noiseTexture() },
  tBreak: { value: typeof document === "undefined" ? null : breakTexture() },
  // where in the crystals their light is strongest just now (the pointer moves it about inside them)
  uGemPos: { value: GEM.clone() },
  // the light the crystals give just now (their colour times their strength; it breathes)
  uGemLight: { value: new Vector3() },
  uSkyLight: { value: new Vector3(SKY_COLOR.r, SKY_COLOR.g, SKY_COLOR.b).multiplyScalar(SKY_POWER) },
  uSunLight: { value: new Vector3(SUN_COLOR.r, SUN_COLOR.g, SUN_COLOR.b).multiplyScalar(SUN_POWER) },
  // the sun's view down the hole (how far the first rock is along each of its rays), and where that view is taken from
  tSun: { value: null as unknown },
  uSunPos: { value: new Vector3() },
  uSunRight: { value: new Vector3(1, 0, 0) },
  uSunUp: { value: new Vector3(0, 0, 1) },
  // how far every point around the crystals is from them: what their light cannot reach is in shadow
  tShadow: { value: null as unknown },
  // when each of the last four shells of light set out (s), and whether any is still on its way
  uPulses: { value: [-100, -100, -100, -100] },
  uPulsing: { value: 0 },
};

// the uniforms glslCommon declares, for every material that includes it
export const common = {
  uTime: shared.uTime,
  tNoise: shared.tNoise,
  uGemPos: shared.uGemPos,
  uGemLight: shared.uGemLight,
  uSkyLight: shared.uSkyLight,
  uSunLight: shared.uSunLight,
  tShadow: shared.tShadow,
  tSun: shared.tSun,
  uSunPos: shared.uSunPos,
  uSunRight: shared.uSunRight,
  uSunUp: shared.uSunUp,
  uPulses: shared.uPulses,
  uPulsing: shared.uPulsing,
};

export const glslCommon = /* glsl */ `
uniform float uTime;
uniform highp sampler3D tNoise;
uniform vec3 uGemPos;
uniform vec3 uGemLight;
uniform vec3 uSkyLight;
uniform vec3 uSunLight;
uniform samplerCube tShadow;
uniform sampler2D tSun;
uniform vec3 uSunPos;
uniform vec3 uSunRight;
uniform vec3 uSunUp;
uniform float uPulses[4];
uniform float uPulsing;

#define PI 3.14159265
#define WATER_Y ${WATER_Y.toFixed(2)}
#define GEM_R ${GEM_R.toFixed(2)}
// the middle of the crystals, where their shadows were recorded from
#define GEM_MID vec3(${GEM.toArray().map((v) => v.toFixed(3)).join(", ")})
#define SHAFT_TOP vec3(${SHAFT.top.toArray().map((v) => v.toFixed(2)).join(", ")})
#define SHAFT_DIR vec3(${SHAFT.foot.clone().sub(SHAFT.top).normalize().toArray().map((v) => v.toFixed(4)).join(", ")})
#define SHAFT_SPREAD ${SHAFT.spread.toFixed(3)}
#define SUN_DIR SHAFT_DIR
#define SUN_SPAN ${SUN_SPAN.toFixed(2)}
#define PULSE_SPEED ${PULSE.speed.toFixed(2)}
#define PULSE_LIFE ${PULSE.life.toFixed(2)}
#define PULSE_COLOR vec3(${PULSE.color.r.toFixed(3)}, ${PULSE.color.g.toFixed(3)}, ${PULSE.color.b.toFixed(3)})

float saturate(float x) { return clamp(x, 0.0, 1.0); }

// a different number at every pixel, evenly spread
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// The shells of light a click sends out from the crystals, at a point: x is the bright front of one passing through
// it, y the glow it leaves behind for a few metres. They take no notice of rock: for a moment they show what the
// crystals' own light never reaches.
vec2 pulse(vec3 p) {
  vec2 total = vec2(0.0);
  if (uPulsing < 0.5) return total;
  float dist = length(p - GEM_MID);
  for (int i = 0; i < 4; i++) {
    float age = uTime - uPulses[i];
    if (age < 0.0 || age > PULSE_LIFE) continue;
    float x = dist - age * PULSE_SPEED;
    float fade = 1.0 - age / PULSE_LIFE;
    total += vec2(exp(-x * x * 26.0), smoothstep(-3.8, 0.0, x) * step(x, 0.0)) * fade * fade;
  }
  return total;
}

// How much of the crystals' light arrives at a point (0–1). The further what stands in the way is from the point, the
// softer the edge of its shadow.
float gemShadow(vec3 p, float seed) {
  vec3 dir = p - GEM_MID;
  float dist = length(dir);
  dir /= dist;
  vec3 t = normalize(cross(dir, abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(dir, t);
  float bias = 0.035 + 0.006 * dist;
  float rot = seed * 6.2832;
  float reach = min(GEM_R / dist, 0.12) * 0.9;
  float blocked = 0.0, count = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i) + 0.5;
    float a = fi * 2.39996 + rot;
    vec2 o = vec2(cos(a), sin(a)) * sqrt(fi / 4.0) * reach;
    float z = textureLod(tShadow, dir + t * o.x + b * o.y, 0.0).r;
    if (z < dist - bias) { blocked += z; count += 1.0; }
  }
  if (count < 0.5) return 1.0;
  float near = blocked / count;
  float soft = clamp(GEM_R * (dist - near) / (near * dist), 0.003, 0.09);
  float lit = 0.0;
  for (int i = 0; i < 7; i++) {
    float fi = float(i) + 0.5;
    float a = fi * 2.39996 + rot + 1.7;
    vec2 o = vec2(cos(a), sin(a)) * sqrt(fi / 7.0) * soft;
    lit += step(dist - bias, textureLod(tShadow, dir + t * o.x + b * o.y, 0.0).r);
  }
  return lit / 7.0;
}

// one look instead of eleven, for the air and what drifts in it
float gemShadowHard(vec3 p) {
  vec3 dir = p - GEM_MID;
  float dist = length(dir);
  return step(dist - 0.06, textureLod(tShadow, dir, 0.0).r);
}

// where a point falls in the sun's view (xy, 0–1 across it) and how far along the sun's rays it lies (z)
vec3 sunPlace(vec3 p) {
  vec3 q = p - uSunPos;
  return vec3(vec2(dot(q, uSunRight), dot(q, uSunUp)) / SUN_SPAN * 0.5 + 0.5, dot(q, SUN_DIR));
}

// Trees stand over the hole: the sun comes through their leaves in patches, which is what parts its beam into rays.
// The leaves are never still, so the patches drift and open and close, as light does under moving water.
float leaves(vec2 uv) {
  float n = textureLod(tNoise, vec3(uv * 2.1 + uTime * vec2(0.004, 0.0025), 0.37 + uTime * 0.03), 0.0).w
    + 0.6 * textureLod(tNoise, vec3(uv * 5.3 + 0.2 - uTime * vec2(0.006, 0.009), 0.71 + uTime * 0.055), 0.0).w
    + 0.3 * textureLod(tNoise, vec3(uv * 13.0 + uTime * vec2(0.014, -0.01), 0.13 + uTime * 0.1), 0.0).w;
  return smoothstep(-0.28, 0.2, n);
}

// How much of the sun arrives at a point (0–1). No sun comes in but through the hole in the roof.
float sunShadow(vec3 p, float seed) {
  vec3 s = sunPlace(p);
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) return 0.0;
  float gaps = leaves(s.xy);
  if (gaps <= 0.0) return 0.0;
  float bias = 0.06;
  float rot = seed * 6.2832;
  float blocked = 0.0, count = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i) + 0.5;
    float a = fi * 2.39996 + rot;
    float z = textureLod(tSun, s.xy + vec2(cos(a), sin(a)) * sqrt(fi / 4.0) * 0.012, 0.0).r;
    if (z < s.z - bias) { blocked += z; count += 1.0; }
  }
  if (count < 0.5) return gaps;
  // the sun is half a degree wide: the edge of a shadow softens by a centimetre for every metre it is thrown
  float soft = clamp((s.z - blocked / count) * 0.011 / SUN_SPAN * 0.5, 0.0008, 0.012);
  float lit = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i) + 0.5;
    float a = fi * 2.39996 + rot + 1.7;
    lit += step(s.z - bias, textureLod(tSun, s.xy + vec2(cos(a), sin(a)) * sqrt(fi / 6.0) * soft, 0.0).r);
  }
  return lit / 6.0 * gaps;
}

// (for the air and what drifts in it: one look, and the leaves without their finest gaps, which the mist blurs anyway)
float sunShadowHard(vec3 p) {
  vec3 s = sunPlace(p);
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) return 0.0;
  float n = textureLod(tNoise, vec3(s.xy * 2.1 + uTime * vec2(0.004, 0.0025), 0.37 + uTime * 0.03), 0.0).w
    + 0.6 * textureLod(tNoise, vec3(s.xy * 5.3 + 0.2 - uTime * vec2(0.006, 0.009), 0.71 + uTime * 0.055), 0.0).w;
  return step(s.z - 0.08, textureLod(tSun, s.xy, 0.0).r) * smoothstep(-0.28, 0.2, n);
}

// the light of the sky that reaches a point through the hole in the roof, not counting what stands in the way
float shaftLight(vec3 p) {
  vec3 d = p - SHAFT_TOP;
  float along = dot(d, SHAFT_DIR);
  float off = length(d - SHAFT_DIR * along) / max(along, 0.1);
  float far = max(along, 2.0) / 10.0;
  return smoothstep(SHAFT_SPREAD, SHAFT_SPREAD * 0.35, off) / (far * far) * step(0.0, along);
}

// how bright a smooth surface shines at one angle (GGX), for a roughness a (already squared once)
float ggx(float NdH, float NdV, float NdL, float a) {
  float a2 = a * a;
  float d = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * d * d);
  float k = a * 0.5;
  float G = 1.0 / ((NdV * (1.0 - k) + k) * (NdL * (1.0 - k) + k));
  return D * G * 0.25;
}

float fresnel(float c, float f0) { return f0 + (1.0 - f0) * pow(saturate(1.0 - c), 5.0); }
`;

// The air that comes down the hole moves whatever hangs in it. How far a point on a hanging stem is pushed aside (m):
// seed is the stem's own number, along how far down it the point is.
export const glslWind = /* glsl */ `
float gust(float seed) { return 0.55 + 0.45 * sin(uTime * 0.31 + seed * 4.0) * sin(uTime * 0.17 + 1.3 + seed); }
vec3 sway(float seed, float along) {
  float a = max(along, 0.0);
  float reach = 0.02 * a * a / (1.0 + 0.35 * a);
  float ph = seed * 6.2832;
  // (the push travels down the stem, so its tip follows its top a moment late)
  return vec3(sin(uTime * 0.8 + ph - a * 0.5) + 0.4 * sin(uTime * 1.9 + ph * 2.0 - a * 1.1), 0.0, cos(uTime * 0.65 + ph * 1.7 - a * 0.45) + 0.4 * sin(uTime * 1.6 + ph - a)) * reach * gust(seed);
}
`;
