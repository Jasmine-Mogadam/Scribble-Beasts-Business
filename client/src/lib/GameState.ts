import {
  ActionEnum,
  SendEOTWAction as SendEotwAction,
  type HostChangeAction,
  type JoinRoomAction,
  type PlayerListChangeAction,
  type SendDrawingAction,
  type StartGameAction,
  type PlayerDoneAction,
  type StartRoundAction,
  type SendPresenterChangeAction,
  type SendAllBeastsAction,
  type SendWinnersAction,
  type RoomSettingsChangeAction,
  type SessionEndedAction,
} from '@shared/actions';
import { derived, get, writable } from 'svelte/store';
import ClientWebsocket from './ClientWebsocket';
import { View, navigateTo, currentView } from './Navigator';
import { jumpToRound, resetRoundStore, startNextRound } from './stores/roundStore';
import { introPlaying } from './stores/introStore';
import { getEotwCardFromId, type EotwCard } from '@shared/eotw';
import { roomSettings } from './stores/roomSettingsStore';

export const isHost = writable(false);
export const hostName = writable<string | undefined>(undefined);
export const presenterName = writable<string | undefined>(undefined);
export const presenterTimeLeft = writable<number | undefined>(undefined);
export const playerName = writable('');
export const isPresenter = derived(
  [presenterName, playerName],
  ([$presenterName, $playerName]) => $presenterName === $playerName,
);
export const roomName = writable('');
export const currentRound = writable(0);
export const players = writable<string[]>([]);
export const playersDone = writable<string[]>([]);
export const everyoneDoneExceptYou = derived(
  [playersDone, players, playerName],
  ([$playersDone, $players, $playerName]) => {
    const otherPlayers = $players.filter((p) => p !== $playerName);
    return (
      otherPlayers.length > 0 &&
      otherPlayers.every((p) => $playersDone.includes(p))
    );
  },
);
export const drawingImage = writable<string>(''); // Base64url encoded image to draw on
export const eotwCard = writable<EotwCard>();
export const allBeasts = writable<{ playerName: string; drawing: string }[]>(
  [],
);
export const winners = writable<{ winner: string; beast: Base64URLString }[]>(
  [],
);
/** User-facing notice (session ended, opened in another tab, …). */
export const notice = writable<string>('');

function resetGameStores() {
  resetRoundStore();
  playersDone.set([]);
  winners.set([]);
  eotwCard.set(undefined as any);
  presenterName.set(undefined);
  presenterTimeLeft.set(undefined);
  introPlaying.set(false);
}

const joinRoom = (action: JoinRoomAction) => {
  const {
    roomName: roomNameValue,
    playerName: playerNameValue,
    hostName: hostNameValue,
  } = action.payload;
  roomName.set(roomNameValue);
  playerName.set(playerNameValue);
  hostName.set(hostNameValue);
  isHost.set(hostNameValue === playerNameValue);
  notice.set('');
  // On a mid-game reconnect the server follows up with START_GAME; don't bounce
  // through the lobby (that would unmount the round and wipe the canvas).
  if (!action.payload.inGame) {
    if (get(currentView) === View.GAME) resetGameStores();
    navigateTo(View.LOBBY);
  }
};

const playerChange = (action: PlayerListChangeAction) => {
  const { playerList } = action.payload;
  players.set(playerList);
};

const hostChange = (action: HostChangeAction) => {
  const { newHostName } = action.payload;
  hostName.set(newHostName);
  isHost.set(newHostName === get(playerName));
};

const startGame = (action: StartGameAction) => {
  const { currentRound, timer, roundDone, playersDone: done } = action.payload;
  if (currentRound) {
    // reconnecting mid-game: fast-forward to the correct round
    introPlaying.set(false);
    jumpToRound(currentRound - 1, timer || 0, !!roundDone);
    playersDone.set(done ?? []);
  } else {
    // fresh game start (or rejoining during the intro): reset stale state
    resetGameStores();
  }
  navigateTo(View.GAME);
};

const startRound = (action: StartRoundAction) => {
  // First START_ROUND implicitly ends any intro that was still on screen.
  introPlaying.set(false);
  playersDone.set([]);
  startNextRound(action.payload.timeout, action.payload.roundNumber);
};

const endGame = () => {
  resetGameStores();
  navigateTo(View.LOBBY);
};

const sessionEnded = (action: SessionEndedAction) => {
  ClientWebsocket.clearSession();
  if (get(currentView) !== View.ROOM_FORM) {
    resetGameStores();
    navigateTo(View.ROOM_FORM);
    notice.set(action.payload.message);
  }
};

const drawingImageChange = (action: SendDrawingAction) => {
  const { image } = action.payload;
  drawingImage.set(image);
};

