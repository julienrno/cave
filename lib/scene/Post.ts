import {
  Color,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
} from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { common, glslCommon } from "./shared";

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const depthGlsl = /* glsl */ `
  uniform sampler2D tDepth;
  uniform vec2 uNearFar;
  uniform float uFocus;
  uniform float uCoc;
  float depthAt(vec2 uv) {
    float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
    return 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
  }
  // radius of the blur (pixels) for something this far away; uCoc is what a far background gets
  // (what is nearer than the focus is blurred less than a lens would: the pools mirror things far off, and must not smear them)
  float cocAt(float z) { return max(min(uCoc * abs(z - uFocus) / max(z, 1e-4) * (z < uFocus ? 0.4 : 1.0), uCoc * 1.6) - 0.5, 0.0); }
`;

// The damp air: every pixel's line of sight is walked from the eye to the rock, adding up the light the air throws
// toward the eye on the way. For the crystals the steps crowd in where the line passes nearest them, where their light
// is strongest; for the sun they are kept to the stretch of the line that crosses its beam. Rock in the way of either
// leaves a dark shaft in the air: that is what makes the rays.
const airShader = (steps: number, sunSteps: number) => /* glsl */ `
  ${glslCommon}
  uniform sampler2D tDepth;
  uniform vec2 uNearFar;
  uniform vec3 uCamPos;
  uniform vec3 uCamFore;
  uniform vec3 uCamRight;
  uniform vec3 uCamUp;
  // how much light a metre of this air scatters
  uniform float uThick;
  // how strongly the sun's rays show in the air (1 = as the rest of the light does)
  uniform float uRays;
  uniform float uFrame;
  varying vec2 vUv;

  float depthAt(vec2 uv) {
    float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
    return 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
  }

  // the mist is not even: it hangs in slow drifts
  float drift(vec3 p) { return 0.72 + 0.55 * textureLod(tNoise, p * 0.055 + vec3(uTime * 0.0035, -uTime * 0.0018, uTime * 0.0012), 0.0).w; }

  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec3 rd = normalize(uCamFore + uCamRight * ndc.x + uCamUp * ndc.y);
    float reach = depthAt(vUv) / dot(rd, uCamFore);
    float most = min(reach, 45.0);
    float jitter = ign(gl_FragCoord.xy + mod(uFrame, 64.0) * vec2(5.588, 3.191));

    vec3 toGem = uGemPos - uCamPos;
    float nearest = dot(toGem, rd);
    float miss = max(length(toGem - rd * nearest), 0.03);
    float thA = atan(-nearest / miss), thB = atan((most - nearest) / miss);
    float gem = 0.0;
    for (int i = 0; i < ${steps}; i++) {
      float t = nearest + miss * tan(mix(thA, thB, (float(i) + jitter) / ${steps.toFixed(1)}));
      vec3 p = uCamPos + rd * t;
      float d2 = miss * miss + (t - nearest) * (t - nearest);
      // light is thrown on forward more than back: the haze is brighter looking toward the lamp
      float c = dot(normalize(p - uGemPos), -rd);
      float phase = 0.0724 / pow(1.09 - 0.6 * c, 1.5);
      gem += gemShadowHard(p) * drift(p) * phase * exp(-uThick * (t + sqrt(d2))) * d2 / (d2 + GEM_R * GEM_R);
    }
    vec3 light = uGemLight * uThick * gem * (thB - thA) / miss / ${steps.toFixed(1)};

    // the sun's beam is a column down through the hole: only the stretch of the line of sight inside it is walked
    vec3 oc = uCamPos - SHAFT_TOP;
    vec3 across = rd - SUN_DIR * dot(rd, SUN_DIR), from = oc - SUN_DIR * dot(oc, SUN_DIR);
    float qa = dot(across, across), qb = dot(across, from), qc = dot(from, from) - ${(3.9 * 3.9).toFixed(2)};
    float disc = qb * qb - qa * qc;
    if (disc > 0.0 && qa > 1e-5) {
      float root = sqrt(disc);
      float t0 = max((-qb - root) / qa, 0.0), t1 = min((-qb + root) / qa, most);
      if (t1 > t0) {
        float beam = 0.0;
        for (int i = 0; i < ${sunSteps}; i++) {
          float t = mix(t0, t1, (float(i) + jitter) / ${sunSteps.toFixed(1)});
          vec3 p = uCamPos + rd * t;
          // (the mist in the beam is finer than the rest and sinks slowly down it)
          float wisp = 0.62 + 0.75 * textureLod(tNoise, p * 0.17 - SUN_DIR * uTime * 0.012 + vec3(uTime * 0.004, 0.0, -uTime * 0.003), 0.0).w;
          beam += sunShadowHard(p) * drift(p) * wisp * exp(-uThick * t);
        }
        // looking up the beam toward the sun the air is far brighter than looking down it
        float c = dot(SUN_DIR, -rd);
        float phase = 0.0555 / pow(1.3025 - 1.1 * c, 1.5);
        light += uSunLight * uThick * uRays * beam * (t1 - t0) / ${sunSteps.toFixed(1)} * phase;
      }
    }

    // the paler light of the sky, spreading from the hole, in even steps
    float day = 0.0;
    for (int i = 0; i < 5; i++) {
      float t = most * (float(i) + jitter) / 5.0;
      vec3 p = uCamPos + rd * t;
      day += shaftLight(p) * drift(p) * exp(-uThick * t);
    }
    light += uSkyLight * uThick * day * most / 5.0 * 0.16;

    gl_FragColor = vec4(light, exp(-uThick * most));
  }
`;

