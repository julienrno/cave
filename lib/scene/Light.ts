import {
  Color,
  CubeCamera,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  OrthographicCamera,
  RedFormat,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderTarget,
  WebGLRenderer,
} from "three";
import { distanceMaterial } from "./Cave";
import { GEM, LAYER, SHAFT, SUN_DIR, SUN_SPAN, shared } from "./shared";

// Nothing in the cave moves, so the costly views of it are taken once: how far the rock is from the crystals in every
// direction and from the sun down the hole in the roof (their shadows), and the lit cave as seen from its middle (what
// the wet rock mirrors).
export function createLight(renderer: WebGLRenderer, scene: Scene, rock: ShaderMaterial, lowPower: boolean) {
  const shadow = new WebGLCubeRenderTarget(lowPower ? 512 : 1024, {
    type: HalfFloatType,
    format: RedFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    generateMipmaps: false,
  });
  const around = new WebGLCubeRenderTarget(256, {
    type: HalfFloatType,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: true,
  });
  const eye = new Vector3(0.4, 2.3, 2.2);

  const background = scene.background;
  const distance = distanceMaterial();
  const from = new CubeCamera(0.05, 80, shadow);
  from.position.copy(GEM);
  from.layers.set(LAYER.world);
  for (const c of from.children) c.layers.set(LAYER.world);
  // where there is no rock at all the light goes on for ever
  scene.background = new Color(1000, 1000, 1000);
  scene.overrideMaterial = distance;
  from.update(renderer, scene);
  scene.overrideMaterial = null;
  scene.background = background;
  distance.dispose();
  shared.tShadow.value = shadow.texture;

  // the sun looks straight down the hole; whatever it does not see is in shadow
  const sunSize = lowPower ? 1024 : 2048;
  const sun = new WebGLRenderTarget(sunSize, sunSize, { type: HalfFloatType, format: RedFormat, minFilter: NearestFilter, magFilter: NearestFilter });
  const high = new OrthographicCamera(-SUN_SPAN, SUN_SPAN, SUN_SPAN, -SUN_SPAN, 0.1, 60);
  high.position.copy(SHAFT.top).addScaledVector(SUN_DIR, -4);
  high.up.set(0, 0, -1);
  high.lookAt(SHAFT.top);
  high.updateMatrixWorld();
  high.layers.set(LAYER.world);
  const along = new ShaderMaterial({
    uniforms: { uFrom: { value: high.position }, uDir: { value: SUN_DIR } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uFrom;
      uniform vec3 uDir;
      varying vec3 vWorld;
      void main() { gl_FragColor = vec4(dot(vWorld - uFrom, uDir), 0.0, 0.0, 1.0); }
    `,
    side: 2,
  });
  scene.background = new Color(1000, 1000, 1000);
  scene.overrideMaterial = along;
  renderer.setRenderTarget(sun);
  renderer.render(scene, high);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = null;
  scene.background = background;
  along.dispose();
  shared.tSun.value = sun.texture;
  shared.uSunPos.value.copy(high.position);
  shared.uSunRight.value.setFromMatrixColumn(high.matrixWorld, 0);
  shared.uSunUp.value.setFromMatrixColumn(high.matrixWorld, 1);

  const look = new CubeCamera(0.05, 80, around);
  look.position.copy(eye);
  for (const c of look.children) {
    c.layers.set(LAYER.world);
    c.layers.enable(LAYER.sky);
  }
  rock.uniforms.uEnv.value = 0;
  look.update(renderer, scene);
  rock.uniforms.tEnv.value = around.texture;
  rock.uniforms.uEnvPos.value.copy(eye);
  rock.uniforms.uEnv.value = 1;

  return {
    around: around.texture,
    eye,
    dispose() {
      shadow.dispose();
      sun.dispose();
      around.dispose();
    },
  };
}
