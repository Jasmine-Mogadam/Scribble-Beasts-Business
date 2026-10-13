<script lang="ts">
  import { onMount } from 'svelte';
  import { endCurrentRound, roundStore } from '../stores/roundStore';
  import { ROUND_TYPE_COMPONENT_DICT } from '../constants/RoundTypeComponentDict';
  import Intro from './Intro.svelte';
  import { introPlaying } from '../stores/introStore';
  import { isHost } from '../GameState';
  import { roomSettings } from '../stores/roomSettingsStore';
  import { personalSettings } from '../stores/personalSettingsStore';

  const CROSSFADE_MS = 1000;

  // Plain variable (not $state) — avoids Svelte's deep proxy on a native DOM object,
  // which caused DOMException when setting .volume inside a RAF callback.
  let activeAudio: HTMLAudioElement | null = null;
  let pendingAudio: HTMLAudioElement | null = null;
  let fadingOutAudio: HTMLAudioElement | null = null;
  let fadeRafId: number | null = null;
  let isFading: boolean = $state(false);
  let resumeOnInteractionAttached = false;
  let playbackOffsetSeconds = 0;
  let playbackStartedAtMs: number | undefined = undefined;

  let needsSeekOnCanPlay = false;
  let lastAppliedMusicSrc: string | undefined = undefined;

  const shouldPlayMusic = $derived.by(() => {
    if ($introPlaying) return false;
    const mode = $roomSettings.soundMode;
    if (mode === 'none') return false;
    if (mode === 'shared') return $isHost;
    return true;
  });

  const currentRoundMusicSrc = $derived.by(() => {
    const currentRoundNumber = $roundStore.number ?? -1;
    const musicLevel = Math.min(4, Math.max(1, currentRoundNumber + 1));
    return `/files/Scribble%20Beasts%20Bossa%20Nova%20Level%20${musicLevel}.wav`;
  });

  function mod(n: number, m: number) {
    return ((n % m) + m) % m;
  }

  function getCurrentGlobalOffsetSeconds() {
    if (playbackStartedAtMs === undefined) {
      return playbackOffsetSeconds;
    }
    return (
      playbackOffsetSeconds + (performance.now() - playbackStartedAtMs) / 1000
    );
  }

  function freezeGlobalOffset() {
    playbackOffsetSeconds = getCurrentGlobalOffsetSeconds();
    playbackStartedAtMs = undefined;
  }

  function cancelFade() {
    if (fadeRafId !== null) {
      cancelAnimationFrame(fadeRafId);
      fadeRafId = null;
    }
    isFading = false;
    if (fadingOutAudio) {
      fadingOutAudio.pause();
      fadingOutAudio.src = '';
      fadingOutAudio = null;
    }
  }

  function startCrossfade(
    old: HTMLAudioElement | null,
    next: HTMLAudioElement,
    targetVol: number,
  ) {
    cancelFade();
    fadingOutAudio = old;
    isFading = true; // tells the volume $effect to stand down during the fade

    const startOldVol = old ? old.volume : 0;
    const start = performance.now();
    next.volume = 0;

    const tick = (now: number) => {
      const t = Math.min(Math.max((now - start) / CROSSFADE_MS, 0), 1);
      if (old) old.volume = startOldVol * (1 - t);
      next.volume = targetVol * t;

      if (t < 1) {
        fadeRafId = requestAnimationFrame(tick);
      } else {
        fadeRafId = null;
        fadingOutAudio = null;
        isFading = false; // lets the volume $effect re-confirm final volume
        if (old) {
          old.pause();
          old.src = '';
        }
      }
    };
    fadeRafId = requestAnimationFrame(tick);
  }

  function tryPlayRoundMusic() {
    if (!activeAudio || !shouldPlayMusic || needsSeekOnCanPlay) return;

    const playPromise = activeAudio.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise
        .then(() => {
          if (playbackStartedAtMs === undefined) {
            playbackStartedAtMs = performance.now();
          }
        })
        .catch(() => {
          playbackStartedAtMs = undefined;
          if (resumeOnInteractionAttached) return;
          resumeOnInteractionAttached = true;
          const resume = () => {
            if (shouldPlayMusic) {
              if (!activeAudio) return;
              const p = activeAudio.play();
              if (p && typeof p.then === 'function') {
                p.then(() => {
                  if (playbackStartedAtMs === undefined) {
                    playbackStartedAtMs = performance.now();
                  }
                }).catch(() => {
                  playbackStartedAtMs = undefined;
                });
              }
            }
            window.removeEventListener('pointerdown', resume, true);
            window.removeEventListener('keydown', resume, true);
            resumeOnInteractionAttached = false;
          };
          window.addEventListener('pointerdown', resume, true);
          window.addEventListener('keydown', resume, true);
        });
    }
  }

  function pauseRoundMusic(reset = false) {
    cancelFade();
    if (!activeAudio) return;
    if (!reset) freezeGlobalOffset();
    activeAudio.pause();
    if (reset) {
      activeAudio.currentTime = 0;
      playbackOffsetSeconds = 0;
      playbackStartedAtMs = undefined;
      needsSeekOnCanPlay = false;
    }
  }

  $effect(() => {
    if (shouldPlayMusic) {
      tryPlayRoundMusic();
      return;
    }
    pauseRoundMusic();
  });

  $effect(() => {
    if (!activeAudio || isFading) return;
    activeAudio.volume = $personalSettings.soundVolume;
  });

  $effect(() => {
    const src = currentRoundMusicSrc;
    if (lastAppliedMusicSrc === src) return;
    lastAppliedMusicSrc = src;

    // Cancel any in-progress preload
    if (pendingAudio) {
      pendingAudio.src = '';
      pendingAudio = null;
    }

    // Preload the new track in the background while the current one keeps playing
    const pre = new Audio();
    pre.loop = true;
    pre.preload = 'auto';
    pre.volume = $personalSettings.soundVolume;
    pendingAudio = pre;

    pre.addEventListener(
      'loadedmetadata',
      () => {
        if (pendingAudio !== pre) return; // superseded by a newer src change
        pendingAudio = null;

        freezeGlobalOffset();

        const duration = pre.duration;
        if (Number.isFinite(duration) && duration > 0) {
          pre.currentTime = mod(playbackOffsetSeconds, duration);
          needsSeekOnCanPlay = false;
        } else {
          // Duration not yet available; seek once canplay fires
          needsSeekOnCanPlay = true;
          pre.addEventListener(
            'canplay',
            () => {
              if (Number.isFinite(pre.duration) && pre.duration > 0) {
                pre.currentTime = mod(playbackOffsetSeconds, pre.duration);
                needsSeekOnCanPlay = false;
                if (shouldPlayMusic) {
                  startCrossfade(fadingOutAudio ?? null, pre, $personalSettings.soundVolume);
                  tryPlayRoundMusic();
                }
              }
            },
            { once: true },
          );
        }

        const old = activeAudio;
        const targetVol = $personalSettings.soundVolume;
        activeAudio = pre; // reactive: re-triggers shouldPlayMusic effect

        if (shouldPlayMusic && !needsSeekOnCanPlay) {
          // Crossfade: new fades in while old fades out simultaneously.
          // startCrossfade sets isFading=true before the microtask flush so the
          // volume $effect stands down and doesn't override pre.volume = 0.
          startCrossfade(old, pre, targetVol);
          tryPlayRoundMusic();
        } else {
          if (old) {
            old.pause();
            old.src = '';
          }
        }
      },
      { once: true },
    );

    pre.src = src;
    pre.load();
  });

  onMount(() => {
    // Round/intro transitions are driven by global listeners in GameState.ts so
    // they never depend on this component's mount timing (e.g. after reconnect).
    return () => {
      if (pendingAudio) {
        pendingAudio.src = '';
        pendingAudio = null;
      }
      cancelFade();
      pauseRoundMusic(true);
      if (activeAudio) {
        activeAudio.src = '';
        activeAudio = null;
      }
      introPlaying.set(false);
    };
  });
</script>

<div class="game-viewport overflow-hidden relative">
  {#if $introPlaying}
    <Intro />
  {/if}
  {#if $roundStore}
    <div class="paper-card game-card">
      <h1 class="text-pen-red">{$roundStore.current.roundName}</h1>

      {#if $roundStore.ongoing}
        <h3 class="text-pen-blue">{$roundStore.current.description}</h3>

        <div class="round-content">
          <svelte:component
            this={ROUND_TYPE_COMPONENT_DICT[$roundStore.current.roundType]}
            on:end={() => endCurrentRound()}
          />
        </div>
      {:else}
        <p>Great job! Wait for everyone else to finish :D</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .game-viewport {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    width: 100%;
    padding: 1rem;
    box-sizing: border-box;
  }
  .game-card {
    pointer-events: auto;
    width: 100%;
    max-width: 35rem;
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    transform: rotate(-1deg);
    padding-bottom: 2rem;
  }

  h1,
  h3 {
    margin: 0.15rem;
  }
  .round-content {
    margin-top: 0.15rem;
    width: 100%;
  }
</style>
