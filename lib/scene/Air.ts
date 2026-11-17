import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from "three";
import type { Grid } from "./Field";
import { drips, sample } from "./Field";
import { LAYER, WATER_Y, common, glslCommon, rng } from "./shared";

// What hangs and falls in the air of the cave: dust and droplets of mist that only show where light catches them, and
// the drops that fall from the dripstone into the pools.

const moteVertex = /* glsl */ `
  ${glslCommon}
  attribute vec4 aSeed;
  // pixels a metre covers, one metre away
  uniform float uPx;
  // where the lens is set (m), and the blur (pixels) of what is far behind that
  uniform float uFocus;
  uniform float uCoc;
  varying vec3 vLight;
  void main() {
    // each drifts round its own place, slowly
    vec3 p = position + vec3(
      sin(uTime * (0.05 + 0.06 * aSeed.x) + aSeed.y * 6.28),
      sin(uTime * (0.04 + 0.05 * aSeed.z) + aSeed.w * 6.28) * 0.6,
      cos(uTime * (0.05 + 0.05 * aSeed.y) + aSeed.z * 6.28)) * (0.25 + 0.4 * aSeed.w);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = max(-mv.z, 0.05);
    vec3 toGem = uGemPos - p;
    vec3 light = uGemLight / (dot(toGem, toGem) + 0.1) * gemShadowHard(p) + uSkyLight * shaftLight(p) * 0.6 + uSunLight * sunShadowHard(p) * 1.6;
    // (a shell of light passing lights every speck in it)
    vec2 shell = pulse(p);
    light += PULSE_COLOR * (shell.x * 5.0 + shell.y * 0.5);
    // a speck is far smaller than a pixel: it is drawn a pixel or two wide and as faint as its true size makes it
    // out of focus a speck spreads into a faint disc
    float soft = min(uCoc * abs(dist - uFocus) / dist * (dist < uFocus ? 0.4 : 1.0), uCoc * 1.6);
    float size = clamp((0.003 + 0.004 * aSeed.x) * uPx / dist, 1.2, 7.0) + 2.0 * soft;
    float glint = 0.55 + 0.45 * sin(uTime * (0.7 + 2.0 * aSeed.y) + aSeed.x * 40.0);
    float true_ = 0.0016 * uPx / dist;
    vLight = light * glint * 0.5 * min(1.0, (true_ * true_) / (size * size)) * smoothstep(0.15, 0.9, dist) * 12.0;
    gl_PointSize = size;
  }
`;

const speckFragment = /* glsl */ `
  varying vec3 vLight;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    gl_FragColor = vec4(vLight * smoothstep(1.0, 0.25, r), 1.0);
  }
`;

const dropVertex = /* glsl */ `
  ${glslCommon}
  uniform float uPx;
  varying vec3 vLight;
  void main() {
    vec4 mv = viewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = max(-mv.z, 0.05);
    vec3 toGem = uGemPos - position;
    // a drop is a small lens: it throws a spark of the lamp at whoever looks
    vLight = (uGemLight / (dot(toGem, toGem) + 0.1) * gemShadowHard(position) + uSkyLight * shaftLight(position) * 0.5 + uSunLight * sunShadowHard(position)) * 1.4;
    gl_PointSize = clamp(0.014 * uPx / dist, 1.5, 12.0);
  }
`;

const G = 9.81;

export function createAir(grid: Grid, lowPower: boolean) {
  const r = rng(101);
  const count = lowPower ? 1400 : 3200;
  const pos = new Float32Array(count * 3), seed = new Float32Array(count * 4);
  for (let i = 0; i < count; ) {
    const x = (r() * 2 - 1) * 7.5, y = 0.1 + r() * 7, z = -8.5 + r() * 20;
    if (sample(grid, x, y, z) > -0.3) continue;
    pos.set([x, y, z], i * 3);
    seed.set([r(), r(), r(), r()], i * 4);
    i++;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(pos, 3));
  geometry.setAttribute("aSeed", new BufferAttribute(seed, 4));
  const uPx = { value: 1000 }, uFocus = { value: 5 }, uCoc = { value: 0 };
  const material = (vertexShader: string) =>
    new ShaderMaterial({ uniforms: { ...common, uPx, uFocus, uCoc }, vertexShader, fragmentShader: speckFragment, blending: AdditiveBlending, depthWrite: false, transparent: true });
  const motes = new Points(geometry, material(moteVertex));
  motes.name = "motes";
  motes.frustumCulled = false;
  motes.layers.set(LAYER.air);

  // one drop to a dripping tip; each tip keeps its own slow time
  const sites = drips.map(([x, tip, z]) => ({ x, tip, z, every: (3.5 + r() * 7) / 1.15, at: r() * 8, y: tip, falling: false, v: 0 }));
  const dropPos = new Float32Array(sites.length * 3).fill(-999);
  const dropGeometry = new BufferGeometry();
  dropGeometry.setAttribute("position", new BufferAttribute(dropPos, 3));
  const drops = new Points(dropGeometry, material(dropVertex));
  drops.name = "drops";
  drops.frustumCulled = false;
  drops.layers.set(LAYER.air);

  return {
    motes,
    drops,
    uPx,
    uFocus,
    uCoc,
    // lets the drops fall; calls back where one lands in a pool
    update(dt: number, t: number, landed: (x: number, z: number) => void) {
      sites.forEach((s, i) => {
        if (!s.falling && t > s.at) {
          s.falling = true;
          s.y = s.tip;
          s.v = 0;
        }
        if (s.falling) {
          s.v += G * dt;
          s.y -= s.v * dt;
          if (s.y <= WATER_Y) {
            s.falling = false;
            s.at = t + s.every * (0.6 + 0.8 * r());
            landed(s.x, s.z);
          }
        }
        dropPos.set(s.falling ? [s.x, s.y, s.z] : [0, -999, 0], i * 3);
      });
      dropGeometry.attributes.position.needsUpdate = true;
    },
  };
}
