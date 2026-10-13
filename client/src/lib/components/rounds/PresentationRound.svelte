<script lang="ts">
  import Round from '../Round.svelte';
  import {
    drawingImage,
    presenterName,
    isPresenter,
    presenterTimeLeft,
  } from '../../GameState';
  import ClientWebsocket from '../../ClientWebsocket';
  import { ActionEnum } from '@shared/actions';
  import { onMount } from 'svelte';
  import { currentServerRound } from '../../stores/roundStore';

  const myRound = currentServerRound();

  async function handleRoundEnd() {
    // base function will already send end round action for us
  }

  function endPresentation() {
    // send presenter end action
    ClientWebsocket.sendAction({
      type: ActionEnum.PRESENTER_END,
      payload: { roundNumber: myRound },
    });
  }

  function downloadImage() {
    if (!$drawingImage) return;

    const link = document.createElement('a');
    link.href = $drawingImage;
    link.download = 'scribble-beast.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  onMount(() => {
    const interval = setInterval(() => {
      if ($presenterTimeLeft === undefined || $presenterTimeLeft <= 0) {
        return;
      }
      presenterTimeLeft.update((timeLeft) => {
        if (timeLeft === undefined || timeLeft <= 0) return timeLeft;
        return timeLeft - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  });
</script>

<Round onRoundEnd={handleRoundEnd}>
  <div class="presentation-container">
    {#if $drawingImage}
      {#if !$isPresenter}
        <p>Presenter: {$presenterName}</p>
      {:else}
        <p>You are presenting!</p>
      {/if}
      <img
        src={$drawingImage}
        alt="Final Scribble Beast"
        class="drawing-image"
      />
      {#if $isPresenter}
        <button class="btn" on:click={endPresentation}>
          End Presentation
        </button>
      {/if}
      <button class="btn" on:click={downloadImage}> Download Image </button>
    {:else}
      <p>No image to display D:</p>
    {/if}
  </div>
</Round>

<style>
  .presentation-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 20px;
    padding: 20px;
    height: 100%;
    width: 100%;
  }

  h2 {
    font-family: 'AckiPreschool', sans-serif;
    font-size: 2rem;
    text-align: center;
  }

  .drawing-image {
    max-width: 90%;
    max-height: 60vh;
    border: 3px solid black;
    border-radius: 10px;
    background-color: white;
    box-shadow: 5px 5px 15px rgba(0, 0, 0, 0.2);
  }

  .btn {
    padding: 12px 24px;
    font-family: 'AckiPreschool', sans-serif;
    font-size: 1.5rem;
    background-color: #ffb347; /* Pastel orange to match theme likely */
    color: black;
    border: 3px solid black;
    border-radius: 255px 15px 225px 15px / 15px 225px 15px 255px; /* Sketchy border */
    cursor: pointer;
    transition: transform 0.1s;
  }

  .btn:hover {
    transform: scale(1.05);
  }

  .btn:active {
    transform: scale(0.95);
  }
</style>
