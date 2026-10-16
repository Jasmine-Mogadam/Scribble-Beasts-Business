<script lang="ts">
  import Round from '../Round.svelte';
  import { eotwCard } from '../../GameState';

  async function handleRoundEnd() {
    // base function will already send end round action for us
  }
</script>

<Round onRoundEnd={handleRoundEnd}>
  <div class="scene">
    <div class="card">
      <div class="card-face card-front">
        <div class="img-container">
          <img
            src={$eotwCard?.image}
            alt="Silly photorealistic collage that displays the problem described below."
          />
        </div>
        <div class="description-container">
          <p>{$eotwCard?.description ?? ''}</p>
        </div>
      </div>
      <div class="card-face card-back">
        <img src="/images/eotw/back.png" alt="Card Back" />
      </div>
    </div>
  </div>
</Round>

<style>
  .scene {
    width: 300px;
    height: 450px;
    perspective: 1000px;
    margin: 0 auto;
  }

  .card {
    width: 100%;
    height: 100%;
    position: relative;
    transform-style: preserve-3d;
    animation: slide-and-flip 3s ease-in-out forwards;
  }

  .card-face {
    position: absolute;
    width: 100%;
    height: 100%;
    backface-visibility: hidden;
    border-radius: 15px;
    overflow: hidden;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
    background-color: white;
    display: flex;
    flex-direction: column;
  }

  .card-front {
    transform: rotateY(0deg);
  }

  .card-back {
    transform: rotateY(180deg);
    display: flex;
    justify-content: center;
    align-items: center;
    background-color: white; /* Fallback color */
    padding: 10px;
  }

  .card-back img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .img-container {
    flex: 2;
    overflow: hidden;
    display: flex;
    justify-content: center;
    align-items: center;
    background-color: white;
    padding: 10px;
  }

  .img-container img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .description-container {
    flex: 1;
    padding: 15px;
    display: flex;
    justify-content: center;
    align-items: center;
    text-align: center;
    background-color: white;
    color: black;
    font-size: 1.1rem;
    overflow-y: auto;
  }

  @keyframes slide-and-flip {
    0% {
      transform: translateX(-150%) rotateY(180deg);
    }
    40% {
      transform: translateX(0) rotateY(180deg);
    }
    60% {
      transform: translateX(0) rotateY(180deg);
    }
    100% {
      transform: translateX(0) rotateY(0deg);
    }
  }
</style>
