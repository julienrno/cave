import { BufferAttribute, BufferGeometry, Mesh, ShaderMaterial, Vector3 } from "three";
import type { Grid } from "./Field";
import { bakeLight, buildMesh } from "./Field";
import { NOISE_CELLS, common, glslCommon, shared } from "./shared";

// the middle of the chamber and about how far its walls are: what the wet rock mirrors is taken to lie that far off
export const ROOM = { centre: new Vector3(0, 2.6, -0.5), radius: 6.5 };

const vertex = /* glsl */ `
  attribute vec4 aBake;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec4 vBake;
  void main() {
    vWorld = position;
    vNormal = normal;
    vBake = aBake;
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;

// one lump of the grain is this many metres across when the noise is read at f turns a metre
const lump = (f: number) => (1 / (NOISE_CELLS * f)).toFixed(5);

const fragment = /* glsl */ `
  ${glslCommon}
  uniform highp sampler3D tBreak;
  uniform samplerCube tEnv;
  // 0 while the cave around is being recorded for the damp rock to mirror
  uniform float uEnv;
  uniform vec3 uEnvPos;
  uniform float uBump;
  // how damp the rock is, over all (1 = as tuned)
  uniform float uWet;
  // Lighter ways of shading the rock. 7 is what the pools mirror: the crystals' shadow from one look instead of
  // eleven, no finest grain, no mirrored cave (none of it can be told through the ripples). The rest are for timing
  // what the parts cost: 1 one flat colour, 2 the one-look shadow, 3 no sun, 4 no finest grain, 5 no mirrored cave,
  // 6 all of those.
  uniform float uFlat;
  // how much sharper than the graphics card's own choice the grain is read: far from the crystals, by them, and the
  // most that is added there for rock seen at a slant (each step is twice as sharp)
  uniform vec3 uCrisp;
  // three ways the crystals' light can play on the rock, each off (0) or on (1): the grain throwing shadows of its
  // own, bright specks of mineral that flash as the light moves, and streaks of light the crystals throw round them
  uniform vec3 uExtra;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec4 vBake;

  const mat3 R1 = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
  const mat3 R2 = mat3(0.36, 0.48, -0.80, -0.80, 0.60, 0.00, 0.48, 0.64, 0.60);

  // how much of a grain this size (m) can still be told apart, for a pixel that covers px metres of rock
  float seen(float size, float px) { return 1.0 - smoothstep(0.35, 1.1, px / size); }

  void main() {
    int timed = int(uFlat + 0.5);
    if (timed == 1) { gl_FragColor = vec4(0.05); return; }
    bool noFine = timed == 4 || timed >= 6;
    vec3 P = vWorld;
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - P);
    float px = length(fwidth(P));
    float seed = ign(gl_FragCoord.xy);

    // The grain is read from smaller copies of the noise as it gets finer than a pixel; left to itself the graphics card
    // picks them by the widest way a pixel is stretched over the rock, which on rock seen at a slant (the floor, the
    // mound under the crystals) is far too soft. This asks for a sharper copy, and sharper still the more the rock
    // slants. Sharper costs time, so it is spent where the eye rests: on the rock round the crystals.
    float pxA = length(dFdx(P)), pxB = length(dFdy(P));
    float byGem = 1.0 - smoothstep(3.0, 7.0, length(P - GEM_MID));
    float crisp = mix(uCrisp.x, uCrisp.y - min(0.5 * log2(max(pxA, pxB) / max(min(pxA, pxB), 1e-6)), uCrisp.z), byGem);

    // The grain of the rock, coarse to fine. Each reading gives the height of the grain and which way it slopes.
    vec4 a0 = texture(tNoise, P * 0.035);
    vec4 a1 = texture(tNoise, R1 * P * 0.11 + 0.3);
    vec4 a2 = texture(tNoise, R2 * P * 0.31 + 0.7, crisp);
    vec4 a3 = texture(tNoise, R1 * P * 0.83, crisp);
    vec4 a4 = texture(tNoise, R2 * P * 2.3, crisp);
    vec4 a5 = texture(tNoise, P * 6.1 + 0.5, crisp);
    float s3 = seen(${lump(0.83)}, px), s4 = seen(${lump(2.3)}, px), s5 = seen(${lump(6.1)}, px), s6 = seen(${lump(17)}, px), s7 = seen(${lump(47)}, px), s8 = seen(${lump(118)}, px);
    // The finest three are only read where a pixel is small enough to show them: most of the picture is too far off.
    // (Read inside a branch, they have to be told which copy of the noise to use: the one the card would have picked.)
    float copy = log2(max(pxA, pxB) * 64.0) + crisp;
    vec4 a6 = vec4(0.0), a7 = vec4(0.0), a8 = vec4(0.0);
    if (!noFine) {
      if (s6 > 0.0) a6 = textureLod(tNoise, R1 * P * 17.0, copy + ${Math.log2(17).toFixed(3)});
      if (s7 > 0.0) a7 = textureLod(tNoise, R2 * P * 47.0, copy + ${Math.log2(47).toFixed(3)});
      if (s8 > 0.0) a8 = textureLod(tNoise, P * 118.0 + 0.2, copy + ${Math.log2(118).toFixed(3)});
    }

    // The rock is broken into blocks, large ones into smaller: each has a flat face leaning its own way, with a crack
    // round it. (The cracks wander a little, so no two blocks are the same shape.)
    vec3 w = P + a1.xyz * 0.0035 + a3.xyz * 0.0008;
    vec4 b1 = texture(tBreak, R1 * w * 0.2, crisp);
    vec4 b2 = texture(tBreak, R2 * w * 0.57 + 0.37, crisp);
    vec4 b3 = texture(tBreak, w * 1.7 + 0.11, crisp);
    float t3 = seen(${lump(1.7)}, px), t4 = seen(${lump(5.3)}, px);
    vec4 b4 = vec4(0.5, 0.5, 0.5, 1.0);
    if (!noFine && t4 > 0.0) b4 = textureLod(tBreak, R1 * w * 5.3 + 0.53, copy + ${Math.log2(5.3 * 1.5).toFixed(3)});
    vec3 lean = ((b1.rgb * 2.0 - 1.0) * R1) * 0.24 + ((b2.rgb * 2.0 - 1.0) * R2) * 0.19 + (b3.rgb * 2.0 - 1.0) * 0.12 * t3 + ((b4.rgb * 2.0 - 1.0) * R1) * 0.04 * t4;
    // (the finer cracks only here and there: rock is not cracked evenly all over)
    float here = smoothstep(-0.15, 0.45, a2.w + 0.5 * a1.w);
    float crack = max(max((1.0 - smoothstep(0.1, 0.3, b2.a)) * 0.6 * smoothstep(-0.5, 0.2, a1.w - 0.4 * a0.w), (1.0 - smoothstep(0.1, 0.36, b3.a)) * t3 * here), (1.0 - smoothstep(0.1, 0.4, b4.a)) * 0.3 * t4 * here * here);
    // the edges of the big blocks are only worn hollows
    float seam = 1.0 - smoothstep(0.0, 0.5, b1.a);

    // water running down the walls leaves ribs of lime, top to bottom
    vec4 run = texture(tNoise, vec3(P.x * 0.43, P.y * 0.028, P.z * 0.43) + a1.w * 0.015);
    vec4 rib = texture(tNoise, vec3(P.x * 1.9, P.y * 0.07, P.z * 1.9) + a2.w * 0.01);
    float wall = 1.0 - abs(N.y);
    vec3 ribs = (vec3(run.x, 0.0, run.z) * 0.43 * 0.03 + vec3(rib.x, 0.0, rib.z) * 1.9 * 0.006 * s3) * wall;

    // ---- moss, where daylight reaches and the rock faces up enough to hold it
    float day = vBake.z + 1.2 * vBake.w;
    float moss = smoothstep(0.08, 0.7, day) * smoothstep(0.05, 0.6, N.y + 0.5 * a2.w + 0.35 * a4.w) * smoothstep(-0.25, 0.35, a1.w + 0.6 * a3.w + 0.3 * a5.w);
    moss = saturate(moss * 1.2) * step(WATER_Y + 0.03, P.y);

    // (a3 is folded over, which gives a sharp crease where it crosses zero)
    vec3 broad = (a2.xyz * R2) * 0.006 + (a3.xyz * R1) * sign(a3.w) * 0.009 * s3 + ribs;
    // the grain itself: rough at every size down to what a pixel can hold; moss is a soft pile, finer still
    vec3 fine = (a4.xyz * R2) * 0.011 * s4 + a5.xyz * 0.016 * s5 + (a6.xyz * R1) * mix(0.03, 0.036, moss) * s6 + (a7.xyz * R2) * mix(0.03, 0.038, moss) * s7 + a8.xyz * 0.02 * s8;
    // how deep in the grain this point lies: about -1 in a crack, 1 on a crest
    float height = 0.3 * a2.w + (abs(a3.w) * 1.6 - 0.5) * 0.35 * s3 + 0.3 * a4.w * s4 + 0.3 * a5.w * s5 + 0.3 * a6.w * s6 + 0.2 * a7.w * s7 - 1.3 * crack * (1.0 - 0.6 * moss) - 0.45 * seam;

    vec3 slope = (broad + fine) * uBump;
    vec3 tilt = lean * (1.0 - 0.5 * moss) * uBump;
    vec3 Nd = normalize(N + (tilt - dot(tilt, N) * N) - (slope - dot(slope, N) * N));
    // damp lying on the rock fills the finest grain: it keeps to the faces of the blocks and the broader shapes
    vec3 calm = (broad * 0.8 + fine * 0.3) * uBump;
    vec3 Nf = normalize(N + (tilt - dot(tilt, N) * N) * 0.85 - (calm - dot(calm, N) * N));

    // ---- how damp: mostly not; in runs down the walls, in the cracks, in patches, and soaked beside the pools
    float wet = 0.16 + 0.34 * a0.w + 0.24 * a1.w + 0.5 * max(run.w, 0.0) * wall + 0.3 * crack + 0.12 * (b2.r - 0.5);
    wet = clamp(wet * uWet, 0.0, 0.8) * (1.0 - 0.7 * moss);
    float soak = smoothstep(0.24, 0.02, P.y - WATER_Y + 0.05 * a3.w);
    wet = max(wet, soak);
    float under = step(P.y, WATER_Y);

    // ---- the stone: brown to khaki limestone, bed on bed, no two blocks quite the same
    float tone = saturate(0.5 + 0.34 * a0.w + 0.3 * a1.w + 0.2 * a2.w + 0.14 * a4.w);
    vec3 rock = mix(vec3(0.07, 0.058, 0.044), vec3(0.34, 0.285, 0.2), tone);
    float bed = texture(tNoise, vec3(P.x * 0.02, P.y * 0.5 + a0.w * 0.1, P.z * 0.02)).w;
    rock *= 0.82 + 0.34 * bed;
    rock *= (0.74 + 0.5 * b1.g) * (0.8 + 0.4 * b2.b) * (0.86 + 0.28 * b3.r * t3);
    // iron washed out of the rock
    float iron = smoothstep(0.2, 0.9, a1.w * 0.9 + a3.w * 0.4 + bed * 0.5);
    rock = mix(rock, rock * vec3(1.45, 0.9, 0.52), iron * 0.6);
    // lime left where water has run, and in thin white veins through the rock
    float lime = smoothstep(0.2, 0.85, N.y * 0.4 + a2.w * 0.5 + run.w * 0.8);
    rock = mix(rock, vec3(0.44, 0.42, 0.36), lime * 0.34);
    float vein = (1.0 - smoothstep(0.0, 0.05, abs(a2.w + 0.35 * a3.w))) * smoothstep(-0.1, 0.5, a1.w);
    rock = mix(rock, vec3(0.6, 0.58, 0.52), vein * 0.65);
    // black where water has carried manganese down the wall
    rock *= 1.0 - 0.5 * smoothstep(0.25, 0.8, -run.w + 0.3 * a2.w) * wall;
    // pale lichen in blotches, on the drier rock
    float lichen = smoothstep(0.42, 0.6, 0.55 * a3.w + 0.5 * a4.w + 0.6 * b3.g - 0.15) * (1.0 - wet) * smoothstep(0.0, 0.2, day + 0.08);
    rock = mix(rock, vec3(0.4, 0.41, 0.33), lichen * 0.6);
    // the grain: every size of speck and pit, down to what a pixel can hold
    rock *= 1.0 + 0.22 * a5.w * s5 + 0.34 * a6.w * s6 + 0.36 * a7.w * s7 + 0.3 * a8.w * s8;
    rock *= 1.0 - 0.55 * smoothstep(0.35, 0.8, a7.w - 0.3 * a6.w) * s7;
    rock += 0.09 * smoothstep(0.55, 0.9, -a6.w + 0.4 * a8.w * s8) * s6;
    vec3 green = mix(vec3(0.022, 0.04, 0.012), vec3(0.075, 0.105, 0.03), saturate(0.5 + 0.5 * a4.w + 0.4 * a6.w * s6 + 0.3 * a7.w * s7));
    rock = mix(rock, green * (1.0 + 0.35 * a8.w * s8), moss);
    // dark in the cracks and the pits
    float cavity = saturate(0.76 + 0.42 * height);
    rock *= mix(0.4, 1.0, cavity);
    // damp stone is darker, and deeper in colour
    vec3 albedo = rock * mix(1.0, 0.5, wet);
    float grey = dot(albedo, vec3(0.3, 0.55, 0.15));
    albedo = max(mix(vec3(grey), albedo, 1.0 + 0.3 * wet), 0.0);

    // only a sheen where it is damp; a true shine only where it is soaked
    float film = smoothstep(0.3, 0.75, wet) * mix(0.55, 1.0, soak) * (1.0 - under);
    float roughRock = mix(0.94, 0.7, wet);
    float roughFilm = mix(0.42, mix(0.2, 0.09, soak), smoothstep(0.3, 0.8, wet));
    // (a mirror that small glints from pixel to pixel: where the face curves within a pixel it is taken as rougher)
    vec3 ddx = dFdx(Nf), ddy = dFdy(Nf);
    float aFilm = roughFilm * roughFilm;
    aFilm = sqrt(saturate(aFilm * aFilm + min(dot(ddx, ddx) + dot(ddy, ddy), 0.09)));
    float aRock = roughRock * roughRock;
    float NdV = saturate(dot(Nd, V)) + 1e-3;
    float NfV = saturate(dot(Nf, V)) + 1e-3;
    // the grain shades itself: light does not get down into it
    float pit = mix(0.5, 1.0, cavity);

    // ---- the crystals' light
    vec3 toGem = uGemPos - P;
    float d2 = dot(toGem, toGem);
    float d = sqrt(d2);
    vec3 L = toGem / d;
    // the grain cannot catch light the face itself is turned away from
    float facing = smoothstep(-0.08, 0.16, dot(N, L));
    // (and rock turned away from the crystals needs no looking to know it is in shadow: from the way in, that is most of it)
    float shadow = 0.0;
    if (facing > 0.0) shadow = timed == 2 || timed >= 6 ? gemShadowHard(P + N * 0.05) : gemShadow(P + N * 0.05, seed);
    // (close to, the crystals are a cluster of lamps and not one point: their light does not grow without end)
    vec3 E = uGemLight / (d2 + 0.75) * shadow * facing * pit;

    // ---- (1) the grain throws shadows of its own: where the rock rises toward the light more steeply than the light
    // comes in, the point lies behind a bump. Looked for a few centimetres toward the light, round the crystals only.
    if (uExtra.x > 0.0 && byGem > 0.0 && timed < 6) {
      float low = dot(N, L);
      vec3 toward = L - low * N;
      toward /= max(length(toward), 1e-4);
      float rise = (textureLod(tNoise, R2 * (P + toward * 0.03) * 2.3, copy + 1.2).w - a4.w) * 0.16 * s4
        + (textureLod(tNoise, (P + toward * 0.012) * 6.1 + 0.5, copy + 2.6).w - a5.w) * 0.22 * s5;
      float lift = low / max(sqrt(1.0 - low * low), 0.05);
      E *= 1.0 - 0.9 * smoothstep(lift - 0.2, lift + 0.2, rise * 2.6) * byGem * uExtra.x;
    }

    // ---- (3) the crystals are prisms: their light does not leave them evenly but in streaks. The streaks belong to
    // the crystals, which do not move: they only lean a little after the heart of the light, and waver by themselves.
    if (uExtra.z > 0.0) {
      vec3 q = normalize(P - mix(GEM_MID, uGemPos, 0.12));
      q.y *= 0.3;
      float c1 = textureLod(tNoise, q * 0.55 + vec3(0.0, uTime * 0.006, 0.0), 0.0).w;
      float c2 = textureLod(tNoise, q.zxy * 1.3 + 0.37 - vec3(uTime * 0.004), 0.0).w;
      float streak = pow(saturate(1.0 - abs(c1 + 0.5 * c2) * 1.9), 3.0);
      E *= 1.0 + (streak * 2.8 - 0.4) / (1.0 + d2 * 0.05) * uExtra.z;
    }

    float NdL = saturate(dot(Nd, L));
    vec3 H = normalize(L + V);
    vec3 col = albedo / PI * E * NdL;
    // (dry rock barely shines, even at a glancing angle)
    float gloss = mix(0.3, 1.0, wet);
    col += E * NdL * min(ggx(saturate(dot(Nd, H)), NdV, NdL, aRock), 3.0) * fresnel(saturate(dot(V, H)), 0.04) * gloss;

    // ---- (2) specks of mineral in the stone, each a tiny mirror turned its own way: one flashes when it happens to
    // throw the light straight at the eye, so they wink on and off as the light or the eye moves
    float speck = 0.0;
    vec3 facet = N;
    if (uExtra.y > 0.0 && timed < 6) {
      vec4 g = texture(tBreak, R2 * P * 14.0 + 0.19, crisp - 0.75);
      facet = normalize(N + ((g.rgb * 2.0 - 1.0) * R2) * 1.1);
      speck = smoothstep(0.45, 0.65, fract(g.r * 5.3 + g.g * 9.1)) * smoothstep(0.25, 0.5, g.a) * seen(${lump(7)}, px) * (1.0 - 0.8 * moss) * (1.0 - under) * uExtra.y;
      col += E * pow(saturate(dot(facet, H)), 160.0) * speck * 15.0;
    }

    // on the damp the crystals show as a lamp of their own size, not as a point
    vec3 Rf = reflect(-V, Nf);
    vec3 off = dot(toGem, Rf) * Rf - toGem;
    vec3 Ls = normalize(toGem + off * saturate(GEM_R / max(length(off), 1e-4)));
    float wider = saturate(aFilm + GEM_R / (2.0 * d));
    float NfL = saturate(dot(Nf, Ls));
    vec3 Hf = normalize(Ls + V);
    float shine = ggx(saturate(dot(Nf, Hf)), NfV, NfL, aFilm) * (aFilm * aFilm) / (wider * wider);
    col += E * NfL * shine * fresnel(saturate(dot(V, Hf)), 0.025) * film;

    // ---- the sun, where it comes down through the roof
    float sun = 0.0;
    if (timed != 3 && timed != 6 && dot(N, SUN_DIR) < 0.06) sun = sunShadow(P + N * 0.05, fract(seed + 0.37));
    if (sun > 0.0) {
      vec3 S = -SUN_DIR;
      vec3 Es = uSunLight * sun * smoothstep(-0.06, 0.14, dot(N, S)) * pit;
      float NdS = saturate(dot(Nd, S));
      vec3 Hs = normalize(S + V);
      col += albedo / PI * Es * NdS;
      col += Es * NdS * min(ggx(saturate(dot(Nd, Hs)), NdV, NdS, aRock), 3.0) * fresnel(saturate(dot(V, Hs)), 0.04) * gloss;
      float NfS = saturate(dot(Nf, S));
      col += Es * NfS * min(ggx(saturate(dot(Nf, Hs)), NfV, NfS, max(aFilm, 0.02)), 40.0) * fresnel(saturate(dot(V, Hs)), 0.025) * film;
      col += Es * pow(saturate(dot(facet, Hs)), 160.0) * speck * 8.0;
    }

    // ---- light off the other walls, and the sky through the hole
    float open = vBake.x;
    vec3 around = vBake.y * uGemLight + vBake.z * uSkyLight + vBake.w * uSunLight + uSkyLight * 0.0012 * open;
    col += albedo / PI * around * mix(0.5, 1.0, cavity);

    // ---- a shell of light on its way out from the crystals: a bright line where it meets the rock, and behind it the
    // rock lit for a moment as if from the crystals, shadow or no shadow
    vec2 shell = pulse(P);
    col += PULSE_COLOR * (shell.x * (0.12 + 0.5 * cavity) * mix(0.6, 1.0, wet) + albedo / PI * shell.y * 3.4 * (0.3 + 0.7 * NdL) * pit);

    // ---- the cave around, mirrored in the damp
    vec3 o = P - ${`vec3(${ROOM.centre.toArray().map((v) => v.toFixed(2)).join(", ")})`};
    float b = dot(o, Rf);
    float reachT = -b + sqrt(max(b * b - dot(o, o) + ${(ROOM.radius * ROOM.radius).toFixed(2)}, 0.0));
    vec3 mirrored = timed == 5 || timed >= 6 ? vec3(0.0) : textureLod(tEnv, P + Rf * reachT - uEnvPos, 1.0 + roughFilm * 7.0).rgb;
    col += mirrored * fresnel(NfV, 0.025) * film * open * open * uEnv * 0.8;

    // what lies under the pools is seen through their water
    col *= mix(vec3(1.0), exp(-max(WATER_Y - P.y, 0.0) * vec3(9.0, 5.5, 7.0)) * 0.42, under);

    gl_FragColor = vec4(col, 1.0);
  }
