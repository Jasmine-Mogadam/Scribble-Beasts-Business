/* 
------------------------
HOW TO ADD A NEW ACTION:
------------------------
1. Add a new entry to the ActionEnum enum.
2. Create a class extending Action<{ your payload properties }>
3. Add the new action class to the AnyAction union type.
4. Update the Actions object with the new action class.
*/
import type { RoomSettings } from '../settings/index.js';
import { isPlainObject } from '../inputValidation.js';

export const enum ActionEnum {
  /* Room Actions */
  CREATE_ROOM = 'CREATE_ROOM',
  JOIN_ROOM = 'JOIN_ROOM',
  LEAVE_ROOM = 'LEAVE_ROOM',
  RECONNECT = 'RECONNECT',
  ROOM_ERROR = 'ROOM_ERROR',
  /* Lobby Actions */
  HOST_CHANGE = 'HOST_CHANGE',
  PLAYER_LIST_CHANGE = 'PLAYER_LIST_CHANGE',
  START_GAME = 'START_GAME',
  /** Host sends updated room settings; server validates and broadcasts ROOM_SETTINGS_CHANGE */
  UPDATE_ROOM_SETTINGS = 'UPDATE_ROOM_SETTINGS',
  /** Server broadcasts current room settings to all players */
  ROOM_SETTINGS_CHANGE = 'ROOM_SETTINGS_CHANGE',
  /** Intro Actions */
  INTRO_START = 'INTRO_START',
  INTRO_END = 'INTRO_END',
  /** Round Actions */
  END_ROUND = 'END_ROUND',
  START_ROUND = 'START_ROUND',
  SEND_DRAWING = 'SEND_DRAWING',
  SEND_EOTW = 'EOTW_ROUND',
  PRESENTER_CHANGE = 'PRESENTER_CHANGE',
  PRESENTER_START = 'PRESENTER_START',
  PRESENTER_END = 'PRESENTER_END',
  SEND_VOTE = 'VOTE_ROUND',
  PLAYER_DONE = 'PLAYER_DONE',
  SEND_ALL_BEASTS = 'SEND_ALL_BEASTS',
  SEND_WINNERS = 'SEND_WINNERS',
  /** Server: the game finished, everyone goes back to the lobby */
  END_GAME = 'END_GAME',
  /** Server: this client's saved session can't be resumed (room gone / player removed) */
  SESSION_ENDED = 'SESSION_ENDED',
  /** Heartbeat. Must be sent as the exact string PING_MESSAGE (see server GameSocket.ts) */
  PING = 'PING',
  PONG = 'PONG',
}

/**
 * Round-scoped actions carry the server's 1-indexed round number so that late
 * messages from a previous round (slow image encoding, network latency) are
 * ignored instead of ending the *next* round. Optional for backwards compat.
 */
export interface RoundScoped {
  roundNumber?: number;
}

type Base64URLString = string;

class Action<Payload> {
  type: ActionEnum;
  payload: Payload;

  constructor(type: ActionEnum, payload: Payload) {
    this.type = type;
    this.payload = payload;
  }
}

export class CreateRoomAction extends Action<{
  roomName: string;
  hostName: string;
  settings?: RoomSettings;
}> {
  constructor(roomName: string, hostName: string, settings?: RoomSettings) {
    super(ActionEnum.CREATE_ROOM, { roomName, hostName, settings });
  }
}

export class JoinRoomAction extends Action<{
  roomName: string;
  playerName: string;
  hostName?: string; // Used only on server reply (because I'm lazy)
}> {
  constructor(roomName: string, playerName: string, hostName?: string) {
    super(ActionEnum.JOIN_ROOM, { roomName, playerName, hostName });
  }
}

export class ReconnectAction extends Action<{ playerId: string }> {
  constructor(playerId: string) {
    super(ActionEnum.RECONNECT, { playerId });
  }
}

export class LeaveRoomAction extends Action<{}> {
  constructor() {
    super(ActionEnum.LEAVE_ROOM, {});
  }
}