// How shut in each point is by the rock right round it, from the depths alone: the deep of a crack, the foot of a
// boulder, the corner where two faces meet get less of whatever light there is.
const shutShader = (taps: number) => /* glsl */ `
  uniform sampler2D tDepth;
  uniform vec2 uNearFar;
  // tangents of half the camera's field of view, across and up
  uniform vec2 uTan;
  varying vec2 vUv;

  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  vec3 place(vec2 uv) {
    float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
    float d = 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
    return vec3((uv * 2.0 - 1.0) * uTan * d, -d);
  }

  void main() {
    vec3 p = place(vUv);
    vec3 n = normalize(cross(dFdx(p), dFdy(p)));
    // looks about 40 cm round, less close to (never more than a tenth of the picture)
    float span = min(0.4, -p.z * 0.25);
    vec2 reach = min(span / (-p.z * uTan) * 0.5, vec2(0.1));
    float rot = ign(gl_FragCoord.xy) * 6.2832;
    float shut = 0.0;
    for (int i = 0; i < ${taps}; i++) {
      float fi = float(i) + 0.5;
      float a = fi * 2.39996 + rot;
      vec3 v = place(vUv + vec2(cos(a), sin(a)) * sqrt(fi / ${taps.toFixed(1)}) * reach) - p;
      float d2 = dot(v, v);
      shut += max(dot(n, v) * inversesqrt(d2 + 1e-6) - 0.12, 0.0) / (1.0 + d2 / (span * span) * 2.0);
    }
    gl_FragColor = vec4(clamp(1.0 - 2.4 * shut / ${taps.toFixed(1)}, 0.0, 1.0));
  }
`;

