<script lang="ts">
  import {
    Actions,
    ActionEnum,
    type RoomErrorAction,
    type CreateRoomAction,
    type JoinRoomAction,
  } from '@shared/actions';
  import ClientWebsocket from '../ClientWebsocket';
  import {
    isHost,
    roomName as roomNameState,
    hostName as hostNameState,
    playerName as playerNameState,
  } from '../GameState';
  import { navigateTo, View } from '../Navigator';
  import { roomSettings } from '../stores/roomSettingsStore';
  import {
    MAX_NAME_LENGTH,
    normalizePlayerName,
    normalizeRoomName,
    sanitizeNameDraftInput,
  } from '@shared/inputValidation';

  let roomName: string = $state('');
  let roomNameError: string = $state('');
  let playerName: string = $state('');
  let playerNameError: string = $state('');

  function clearErrors() {
    roomNameError = '';
    playerNameError = '';
  }

  function cleanupRoomForm() {
    clearErrors();
    ClientWebsocket.removeActionListener(ActionEnum.ROOM_ERROR);
    ClientWebsocket.removeActionListener(ActionEnum.CREATE_ROOM);
    ClientWebsocket.removeActionListener(ActionEnum.JOIN_ROOM);
  }

  ClientWebsocket.addActionListener<RoomErrorAction>(
    ActionEnum.ROOM_ERROR,
    (action) => {
      clearErrors();
      const { roomInputMessage, nameInputMessage } = action.payload;
      roomNameError = roomInputMessage ?? '';
      playerNameError = nameInputMessage ?? '';
    },
  );
  ClientWebsocket.addActionListener<CreateRoomAction>(
    ActionEnum.CREATE_ROOM,
    (action) => {
      cleanupRoomForm();
      const { hostName, roomName } = action.payload;
      isHost.set(true);
      hostNameState.set(hostName);
      playerNameState.set(hostName);
      roomNameState.set(roomName);
      navigateTo(View.LOBBY);
    },
  );
  ClientWebsocket.addActionListener<JoinRoomAction>(
    ActionEnum.JOIN_ROOM,
    (action) => {
      cleanupRoomForm();
      const { playerName, roomName, hostName } = action.payload;
      isHost.set(false);
      hostNameState.set(hostName);
      playerNameState.set(playerName);
      roomNameState.set(roomName);
      navigateTo(View.LOBBY);
    },
  );

  const inputsFilled = $derived(
    roomName.trim() !== '' && playerName.trim() !== '',
  );

  function joinRoom(event: Event): void {
    event.preventDefault();
    const safeRoomName = normalizeRoomName(roomName);
    const safePlayerName = normalizePlayerName(playerName);
    roomName = safeRoomName;
    playerName = safePlayerName;
    if (!safeRoomName || !safePlayerName) {
      roomNameError = safeRoomName ? '' : 'Room name cannot be empty.';
      playerNameError = safePlayerName ? '' : 'Name cannot be empty.';
      return;
    }
    const joinRoomAction = new Actions.JoinRoom(safeRoomName, safePlayerName);
    // Each room has its own server instance; connect to it, then ask to join.
    ClientWebsocket.connect(safeRoomName);
    ClientWebsocket.sendAction(joinRoomAction);
  }
  function createRoom(event: Event): void {
    event.preventDefault();
    const safeRoomName = normalizeRoomName(roomName);
    const safePlayerName = normalizePlayerName(playerName);
    roomName = safeRoomName;
    playerName = safePlayerName;
    if (!safeRoomName || !safePlayerName) {
      roomNameError = safeRoomName ? '' : 'Room name cannot be empty.';
      playerNameError = safePlayerName ? '' : 'Name cannot be empty.';
      return;
    }
    const createRoomAction = new Actions.CreateRoom(
      safeRoomName,
      safePlayerName,
      $roomSettings,
    );
    ClientWebsocket.connect(safeRoomName);
    ClientWebsocket.sendAction(createRoomAction);
  }

  function onRoomNameInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    roomName = sanitizeNameDraftInput(input.value).toUpperCase();
  }

  function onPlayerNameInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    playerName = sanitizeNameDraftInput(input.value);
  }
</script>

<div class="flex-center-page">
  <form class="paper-card room-form">
    <div class="form-group">
      <label for="roomName" class="text-pen-blue">Room</label>
      <input
        type="text"
        id="roomName"
        bind:value={roomName}
        maxlength={MAX_NAME_LENGTH}
        placeholder="Enter Room Name"
        oninput={onRoomNameInput}
        required
      />
      <div class="text-error">{roomNameError}</div>
    </div>
    <div class="form-group">
      <label for="playerName" class="text-pen-blue">Name</label>
      <input
        type="text"
        id="playerName"
        bind:value={playerName}
        maxlength={MAX_NAME_LENGTH}
        placeholder="Enter Your Player Name"
        oninput={onPlayerNameInput}
        required
      />
      <div class="text-error">{playerNameError}</div>
    </div>
    <div class="button-group">
      <button
        id="joinRoom"
        type="submit"
        onclick={joinRoom}
        disabled={!inputsFilled}
      >
        Join Room
      </button>
      <button
        id="createRoom"
        type="submit"
        onclick={createRoom}
        disabled={!inputsFilled}
      >
        Create Room
      </button>
    </div>
  </form>
</div>

<style>
  div {
    display: contents;
  }
  .room-form {
    transform: rotate(-2deg);
    max-width: 25rem;
    /* Styles are now handled by parent wrapper or shared */
    width: 100%;
    /* max-width: 25rem; This will be controlled by parent */
    padding-top: 4rem;
  }
  .form-group {
    margin-bottom: 1.5rem;
  }
  label {
    display: block;
    margin-bottom: 0.5rem;
    font-size: var(--text-lg);
    text-align: left;
  }
  input {
    width: 90%;
    padding-left: 1rem;
    /* padding inherited from global but 100% width needed here */
  }
  .button-group {
    display: flex;
    gap: 1rem;
    margin-top: 1.5rem;
  }
  button {
    flex: 1;
  }
  button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
</style>
