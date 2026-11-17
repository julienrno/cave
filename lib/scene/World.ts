import { CatmullRomCurve3, Color, MathUtils, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, PlaneGeometry, Scene, ShaderMaterial, Timer, Vector2, Vector3, WebGLRenderer } from "three";
import gsap from "gsap";
import { createAir } from "./Air";
import { Ambience } from "./audio";
import { createCave } from "./Cave";
import { buildGrid, sample, type Grid } from "./Field";
import { GEM_LOOK, createGem } from "./Gem";
import { createLight } from "./Light";
import { createPost } from "./Post";
import { createRoots } from "./Roots";
import { createWater } from "./Water";
import { BOUNDS, CAM, GEM, GEM_COLOR, GEM_POWER, LAYER, PULSE, SHAFT, SKY_COLOR, SUN_COLOR, SUN_POWER, shared, smoothstep } from "./shared";

// wheel pixels for the whole way in
const SCROLL = 12900;
// progress per second while a key is held, and how long the way in takes when it plays by itself (?play)
const KEY_RATE = 0.07;
const PLAY_SECONDS = 54;
// how long the way back out takes
const LEAVE_SECONDS = 8;
const PIXEL_BUDGET = 4_200_000;
// blur radius of a far background when the lens is at its closest, as a fraction of the picture's height
const BLUR = 0.013;

// the way in: down the passage, round the pool, and up to the crystals
const PATH = new CatmullRomCurve3(
  [
    new Vector3(0.3, 3.0, 17.0),
    new Vector3(0.75, 2.8, 14.4),
    new Vector3(0.95, 2.4, 10.8),
    new Vector3(0.4, 1.8, 7.6),
    new Vector3(-0.5, 1.2, 6.6),
    new Vector3(-0.85, 0.95, 5.6),
    // out over the pool, up to the foot of the mound
    new Vector3(-0.78, 0.8, 4.5),
    new Vector3(-0.5, 0.63, 3.3),
  ],
  false,
  "centripetal",
);

function phaseAt(p: number) {
  return p < 0.34 ? "the way in" : p < 0.56 ? "the chamber" : p < 0.88 ? "the pool" : "the light";
}

const next = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export type WorldEvents = {
  // hollowing the cave out, lighting it, then compiling its shaders; 1 once it is ready to show
  onLoad?: (progress: number) => void;
  // every frame: progress along the way in (0–1), how far the crystals are (m), where the visitor is, how much of their
  // light arrives here (1 at one metre) and where they stand in the picture (0–1 across and down)
  onFrame?: (progress: number, distance: number, phase: string, light: number, x: number, y: number) => void;
};

export class World {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(CAM.fov, 1, 0.05, 90);
  private timer = new Timer();
  private post!: ReturnType<typeof createPost>;
  private light?: ReturnType<typeof createLight>;
  private water!: ReturnType<typeof createWater>;
  private air!: ReturnType<typeof createAir>;
  private cave!: Mesh;
  private grid?: Grid;
  private hidden: Object3D[] = [];
  private audio = new Ambience();
  private raf = 0;
  private frames = 0;
  private disposed = false;
  private lowPower = false;
  private pointer = { x: 0, y: 0 };
  private smooth = { x: 0, y: 0 };
  // the pointer again, followed more closely: it moves the heart of the crystals' light about inside them
  private heart = { x: 0, y: 0 };
  // where the visitor has scrolled to, and where the picture is (it eases after)
  private target = 0;
  private p = 0;
  private live = false;
  private leaving = false;
  private playing = false;
  private held = 0;
  private touchY = 0;
  // when the last shell of light set out (s, by the scene's clock), and which of the four is next
  private pulsed = -100;
  private nextPulse = 0;
  private clock = 0;
  private startedAt = 0;
  private bufferSize = new Vector2();
  private at = new Vector3();
  private aim = new Vector3();
  private fore = new Vector3();
  private right = new Vector3();
  private up = new Vector3();
  // top: the render scale to get back to when there is time to spare; calm: seconds the frame rate has held; retry:
  // how long it must hold before a finer scale is tried again
  private quality = { dpr: 1, top: 1, min: 0.55, acc: 0, frames: 0, cooldown: 3, calm: 0, retry: 8, hud: null as HTMLElement | null };
  // how long the screen takes between two pictures (ms): the pace to keep
  private refresh = 1000 / 60;
  private note?: HTMLElement;
  // ?exp=1.2&dof=0&fog=2&rays=0.5&glare=0.5&bump=1.5&wet=2&shut=0 scale those (for tuning)
  // (&auto=0 keeps the render scale where it is)
  private tune = { exp: 1, dof: 1, fog: 1, rays: 1, glare: 1, bump: 1, wet: 1, shut: 1, auto: 1 };
  // parts of the picture that can be left out or done another way (for timing them: ?bench)
  private opt = { mirror: true, leanMirror: true, off: {} as { air?: boolean; shut?: boolean; dof?: boolean; glare?: boolean } };

