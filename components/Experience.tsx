"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type Ref } from "react";
import gsap from "gsap";

const TITLE = "pov: you’re stuck in a cave";
const AUTHOR_URL = "https://julienrenau.com/";
const AUTHOR_X = "https://x.com/julien_rno";
// the stages of the way in, as the scene names them
const PHASES = ["the way in", "the chamber", "the pool", "the light"];
const two = (n: number) => String(n).padStart(2, "0");
// how out of focus the cave is behind the title (px)
const SCENE_BLUR = 10;

// What the loading line says as the bar fills
const LINES: [number, string][] = [
  [0, "hollowing the rock"],
  [30, "letting the water in"],
  [50, "bringing the roof down"],
  [68, "bouncing the light"],
  [86, "growing the crystals"],
  [94, "adjusting the eyes"],
];
const lineAt = (pct: number) => LINES.reduce((l, [at, text]) => (pct >= at ? text : l), LINES[0][1]);


const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/<>-_";

// A button whose label, when pointed at, runs through other characters before it settles from the left.
function Key({ label, className, ref, ...rest }: { label: string; ref?: Ref<HTMLButtonElement> } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const text = useRef<HTMLSpanElement>(null);
  const run = useRef({ t: 1 });
  // the letters are written by hand, here and while they run
  useEffect(() => {
    gsap.killTweensOf(run.current);
    if (text.current) text.current.textContent = label;
  }, [label]);
  const scramble = () => {
    const el = text.current;
    if (!el) return;
    let step = -1;
    gsap.fromTo(
      run.current,
      { t: 0 },
      {
        t: 1,
        duration: 0.42,
        ease: "none",
        overwrite: true,
        onUpdate: () => {
          const now = Math.floor(run.current.t * 11);
          if (now === step) return;
          step = now;
          const settled = Math.floor(run.current.t * label.length);
          el.textContent = [...label].map((ch, i) => (i < settled || ch === " " ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)])).join("");
        },
        onComplete: () => {
          el.textContent = label;
        },
      },
    );
  };
  return (
    <button ref={ref} type="button" className={className ? `key ${className}` : "key"} aria-label={label} onPointerEnter={scramble} onFocus={scramble} {...rest}>
      <span ref={text} aria-hidden="true" />
    </button>
  );
}

type WorldHandle = { dispose(): void; start(): void; leave(): void; toggleSound(): boolean };

function Credits() {
  return (
    <div className="credits" onClick={(e) => e.stopPropagation()}>
      <p className="credits-author">
        Made by{" "}
        <a href={AUTHOR_URL} target="_blank" rel="noreferrer">
          Julien Renau
        </a>{" "}
        with Claude Fable 5.2 ·{" "}
        <a href={AUTHOR_X} target="_blank" rel="noreferrer">
          @julien_rno
        </a>
      </p>
      <p>
        Everything is made in code: the rock and the water on it, the dripstone, the pools and what they mirror, the
        crystals, their light in the damp air and the sound of the place. No models, no textures, no recordings.
      </p>
      <p>type: Geist, Geist Mono (OFL) · three.js, GSAP</p>
    </div>
  );
}

