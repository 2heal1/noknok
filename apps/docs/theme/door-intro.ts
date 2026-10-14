// A silent, local illustration. It never connects to an agent or meeting.
const DURATION = 10200;
const MESSAGE_TIMES = [4050, 5400, 6750, 8100, 9450];
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const progress = (time: number, start: number, end: number) => clamp((time - start) / (end - start));
const smooth = (value: number) => value * value * (3 - 2 * value);

export interface DoorIntroController {
  setActive(value: boolean): void;
  refresh(): void;
  destroy(): void;
}

export function createDoorIntro(stage: HTMLElement, { active = true, translate }: { active?: boolean; translate: (key: string) => string }): DoorIntroController | null {
  const doorElement = stage.querySelector<HTMLElement>('.door-intro');
  const controlsElement = stage.querySelector<HTMLElement>('.intro-controls');
  if (!doorElement || !controlsElement) return null;
  const door: HTMLElement = doorElement;
  const controls: HTMLElement = controlsElement;
  const pause = controls.querySelector<HTMLButtonElement>('[data-intro-action="pause"]')!;
  const skip = controls.querySelector<HTMLButtonElement>('[data-intro-action="skip"]')!;
  const replay = controls.querySelector<HTMLButtonElement>('[data-intro-action="replay"]')!;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let elapsed = 0;
  let lastFrame: number | null = null;
  let frameId: number | null = null;
  let visible = false;
  let started = false;
  let complete = false;
  let manuallyPaused = false;

  function updateControls() {
    controls.hidden = !active;
    pause.hidden = complete;
    skip.hidden = complete;
    replay.hidden = !complete || reducedMotion.matches;
    pause.textContent = translate(manuallyPaused ? 'intro.resume' : 'intro.pause');
    pause.setAttribute('aria-pressed', String(manuallyPaused));
    skip.textContent = translate('intro.skip');
    replay.textContent = translate('intro.replay');
  }

  function draw() {
    const time = complete ? DURATION : elapsed;
    const opening = smooth(progress(time, 1550, 2750));
    const zoom = progress(time, 2500, 3850);
    const reveal = smooth(progress(time, 3200, 3850));
    const knock = [540, 1090].reduce((sum, start) => {
      const p = progress(time, start, start + 350);
      return sum + Math.sin(p * Math.PI * 4) * Math.pow(1 - p, 2) * 3;
    }, 0);
    const pulse = [540, 1090].reduce((max, start) => {
      const p = progress(time, start, start + 700);
      return Math.max(max, Math.sin(p * Math.PI) * (1 - p));
    }, 0);
    stage.style.setProperty('--door-angle', `${-84 * opening}deg`);
    stage.style.setProperty('--door-shake', `${knock}deg`);
    stage.style.setProperty('--camera-scale', String(1 + 17 * zoom ** 3));
    stage.style.setProperty('--knock-scale', String(1 + pulse * .65));
    stage.style.setProperty('--knock-opacity', String(1 - opening));
    stage.style.setProperty('--intro-opacity', String(1 - reveal));
    stage.style.setProperty('--chat-opacity', String(reveal));
    stage.style.setProperty('--chat-scale', String(.82 + .18 * reveal));
    for (let index = 0; index < 3; index += 1) {
      const start = 540 + index * 100;
      const p = progress(time, time < 1090 + index * 100 ? start : 1090 + index * 100, time < 1090 + index * 100 ? start + 900 : 1990 + index * 100);
      stage.style.setProperty(`--wave-${index}-scale`, String(.8 + 1.2 * p));
      stage.style.setProperty(`--wave-${index}-opacity`, String(Math.sin(p * Math.PI) * .55 * (1 - opening)));
    }
    stage.querySelectorAll<HTMLElement>('#story-messages .story-message').forEach((row, index) => {
      const p = complete || !active ? 1 : smooth(progress(time, MESSAGE_TIMES[index] ?? 9000, (MESSAGE_TIMES[index] ?? 9000) + 400));
      row.style.opacity = String(p);
      row.style.transform = `translateY(${(1 - p) * 13}px)`;
    });
    door.hidden = complete || !active;
    stage.classList.toggle('intro-enabled', active);
    stage.classList.toggle('intro-running', active && !complete);
  }

  function cancelFrame() {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    lastFrame = null;
    stage.classList.remove('intro-playing');
  }

  function finish({ focus = false } = {}) {
    cancelFrame();
    complete = true;
    started = true;
    manuallyPaused = false;
    elapsed = DURATION;
    const restoreFocus = focus || controls.contains(document.activeElement);
    stage.dataset.introState = active ? 'complete' : 'inactive';
    stage.classList.remove('intro-paused');
    stage.classList.add('intro-complete');
    draw();
    updateControls();
    if (restoreFocus && !replay.hidden && active) replay.focus({ preventScroll: true });
    else if (restoreFocus && active) {
      stage.closest('section')?.querySelector<HTMLElement>('[data-scene="contact"]')?.focus({ preventScroll: true });
    }
  }

  function tick(now: number) {
    frameId = null;
    if (lastFrame !== null) elapsed = Math.min(DURATION, elapsed + now - lastFrame);
    lastFrame = now;
    if (elapsed >= DURATION) {
      finish();
      return;
    }
    draw();
    frameId = requestAnimationFrame(tick);
  }

  function syncPlayback() {
    cancelFrame();
    stage.classList.toggle('intro-paused', manuallyPaused && active && !complete);
    if (complete || !active) {
      stage.dataset.introState = active ? 'complete' : 'inactive';
      return;
    }
    if (reducedMotion.matches) {
      finish();
      return;
    }
    if (!visible || document.hidden || manuallyPaused) {
      stage.dataset.introState = started ? 'paused' : 'waiting';
      return;
    }
    started = true;
    stage.dataset.introState = 'playing';
    stage.classList.add('intro-playing');
    frameId = requestAnimationFrame(tick);
  }

  function setActive(value: boolean) {
    if (active && !value && started && !complete) finish();
    active = value;
    draw();
    updateControls();
    syncPlayback();
  }

  const onPause = () => {
    manuallyPaused = !manuallyPaused;
    updateControls();
    syncPlayback();
  };
  const onSkip = () => finish({ focus: true });
  const onReplay = () => {
    elapsed = 0;
    complete = false;
    manuallyPaused = false;
    stage.classList.remove('intro-complete');
    draw();
    updateControls();
    pause.focus({ preventScroll: true });
    syncPlayback();
  };
  document.addEventListener('visibilitychange', syncPlayback);
  const onMotionChange = () => {
    if (reducedMotion.matches) finish();
    updateControls();
  };
  pause.addEventListener('click', onPause);
  skip.addEventListener('click', onSkip);
  replay.addEventListener('click', onReplay);
  reducedMotion.addEventListener('change', onMotionChange);
  let observer: IntersectionObserver | undefined;
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting && entries[0].intersectionRatio >= .3;
      syncPlayback();
    }, { threshold: [0, .3] });
    observer.observe(stage);
  } else visible = true;

  // Screen readers get the full illustrative conversation, not timed announcements.
  stage.querySelector('#story-messages')?.setAttribute('aria-live', 'off');
  setActive(active);
  return {
    setActive,
    refresh() { draw(); updateControls(); },
    destroy() {
      cancelFrame();
      observer?.disconnect();
      document.removeEventListener('visibilitychange', syncPlayback);
      reducedMotion.removeEventListener('change', onMotionChange);
      pause.removeEventListener('click', onPause);
      skip.removeEventListener('click', onSkip);
      replay.removeEventListener('click', onReplay);
    },
  };
}