  constructor(
    private container: HTMLElement,
    private events: WorldEvents = {},
  ) {
    const lowPower = (this.lowPower = matchMedia("(pointer: coarse)").matches);
    const query = new URLSearchParams(location.search);
    // ?dpr=1.5 sets another cap on the render scale (for tuning)
    const dpr = Math.min(devicePixelRatio, Number(query.get("dpr")) || 1.25);
    Object.assign(this.quality, { dpr, top: dpr, min: lowPower ? 0.7 : 0.55 });
    for (const key of Object.keys(this.tune) as (keyof typeof this.tune)[]) if (query.has(key)) this.tune[key] = Number(query.get(key));

    this.renderer = new WebGLRenderer({
      antialias: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: query.has("still"),
    });
    this.renderer.setPixelRatio(dpr);
    this.renderer.info.autoReset = false;
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);
    // ?msaa=2 sets how many samples smooth the edges (for tuning)
    this.post = createPost(this.renderer, lowPower, query.has("msaa") ? Number(query.get("msaa")) : undefined);
    this.timer.connect(document);
    // The screen's own pace is found over the first few hundred of its pictures: the shorter gaps between two of them
    // (the long ones are the cave being built, or a frame that came late), taken as the nearest pace screens are made to.
    const gaps: number[] = [];
    let before = 0;
    const pace = (now: number) => {
      if (before) gaps.push(now - before);
      before = now;
      if (gaps.length >= 20 && gaps.length % 20 === 0) {
        const short = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length * 0.15)];
        const hz = [240, 165, 144, 120, 100, 90, 75, 60, 50].reduce((best, h) => (Math.abs(1000 / h - short) < Math.abs(1000 / best - short) ? h : best));
        this.refresh = 1000 / hz;
      }
      if (!this.disposed && gaps.length < 400) requestAnimationFrame(pace);
    };
    requestAnimationFrame(pace);
    this.build(query).catch((e) => {
      if (!this.disposed) console.error(e);
    });
  }

  // The cave is hollowed out and lit in steps, so the loading bar can move between them.
  private async build(query: URLSearchParams) {
    const report = this.events.onLoad ?? (() => {});
    const step = (from: number, to: number) => async (done: number) => {
      report(from + (to - from) * done);
      await next();
      if (this.disposed) throw new Error("left");
    };
    report(0.02);
    await next();
    // ?voxel=0.08 cuts the rock finer (for tuning)
    const voxel = Number(query.get("voxel")) || (this.lowPower ? 0.14 : 0.1);
    const grid = (this.grid = await buildGrid(voxel, step(0.02, 0.5)));
    this.cave = await createCave(grid, step(0.5, 0.84));
    await step(0.84, 0.86)(1);

    // The sky over the hole in the roof: a bright day, hazy toward the sun. It is a sheet over the hole and nothing
    // more: anywhere else that no rock is drawn (as under the pools, in what they mirror) there is only the dark.
    this.scene.background = new Color(0, 0, 0);
    const sky = new Mesh(new PlaneGeometry(60, 60).rotateX(Math.PI / 2), new MeshBasicMaterial({ color: new Color(SKY_COLOR.r, SKY_COLOR.g, SKY_COLOR.b).lerp(SUN_COLOR, 0.45).multiplyScalar(7), toneMapped: false }));
    sky.position.set(SHAFT.top.x, BOUNDS.max.y + 4, SHAFT.top.z);
    sky.name = "sky";
    sky.layers.set(LAYER.sky);
    this.scene.add(sky);
    // the crystals stand on the rock under them
    let foot = GEM.y;
    while (foot > 0 && sample(grid, GEM.x, foot, GEM.z) < 0) foot -= 0.02;
    const gem = createGem(foot);
    this.water = createWater();
    this.air = createAir(grid, this.lowPower);
    this.scene.add(this.cave, createRoots(grid), gem, this.water.mesh, this.air.motes, this.air.drops);
    shared.uGemLight.value.set(GEM_COLOR.r, GEM_COLOR.g, GEM_COLOR.b).multiplyScalar(GEM_POWER);
    const rock = this.cave.material as ShaderMaterial;
    rock.uniforms.uBump.value = this.tune.bump;
    rock.uniforms.uWet.value = this.tune.wet;
    // ?fx=13 sets which of the ways the light plays on the rock are on (0 for none; keys 1, 2 and 3 do it by hand)
    if (query.has("fx")) for (let i = 0; i < 3; i++) rock.uniforms.uExtra.value.setComponent(i, query.get("fx")!.includes(String(i + 1)) ? 1 : 0);
    this.post.air.uRays.value *= this.tune.rays;
    this.post.join.uShut.value *= this.tune.shut;
    this.post.air.uThick.value *= this.tune.fog;
    this.post.finish.uGlare.value *= this.tune.glare;
    this.light = createLight(this.renderer, this.scene, rock, this.lowPower);
    const gu = (gem.material as ShaderMaterial).uniforms;
    gu.tEnv.value = this.light.around;
    gu.uEnvPos.value.copy(this.light.eye);
    await step(0.86, 0.92)(1);

    this.resize();
    window.addEventListener("resize", this.resize);
    this.camera.layers.enableAll();
    await this.renderer.compileAsync(this.scene, this.camera).catch(() => undefined);
    if (this.disposed) return;

    // ?p=0.7 opens part-way in, ?play walks in by itself, ?still=0.7 draws one frame there (for screenshots)
    const start = Number(query.get("p") ?? query.get("still"));
    if (Number.isFinite(start) && start > 0) this.p = this.target = MathUtils.clamp(start, 0, 1);
    // ?mx=0.8&my=-0.5 puts the pointer there, -1 to 1 across and down (for screenshots)
    this.pointer.x = Number(query.get("mx")) || 0;
    this.pointer.y = Number(query.get("my")) || 0;
    // ?pulse=1.2 shows a shell of light that set out that many seconds ago (for screenshots, with ?still)
    if (query.has("pulse")) shared.uPulses.value[0] = this.pulsed = (Number(query.get("t")) || 20) - Number(query.get("pulse"));
    this.playing = query.has("play");
    if (query.has("fps")) this.perfPanel();
    // ?hide=motes,water leaves those out (for tuning)
    const hide = (query.get("hide") ?? "").split(",");
    this.scene.traverse((o) => {
      if (o.name && hide.includes(o.name)) this.hidden.push(o);
    });
    for (const o of this.hidden) o.visible = false;
    if (query.has("bench")) {
      report(1);
      await this.bench();
      return;
    }
    if (query.has("still")) {
      this.frame(0.016, Number(query.get("t")) || 20, true);
      this.renderer.getContext().finish();
      (window as unknown as { __still: boolean }).__still = true;
      report(1);
      return;
    }
    this.tick();
    report(1);
  }

  // ?bench: how long each part of the picture takes on this machine (ms a frame), at three places along the way in.
  // Frames are drawn back to back and the graphics card made to finish them, so the screen's own pace does not cap it.
  private async bench() {
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    const rock = (this.cave.material as ShaderMaterial).uniforms;
    const time = (frames = 20) => {
      for (let i = 0; i < 3; i++) this.frame(0.016, 20);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const from = performance.now();
      for (let i = 0; i < frames; i++) this.frame(0.016, 20 + i * 0.016);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return Math.round(((performance.now() - from) / frames) * 100) / 100;
    };
    // (?bench=quick: only the main figures)
    const quick = new URLSearchParams(location.search).get("bench") === "quick";
    const all = { air: true, shut: true, dof: true, glare: true };
    const out: Record<string, unknown> = { buffer: `${this.bufferSize.x}x${this.bufferSize.y}`, scale: this.renderer.getPixelRatio() };
    const show = document.createElement("pre");
    show.style.cssText = "position:fixed;inset:12px auto auto 12px;padding:10px;background:#000c;color:#fff;font:11px/1.5 ui-monospace,monospace;z-index:40;white-space:pre-wrap;max-width:90vw";
    document.body.appendChild(show);
    for (const p of [0.02, 0.5, 1]) {
      this.p = this.target = p;
      const row: Record<string, number> = {};
      const set = (mirror: boolean, off: typeof this.opt.off, flat = 0) => {
        Object.assign(this.opt, { mirror, off });
        rock.uFlat.value = flat;
      };
      set(true, {});
      row.full = time();
      set(false, {});
      row.noMirror = time();
      set(true, { air: true });
      row.noAir = time();
      if (!quick) {
        set(true, { shut: true });
        row.noShut = time();
        set(true, { dof: true });
        row.noDof = time();
        set(true, { glare: true });
        row.noGlare = time();
      }
      set(false, all);
      row.sceneOnly = time();
      set(false, all, 1);
      row.sceneOnlyFlatRock = time();
      set(true, {});
      out[`p=${p}`] = row;
      show.textContent = JSON.stringify(out, null, 1);
      await next();
    }
    if (quick) {
      (window as unknown as { __bench: unknown }).__bench = out;
      return;
    }
    // what the parts of the rock's own shading cost, with nothing else drawn
    for (const p of [0.02, 0.5]) {
      this.p = this.target = p;
      const row: Record<string, number> = {};
      Object.assign(this.opt, { mirror: false, off: all });
      for (const [name, mode] of [["rock", 0], ["oneLookShadow", 2], ["noSun", 3], ["noFineGrain", 4], ["noMirroredCave", 5], ["allFour", 6], ["flat", 1]] as [string, number][]) {
        rock.uFlat.value = mode;
        row[name] = time();
      }
      rock.uFlat.value = 0;
      out[`rock p=${p}`] = row;
      show.textContent = JSON.stringify(out, null, 1);
      await next();
    }
    // how much the sharpness of the grain costs: [far from the crystals, by them, most added for slant]
    {
      const row: Record<string, number> = {};
      const crisp = rock.uCrisp.value;
      const was = crisp.clone();
      Object.assign(this.opt, { mirror: true, off: {} });
      for (const p of [0.5, 1])
        for (const c of [[0, 0, 0], [-0.35, -1, 1.25], [-0.5, -1, 1.25], [0, -1, 1.25], [-0.35, -1, 0.75], [-0.35, -0.75, 0.75], [-1, -1, 1.25]]) {
          this.p = this.target = p;
          crisp.set(c[0], c[1], c[2]);
          row[`p=${p} [${c.join(", ")}]`] = time();
        }
      crisp.copy(was);
      out.crisp = row;
      show.textContent = JSON.stringify(out, null, 1);
      await next();
    }
    // the same again with fewer pixels, and without the extra samples that smooth the edges
    this.p = this.target = 0.5;
    const dpr = this.quality.dpr;
    const sized: Record<string, number> = {};
    for (const k of [1, 0.8, 0.64]) {
      this.quality.dpr = dpr * k;
      this.resize();
      Object.assign(this.opt, { mirror: true, off: {} });
      sized[`x${k} (${this.bufferSize.x}x${this.bufferSize.y}) full`] = time();
      Object.assign(this.opt, { mirror: false, off: all });
      sized[`x${k} sceneOnly`] = time();
      await next();
    }
    this.quality.dpr = dpr;
    this.resize();
    this.post.scene.samples = 0;
    this.post.scene.dispose();
    sized["noMsaa sceneOnly"] = time();
    Object.assign(this.opt, { mirror: true, off: {} });
    sized["noMsaa full"] = time();
    out["p=0.5 by size"] = sized;
    out.triangles = this.renderer.info.render.triangles;
    show.textContent = JSON.stringify(out, null, 1);
    (window as unknown as { __bench: unknown }).__bench = out;
  }

  // the visitor has entered: the scroll is theirs
  start() {
    this.live = true;
    this.startedAt = performance.now();
    this.audio.start();
    window.addEventListener("click", this.onClick);
    window.addEventListener("wheel", this.onWheel, { passive: true });
    window.addEventListener("pointermove", this.onPointer);
    window.addEventListener("touchstart", this.onTouchStart, { passive: true });
    window.addEventListener("touchmove", this.onTouchMove, { passive: true });
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
  }

  // a click anywhere on the picture sends a shell of light out from the crystals
  private onClick = (e: MouseEvent) => {
    // (not the click that let the visitor in, nor one on a button or the credits)
    if (performance.now() - this.startedAt < 500 || (e.target as HTMLElement).closest?.("button, a, .credits")) return;
    this.pulse();
  };

  pulse() {
    shared.uPulses.value[this.nextPulse] = this.pulsed = this.clock;
    this.nextPulse = (this.nextPulse + 1) % 4;
    this.audio.chime();
  }

  // back out to where the visitor came in
  leave() {
    if (this.leaving) return;
    this.leaving = true;
    this.playing = false;
    gsap.to(this, {
      target: 0,
      duration: LEAVE_SECONDS,
      ease: "power2.inOut",
      onComplete: () => {
        this.leaving = false;
      },
    });
  }

  toggleSound() {
    return this.audio.toggle();
  }

  private scrollBy(amount: number) {
    if (!this.live || this.leaving) return;
    this.target = MathUtils.clamp(this.target + amount, 0, 1);
  }

  private onWheel = (e: WheelEvent) => this.scrollBy((e.deltaY * (e.deltaMode === 1 ? 32 : 1)) / SCROLL);

  private onTouchStart = (e: TouchEvent) => {
    this.touchY = e.touches[0].clientY;
  };

  private onTouchMove = (e: TouchEvent) => {
    const y = e.touches[0].clientY;
    this.scrollBy(((this.touchY - y) * 3) / SCROLL);
    this.touchY = y;
    this.pointer.x = (e.touches[0].clientX / innerWidth) * 2 - 1;
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const dir = ["ArrowDown", "PageDown", "w"].includes(e.key) ? 1 : ["ArrowUp", "PageUp", "s"].includes(e.key) ? -1 : 0;
    if (dir) this.held = e.type === "keydown" ? dir : 0;
    else if (e.type === "keydown" && e.key.toLowerCase() === "m") this.audio.toggle();
    else if (e.type === "keydown" && !e.repeat && "123".includes(e.key) && e.key) this.extra(Number(e.key) - 1);
    // space (or P) walks in by itself, and stops again; kept from pressing whichever button was last used
    else if (this.live && (e.key === " " || e.key.toLowerCase() === "p")) {
      e.preventDefault();
      if (e.type === "keydown" && !e.repeat && !this.leaving) this.playing = !this.playing && this.target < 1;
    }
  };

  private onPointer = (e: PointerEvent) => {
    this.pointer.x = (e.clientX / innerWidth) * 2 - 1;
    this.pointer.y = (e.clientY / innerHeight) * 2 - 1;
  };

  // turns one of the three ways the light plays on the rock on or off, and says for a moment which are on
  private extra(which: number) {
    const on = (this.cave.material as ShaderMaterial).uniforms.uExtra.value as Vector3;
    on.setComponent(which, on.getComponent(which) ? 0 : 1);
    if (!this.note) {
      this.note = document.createElement("div");
      this.note.style.cssText =
        "position:fixed;bottom:64px;left:50%;transform:translateX(-50%);padding:8px 12px;background:#000a;color:#e6f0e8;" +
        "font:11px/1.6 ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;z-index:30;pointer-events:none;transition:opacity .4s";
      document.body.appendChild(this.note);
    }
    const names = ["1 grain shadows", "2 mineral glints", "3 caustics"];
    this.note.textContent = names.map((n, i) => `${n} ${on.getComponent(i) ? "on" : "off"}`).join("  ·  ");
    this.note.style.opacity = "1";
    gsap.killTweensOf(this.note);
    gsap.to(this.note, { opacity: 0, delay: 2.5, duration: 0.4 });
  }

  private perfPanel() {
    const hud = (this.quality.hud = document.createElement("div"));
    hud.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:8px 10px;border-radius:8px;background:#0008;color:#fff;" +
      "font:12px/1.6 ui-monospace,monospace;z-index:30;pointer-events:none";
    document.body.appendChild(hud);
  }

  private resize = () => {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const dpr = Math.min(this.quality.dpr, Math.sqrt(PIXEL_BUDGET / (w * h)));
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.renderer.getDrawingBufferSize(this.bufferSize);
    this.post.setSize(this.bufferSize.x, this.bufferSize.y);
    this.water.setSize(this.bufferSize.x, this.bufferSize.y);
    this.camera.aspect = w / h;
    this.post.finish.uAspect.value = w / h;
  };

  private tick = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    this.timer.update();
    const dt = this.timer.getDelta();
    this.adapt(dt);
    this.frame(Math.min(dt, 0.05), this.timer.getElapsed());
  };

  // The render scale follows the frame rate: a step coarser whenever the screen's pace is not being kept, and a step
  // finer again once it has held for a while (waiting longer each time that turns out to have been too much).
  private adapt(dt: number) {
    const q = this.quality;
    // (a long gap is the tab having been away, not a slow frame)
    if (dt > 0.1) {
      q.acc = q.frames = 0;
      return;
    }
    q.acc += dt;
    q.frames++;
    if (q.acc < 0.5) return;
    const ms = (q.acc / q.frames) * 1000;
    q.acc = q.frames = 0;
    const drawn = this.renderer.info.render;
    if (q.hud) q.hud.textContent = `${Math.round(1000 / ms)} fps · ${ms.toFixed(1)} ms · scale ${this.renderer.getPixelRatio().toFixed(2)} · ${(drawn.triangles / 1e6).toFixed(1)}M tris · ${drawn.calls} calls`;
    if (q.cooldown > 0) {
      q.cooldown -= 0.5;
      return;
    }
    if (!this.tune.auto) return;
    // one picture in thirty late is already too many
    const late = ms > this.refresh * 1.035;
    // (for the sake of a smooth picture it gives up a fifth of its sharpness at most; more only when frames are slow outright)
    const floor = ms > 26 ? q.min : Math.max(q.min, q.top * 0.8);
    if (late && q.dpr > floor) {
      q.dpr = Math.max(floor, q.dpr * (ms > this.refresh * 1.4 ? 0.86 : 0.93));
      q.cooldown = 1.5;
      if (q.calm < 3) q.retry = Math.min(q.retry * 2, 120);
      q.calm = 0;
      this.resize();
    } else if (!late) {
      q.calm += 0.5;
      if (q.calm >= q.retry && q.dpr < q.top) {
        q.dpr = Math.min(q.top, q.dpr * 1.07);
        q.cooldown = 1.5;
        q.calm = 0;
        this.resize();
      }
    }
  }

  private frame(dt: number, t: number, whole = false) {
    this.renderer.info.reset();
    shared.uTime.value = this.clock = t;
    const sincePulse = t - this.pulsed;
    shared.uPulsing.value = sincePulse < PULSE.life ? 1 : 0;
    if (this.held) this.scrollBy(this.held * KEY_RATE * dt);
    if (this.playing) this.target = Math.min(1, this.target + dt / PLAY_SECONDS);
    if (this.target >= 1) this.playing = false;
    this.p += (this.target - this.p) * (whole ? 1 : 1 - Math.exp(-dt * 3.2));
    const p = this.p;

    // the crystals' light is never quite steady: it breathes
    // (and flares as a shell of light leaves it)
    const breath = 1 + 0.055 * Math.sin(t * 0.83) + 0.025 * Math.sin(t * 2.17 + 1.3) + 0.9 * Math.exp(-Math.max(sincePulse, 0) * 3.5) * (sincePulse < 4 ? 1 : 0);
    shared.uGemLight.value.set(GEM_COLOR.r, GEM_COLOR.g, GEM_COLOR.b).multiplyScalar(GEM_POWER * breath);
    // nor is the sun's, through leaves and whatever cloud passes
    const day = 1 + 0.11 * Math.sin(t * 0.41) + 0.07 * Math.sin(t * 1.07 + 2.1) + 0.04 * Math.sin(t * 2.3 + 0.7);
    shared.uSunLight.value.set(SUN_COLOR.r, SUN_COLOR.g, SUN_COLOR.b).multiplyScalar(SUN_POWER * day);

    // ---- the camera: along the way in, looking at the crystals; the pointer only turns the head a little
    const camera = this.camera;
    PATH.getPointAt(p, this.at);
    const k = 1 - Math.exp(-dt * 2);
    this.smooth.x += (this.pointer.x - this.smooth.x) * (whole ? 1 : k);
    this.smooth.y += (this.pointer.y - this.smooth.y) * (whole ? 1 : k);
    const quick = whole ? 1 : 1 - Math.exp(-dt * 7);
    this.heart.x += (this.pointer.x - this.heart.x) * quick;
    this.heart.y += (this.pointer.y - this.heart.y) * quick;
    // a body is never quite still either
    this.at.x += Math.sin(t * 0.23) * 0.02 + this.smooth.x * 0.1;
    this.at.y += Math.sin(t * 0.31 + 2) * 0.012 - this.smooth.y * 0.04;
    camera.position.copy(this.at);
    const dist = this.at.distanceTo(GEM_LOOK);
    // from far off the eye rests a little above the crystals, on the chamber as a whole
    this.aim.copy(GEM_LOOK);
    // (and close to, a little under them: the crystals sit just above the middle, with the pool at the foot of the mound
    // still in the bottom of the picture)
    this.aim.y += 0.8 * (1 - smoothstep(0.1, 0.6, p)) - 0.08 - 0.6 * smoothstep(0.45, 1, p);
    this.aim.x += this.smooth.x * 0.1 * dist + Math.sin(t * 0.17) * 0.004 * dist;
    this.aim.y -= this.smooth.y * 0.05 * dist;
    camera.lookAt(this.aim);
    const tall = camera.aspect < 1 ? Math.min(26, (1 - camera.aspect) * 34) : 0;
    // The lens widens on the way in: by the crystals there is more of the cave in the picture, not less. It widens in
    // step with the way itself, from the first metre to the last: so much nearer, so much wider.
    camera.fov = MathUtils.lerp(CAM.fov, 72, p) + tall;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    // the heart of the light goes where the pointer is, as far as the crystals reach: across the picture, and up and down
    this.right.setFromMatrixColumn(camera.matrixWorld, 0);
    shared.uGemPos.value.copy(GEM).addScaledVector(this.right, this.heart.x * 0.36);
    // (never so low that the mound it stands on shuts its light off from the floor)
    shared.uGemPos.value.y += 0.34 - this.heart.y * 0.3;

    // ---- what falls
    this.air.update(dt, t, (x, z) => {
      this.water.ring(x, z, t, 0.7 + Math.random() * 0.6);
      this.audio.drip(x - this.at.x, Math.hypot(x - this.at.x, z - this.at.z));
    });
    const tan = Math.tan(MathUtils.degToRad(camera.fov / 2));
    this.air.uPx.value = this.bufferSize.y / (2 * tan);

    // the lens is set on the crystals; close to them, what is behind and in front goes soft
    const blur = BLUR * this.bufferSize.y * (0.04 + 0.96 * smoothstep(0.4, 1, p)) * this.tune.dof;
    this.air.uFocus.value = dist;
    this.air.uCoc.value = blur;

    // ---- the pools' mirror: the cave above them, seen from under the water
    const renderer = this.renderer;
    const rock = (this.cave.material as ShaderMaterial).uniforms;
    const wet = this.opt.mirror && this.water.mesh.visible && !this.hidden.includes(this.water.mesh);
    if (wet) {
      this.water.follow(camera);
      this.water.under.layers.set(LAYER.world);
      this.water.under.layers.enable(LAYER.gem);
      this.water.under.layers.enable(LAYER.plant);
      this.water.under.layers.enable(LAYER.sky);
      // (seen through ripples, the rock can be shaded more lightly)
      const full = rock.uFlat.value;
      if (this.opt.leanMirror && !full) rock.uFlat.value = 7;
      renderer.setRenderTarget(this.water.target);
      renderer.render(this.scene, this.water.under);
      rock.uFlat.value = full;
    }

    // ---- the cave itself
    const post = this.post;
    renderer.setRenderTarget(post.scene);
    renderer.render(this.scene, camera);

    camera.getWorldDirection(this.fore);
    this.right.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(tan * camera.aspect);
    this.up.setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(tan);
    post.air.uCamPos.value.copy(camera.position);
    post.air.uCamFore.value.copy(this.fore);
    post.air.uCamRight.value.copy(this.right);
    post.air.uCamUp.value.copy(this.up);
    post.air.uFrame.value = whole ? 0 : this.frames++;
    post.nearFar.value.set(camera.near, camera.far);
    post.shut.uTan.value.set(tan * camera.aspect, tan);
    post.focus.value = dist;
    post.coc.value = blur;
    // at the end of the way in the crystals are what the eye is on: there their outline is kept clean of the blur behind
    post.sharp.value = smoothstep(0.82, 1, p);
    // the eye has grown used to the dark out in the passage, and closes a little as it nears the light
    post.finish.uExposure.value = MathUtils.lerp(2.6, 1.8, smoothstep(0, 0.9, p)) * this.tune.exp;
    post.finish.uTime.value = t;
    post.render(this.opt.off);

    const light = GEM_POWER / (dist * dist + 0.75);
    this.audio.update(dt, p, dist);
    this.aim.copy(GEM_LOOK).project(camera);
    this.events.onFrame?.(p, dist, phaseAt(p), light, this.aim.x * 0.5 + 0.5, 0.5 - this.aim.y * 0.5);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    gsap.killTweensOf(this);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("click", this.onClick);
    window.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("pointermove", this.onPointer);
    window.removeEventListener("touchstart", this.onTouchStart);
    window.removeEventListener("touchmove", this.onTouchMove);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
    this.timer.dispose();
    this.audio.dispose();
    this.quality.hud?.remove();
    this.note?.remove();
    this.scene.traverse((o) => {
      const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } };
      m.geometry?.dispose();
      m.material?.dispose();
    });
    this.light?.dispose();
    this.water?.dispose();
    this.post.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