export class RoomErrorAction extends Action<{
  nameInputMessage?: string;
  roomInputMessage?: string;
}> {
  constructor(nameInputMessage?: string, roomInputMessage?: string) {
    super(ActionEnum.ROOM_ERROR, { nameInputMessage, roomInputMessage });
  }
}

export class HostChangeAction extends Action<{ newHostName: string }> {
  constructor(newHostName: string) {
    super(ActionEnum.HOST_CHANGE, { newHostName });
  }
}

export interface StartGamePayload {
  /** Set only when (re)joining a game in progress: 1-indexed current round */
  currentRound?: number;
  /** Seconds left in the current round */
  timer?: number;
  /** The rejoining player already finished the current round */
  roundDone?: boolean;
  /** Names of players who already finished the current round */
  playersDone?: string[];
  /** The intro video is still playing */
  introPlaying?: boolean;
}

export class StartGameAction extends Action<StartGamePayload> {
  constructor(currentRound?: number, timer?: number, extra: Omit<StartGamePayload, 'currentRound' | 'timer'> = {}) {
    super(ActionEnum.START_GAME, { currentRound, timer, ...extra });
  }
}

export class PlayerListChangeAction extends Action<{ playerList: string[] }> {
  constructor(playerList: string[]) {
    super(ActionEnum.PLAYER_LIST_CHANGE, { playerList });
  }
}

export class UpdateRoomSettingsAction extends Action<{ settings: RoomSettings }> {
  constructor(settings: RoomSettings) {
    super(ActionEnum.UPDATE_ROOM_SETTINGS, { settings });
  }
}

export class RoomSettingsChangeAction extends Action<{ settings: RoomSettings }> {
  constructor(settings: RoomSettings) {
    super(ActionEnum.ROOM_SETTINGS_CHANGE, { settings });
  }
}

// Intro Actions
export class IntroStartAction extends Action<{}> {
  constructor() {
    super(ActionEnum.INTRO_START, {});
  }
}
export class IntroEndAction extends Action<{}> {
  constructor() {
    super(ActionEnum.INTRO_END, {});
  }
}

// Round Actions
export class EndRoundAction extends Action<RoundScoped> {
  constructor(roundNumber?: number) {
    super(ActionEnum.END_ROUND, roundNumber === undefined ? {} : { roundNumber });
  }
}
export class StartRoundAction extends Action<{ timeout: number } & RoundScoped> {
  constructor(timeout: number, roundNumber?: number) {
    super(
      ActionEnum.START_ROUND,
      roundNumber === undefined ? { timeout } : { timeout, roundNumber },
    );
  }
}
export class SendDrawingAction extends Action<{ image: Base64URLString } & RoundScoped> {
  constructor(image: Base64URLString, roundNumber?: number) {
    super(
      ActionEnum.SEND_DRAWING,
      roundNumber === undefined ? { image } : { image, roundNumber },
    );
  }
}
export class SendEOTWAction extends Action<{ eotwId: number }> {
  constructor(eotwId: number) {
    super(ActionEnum.SEND_EOTW, { eotwId });
  }
}
export class SendPresenterChangeAction extends Action<{
  newPresenter: string;
  timeout?: number;
}> {
  constructor(newPresenter: string, timeout?: number) {
    super(ActionEnum.PRESENTER_CHANGE, { newPresenter, timeout });
  }
}
export class SendPresenterStartAction extends Action<{}> {
  constructor() {
    super(ActionEnum.PRESENTER_START, {});
  }
}
export class SendAllBeastsAction extends Action<{
  drawings: { playerName: string; drawing: Base64URLString }[];
}> {
  constructor(drawings: { playerName: string; drawing: Base64URLString }[]) {
    super(ActionEnum.SEND_ALL_BEASTS, { drawings });
  }
}
export class SendPresenterEndAction extends Action<RoundScoped> {
  constructor(roundNumber?: number) {
    super(ActionEnum.PRESENTER_END, roundNumber === undefined ? {} : { roundNumber });
  }
}
export class SendVoteAction extends Action<
  {
    first: string; // player who had the best
    second?: string; // second best (might only be 2 players)
    third?: string; // third best (might only be 3 players)
  } & RoundScoped
