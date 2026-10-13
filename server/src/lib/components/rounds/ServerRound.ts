import type { Player } from '../Player.js';
import { Game } from '../Game.js';
import {
  ActionEnum,
  AnyRoundAction,
} from '../../../../../shared/actions/index.js';

export abstract class ServerRound {
  game: Game;
  abstract expectedActions: ActionEnum[];
  constructor(game: Game) {
    this.game = game;
  }

  /** Called when the round starts */
  abstract setup(players: Player[]): void;

  /**
   * Called when a player sends a response for this round
   * @returns true if the round should end
   * */
  abstract roundResponseHandler(
    action: AnyRoundAction,
    player: Player,
  ): boolean;

  /** Called when a player reconnects mid-round. Send any round-specific state they need. */
  sendReconnectState(_player: Player): void {}

  /** A player's work-in-progress saved on page unload (drawing rounds only). */
  autosave(_image: string, _player: Player): void {}

  /** Called when the round ends or the game is aborted. Clear any timers here. */
  cleanup(): void {}
}
