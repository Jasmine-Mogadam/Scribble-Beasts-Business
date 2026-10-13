import { Room, defaultRoomContext, type RoomContext } from '../components/Room.js';
import {
  Actions,
  ActionEnum,
  CreateRoomAction,
  JoinRoomAction,
  ParseAction,
  type AnyAction,
} from '../../../../shared/actions/index.js';
import { Player, Host } from '../components/Player.js';
import { getHostRoomSettings } from '../components/HostRoomSettings.js';
import { normalizeRoomSettings } from '../../../../shared/settings/index.js';
import {
  normalizePlayerName,
  normalizeRoomName,
} from '../../../../shared/inputValidation.js';
import type { GameSocket } from '../net/GameSocket.js';

function send(ws: GameSocket, action: object) {
  try {
    ws.send(JSON.stringify(action));
  } catch (err) {
    console.error('Failed to send to roomless socket:', err);
  }
}

export function handleRoomless(
  ws: GameSocket,
  context: RoomContext = defaultRoomContext,
) {
  ws.addEventListener('message', function message(ev: { data: unknown }) {
    const action = ParseAction<AnyAction>(String(ev.data));
    if (!action) return;

    switch (action.type) {
      case ActionEnum.CREATE_ROOM:
        createRoom(action as CreateRoomAction, ws, context);
        break;

      case ActionEnum.JOIN_ROOM:
        joinRoom(action as JoinRoomAction, ws, context);
        break;

      case ActionEnum.RECONNECT:
        // Reconnect was already attempted at connection time via query param.
        // If we're here, the player wasn't found — silently ignore.
        break;

      case ActionEnum.LEAVE_ROOM:
        // Harmless: client is already out of any room
        break;

      default:
        console.warn(
          'Unexpected action type while user is not in room: ',
          action.type,
        );
        break;
    }
  });
}

/**
 * Entry point for every new socket.
 * @param playerId the client's saved session id (from the `playerId` query param), if any
 */
export function handleNewConnection(
  ws: GameSocket,
  playerId: string | undefined,
  context: RoomContext = defaultRoomContext,
) {
  if (playerId) {
    const result = findGlobalPlayer(playerId, context);
    if (result) {
      const { player, room } = result;
      player.reconnect(ws, room);
      console.log(`Player ${player.name} reconnected.`);
      return;
    }
    // The client thinks it is in a game that no longer exists (room destroyed,
    // player timed out, server restarted). Tell it, so it doesn't sit on a dead
    // game screen forever.
    send(ws, new Actions.SessionEnded('That game has ended. Join or create a new room.'));
  }

  console.log('New WebSocket connection');
  handleRoomless(ws, context);
}

/** Parse `/api/room/<name>?playerId=…` (or legacy `/?playerId=…`). */
export function parseConnectionUrl(url: string): {
  roomName?: string;
  playerId?: string;
} {
  const parsed = new URL(url, 'http://localhost');
  const match = parsed.pathname.match(/\/room\/([^/]+)\/?$/);
  let roomName: string | undefined;
  if (match) {
    try {
      roomName = normalizeRoomName(decodeURIComponent(match[1])) || undefined;
    } catch {
      roomName = undefined;
    }
  }
  const playerId = parsed.searchParams.get('playerId') || undefined;
  return { roomName, playerId };
}

function roomMismatch(roomName: string, context: RoomContext): boolean {
  return !!context.expectedRoomName && context.expectedRoomName !== roomName;
}