> {
  constructor(first: string, second?: string, third?: string, roundNumber?: number) {
    super(ActionEnum.SEND_VOTE, { first, second, third, roundNumber });
  }
}

export class PlayerDoneAction extends Action<{ playerName: string }> {
  constructor(playerName: string) {
    super(ActionEnum.PLAYER_DONE, { playerName });
  }
}

export class SendWinnersAction extends Action<{
  winners: { winner: string; beast: Base64URLString }[];
}> {
  constructor(winners: { winner: string; beast: Base64URLString }[]) {
    super(ActionEnum.SEND_WINNERS, { winners });
  }
}

export class EndGameAction extends Action<{}> {
  constructor() {
    super(ActionEnum.END_GAME, {});
  }
}

export class SessionEndedAction extends Action<{ message: string }> {
  constructor(message: string) {
    super(ActionEnum.SESSION_ENDED, { message });
  }
}

export type AnyRoundAction =
  | EndRoundAction
  | StartRoundAction
  | SendDrawingAction
  | SendEOTWAction
  | SendVoteAction
  | PlayerDoneAction;

// Type for any action
export type AnyAction =
  | CreateRoomAction
  | JoinRoomAction
  | LeaveRoomAction
  | ReconnectAction
  | RoomErrorAction
  | HostChangeAction
  | StartGameAction
  | PlayerListChangeAction
  | UpdateRoomSettingsAction
  | RoomSettingsChangeAction
  | IntroStartAction
  | IntroEndAction
  | SendPresenterChangeAction
  | SendPresenterStartAction
  | SendPresenterEndAction
  | SendAllBeastsAction
  | SendWinnersAction
  | EndGameAction
  | SessionEndedAction
  | AnyRoundAction;

// Actions object for easy import and readability
export const Actions = {
  CreateRoom: CreateRoomAction,
  JoinRoom: JoinRoomAction,
  LeaveRoom: LeaveRoomAction,
  Reconnect: ReconnectAction,
  RoomError: RoomErrorAction,
  HostChange: HostChangeAction,
  StartGame: StartGameAction,
  PlayerListChange: PlayerListChangeAction,
  UpdateRoomSettings: UpdateRoomSettingsAction,
  RoomSettingsChange: RoomSettingsChangeAction,
  IntroStart: IntroStartAction,
  IntroEnd: IntroEndAction,
  EndRound: EndRoundAction,
  StartRound: StartRoundAction,
  SendDrawing: SendDrawingAction,
  PresenterChange: SendPresenterChangeAction,
  PresenterEnd: SendPresenterEndAction,
  PresenterStart: SendPresenterStartAction,
  SendETOW: SendEOTWAction,
  SendVote: SendVoteAction,
  SendBeasts: SendAllBeastsAction,
  PlayerDone: PlayerDoneAction,
  SendWinners: SendWinnersAction,
  EndGame: EndGameAction,
  SessionEnded: SessionEndedAction,
};

interface IWebSocket {
  addEventListener(
    type: string,
    listener: (this: IWebSocket, ev: any) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (this: IWebSocket, ev: any) => void,
  ): void;
  send(data: string): void;
  close(): void;
  removeAllListeners?(): void;
  readyState: number;
}

interface MessageEvent {
  data: any;
}

export class ActionTarget<T extends IWebSocket, E extends MessageEvent> {
  /** Toggle per-message send logging (noisy; disabled in tests/simulations). */
  static logSends = true;
  #ws: T;
  #actionListeners: Record<ActionEnum, ((this: T, ev: E) => void)[]>;

  constructor(ws: T) {
    this.#ws = ws;
    this.#actionListeners = {} as Record<
      ActionEnum,
      ((this: T, ev: E) => void)[]
    >;
  }

