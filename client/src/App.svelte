<script lang="ts">
  import { onMount } from 'svelte';
  import ClientWebsocket from './lib/ClientWebsocket';
  import { Actions } from '@shared/actions';
  import ErrorToast from './lib/components/ErrorToast.svelte';
  import LandingPage from './lib/components/LandingPage.svelte';
  import Lobby from './lib/components/Lobby.svelte';
  import Game from './lib/components/Game.svelte';
  import ConfirmationModal from './lib/components/ConfirmationModal.svelte';
  import PersonalSettingsPanel from './lib/components/PersonalSettingsPanel.svelte';
  import { View, currentView, currentPath, navigateTo } from './lib/Navigator';
  import { resetState } from './lib/GameState';
  import { personalSettings } from './lib/stores/personalSettingsStore';

  resetState();
  // After a refresh, rejoin the room this tab was in (server restores our seat)
  ClientWebsocket.resumeSession();

  let showLeaveConfirm = $state(false);
  let showPersonalSettings = $state(false);
  let FontTestPage = $state<any>(null);
  const isDev = import.meta.env.DEV;

  function resetPersonalSettings() {
    personalSettings.set({ font: 'Children', fontSize: 'normal', soundVolume: 1 });
  }

  function leaveRoom() {
    ClientWebsocket.sendAction(new Actions.LeaveRoom());
    ClientWebsocket.disconnect();
    navigateTo(View.ROOM_FORM);
  }

  // Determine if we should show the landing page based on the current view or the path
  // This allows direct URL access to /playtesting, /about, /rules
  const showLandingPage = $derived(
    $currentView === View.ROOM_FORM ||
      ['/playtesting', '/about', '/rules', '/credits'].includes($currentPath),
  );

  const inRoom = $derived($currentView !== View.ROOM_FORM);
  const showFontTest = $derived(isDev && $currentPath === '/fonttest');

  onMount(async () => {
    if (!isDev || window.location.pathname !== '/fonttest') return;
    const module = await import('./lib/components/FontTestPage.svelte');
    FontTestPage = module.default;
  });
</script>

<main>
  <ErrorToast />
  <ConfirmationModal
    bind:show={showLeaveConfirm}
    title="Leave Room?"
    message="Are you sure you want to leave the room?"
    onConfirm={leaveRoom}
  />

  {#if inRoom}
    <button class="leave-room" onclick={() => (showLeaveConfirm = true)}>
      Leave Room
    </button>
    <button
      class="personal-settings-btn"
      onclick={() => (showPersonalSettings = true)}
      aria-label="Personal settings"
    >
      My Settings
    </button>
  {/if}

  {#if showPersonalSettings}
    <div
      class="modal-backdrop"
      onclick={(e) =>
        e.target === e.currentTarget && (showPersonalSettings = false)}
      onkeydown={(e) => e.key === 'Escape' && (showPersonalSettings = false)}
      role="dialog"
      aria-modal="true"
      aria-label="Personal Settings"
      tabindex="-1"
    >
      <div class="modal-card paper-card" role="document">
        <div class="modal-header">
          <h2>My Settings</h2>
          <div class="header-actions">
            <button class="reset-btn" onclick={resetPersonalSettings}
              >Reset to defaults</button
            >
            <button
              class="close-btn"
              onclick={() => (showPersonalSettings = false)}>✕</button
            >
          </div>
        </div>
        <div class="modal-body">
          <PersonalSettingsPanel />
        </div>
      </div>
    </div>
  {/if}

  {#if showFontTest}
    {#if FontTestPage}
      <FontTestPage />
    {:else}
      <p>Loading font tester...</p>
    {/if}
  {:else if showLandingPage}
    <LandingPage />
  {:else if $currentView === View.LOBBY}
    <Lobby />
  {:else if $currentView === View.GAME}
    <Game />
  {/if}
</main>

<style>
  .leave-room {
    position: fixed;
    z-index: 999;
    top: 1rem;
    right: 1rem;
    background-color: #ff0000;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
    cursor: pointer;
  }

  .personal-settings-btn {
    position: fixed;
    z-index: 999;
    top: 1rem;
    left: 1rem;
    background-color: var(--pen-black);
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
    cursor: pointer;
    font-size: var(--text-sm);
  }

  .personal-settings-btn:hover {
    background-color: #1a252f;
  }

  /* Personal settings modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
    backdrop-filter: blur(2px);
    padding: 1rem;
  }

  .modal-card {
    width: min(30rem, 100%);
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    transform: rotate(0.5deg);
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    /* Indent to clear the paper-card dog-ear (50px corner + card padding) */
    padding-left: 1.75rem;
    padding-bottom: 0.75rem;
    border-bottom: 2px solid var(--grid-blue);
    margin-bottom: 0.5rem;
    flex-shrink: 0;
  }

  .modal-header h2 {
    margin: 0;
    font-size: var(--text-xl);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .reset-btn {
    background: none;
    border: 1.5px solid var(--grid-blue);
    color: var(--pen-black);
    font-size: var(--text-sm);
    padding: 0.2rem 0.6rem;
    border-radius: 0.25rem;
    cursor: pointer;
    font-family: inherit;
    opacity: 0.75;
  }

  .reset-btn:hover {
    background-color: var(--grid-blue);
    opacity: 1;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: var(--text-xl);
    cursor: pointer;
    color: var(--pen-black);
    padding: 0.2rem 0.4rem;
    line-height: 1;
  }

  .close-btn:hover {
    background: none;
    color: var(--pen-red);
  }

  .modal-body {
    overflow-y: auto;
    padding-right: 0.25rem;
  }
</style>
