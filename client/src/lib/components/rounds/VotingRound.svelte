<script lang="ts">
  import { writable } from 'svelte/store';
  import { allBeasts, playerName, players } from '../../GameState';
  import Round from '../Round.svelte';
  import ClientWebsocket from '../../ClientWebsocket';
  import { ActionEnum } from '@shared/actions';
  import { roundStore, currentServerRound } from '../../stores/roundStore';
  import { roomSettings } from '../../stores/roomSettingsStore';
  import { onMount } from 'svelte';

  // Self-voting: always allowed in 2-player games; otherwise controlled by room setting.
  const allowSelfVote = $derived(
    $players ? $players.length === 2 || $roomSettings.allowSelfVote : false,
  );
  // Only show beasts the player is allowed to vote for.
  const votableBeasts = $derived(
    $allBeasts
      ? allowSelfVote
        ? $allBeasts
        : $allBeasts.filter((b) => b.playerName !== $playerName)
      : [],
  );
  const submissionCount = $derived(votableBeasts.length);
  // 2-player: 2 picks (self-vote allowed fills the gap); 3-player: 2 picks; 4+: min(3, players-1)
  const maxPicks = $derived(
    $players && $players.length > 0
      ? Math.min(3, Math.max(2, $players.length - 1))
      : 0,
  );

  // Store the user's picks here for now (exported so other modules can import if needed)
  export const userPicks = writable<any[]>([]);

  // Local picks array of indices into votableBeasts in selection order
  let picks: number[] = $state([]);
  let submitted = $state(false);
  const myRound = currentServerRound();

  const ordinals = ['', 'second', 'third'];

  const promptText = $derived(
    maxPicks === 0
      ? 'No votes required'
      : picks.length === 0
      ? `Pick your ${ordinals[0]} favorite beast`
      : picks.length < maxPicks
      ? `Pick your ${ordinals[picks.length]} favorite beast`
      : `Submit your vote!`,
  );
  const cols = 2;

  async function handleRoundEnd() {
    finishVoting();
  }

  function handleCardClick(i: number) {
    // If no votes required, ignore
    if (maxPicks === 0) return;

    const idx = picks.indexOf(i);
    if (idx !== -1) {
      // deselect and remove later picks (can't keep order gaps)
      picks = picks.slice(0, idx).concat(picks.slice(idx + 1));
    } else {
      if (picks.length >= maxPicks) return; // don't exceed allowed picks
      picks = [...picks, i];
    }

    // update exported store for now
    const selected = picks.map((pi) => votableBeasts[pi]);
    userPicks.set(selected);
  }

  function finishVoting() {
    if (submitted) return;
    submitted = true;
    // send action to server with picks
    ClientWebsocket.sendAction({
      type: ActionEnum.SEND_VOTE,
      payload: {
        first: votableBeasts[picks[0]]?.playerName ?? '',
        second: votableBeasts[picks[1]]?.playerName ?? '',
        third: votableBeasts[picks[2]]?.playerName ?? '',
        roundNumber: myRound,
      },
    });
    roundStore.update((state) => ({
      ...state,
      ongoing: false,
    }));
  }

  // Carousel / mobile browsing state
  let carousel: HTMLDivElement | null = null;
  let currentIndex = 0;

  function scrollToIndex(i: number) {
    if (!carousel) return;
    const width = carousel.clientWidth;
    carousel.scrollTo({ left: i * width, behavior: 'smooth' });
    currentIndex = i;
  }

  function prevCard() {
    if (currentIndex > 0) scrollToIndex(currentIndex - 1);
  }

  function nextCard() {
    if (currentIndex < votableBeasts.length - 1) scrollToIndex(currentIndex + 1);
  }

  let resizeObserver: ResizeObserver | null = null;
  onMount(() => {
    if (!carousel) return;
    // Keep current index aligned on resize
    resizeObserver = new ResizeObserver(() => scrollToIndex(currentIndex));
    resizeObserver.observe(carousel);
    return () => resizeObserver && resizeObserver.disconnect();
  });

  function handleScroll() {
    if (!carousel) return;
    const idx = Math.round(
      carousel.scrollLeft / Math.max(1, carousel.clientWidth),
    );
    currentIndex = idx;
  }
</script>