  setWebsocket(ws: T) {
    this.#ws = ws;
    // Re-attach all existing listeners to the new websocket
    Object.values(this.#actionListeners).forEach((listeners) => {
      listeners.forEach((listener) => {
        this.addEventListener('message', listener);
      });
    });
  }

  addEventListener(type: string, listener: (this: T, ev: E) => void): void {
    this.#ws.addEventListener(
      type,
      listener as (this: IWebSocket, ev: any) => void,
    );
  }

  removeEventListener(type: string, listener: (this: T, ev: E) => void): void {
    this.#ws.removeEventListener(
      type,
      listener as (this: IWebSocket, ev: any) => void,
    );
  }

  addActionListener<A extends AnyAction>(
    actionType: ActionEnum,
    listener: (action: A) => void,
  ): () => void {
    const actionListener = (ev: E) => {
      const action = ParseAction<A>(ev.data, actionType);
      if (!action) return;
      listener(action);
    };
    this.addEventListener('message', actionListener);
    if (!this.#actionListeners[actionType]) {
      this.#actionListeners[actionType] = [];
    }
    this.#actionListeners[actionType].push(actionListener);

    return () => {
      this.removeEventListener('message', actionListener);
      if (this.#actionListeners[actionType]) {
        this.#actionListeners[actionType] = this.#actionListeners[
          actionType
        ].filter((l) => l !== actionListener);
      }
    };
  }

  removeActionListener(actionType: ActionEnum) {
    const listeners = this.#actionListeners[actionType];
    if (!listeners) return;
    listeners.forEach((listener) => {
      this.removeEventListener('message', listener);
    });
    delete this.#actionListeners[actionType];
  }

  #websocketOpen = 1;
  sendAction(action: object): void {
    const msg = JSON.stringify(action);
    if (this.#ws.readyState === this.#websocketOpen) {
      // Truncate image data for logging
      const logAction = JSON.parse(msg);
      if (
        logAction.type === ActionEnum.SEND_DRAWING &&
        logAction.payload.image
      ) {
        logAction.payload.image = 'image_data';
      } else if (
        logAction.type === ActionEnum.SEND_ALL_BEASTS &&
        logAction.payload.drawings
      ) {
        logAction.payload.drawings = logAction.payload.drawings.map(
          (drawing: { playerName: string; drawing: string }) => ({
            playerName: drawing.playerName,
            drawing: 'image_data',
          }),
        );
      } else if (
        logAction.type === ActionEnum.SEND_WINNERS &&
        logAction.payload.winners
      ) {
        logAction.payload.winners = logAction.payload.winners.map(
          (w: { winner: string; beast: string }) => ({
            winner: w.winner,
            beast: w.beast.length > 10 ? w.beast.substring(0, 10) + '…' : w.beast,
          }),
        );
      }
      if (ActionTarget.logSends) console.log('sent:', JSON.stringify(logAction));
      this.#ws.send(msg);
    } else {
      console.error('WebSocket is not open. Ready state:', this.#ws.readyState, 'Action:', JSON.stringify(action).substring(0, 100));
    }
  }

  destroy() {
    this.#ws.close();
    this.#ws.removeAllListeners?.();
  }
}

export function ParseAction<T extends AnyAction>(
  data: string,
  desiredType?: ActionEnum,
): T | null {
  try {
    // check that data has the structure of an Action
    const parsedAction = JSON.parse(data) as T;
    if (
      !isPlainObject(parsedAction) || // not a plain object
      typeof parsedAction.type !== 'string' || // missing or invalid value for type
      !('payload' in parsedAction) || // missing payload
      !isPlainObject(parsedAction.payload) // payload must be a plain object
    ) {
      console.error('Received non-action: ', parsedAction);
      return null;
    }
    if (desiredType && parsedAction.type !== desiredType) {
      return null;
    }
    return parsedAction;
  } catch (e) {
    console.error('Received non-JSON: ', data);
    return null;
  }
}
