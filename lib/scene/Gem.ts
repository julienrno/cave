import { BufferAttribute, BufferGeometry, Mesh, ShaderMaterial, Vector3 } from "three";
import { GEM, GEM_POWER, LAYER, common, glslCommon, rng } from "./shared";

// A cluster of six-sided crystals, the kind quartz grows as: a long one standing, the rest leaning out around its foot.
// They are the only lamp in the cave.

type Crystal = { base: Vector3; axis: Vector3; length: number; radius: number; seed: number };

function cluster(footY: number) {
  const r = rng(41);
  const list: Crystal[] = [
    { base: new Vector3(0.02, footY - 0.2, 0), axis: new Vector3(0.07, 1, -0.05).normalize(), length: 1.32, radius: 0.155, seed: r() },
    { base: new Vector3(-0.13, footY - 0.2, 0.07), axis: new Vector3(-0.26, 1, 0.12).normalize(), length: 0.98, radius: 0.115, seed: r() },
    { base: new Vector3(0.13, footY - 0.2, -0.09), axis: new Vector3(0.3, 1, -0.22).normalize(), length: 0.84, radius: 0.1, seed: r() },
  ];
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 + r() * 0.5, lean = 0.5 + 0.75 * r();
    const out = 0.1 + 0.2 * r();
    list.push({
      base: new Vector3(Math.cos(a) * out, footY - 0.16, Math.sin(a) * out),
      axis: new Vector3(Math.cos(a) * lean, 1, Math.sin(a) * lean).normalize(),
      length: 0.34 + 0.42 * r() * r(),
      radius: 0.04 + 0.05 * r(),
      seed: r(),
    });
  }
  return list;
}

function geometry(list: Crystal[]) {
  const pos: number[] = [], nor: number[] = [], inner: number[] = [];
  const u = new Vector3(), v = new Vector3(), a = new Vector3(), b = new Vector3(), c = new Vector3(), n = new Vector3();
  const r = rng(77);
  // flat faces: every corner carries its own face's direction
  const tri = (p: Vector3, q: Vector3, s: Vector3, k: Crystal, hp: number, hq: number, hs: number) => {
    n.copy(q).sub(p).cross(c.copy(s).sub(p)).normalize();
    for (const [w, h] of [[p, hp], [q, hq], [s, hs]] as [Vector3, number][]) {
      pos.push(w.x, w.y, w.z);
      nor.push(n.x, n.y, n.z);
      // how far up the crystal (0 at its foot, 1 at its point), its thickness, and a number of its own
      inner.push(h, k.radius, k.seed);
    }
  };
  for (const k of list) {
    u.set(1, 0, 0).cross(k.axis).normalize();
    v.copy(k.axis).cross(u);
    const turn = r() * Math.PI;
    // no two sides quite the same width
    const side = Array.from({ length: 6 }, () => 0.8 + 0.4 * r());
    const neck = k.length - k.radius * (1.5 + 1.1 * r());
    const tipOff = [(r() - 0.5) * 0.5 * k.radius, (r() - 0.5) * 0.5 * k.radius];
    const ring = (i: number, h: number, out: Vector3) => {
      const ang = turn + (i / 6) * Math.PI * 2;
      // a touch narrower toward the point
      const rad = k.radius * side[i % 6] * (1 - 0.12 * (h / k.length));
      return out.copy(k.base).addScaledVector(k.axis, h).addScaledVector(u, Math.cos(ang) * rad).addScaledVector(v, Math.sin(ang) * rad);
    };
    const tip = new Vector3().copy(k.base).addScaledVector(k.axis, k.length).addScaledVector(u, tipOff[0]).addScaledVector(v, tipOff[1]);
    const p0 = new Vector3(), p1 = new Vector3(), p2 = new Vector3(), p3 = new Vector3();
    for (let i = 0; i < 6; i++) {
      ring(i, 0, p0);
      ring(i + 1, 0, p1);
      ring(i + 1, neck, p2);
      ring(i, neck, p3);
      const top = neck / k.length;
      tri(p0, p1, p2, k, 0, 0, top);
      tri(p0, p2, p3, k, 0, top, top);
      tri(p3, p2, tip, k, top, top, 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute("aInner", new BufferAttribute(new Float32Array(inner), 3));
  return g;
}

const vertex = /* glsl */ `
  attribute vec3 aInner;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vInner;
  void main() {
    vWorld = position;
    vNormal = normal;
    vInner = aInner;
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;

const fragment = /* glsl */ `
  ${glslCommon}
  uniform samplerCube tEnv;
  uniform vec3 uEnvPos;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vInner;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorld);
    float NdV = saturate(dot(N, V));
    vec3 tint = uGemLight / max(max(uGemLight.r, uGemLight.g), uGemLight.b);
    float power = max(max(uGemLight.r, uGemLight.g), uGemLight.b) / ${GEM_POWER.toFixed(1)};

    // looking into a face, the eye goes in along a bent line; veils and flaws hang inside at different depths
    vec3 into = refract(-V, N, 1.0 / 1.55);
    float flaws = 0.0;
    for (int i = 1; i <= 3; i++) {
      vec3 q = vWorld + into * (0.035 * float(i) * float(i)) + vInner.z * 7.0;
      float f = texture(tNoise, q * vec3(0.9, 0.35, 0.9) * float(i)).w;
      flaws += smoothstep(0.55, 0.0, abs(f)) / float(i);
    }
    // the light is made low in the heart of each crystal: brightest seen square on and near the foot, fading to the point
    float up = smoothstep(0.0, 1.0, vInner.x);
    // the light has a heart, somewhere inside the cluster (the pointer moves it): the crystal is brightest round it
    vec3 fromHeart = vWorld - uGemPos;
    float near = exp(-dot(fromHeart, fromHeart) * 5.5);
    float heart = pow(NdV, 2.0) * mix(0.22, 1.75, near);
    // the body of the crystal is a deeper green than the light it gives
    vec3 deep = tint * tint;
    vec3 col = deep * (0.2 + 0.75 * flaws) * mix(1.3, 0.45, up) * (0.6 + 0.9 * near);
    col += mix(deep, tint, 0.5) * 1.25 * heart;
    col *= power;

    // the faces are polished: at a glancing angle they mirror the cave
    vec3 R = reflect(-V, N);
    float F = fresnel(NdV, 0.06);
    col = col * (1.0 - F) + textureLod(tEnv, vWorld + R * 5.0 - uEnvPos, 1.5).rgb * F * 2.0;
    // a brighter line along every edge, where the light inside is caught
    col += tint * power * 0.8 * pow(1.0 - NdV, 4.0) * (0.4 + 1.2 * near);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createGem(footY: number) {
  const material = new ShaderMaterial({
    uniforms: { ...common, tEnv: { value: null }, uEnvPos: { value: new Vector3() } },
    vertexShader: vertex,
    fragmentShader: fragment,
  });
  const mesh = new Mesh(geometry(cluster(footY)), material);
  mesh.name = "gem";
  mesh.layers.set(LAYER.gem);
  mesh.frustumCulled = false;
  return mesh;
}

// the crystals' own middle, for whatever needs to look at them
export const GEM_LOOK = new Vector3(GEM.x, GEM.y + 0.05, GEM.z);
