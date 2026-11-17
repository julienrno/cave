import { CustomBlending, HalfFloatType, LinearFilter, Matrix4, Mesh, OneFactor, PerspectiveCamera, Plane, PlaneGeometry, ShaderMaterial, SrcAlphaFactor, Vector3, Vector4, WebGLRenderTarget } from "three";
import { BOUNDS, LAYER, WATER_Y, common, glslCommon } from "./shared";

// rings on the pools at once
export const RINGS = 8;

const vertex = /* glsl */ `
  uniform mat4 uMirror;
  varying vec3 vWorld;
  varying vec4 vMirror;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    vMirror = uMirror * vec4(vWorld, 1.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

const fragment = /* glsl */ `
  ${glslCommon}
  uniform sampler2D tMirror;
  // where a drop fell (x, z), when, and how hard
  uniform vec4 uRings[${RINGS}];
  varying vec3 vWorld;
  varying vec4 vMirror;

  void main() {
    vec3 V = normalize(cameraPosition - vWorld);
    // still water, only just breathing; and the rings that spread from each drop
    vec2 tilt = (textureLod(tNoise, vec3(vWorld.xz * 0.21, uTime * 0.02), 0.0).xz + textureLod(tNoise, vec3(vWorld.zx * 0.67 + 0.4, uTime * 0.033), 0.0).xz) * 0.00022;
    for (int i = 0; i < ${RINGS}; i++) {
      vec4 ring = uRings[i];
      float age = uTime - ring.z;
      if (age < 0.0 || age > 9.0) continue;
      vec2 away = vWorld.xz - ring.xy;
      float r = length(away);
      float front = 0.42 * age;
      float x = r - front;
      // a short train of ripples just behind the front, dying as it spreads
      float train = sin(x * 34.0) * exp(-x * x * 7.0) * smoothstep(0.0, 0.25, age);
      tilt += away / max(r, 1e-3) * train * ring.w * 0.05 * exp(-age * 0.55) / (1.0 + 2.2 * front);
    }
    vec3 N = normalize(vec3(-tilt.x, 1.0, -tilt.y));
    float NdV = saturate(dot(N, V));
    // (a little more of a mirror than clean water is: a cave pool carries a skin of dust and lime)
    float F = 0.035 + 0.965 * pow(1.0 - NdV, 4.2);
    vec2 uv = vMirror.xy / vMirror.w + N.xz * 0.7;
    vec3 mirrored = texture(tMirror, uv).rgb;
    // what is not mirrored goes into the water: the floor of the pool shows through, a little dimmer
    gl_FragColor = vec4(mirrored * F, (1.0 - F) * 0.94);
  }
`;

export function createWater() {
  const target = new WebGLRenderTarget(4, 4, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, samples: 0 });
  const rings = Array.from({ length: RINGS }, () => new Vector4(0, 0, -100, 0));
  const material = new ShaderMaterial({
    uniforms: { ...common, tMirror: { value: target.texture }, uMirror: { value: new Matrix4() }, uRings: { value: rings } },
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: SrcAlphaFactor,
  });
  const w = BOUNDS.max.x - BOUNDS.min.x, d = BOUNDS.max.z - BOUNDS.min.z;
  const mesh = new Mesh(new PlaneGeometry(w, d).rotateX(-Math.PI / 2), material);
  mesh.position.set((BOUNDS.max.x + BOUNDS.min.x) / 2, WATER_Y, (BOUNDS.max.z + BOUNDS.min.z) / 2);
  mesh.name = "water";
  mesh.layers.set(LAYER.air);

  // the camera that sees what the pools mirror: the visitor's own, turned over under the water
  const under = new PerspectiveCamera();
  const fore = new Vector3(), up = new Vector3();
  // the surface of the pools (a touch under it, so the shore is not left with a gap), as the mirrored camera sees it
  const surface = new Plane(), cut = new Vector4(), corner = new Vector4();
  const half = new Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  let next = 0;

  return {
    mesh,
    target,
    under,
    rings,
    setSize(wide: number, high: number) {
      target.setSize(Math.max(2, wide >> 1), Math.max(2, high >> 1));
    },
    // set the mirrored camera from the visitor's
    follow(camera: PerspectiveCamera) {
      camera.getWorldDirection(fore);
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      under.position.copy(camera.position);
      under.position.y = 2 * WATER_Y - under.position.y;
      under.up.set(up.x, -up.y, up.z);
      fore.y = -fore.y;
      under.lookAt(fore.add(under.position));
      under.fov = camera.fov;
      under.aspect = camera.aspect;
      under.near = camera.near;
      under.far = camera.far;
      under.updateProjectionMatrix();
      under.updateMatrixWorld();
      material.uniforms.uMirror.value.copy(half).multiply(under.projectionMatrix).multiply(under.matrixWorldInverse);
      // The mirrored camera is under the water, and must see only what stands above it. Its near plane is laid along
      // the water's surface (Lengyel's oblique frustum): nothing under the surface is drawn, at no cost to the shaders.
      surface.set(up.set(0, 1, 0), -(WATER_Y - 0.03)).applyMatrix4(under.matrixWorldInverse);
      cut.set(surface.normal.x, surface.normal.y, surface.normal.z, surface.constant);
      const m = under.projectionMatrix.elements;
      corner.set((Math.sign(cut.x) + m[8]) / m[0], (Math.sign(cut.y) + m[9]) / m[5], -1, (1 + m[10]) / m[14]);
      cut.multiplyScalar(2 / cut.dot(corner));
      m[2] = cut.x;
      m[6] = cut.y;
      m[10] = cut.z + 1;
      m[14] = cut.w;
      under.projectionMatrixInverse.copy(under.projectionMatrix).invert();
    },
    // a drop has fallen in
    ring(x: number, z: number, t: number, strength: number) {
      rings[next].set(x, z, t, strength);
      next = (next + 1) % RINGS;
    },
    dispose() {
      target.dispose();
    },
  };
}