// the cave seen through that air
const joinShader = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tAir;
  uniform sampler2D tShut;
  uniform float uShut;
  uniform vec2 uRes;
  varying vec2 vUv;
  void main() {
    vec2 px = 2.0 / uRes;
    // (The air was worked out at half size, with a different start along each line of sight: it is spread a little.
    // Four looks half a step off to the corners, each of which the card already averages over four neighbours.)
    vec2 h = px * 0.5, k = vec2(h.x, -h.y);
    vec4 air = (texture2D(tAir, vUv + h) + texture2D(tAir, vUv - h) + texture2D(tAir, vUv + k) + texture2D(tAir, vUv - k)) * 0.25;
    float shut = (texture2D(tShut, vUv + h).r + texture2D(tShut, vUv - h).r + texture2D(tShut, vUv + k).r + texture2D(tShut, vUv - k).r) * 0.25;
    vec3 c = texture2D(tColor, vUv).rgb;
    // (what gives light of its own is not dimmed by being shut in)
    float own = smoothstep(1.5, 5.0, max(c.r, max(c.g, c.b)));
    c *= mix(1.0, mix(shut, 1.0, own), uShut);
    gl_FragColor = vec4(c * air.a + air.rgb, 1.0);
  }
`;

// depth of field, gathered at half size: each pixel collects the neighbours whose blur reaches it
const blurShader = (taps: number) => /* glsl */ `
  uniform sampler2D tColor;
  uniform vec2 uRes;
  ${depthGlsl}
  varying vec2 vUv;

  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

  void main() {
    vec4 c0 = texture2D(tColor, vUv);
    if (uCoc < 0.6) { gl_FragColor = c0; return; }
    float z0 = depthAt(vUv);
    float coc0 = cocAt(z0);
    float reach = uCoc * 1.6;
    vec3 acc = c0.rgb;
    float sum = 1.0;
    float spread = coc0;
    float rot = ign(gl_FragCoord.xy) * 6.2832;
    for (int i = 0; i < ${taps}; i++) {
      float fi = float(i) + 0.5;
      float r = sqrt(fi / ${taps.toFixed(1)}) * reach;
      float a = fi * 2.39996 + rot;
      vec2 uv = vUv + vec2(cos(a), sin(a)) * r / uRes;
      float z = depthAt(uv);
      float coc = cocAt(z);
      // what lies behind this pixel cannot smear over it further than the pixel is itself blurred
      if (z > z0) coc = min(coc, coc0 * 2.0);
      float w = smoothstep(r - 1.0, r + 1.0, coc);
      acc += texture2D(tColor, uv).rgb * w;
      spread += coc * w;
      sum += w;
    }
    // alpha: how blurred what landed here is, so soft rock in front can spill over sharp rock behind
    gl_FragColor = vec4(acc / sum, spread / sum);
  }
`;

// evens out the grain the gather leaves in the blurred parts
const smoothShader = /* glsl */ `
  uniform sampler2D tColor;
  uniform vec2 uRes;
  uniform float uCoc;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tColor, vUv);
    if (uCoc < 0.6) { gl_FragColor = c; return; }
    float r = min(c.a, uCoc) * 0.2;
    vec3 acc = c.rgb;
    float sum = 1.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      vec4 s = texture2D(tColor, vUv + vec2(float(i), float(j)) * r / uRes);
      float w = smoothstep(0.0, 1.5, s.a);
      acc += s.rgb * w;
      sum += w;
    }
    gl_FragColor = vec4(acc / sum, c.a);
  }
`;

// the sharp picture where it is in focus, the blurred one elsewhere
const focusShader = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tBlur;
  uniform vec2 uRes;
  // how strictly what is in focus is kept apart from the blur behind it (0–1)
  uniform float uSharp;
  ${depthGlsl}
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(tColor, vUv);
    if (uCoc < 0.6) { gl_FragColor = c; return; }
    float own = cocAt(depthAt(vUv));
    vec4 b = texture2D(tBlur, vUv);
    // The blurred picture is half the size of the sharp one, so along the outline of something in focus each pixel is
    // handed a blend of the thing and of the blur behind it: its edge goes soft, and its light leaks into the blur.
    // Kept apart, each pixel takes only from those of its four neighbours in the blurred picture that are about as
    // blurred as itself.
    if (uSharp > 0.0) {
      vec2 size = floor(uRes * 0.5);
      vec2 st = vUv * size - 0.5;
      vec2 base = floor(st), f = st - base;
      vec4 acc = vec4(0.0);
      float sum = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 o = vec2(mod(float(i), 2.0), floor(float(i) * 0.5));
        vec4 t = texture2D(tBlur, (base + o + 0.5) / size);
        vec2 near = mix(1.0 - f, f, o);
        float d = t.a - own;
        float w = near.x * near.y / (0.02 + d * d);
        acc += t * w;
        sum += w;
      }
      b = mix(b, acc / max(sum, 1e-6), uSharp);
    }
    gl_FragColor = vec4(mix(c.rgb, b.rgb, smoothstep(0.4, 2.2, max(own, b.a))), 1.0);
  }
`;