`;

// writes how far each point is from the crystals, for their shadows
export const distanceMaterial = () =>
  new ShaderMaterial({
    uniforms: { uGemPos: common.uGemPos },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uGemPos;
      varying vec3 vWorld;
      void main() { gl_FragColor = vec4(length(vWorld - uGemPos), 0.0, 0.0, 1.0); }
    `,
    side: 2,
  });

export async function createCave(grid: Grid, report: (done: number) => Promise<void> | void) {
  const built = await buildMesh(grid, (d) => report(d * 0.3));
  const bake = await bakeLight(grid, built.position, built.normal, built.count, (d) => report(0.3 + d * 0.7));
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(built.position, 3));
  geometry.setAttribute("normal", new BufferAttribute(built.normal, 3));
  geometry.setAttribute("aBake", new BufferAttribute(bake, 4));
  geometry.setIndex(new BufferAttribute(built.index, 1));
  geometry.computeBoundingSphere();
  const material = new ShaderMaterial({
    uniforms: {
      ...common,
      tBreak: shared.tBreak,
      tEnv: { value: null },
      uEnv: { value: 0 },
      uEnvPos: { value: new Vector3() },
      uBump: { value: 1 },
      uWet: { value: 1 },
      uFlat: { value: 0 },
      uCrisp: { value: new Vector3(-0.35, -1, 1.25) },
      uExtra: { value: new Vector3(0, 0, 1) },
    },
    vertexShader: vertex,
    fragmentShader: fragment,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = "cave";
  mesh.frustumCulled = false;
  return mesh;
}