<Round onRoundEnd={handleRoundEnd}>
  <div class="voting-container">
    <div class="prompt">{promptText}</div>
    {#if votableBeasts.length > 0}
      <div
        class="voting-grid"
        bind:this={carousel}
        onscroll={handleScroll}
        style={`grid-template-columns: repeat(${cols}, minmax(var(--min-card-size), 1fr)); column-gap: var(--col-gap); row-gap: var(--row-gap);`}
      >
        {#each votableBeasts as beast, i}
          <div
            class="card"
            class:center-span={submissionCount % 2 === 1 &&
              i === submissionCount - 1}
            class:selected={picks.includes(i)}
            role="button"
            aria-pressed={picks.includes(i)}
            aria-label={`Drawing by ${beast.playerName}`}
            onclick={() => handleCardClick(i)}
          >
            <div class="image-wrap">
              <img src={beast.drawing} alt={`Drawing by ${beast.playerName}`} />
              {#if picks.includes(i)}
                <div class="selected-overlay" />
                <div class="badge">{picks.indexOf(i) + 1}</div>
              {/if}
            </div>
            <div class="drawer">{beast.playerName}</div>
            <button
              class="vote-btn"
              class:vote-btn-selected={picks.includes(i)}
              disabled={!picks.includes(i) && picks.length >= maxPicks}
              onclick={(e) => { e.stopPropagation(); handleCardClick(i); }}
            >
              {picks.includes(i) ? 'Remove' : 'Vote'}
            </button>
          </div>
        {/each}
      </div>
      <button
        class="carousel-arrow left"
        onclick={prevCard}
        aria-label="Previous drawing"
        ><span class="arrow-char">
          <img src="/icons/arrow-left.svg" alt="‹" height="20px" width="20px" />
        </span></button
      >
      <button
        class="carousel-arrow right"
        onclick={nextCard}
        aria-label="Next drawing"
        ><span class="arrow-char">
          <img
            src="/icons/arrow-right.svg"
            alt="›"
            height="20px"
            width="20px"
          />
        </span></button
      >
      <div class="voting-actions">
        {#if picks.length === maxPicks && maxPicks > 0}
          <button class="btn" onclick={finishVoting}>Finish Voting</button>
        {/if}
      </div>
    {:else}
      <p>No drawings to vote on yet.</p>
    {/if}
  </div>
</Round>

<style>
  .voting-container {
    width: min(
      1400px,
      96%
    ); /* take more horizontal space but keep a comfortable max */
    margin: 0 auto;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem;
    box-sizing: border-box;
    overflow: visible; /* let the page handle scrolling */
    position: relative;
    --min-card-size: 200px; /* adjustable minimum card dimension */
    --vertical-offset: 160px; /* space for prompt, actions and padding */
    --row-gap: 1.5rem; /* vertical separation between rows */
    --col-gap: 1.5rem; /* horizontal separation between columns */
  }

  .voting-grid {
    display: grid;
    column-gap: var(--col-gap);
    row-gap: var(--row-gap);
    align-items: start;
    align-content: start; /* stack rows from top */
    grid-auto-rows: auto; /* let rows size to their content to avoid overlap */
  }

  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    background: white;
    border: 3px solid black;
    border-radius: 8px;
    padding: 8px;
    box-shadow: 4px 4px 10px rgba(0, 0, 0, 0.08);
    min-width: var(--min-card-size);
    min-height: var(--min-card-size);
    max-height: 75vh;
    overflow: hidden;
    box-sizing: border-box;
    cursor: pointer;
  }

  .card.center-span {
    grid-column: 1 / -1; /* span both columns */
    justify-self: center; /* center horizontally */
    max-width: min(720px, calc(var(--min-card-size) * 1.8));
  }

  .image-wrap {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: white;
    flex: 1 1 auto; /* let image area grow to fill card */
    aspect-ratio: 3 / 4; /* force portrait container */
    max-height: 75vh;
  }

  .selected-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    pointer-events: none;
    border-radius: 6px;
  }

  .badge {
    position: absolute;
    top: 8px;
    right: 8px;
    background: #222;
    color: white;
    font-weight: 800;
    padding: 6px 10px;
    border-radius: 999px;
    font-size: 1rem;
    pointer-events: none;
  }

  .prompt {
    font-size: 1.25rem;
    font-weight: 700;
    text-align: center;
  }

  .voting-actions {
    display: flex;
    justify-content: center;
    gap: 1rem;
    margin-top: 0.75rem;
  }

  .card img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    background: white;
  }

  /* hide arrows by default (visible only on small screens) */
  .carousel-arrow {
    display: none;
  }

  .vote-btn {
    margin-top: 8px;
    width: 100%;
    padding: 6px 0;
    font-weight: 700;
    font-size: 0.9rem;
    background: #e8f5e9;
    color: #2e7d32;
    border: 2px solid #2e7d32;
    border-radius: 6px;
    cursor: pointer;
  }

  .vote-btn.vote-btn-selected {
    background: #fce4ec;
    color: #c62828;
    border-color: #c62828;
  }

  .vote-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .drawer {
    margin-top: 8px;
    text-align: center;
    font-weight: 700;
    font-size: 1rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (min-width: 900px) {
    .voting-grid {
      grid-template-columns: repeat(2, minmax(var(--min-card-size), 1fr));
    }
  }

  /* Mobile carousel behavior: show one card at a time, allow swipe */
  @media (max-width: 899px) {
    .voting-grid {
      display: flex;
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
      scroll-behavior: smooth;
      padding-bottom: 0.5rem; /* space for swipe */
      height: 75vh;
    }

    .voting-grid .card {
      flex: 0 0 100%;
      min-width: 100%;
      max-width: 100%;
      scroll-snap-align: center;
      margin: 0; /* use column gap as spacing via padding if needed */
      height: 100%;
      box-sizing: border-box;
    }

    .card.center-span {
      grid-column: auto; /* ignore grid span on mobile */
      max-width: 100%;
    }

    .carousel-arrow {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      background: rgba(255, 255, 255, 0.9);
      border: 2px solid #222;
      color: #222;
      width: 44px;
      height: 44px;
      border-radius: 999px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      cursor: pointer;
      z-index: 20;
      box-shadow: 2px 2px 6px rgba(0, 0, 0, 0.12);
    }

    /* Nudge the glyph down slightly to account for font metrics so it appears visually centered */
    .carousel-arrow .arrow-char {
      display: inline-block;
      line-height: 1;
      transform: translateY(1px);
    }

    .carousel-arrow.left {
      left: 8px;
    }
    .carousel-arrow.right {
      right: 8px;
    }

    /* Hide arrows on larger screens (they are positioned but not needed) */
    .carousel-arrow {
      display: flex;
    }
  }
</style>