const presenterChange = (action: SendPresenterChangeAction) => {
  const { newPresenter, timeout } = action.payload;
  presenterName.set(newPresenter);
  presenterTimeLeft.set(typeof timeout === 'number' ? timeout : undefined);
};
const eotwChange = (action: SendEotwAction) => {
  const { eotwId } = action.payload;
  eotwCard.set(getEotwCardFromId(eotwId));
};

const playerDone = (action: PlayerDoneAction) => {
  const { playerName } = action.payload;
  playersDone.update((done) =>
    done.includes(playerName) ? done : [...done, playerName],
  );
};

const loadBeasts = (action: SendAllBeastsAction) => {
  allBeasts.set(action.payload.drawings);
};

const loadWinners = (action: SendWinnersAction) => {
  winners.set(action.payload.winners);
  console.log(
    'Winners:',
    action.payload.winners.map((w) => ({
      winner: w.winner,
      beast: w.beast.length > 10 ? w.beast.substring(0, 10) + '…' : w.beast,
    })),
  );
};

const settingsChanged = (action: RoomSettingsChangeAction) => {
  roomSettings.set(action.payload.settings);
};

export function resetState() {
  ClientWebsocket.removeActionListener(ActionEnum.JOIN_ROOM);
  ClientWebsocket.removeActionListener(ActionEnum.PLAYER_LIST_CHANGE);
  ClientWebsocket.removeActionListener(ActionEnum.HOST_CHANGE);
  ClientWebsocket.removeActionListener(ActionEnum.START_GAME);
  ClientWebsocket.removeActionListener(ActionEnum.SEND_DRAWING);
  ClientWebsocket.removeActionListener(ActionEnum.SEND_EOTW);
  ClientWebsocket.removeActionListener(ActionEnum.PLAYER_DONE);
  ClientWebsocket.removeActionListener(ActionEnum.START_ROUND);
  ClientWebsocket.removeActionListener(ActionEnum.PRESENTER_CHANGE);
  ClientWebsocket.removeActionListener(ActionEnum.PRESENTER_START);
  ClientWebsocket.removeActionListener(ActionEnum.PRESENTER_END);
  ClientWebsocket.removeActionListener(ActionEnum.SEND_ALL_BEASTS);
  ClientWebsocket.removeActionListener(ActionEnum.SEND_WINNERS);
  ClientWebsocket.removeActionListener(ActionEnum.ROOM_SETTINGS_CHANGE);
  ClientWebsocket.removeActionListener(ActionEnum.INTRO_START);
  ClientWebsocket.removeActionListener(ActionEnum.INTRO_END);
  ClientWebsocket.removeActionListener(ActionEnum.END_GAME);
  ClientWebsocket.removeActionListener(ActionEnum.SESSION_ENDED);

  ClientWebsocket.addActionListener<JoinRoomAction>(
    ActionEnum.JOIN_ROOM,
    joinRoom,
  );
  ClientWebsocket.addActionListener<PlayerListChangeAction>(
    ActionEnum.PLAYER_LIST_CHANGE,
    playerChange,
  );
  ClientWebsocket.addActionListener<HostChangeAction>(
    ActionEnum.HOST_CHANGE,
    hostChange,
  );
  ClientWebsocket.addActionListener<StartGameAction>(
    ActionEnum.START_GAME,
    startGame,
  );
  ClientWebsocket.addActionListener<SendDrawingAction>(
    ActionEnum.SEND_DRAWING,
    drawingImageChange,
  );
  ClientWebsocket.addActionListener<SendEotwAction>(
    ActionEnum.SEND_EOTW,
    eotwChange,
  );
  ClientWebsocket.addActionListener<SendPresenterChangeAction>(
    ActionEnum.PRESENTER_CHANGE,
    presenterChange,
  );
  ClientWebsocket.addActionListener<PlayerDoneAction>(
    ActionEnum.PLAYER_DONE,
    playerDone,
  );
  ClientWebsocket.addActionListener<StartRoundAction>(
    ActionEnum.START_ROUND,
    startRound,
  );
  ClientWebsocket.addActionListener(ActionEnum.INTRO_START, () =>
    introPlaying.set(true),
  );
  ClientWebsocket.addActionListener(ActionEnum.INTRO_END, () =>
    introPlaying.set(false),
  );
  ClientWebsocket.addActionListener(ActionEnum.END_GAME, endGame);
  ClientWebsocket.addActionListener<SessionEndedAction>(
    ActionEnum.SESSION_ENDED,
    sessionEnded,
  );
  ClientWebsocket.addActionListener<SendAllBeastsAction>(
    ActionEnum.SEND_ALL_BEASTS,
    loadBeasts,
  );
  ClientWebsocket.addActionListener<SendWinnersAction>(
    ActionEnum.SEND_WINNERS,
    loadWinners,
  );
  ClientWebsocket.addActionListener<RoomSettingsChangeAction>(
    ActionEnum.ROOM_SETTINGS_CHANGE,
    settingsChanged,
  );
}
