<script lang="ts">
  import { connectionStatus } from '../ClientWebsocket';
  import { notice } from '../GameState';

  // Only complain about reconnects that take a moment; brief blips are silent.
  const SHOW_RECONNECTING_AFTER_MS = 1500;
  let reconnectingVisible = $state(false);
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const status = $connectionStatus;
    clearTimeout(reconnectTimer);
    if (status === 'reconnecting') {
      reconnectTimer = setTimeout(() => (reconnectingVisible = true), SHOW_RECONNECTING_AFTER_MS);
    } else {
      reconnectingVisible = false;
    }
    return () => clearTimeout(reconnectTimer);
  });

  const message = $derived(
    $connectionStatus === 'replaced'
      ? 'You opened this game in another tab, so this tab was disconnected. Refresh to play here instead.'
      : reconnectingVisible
        ? 'Connection lost. Reconnecting…'
        : $notice,
  );
</script>

<div>
  <div>
    <div
      class="toast-error"
      class:toast-hidden={!message}
      class:toast-visible={!!message}
      role="status"
      aria-live="polite"
    >
      <pre class="toast-content">{message}</pre>
      {#if $notice && message === $notice}
        <button class="toast-close" onclick={() => notice.set('')} aria-label="Dismiss">✕</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .toast-error {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background-color: #dc2626;
    color: white;
    padding: 16px;
    border-radius: 8px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    max-width: 90vw;
    transition: all 0.3s ease-out;
    z-index: 9999;
  }

  .toast-hidden {
    opacity: 0;
    transform: translateX(-50%) translateY(20px);
  }

  .toast-visible {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  .toast-hidden {
    pointer-events: none;
  }

  .toast-close {
    background: none;
    border: none;
    color: white;
    margin-left: 0.75rem;
    cursor: pointer;
  }

  .toast-error {
    display: flex;
    align-items: flex-start;
  }

  .toast-content {
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
</style>
