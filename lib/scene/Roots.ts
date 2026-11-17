import { BufferAttribute, BufferGeometry, Group, InstancedBufferAttribute, InstancedBufferGeometry, Matrix4, Mesh, Quaternion, ShaderMaterial, Vector3 } from "three";
import type { Grid } from "./Field";
import { sample } from "./Field";
import { BOUNDS, LAYER, SHAFT, SUN_DIR, common, glslCommon, glslWind, rng } from "./shared";

// What the trees above have sent down through the hole in the roof after water: roots hanging like ropes, some nearly
// to the floor, and creepers in leaf among them. The air coming down the hole keeps them all moving a little.

const stemVertex = /* glsl */ `
  ${glslCommon}
  ${glslWind}
  attribute vec2 aAlong;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vWorld = position + sway(aAlong.y, aAlong.x);
    vNormal = normal;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const stemFragment = /* glsl */ `
  ${glslCommon}
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 bark = mix(vec3(0.11, 0.075, 0.045), vec3(0.2, 0.15, 0.09), 0.5 + 0.5 * texture(tNoise, vWorld * vec3(9.0, 1.2, 9.0)).w);
    vec3 toGem = uGemPos - vWorld;
    float d2 = dot(toGem, toGem);
    vec3 E = uGemLight / (d2 + 0.75) * gemShadowHard(vWorld) * saturate(0.25 + 0.75 * dot(N, toGem * inversesqrt(d2)));
    E += uSunLight * sunShadowHard(vWorld + N * 0.03) * saturate(0.2 + 0.8 * dot(N, -SUN_DIR));
    // the sky down the hole, and a little of everything else
    E += uSkyLight * shaftLight(vWorld) * (0.6 + 0.4 * N.y) + (uSunLight * 0.004 + uGemLight * 0.002);
    vec2 shell = pulse(vWorld);
    gl_FragColor = vec4(bark / PI * (E + PULSE_COLOR * shell.y * 4.0) + PULSE_COLOR * shell.x * 0.35, 1.0);
  }