export default function Experience() {
  const stage = useRef<HTMLDivElement>(null);
  const worldRef = useRef<WorldHandle | null>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const loaderRef = useRef<HTMLDivElement>(null);
  const hazeRef = useRef<HTMLDivElement>(null);
  const enterRef = useRef<HTMLButtonElement>(null);
  const distRef = useRef<HTMLSpanElement>(null);
  const lightRef = useRef<HTMLSpanElement>(null);
  const phaseRef = useRef("");
  const markRef = useRef<HTMLElement>(null);
  const reticleRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLParagraphElement>(null);
  const pctRef = useRef({ v: 0 });
  const endedRef = useRef(false);
  // the percentage shown (eased towards the real one), then the title, then the way in
  const [shown, setShown] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [clickable, setClickable] = useState(false);
  const [entered, setEntered] = useState(false);
  const [uiIn, setUiIn] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [credits, setCredits] = useState(false);
  const [touch, setTouch] = useState(false);
  const [failed, setFailed] = useState(false);
  const [muted, setMuted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [phase, setPhase] = useState(0);
  // screenshots and tuning (?still, ?ui, ?play) skip the screens
  const [bare, setBare] = useState(false);

  useEffect(() => {
    setTouch(window.matchMedia("(hover: none) and (pointer: coarse)").matches);
    const q = location.search;
    const isBare = q.includes("still") || q.includes("ui") || q.includes("play") || q.includes("bench");
    setBare(isBare);
    setStill(q.includes("still"));
    // (scaled up a touch so the blurred edges of the canvas stay off screen)
    if (!isBare && stage.current) {
      stage.current.style.filter = `blur(${SCENE_BLUR}px)`;
      stage.current.style.transform = "scale(1.04)";
    }

    let cancelled = false;
    import("@/lib/scene/World").then(({ World }) => {
      if (cancelled || !stage.current) return;
      const probe = document.createElement("canvas");
      if (!probe.getContext("webgl2")) {
        setFailed(true);
        return;
      }
      const world = new World(stage.current, {
        onLoad: (progress) => {
          const last = progress >= 1;
          if (last && isBare && !q.includes("still")) world.start();
          gsap.to(pctRef.current, {
            v: progress * 100,
            duration: 0.45,
            ease: "power1.out",
            overwrite: true,
            onUpdate: () => setShown(Math.floor(pctRef.current.v)),
            onComplete: last
              ? () =>
                  gsap.to(loaderRef.current, {
                    autoAlpha: 0,
                    duration: 1.4,
                    delay: 0.35,
                    ease: "sine.inOut",
                    onComplete: () => setLoaded(true),
                  })
              : undefined,
          });
        },
        // written straight to the page: this runs every frame
        onFrame: (p, distance, phase, light, x, y) => {
          if (distRef.current) distRef.current.textContent = distance.toFixed(2);
          if (lightRef.current) lightRef.current.textContent = light.toFixed(light < 10 ? 2 : 1);
          if (markRef.current) markRef.current.style.top = `${(p * 100).toFixed(2)}%`;
          // the frame that follows the crystals about the picture
          if (reticleRef.current) reticleRef.current.style.transform = `translate(${(x * innerWidth).toFixed(1)}px, ${(y * innerHeight).toFixed(1)}px)`;
          if (phase !== phaseRef.current) {
            phaseRef.current = phase;
            setPhase(Math.max(0, PHASES.indexOf(phase)));
          }
          if (hintRef.current) hintRef.current.style.opacity = p < 0.012 ? "1" : "0";
          const over = endedRef.current ? p > 0.9 : p > 0.992;
          if (over !== endedRef.current) setEnded((endedRef.current = over));
        },
      });
      worldRef.current = world;
    });
    return () => {
      cancelled = true;
      worldRef.current?.dispose();
    };
  }, []);

  // the title writes itself in, then the way in appears (the click only counts from then on)
  useEffect(() => {
    if (!loaded) return;
    const veil = veilRef.current;
    if (!veil) return;
    gsap.fromTo(
      veil.querySelectorAll("h1 .ch"),
      { opacity: 0, y: 8, filter: "blur(6px)" },
      { opacity: 1, y: 0, filter: "blur(0px)", duration: 1.5, stagger: 0.04, ease: "sine.out", delay: 0.4 },
    );
    gsap.fromTo(
      veil.querySelectorAll(".enter, .veil-hint"),
      { opacity: 0 },
      { opacity: 1, duration: 1.6, delay: 1.7, onStart: () => setClickable(true) },
    );
  }, [loaded]);

  useEffect(() => {
    if (clickable) enterRef.current?.focus({ preventScroll: true });
  }, [clickable]);

  const enter = () => {
    if (!clickable || entered || leaving) return;
    // the sound starts inside the click itself, so the browser lets it play
    worldRef.current?.start();
    setCredits(false);
    setLeaving(true);
    const veil = veilRef.current;
    if (!veil) return;
    gsap.killTweensOf(veil.querySelectorAll("h1, h1 .ch, .enter, .veil-hint"));
    gsap.to(veil.querySelectorAll("h1, .enter, .veil-hint"), { opacity: 0, y: -6, duration: 0.5, ease: "sine.in", overwrite: true });
    gsap.to(hazeRef.current, { opacity: 0, duration: 1.6, delay: 0.2, ease: "power2.inOut" });
    // the cave comes into focus; once sharp the blur is dropped entirely, so it costs nothing on the way in
    const scene = stage.current;
    if (scene) {
      const blur = { px: SCENE_BLUR };
      gsap.to(blur, {
        px: 0,
        duration: 1.6,
        delay: 0.2,
        ease: "power2.inOut",
        onUpdate: () => {
          scene.style.filter = `blur(${blur.px.toFixed(2)}px)`;
          scene.style.transform = `scale(${(1 + (0.04 * blur.px) / SCENE_BLUR).toFixed(4)})`;
        },
        onComplete: () => {
          scene.style.filter = "";
          scene.style.transform = "";
        },
      });
    }
    gsap.to(veil, { autoAlpha: 0, duration: 0.4, delay: 1.5, onComplete: () => setEntered(true) });
    window.setTimeout(() => setUiIn(true), 900);
  };

  const [still, setStill] = useState(false);
  const running = uiIn || (bare && !still);

  return (
    <main className="experience">
      <div ref={stage} className="stage" />

      {running && (
        <>
          <div className="frame" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>

          <a className="signature" href={AUTHOR_URL} target="_blank" rel="noreferrer">
            made by julien renau
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M1.5 10.5L10.5 1.5M3.5 1.5H10.5V8.5" />
            </svg>
          </a>

          {/* what an instrument carried in would read */}
          <dl className="readout" aria-live="off">
            <div>
              <dt>dist</dt>
              <dd>
                <span ref={distRef}>14.50</span> m
              </dd>
            </div>
            <div>
              <dt>light</dt>
              <dd>
                <span ref={lightRef}>0.19</span> lx
              </dd>
            </div>
            <div>
              <dt>stage</dt>
              <dd>
                {two(phase + 1)} / {two(PHASES.length)}
              </dd>
            </div>
          </dl>

          <div ref={reticleRef} className={phase > 1 ? "reticle is-off" : "reticle"} aria-hidden="true">
            <svg viewBox="-50 -50 100 100">
              <path d="M-50-36V-50H-36M36-50H50V-36M50 36V50H36M-36 50H-50V36" />
              <path className="reticle-ticks" d="M0-50V-45M0 50V45M-50 0H-45M50 0H45" />
            </svg>
            <span>{PHASES[phase]}</span>
          </div>

          {/* the whole way in as a scale: the passage at the top, the crystals at the bottom */}
          <div className="rail" aria-hidden="true">
            {Array.from({ length: 21 }, (_, i) => (
              <i key={i} style={{ top: `${i * 5}%` }} />
            ))}
            <b ref={markRef} />
          </div>

          <div className="keys">
            <Key label={`sound ${muted ? "off" : "on"}`} aria-pressed={!muted} onClick={() => setMuted(worldRef.current?.toggleSound() ?? false)} />
            <Key label="credits" aria-expanded={credits} onClick={() => setCredits((c) => !c)} />
          </div>

          <p ref={hintRef} className="scroll-hint">
            {touch ? "drag up to go in" : "scroll to go in"}
          </p>

          <div className={ended ? "ending is-on" : "ending"} aria-hidden={!ended}>
            <p>it was here all along.</p>
            <Key label="back to the entrance" tabIndex={ended ? 0 : -1} onClick={() => worldRef.current?.leave()} />
          </div>

          {credits && (
            <div className="credits-pop">
              <Credits />
            </div>
          )}
        </>
      )}

      {!bare && !entered && (
        <div
          ref={veilRef}
          className={`veil${clickable ? "" : " is-waiting"}`}
          onClick={enter}
        >
          <div ref={hazeRef} className="veil-haze" aria-hidden="true" />
          <div className="frame" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
          {failed ? (
            <div className="loader" role="alert">
              <span className="loader-line">
                this cave needs WebGL 2, which this browser has turned off. try another browser, or turn on hardware
                acceleration in its settings.
              </span>
            </div>
          ) : loaded ? (
            <>
              <h1 aria-label={TITLE}>
                {/* letter by letter for the fade-in, kept together by word so narrow screens wrap between words */}
                {TITLE.split(" ").map((word, w, all) => (
                  <span key={w} className="word" aria-hidden="true">
                    {word.split("").map((ch, i) => (
                      <span key={i} className="ch">
                        {ch}
                      </span>
                    ))}
                    {w < all.length - 1 ? <span className="ch"> </span> : null}
                  </span>
                ))}
              </h1>
              <Key ref={enterRef} label={touch ? "tap to go in" : "click to go in"} className="enter" disabled={!clickable} />
              <p className="veil-hint">
                {touch ? "drag up to go deeper · tap to send the light out" : "scroll to go deeper · move to steer the light · click to send it out"}
              </p>
              {!leaving && (
                <Key
                  label="credits"
                  className="credits-toggle"
                  aria-expanded={credits}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCredits((c) => !c);
                  }}
                />
              )}
              {credits && <Credits />}
            </>
          ) : (
            <div ref={loaderRef} className="loader">
              <div className="loader-card">
                <h1 className="loader-name">cave</h1>
                <p className="loader-about">
                  A passage down into the rock, a chamber the sun only reaches through a hole in its roof, and something
                  in it that gives a light of its own.
                </p>
                <div
                  className="loader-bar"
                  role="progressbar"
                  aria-label="Loading"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={shown}
                >
                  <i style={{ transform: `scaleX(${shown / 100})` }} />
                </div>
                <span className="loader-line">
                  <span aria-live="polite">{lineAt(shown)}…</span> <span aria-hidden="true">{String(shown).padStart(3, "0")}%</span>
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
