<script lang="ts">
  import {
    roundStore,
    endCurrentRound,
    currentServerRound,
  } from '../stores/roundStore';
  import { presenterTimeLeft } from '../GameState';
  import { get } from 'svelte/store';
  import ClientWebsocket from '../ClientWebsocket';
  import { onMount } from 'svelte';
  import { ActionEnum, type EndRoundAction } from '@shared/actions';
  import { RoundEnum } from '@shared/rounds';
  import { type Snippet } from 'svelte';

  let { children, onRoundEnd }: { 
    children: Snippet;
    onRoundEnd: () => Promise<void> | void;
  } = $props();

  let canClickDone = $state(false);
  let isEnding = $state(false);

  // The round this component instance belongs to. Captured up front because
  // onRoundEnd() is async and the next round may start before it resolves.
  const myRound = currentServerRound();

  async function handleEnd() {
    if (isEnding) return;
    isEnding = true;
    // Let the round send its end action (same for timeout or button click)
    await onRoundEnd();
    endCurrentRound(undefined, myRound);
  }

  // Handle server-initiated round ends and timer tick
  onMount(() => {
    const currentState = get(roundStore);
    const elapsed = currentState.duration - currentState.timeLeft;
    // 5 second anti-spam delay
    const remainingDelay = 5000 - elapsed * 1000;

    let enableButtonTimer: ReturnType<typeof setTimeout> | undefined;

    if (remainingDelay <= 0) {
      canClickDone = true;
    } else {
      enableButtonTimer = setTimeout(() => {
        canClickDone = true;
      }, remainingDelay);
    }

    console.log('[Round.svelte] mounted, adding END_ROUND listener');
    const removeServerEndRoundListener = ClientWebsocket.addActionListener(
      ActionEnum.END_ROUND,
      (action: EndRoundAction) => {
        const round = action.payload.roundNumber;
        if (round !== undefined && round !== myRound) return;
        void handleEnd();
      },
    );

    const interval = setInterval(() => {
      const s = get(roundStore);
      if (!s.ongoing || s.timeLeft <= 0) return;

      if (s.timeLeft === 1) {
        // last tick -> submit + end the round (same path as the Done button)
        roundStore.update((st) => ({ ...st, timeLeft: 0 }));
        void handleEnd();
        return;
      }

      roundStore.update((st) => ({ ...st, timeLeft: st.timeLeft - 1 }));
    }, 1000);

    return () => {
      console.log('[Round.svelte] unmounting, removing END_ROUND listener');
      clearInterval(interval);
      removeServerEndRoundListener();
      clearTimeout(enableButtonTimer);
    };
  });

</script>

<div class="round-container">
  {@render children()}

  <div class="round-footer">
    <div class="timer">
      {#if $roundStore?.current.roundType === RoundEnum.PRESENT && $presenterTimeLeft !== undefined}
        {$presenterTimeLeft}s
      {:else}
        {$roundStore?.timeLeft ?? 0}s
      {/if}
    </div>

    {#if !$roundStore?.current.hideButton}
      <button
        onclick={handleEnd}
        disabled={!canClickDone}
        class="done-button"
        class:hidden-until-active={!canClickDone}>Done</button
      >
    {/if}
  </div>
</div>

<style>
  .hidden-until-active {
    opacity: 0.1;
    cursor: not-allowed;
  }
  .round-container {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .round-footer {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .timer {
    font-size: var(--text-xl);
    font-weight: bold;
  }
  .done-button {
    position: fixed;
    bottom: 1rem;
    right: 1rem;
    z-index: 999;
  }
</style>