`;

const leafVertex = /* glsl */ `
  ${glslCommon}
  ${glslWind}
  // where on its stem the leaf is fixed, which way it is turned, and (how far down the stem, the stem's own number, the
  // leaf's length, the leaf's own number)
  attribute vec3 aAnchor;
  attribute vec4 aTurn;
  attribute vec4 aLeaf;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vFlat;
  varying vec4 vLit;

  vec3 turned(vec3 v, vec4 q) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

  void main() {
    float own = aLeaf.w;
    float wind = gust(aLeaf.y);
    // a leaf twists on its stalk and nods, quicker than the stem it hangs from
    float twist = (sin(uTime * (1.7 + 1.6 * own) + own * 40.0) * 0.5 + sin(uTime * 4.3 + own * 17.0) * 0.12) * (0.25 + 0.75 * wind);
    float nod = sin(uTime * (1.1 + own) + own * 9.0) * 0.28 * wind;
    vec3 p = position * aLeaf.z, n = normal;
    float c = cos(twist), s = sin(twist);
    p = vec3(p.x * c + p.z * s, p.y, p.z * c - p.x * s);
    n = vec3(n.x * c + n.z * s, n.y, n.z * c - n.x * s);
    c = cos(nod); s = sin(nod);
    p = vec3(p.x, p.y * c - p.z * s, p.z * c + p.y * s);
    n = vec3(n.x, n.y * c - n.z * s, n.z * c + n.y * s);
    vec3 at = aAnchor + sway(aLeaf.y, aLeaf.x);
    vWorld = at + turned(p, aTurn);
    vNormal = turned(n, aTurn);
    vFlat = vec3(position.xy, own);
    // (the lights are looked up once for the whole leaf, where it is fixed)
    vec3 toGem = uGemPos - at;
    vLit = vec4(uGemLight / (dot(toGem, toGem) + 0.75) * gemShadowHard(at), sunShadowHard(at));
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const leafFragment = /* glsl */ `
  ${glslCommon}
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vFlat;
  varying vec4 vLit;
  void main() {
    vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    // no two leaves the same green; paler along the rib, and darker toward the stalk
    vec3 leaf = mix(vec3(0.03, 0.075, 0.016), vec3(0.085, 0.15, 0.03), vFlat.z) * (0.75 + 0.35 * vFlat.y);
    leaf = mix(leaf, leaf * vec3(1.5, 1.4, 1.1), smoothstep(0.035, 0.0, abs(vFlat.x)));
    vec3 S = -SUN_DIR;
    float towards = dot(N, S);
    // a leaf lets light through: seen from underneath with the sun on it, it glows
    vec3 col = leaf / PI * uSunLight * vLit.a * (saturate(towards) + saturate(-towards) * vec3(1.6, 2.1, 0.5) * 0.55);
    vec3 L = normalize(uGemPos - vWorld);
    col += leaf / PI * vLit.rgb * (0.3 + 0.7 * abs(dot(N, L)));
    col += leaf / PI * (uSkyLight * shaftLight(vWorld) * (0.55 + 0.45 * N.y) + uSunLight * 0.004 + uGemLight * 0.002);
    vec2 shell = pulse(vWorld);
    col += PULSE_COLOR * (leaf / PI * shell.y * 4.0 + shell.x * 0.3);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// one leaf, lying along +y from its stalk, folded a little along its rib
function leafShape() {
  const half = [0, 0.2, 0.235, 0.15, 0];
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const fold = 0.09;
  for (let i = 0; i < 5; i++) {
    const y = i / 4;
    // rib, left edge, right edge; the tip curls down a touch
    const dip = -0.1 * y * y;
    pos.push(0, y, dip, -half[i], y, dip + fold * (half[i] / 0.235), half[i], y, dip + fold * (half[i] / 0.235));
    nor.push(0, 0.1, 1, 0.35, 0.1, 0.93, -0.35, 0.1, 0.93);
  }
  for (let i = 0; i < 4; i++) {
    const c = i * 3, n = c + 3;
    idx.push(c, n + 1, c + 1, c, n, n + 1, c, n + 2, n, c, c + 2, n + 2);
  }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx };
}

export function createRoots(grid: Grid) {
  const r = rng(313);
  // a second run of numbers for the leaves, so the stems grow where they did before there were any
  const rl = rng(717);
  const pos: number[] = [], nor: number[] = [], along: number[] = [], idx: number[] = [];
  const anchor: number[] = [], turn: number[] = [], info: number[] = [];
  const SIDES = 5;
  const p = new Vector3(), q = new Vector3(), tangent = new Vector3(), u = new Vector3(), v = new Vector3();
  const lx = new Vector3(), ly = new Vector3(), lz = new Vector3(), basis = new Matrix4(), quat = new Quaternion();
  const leafAt = (at: Vector3, s: number, seed: number, size: number) => {
    // it grows out from the stem and hangs: mostly outward, somewhat down
    const a = rl() * Math.PI * 2;
    ly.set(Math.cos(a), -0.25 - 0.9 * rl(), Math.sin(a)).normalize();
    lx.set(-Math.sin(a), (rl() - 0.5) * 0.6, Math.cos(a)).normalize();
    lz.crossVectors(lx, ly).normalize();
    lx.crossVectors(ly, lz);
    quat.setFromRotationMatrix(basis.makeBasis(lx, ly, lz));
    anchor.push(at.x, at.y, at.z);
    turn.push(quat.x, quat.y, quat.z, quat.w);
    info.push(s, seed, size, rl());
  };
  // the hole runs along the sun's line; roots start from its wall, part-way up
  const across = new Vector3(SUN_DIR.y, -SUN_DIR.x, 0).normalize(), other = new Vector3().crossVectors(SUN_DIR, across);
  for (let i = 0; i < 46; i++) {
    const around = r() * Math.PI * 2, up = 0.5 + r() * 3.4;
    // out from the middle of the hole until rock is met
    q.copy(SHAFT.foot).addScaledVector(SUN_DIR, -up);
    const out = p.copy(across).multiplyScalar(Math.cos(around)).addScaledVector(other, Math.sin(around));
    let far = 0.4;
    while (far < 4.5 && sample(grid, q.x + out.x * far, q.y + out.y * far, q.z + out.z * far) < 0) far += 0.05;
    if (far >= 4.5) continue;
    // a root hangs a little clear of the wall it came through
    const hang = far - 0.1 - r() * r() * 1.1;
    const x0 = q.x + out.x * hang, y0 = Math.min(q.y + out.y * hang, BOUNDS.max.y - 0.5), z0 = q.z + out.z * hang;
    const length = 1.2 + 6.2 * Math.pow(r(), 1.6);
    const thick = 0.006 + 0.014 * r() * r();
    const bend = 0.05 + 0.12 * r(), phase = r() * 6.28, kink = 1.2 + 2.5 * r();
    const seed = i / 46;
    // two in three are creepers, in leaf; the rest bare root
    const leafy = rl() < 0.68;
    let nextLeaf = 0.15 + 0.3 * rl();
    const at = (s: number, to: Vector3) => to.set(x0 + Math.sin(s * kink + phase) * bend * Math.min(1, s), y0 - s, z0 + Math.cos(s * kink * 0.8 + phase * 1.7) * bend * Math.min(1, s));
    const base = pos.length / 3;
    let rings = 0;
    for (let s = -0.3; s <= length; s += 0.12) {
      at(s, p);
      // (it stops at whatever it comes down onto)
      if (s > 0.5 && sample(grid, p.x, p.y, p.z) > -0.02) break;
      at(s + 0.05, tangent).sub(p).normalize();
      u.set(1, 0, 0).cross(tangent).normalize();
      v.crossVectors(tangent, u);
      // thinner toward the tip
      const rad = thick * (1 - 0.75 * Math.max(0, s) / length);
      for (let k = 0; k < SIDES; k++) {
        const a = (k / SIDES) * Math.PI * 2;
        const nx = u.x * Math.cos(a) + v.x * Math.sin(a), ny = u.y * Math.cos(a) + v.y * Math.sin(a), nz = u.z * Math.cos(a) + v.z * Math.sin(a);
        pos.push(p.x + nx * rad, p.y + ny * rad, p.z + nz * rad);
        nor.push(nx, ny, nz);
        along.push(s, seed);
      }
      if (rings > 0)
        for (let k = 0; k < SIDES; k++) {
          const a = base + (rings - 1) * SIDES + k, b = base + (rings - 1) * SIDES + ((k + 1) % SIDES);
          idx.push(a, a + SIDES, b, b, a + SIDES, b + SIDES);
        }
      rings++;
      // leaves in ones and twos down the creeper, larger where there is more light near the top
      while (leafy && s >= nextLeaf) {
        const size = (0.1 + 0.11 * rl()) * (1 - 0.35 * (s / length));
        leafAt(p, s, seed, size);
        if (rl() < 0.45) leafAt(p, s, seed, size * (0.6 + 0.3 * rl()));
        nextLeaf += 0.07 + 0.16 * rl();
      }
    }
  }

  const stems = new BufferGeometry();
  stems.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  stems.setAttribute("normal", new BufferAttribute(new Float32Array(nor), 3));
  stems.setAttribute("aAlong", new BufferAttribute(new Float32Array(along), 2));
  stems.setIndex(idx);
  const stemMesh = new Mesh(stems, new ShaderMaterial({ uniforms: { ...common }, vertexShader: stemVertex, fragmentShader: stemFragment, side: 2 }));
  stemMesh.name = "roots";

  const shape = leafShape();
  const leaves = new InstancedBufferGeometry();
  leaves.setAttribute("position", new BufferAttribute(shape.pos, 3));
  leaves.setAttribute("normal", new BufferAttribute(shape.nor, 3));
  leaves.setIndex(shape.idx);
  leaves.setAttribute("aAnchor", new InstancedBufferAttribute(new Float32Array(anchor), 3));
  leaves.setAttribute("aTurn", new InstancedBufferAttribute(new Float32Array(turn), 4));
  leaves.setAttribute("aLeaf", new InstancedBufferAttribute(new Float32Array(info), 4));
  leaves.instanceCount = info.length / 4;
  const leafMesh = new Mesh(leaves, new ShaderMaterial({ uniforms: { ...common }, vertexShader: leafVertex, fragmentShader: leafFragment, side: 2 }));
  leafMesh.name = "leaves";

  const group = new Group();
  group.add(stemMesh, leafMesh);
  group.traverse((o) => {
    o.frustumCulled = false;
    o.layers.set(LAYER.plant);
  });
  return group;
}