// The glare of a lens: whatever is very bright spills light round itself. The picture is halved again and again, and
// the smaller ones laid back over the larger.
const dimShader = /* glsl */ `
  uniform sampler2D tColor;
  uniform vec2 uTexel;
  // 1 on the first halving: only what is bright is kept, and a single burning pixel cannot outweigh its neighbours
  uniform float uFirst;
  varying vec2 vUv;
  vec3 keep(vec3 c) {
    float l = max(c.r, max(c.g, c.b));
    // (one pixel gone wrong must not be spread over the whole picture)
    if (!(l < 1e4)) return vec3(0.0);
    float over = max(l - 0.9, 0.0);
    return c * mix(1.0, over / (over + 0.9) * 1.0 / (1.0 + 0.04 * l), uFirst);
  }
  void main() {
    vec3 c = keep(texture2D(tColor, vUv).rgb) * 4.0;
    c += keep(texture2D(tColor, vUv + uTexel).rgb) + keep(texture2D(tColor, vUv - uTexel).rgb);
    c += keep(texture2D(tColor, vUv + vec2(uTexel.x, -uTexel.y)).rgb) + keep(texture2D(tColor, vUv - vec2(uTexel.x, -uTexel.y)).rgb);
    gl_FragColor = vec4(c / 8.0, 1.0);
  }
`;

const spreadShader = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tAdd;
  uniform vec2 uTexel;
  uniform float uWeight;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tColor, vUv + vec2(uTexel.x * 2.0, 0.0)).rgb + texture2D(tColor, vUv - vec2(uTexel.x * 2.0, 0.0)).rgb;
    c += texture2D(tColor, vUv + vec2(0.0, uTexel.y * 2.0)).rgb + texture2D(tColor, vUv - vec2(0.0, uTexel.y * 2.0)).rgb;
    c += (texture2D(tColor, vUv + uTexel).rgb + texture2D(tColor, vUv - uTexel).rgb) * 2.0;
    c += (texture2D(tColor, vUv + vec2(uTexel.x, -uTexel.y)).rgb + texture2D(tColor, vUv - vec2(uTexel.x, -uTexel.y)).rgb) * 2.0;
    gl_FragColor = vec4(c / 12.0 * uWeight + texture2D(tAdd, vUv).rgb, 1.0);
  }
`;

const finishShader = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tGlare;
  uniform float uExposure;
  uniform float uGlare;
  uniform float uTime;
  uniform float uAspect;
  uniform float uFade;
  uniform float uVignette;
  varying vec2 vUv;

  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  vec3 film(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

  void main() {
    vec2 d = vUv - 0.5;
    // colours part a little toward the corners, as they do through glass
    float fringe = 0.0035 * dot(d, d);
    vec3 c = vec3(texture2D(tColor, 0.5 + d * (1.0 + fringe)).r, texture2D(tColor, vUv).g, texture2D(tColor, 0.5 + d * (1.0 - fringe)).b);
    c += texture2D(tGlare, vUv).rgb * uGlare;
    c *= uExposure;
    vec2 v = d * vec2(uAspect, 1.0);
    c *= 1.0 - uVignette * smoothstep(0.25, 1.05, length(v));
    c = film(c);
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // the dark is never quite black, and leans cold
    c += vec3(0.0025, 0.006, 0.006) * (1.0 - smoothstep(0.0, 0.2, l));
    c = pow(c, vec3(1.0 / 2.2));
    float g = hash(gl_FragCoord.xy + floor(fract(uTime * 7.0) * 977.0) * vec2(17.0, 31.0)) - 0.5;
    c += g * 0.028;
    gl_FragColor = vec4(c * uFade, 1.0);
  }
`;