function createRoom(action: CreateRoomAction, ws: GameSocket, context: RoomContext) {
  const normalizedRoomName = normalizeRoomName(action.payload.roomName);
  const normalizedHostName = normalizePlayerName(action.payload.hostName);
  const { settings } = action.payload;

  let { roomInputMessage, nameInputMessage } = checkIfParamsAreEmpty(
    normalizedRoomName,
    normalizedHostName,
  );

  if (roomInputMessage || nameInputMessage) {
    send(ws, new Actions.RoomError(nameInputMessage, roomInputMessage));
    return;
  }

  if (roomMismatch(normalizedRoomName, context)) {
    send(ws, new Actions.RoomError(undefined, 'Connected to the wrong room. Refresh and try again.'));
    return;
  }

  if (context.rooms[normalizedRoomName]) {
    send(ws, new Actions.RoomError(nameInputMessage, 'Room name already taken.'));
    return;
  }

  const host = new Host(normalizedHostName, ws);
  const settingsFromHostHistory = getHostRoomSettings(normalizedHostName);
  const initialSettings = normalizeRoomSettings(
    settings ?? settingsFromHostHistory,
  );
  const newRoom = new Room(normalizedRoomName, host, initialSettings, context);
  context.rooms[normalizedRoomName] = newRoom;
  host.sendAction(new Actions.CreateRoom(normalizedRoomName, normalizedHostName));
  host.sendAction(new Actions.Reconnect(host.id));
  console.log(`Room ${normalizedRoomName} created with host ${normalizedHostName}`);
}

function joinRoom(action: JoinRoomAction, ws: GameSocket, context: RoomContext) {
  const normalizedRoomName = normalizeRoomName(action.payload.roomName);
  const normalizedPlayerName = normalizePlayerName(action.payload.playerName);

  let { roomInputMessage, nameInputMessage } = checkIfParamsAreEmpty(
    normalizedRoomName,
    normalizedPlayerName,
  );

  if (roomInputMessage || nameInputMessage) {
    send(ws, new Actions.RoomError(nameInputMessage, roomInputMessage));
    return;
  }

  if (roomMismatch(normalizedRoomName, context)) {
    send(ws, new Actions.RoomError(undefined, 'Connected to the wrong room. Refresh and try again.'));
    return;
  }

  const room = context.rooms[normalizedRoomName];
  if (!room) {
    send(ws, new Actions.RoomError(undefined, 'Room does not exist.'));
    return;
  }

  const existing = room.findPlayerByName(normalizedPlayerName);
  if (existing?.disconnected) {
    // Someone lost their tab/session (closed browser, new device) and is
    // rejoining under the same name: give them their seat back — mid-game
    // included — instead of locking them out.
    existing.reconnect(ws, room);
    existing.sendAction(new Actions.Reconnect(existing.id));
    console.log(`Player ${normalizedPlayerName} rejoined room ${normalizedRoomName} by name`);
    return;
  }

  if (room.game) {
    roomInputMessage = 'Game already started.';
  } else if (existing) {
    nameInputMessage = 'Name already taken in this room.';
  }

  if (nameInputMessage || roomInputMessage) {
    send(ws, new Actions.RoomError(nameInputMessage, roomInputMessage));
    return;
  }

  const player = new Player(normalizedPlayerName, ws);
  room.addPlayer(player);
  player.sendAction(
    new Actions.JoinRoom(normalizedRoomName, normalizedPlayerName, room.host.name),
  );
  player.sendAction(new Actions.Reconnect(player.id));
  console.log(`Player ${normalizedPlayerName} joined room ${normalizedRoomName}`);
}

function checkIfParamsAreEmpty(
  roomName: string,
  playerName: string,
): { roomInputMessage?: string; nameInputMessage?: string } {
  let nameInputMessage: string | undefined;
  let roomInputMessage: string | undefined;

  if (!playerName?.trim()) {
    nameInputMessage = 'Name cannot be empty.';
  }
  if (!roomName?.trim()) {
    roomInputMessage = 'Room name cannot be empty.';
  }

  return { roomInputMessage, nameInputMessage };
}

function findGlobalPlayer(
  playerId: string,
  context: RoomContext,
): { player: Player; room: Room } | undefined {
  for (const room of Object.values(context.rooms)) {
    const player = room.findPlayerById(playerId);
    if (player) {
      return { player, room };
    }
  }
  return undefined;
}