const GLARE_LEVELS = 6;

export function createPost(renderer: WebGLRenderer, lowPower: boolean, samples = lowPower ? 0 : 2) {
  const size = renderer.getDrawingBufferSize(new Vector2());
  const depth = new DepthTexture(size.x, size.y);
  depth.minFilter = depth.magFilter = NearestFilter;
  const opts = { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter };
  // the cave as the camera draws it, with its depth
  const scene = new WebGLRenderTarget(size.x, size.y, { ...opts, samples, depthTexture: depth });
  const flat = (shift: number) => new WebGLRenderTarget(Math.max(1, size.x >> shift), Math.max(1, size.y >> shift), { ...opts, depthBuffer: false });
  const air = flat(1);
  const shutIn = flat(1);
  const joined = flat(0);
  const blurred = flat(1);
  const smoothed = flat(1);
  const focused = flat(0);
  const dims = Array.from({ length: GLARE_LEVELS }, (_, i) => flat(i + 1));
  const spreads = Array.from({ length: GLARE_LEVELS - 1 }, (_, i) => flat(i + 1));

  const nearFar = { value: new Vector2(0.1, 1000) };
  const focus = { value: 5 };
  const coc = { value: 0 };
  const sharp = { value: 0 };
  const res = { value: size.clone() };
  const pass = (fragmentShader: string, uniforms: Record<string, { value: unknown }>) =>
    new FullScreenQuad(new ShaderMaterial({ vertexShader: quadVertex, fragmentShader, uniforms, depthTest: false, depthWrite: false }));

  const haze = pass(airShader(lowPower ? 11 : 13, lowPower ? 14 : 17), {
    ...common,
    tDepth: { value: depth },
    uNearFar: nearFar,
    uCamPos: { value: new Vector3() },
    uCamFore: { value: new Vector3() },
    uCamRight: { value: new Vector3() },
    uCamUp: { value: new Vector3() },
    uThick: { value: 0.009 },
    uRays: { value: 3.6 },
    uFrame: { value: 0 },
  });
  const shut = pass(shutShader(lowPower ? 8 : 12), { tDepth: { value: depth }, uNearFar: nearFar, uTan: { value: new Vector2(1, 1) } });
  const join = pass(joinShader, { tColor: { value: scene.texture }, tAir: { value: air.texture }, tShut: { value: shutIn.texture }, uShut: { value: 0.85 }, uRes: res });
  const blur = pass(blurShader(lowPower ? 18 : 24), {
    tColor: { value: joined.texture },
    tDepth: { value: depth },
    uRes: res,
    uNearFar: nearFar,
    uFocus: focus,
    uCoc: coc,
  });
  const smooth = pass(smoothShader, { tColor: { value: blurred.texture }, uRes: res, uCoc: coc });
  const refocus = pass(focusShader, {
    tColor: { value: joined.texture },
    tBlur: { value: smoothed.texture },
    uRes: res,
    uSharp: sharp,
    tDepth: { value: depth },
    uNearFar: nearFar,
    uFocus: focus,
    uCoc: coc,
  });
  const dim = pass(dimShader, { tColor: { value: null }, uTexel: { value: new Vector2() }, uFirst: { value: 0 } });
  const spread = pass(spreadShader, { tColor: { value: null }, tAdd: { value: null }, uTexel: { value: new Vector2() }, uWeight: { value: 1 } });
  const finish = pass(finishShader, {
    tColor: { value: focused.texture },
    tGlare: { value: spreads[0].texture },
    uExposure: { value: 1 },
    uGlare: { value: 0.32 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uFade: { value: 1 },
    uVignette: { value: 0.5 },
  });
  const dimU = (dim.material as ShaderMaterial).uniforms, spreadU = (spread.material as ShaderMaterial).uniforms;
  const finishU = (finish.material as ShaderMaterial).uniforms;

  return {
    scene,
    depth,
    nearFar,
    focus,
    // blur radius of a far background, in pixels
    coc,
    // how strictly what is in focus is kept apart from the blur behind it (0–1)
    sharp,
    res,
    air: (haze.material as ShaderMaterial).uniforms,
    shut: (shut.material as ShaderMaterial).uniforms,
    join: (join.material as ShaderMaterial).uniforms,
    finish: (finish.material as ShaderMaterial).uniforms,

    // everything between the cave as drawn and the picture on the screen (off: parts left out, for timing the rest)
    render(off: { air?: boolean; shut?: boolean; dof?: boolean; glare?: boolean } = {}) {
      const blank = (target: WebGLRenderTarget, value: number) => {
        const was = renderer.getClearColor(new Color()), alpha = renderer.getClearAlpha();
        renderer.setRenderTarget(target);
        renderer.setClearColor(new Color(value, value, value), 1);
        renderer.clear();
        renderer.setClearColor(was, alpha);
      };
      if (off.air) blank(air, 0);
      else {
        renderer.setRenderTarget(air);
        haze.render(renderer);
      }
      if (off.shut) blank(shutIn, 1);
      else {
        renderer.setRenderTarget(shutIn);
        shut.render(renderer);
      }
      renderer.setRenderTarget(joined);
      join.render(renderer);
      // with nothing to blur the last pass alone hands the picture on
      if (coc.value >= 0.6 && !off.dof) {
        renderer.setRenderTarget(blurred);
        blur.render(renderer);
        renderer.setRenderTarget(smoothed);
        smooth.render(renderer);
      }
      const sharp = coc.value;
      if (off.dof) coc.value = 0;
      renderer.setRenderTarget(focused);
      refocus.render(renderer);
      coc.value = sharp;
      const glare = finishU.uGlare.value;
      if (off.glare) {
        finishU.uGlare.value = 0;
        renderer.setRenderTarget(null);
        finish.render(renderer);
        finishU.uGlare.value = glare;
        return;
      }

      let from: WebGLRenderTarget = focused;
      dims.forEach((to, i) => {
        dimU.tColor.value = from.texture;
        dimU.uTexel.value.set(0.5 / to.width, 0.5 / to.height);
        dimU.uFirst.value = i === 0 ? 1 : 0;
        renderer.setRenderTarget(to);
        dim.render(renderer);
        from = to;
      });
      for (let i = GLARE_LEVELS - 2; i >= 0; i--) {
        const small = i === GLARE_LEVELS - 2 ? dims[i + 1] : spreads[i + 1];
        spreadU.tColor.value = small.texture;
        spreadU.tAdd.value = dims[i].texture;
        spreadU.uTexel.value.set(0.5 / small.width, 0.5 / small.height);
        // the widest spill is the faintest
        spreadU.uWeight.value = 0.85;
        renderer.setRenderTarget(spreads[i]);
        spread.render(renderer);
      }
      renderer.setRenderTarget(null);
      finish.render(renderer);
    },
    setSize(w: number, h: number) {
      for (const t of [scene, joined, focused]) t.setSize(w, h);
      for (const t of [air, shutIn, blurred, smoothed]) t.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
      dims.forEach((t, i) => t.setSize(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))));
      spreads.forEach((t, i) => t.setSize(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))));
      res.value.set(w, h);
    },
    dispose() {
      for (const t of [scene, air, shutIn, joined, blurred, smoothed, focused, ...dims, ...spreads]) t.dispose();
      for (const q of [haze, shut, join, blur, smooth, refocus, dim, spread, finish]) {
        q.material.dispose();
        q.dispose();
      }
    },
  };
}
