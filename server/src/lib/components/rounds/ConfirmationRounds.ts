import {
  ActionEnum,
  AnyRoundAction,
  SendEOTWAction as SendEotwAction,
  SendWinnersAction,
} from '../../../../../shared/actions/index.js';
import {
  EndOfTheWorldRound,
  PlaceholderRound,
  WinnersRound,
} from '../../../../../shared/rounds/index.js';
import { ServerRound } from './ServerRound.js';
import { Player } from '../Player.js';
import { Mixin } from 'ts-mixer';
import { getRandomEotwCard, type EotwCard } from '../../../../../shared/eotw/index.js';

export abstract class ServerConfirmationRound extends ServerRound {
  expectedActions = [ActionEnum.END_ROUND];

  setup(players: Player[]): void {
    // most confirmation rounds don't need setup
  }

  roundResponseHandler(action: AnyRoundAction, player: Player): boolean {
    // most confirmation rounds end immediately upon receiving a response
    return true;
  }
}

export class ServerPlaceholderRound extends Mixin(
  ServerConfirmationRound,
  PlaceholderRound,
) {}

export class ServerEndOfTheWorldRound extends Mixin(
  ServerConfirmationRound,
  EndOfTheWorldRound,
) {
  currentCard: EotwCard | undefined;

  setup(players: Player[]): void {
    this.currentCard = getRandomEotwCard();
    players
      .filter((p) => !p.disconnected)
      .forEach((player) => {
        player.sendAction(new SendEotwAction(this.currentCard!.id));
      });
  }

  sendReconnectState(player: Player): void {
    if (this.currentCard) {
      player.sendAction(new SendEotwAction(this.currentCard.id));
    }
  }
}

export class ServerWinnersRound extends Mixin(
  ServerConfirmationRound,
  WinnersRound,
) {
  winners: { winner: string; beast: string }[] = [];
  setup(players: Player[]): void {
    this.winners = [];
    // slice: never reorder the game's shared player list
    const top3 = players.slice().sort((a, b) => b.score - a.score).slice(0, 3);
    top3.forEach((p) => {
      this.winners.push({ winner: p.name, beast: p.lastUploadedImage });
    });
    const labels = ['First', 'Second', 'Third'];
    this.winners.forEach((w, i) => {
      console.log(
        `${labels[i]} place: ${w.winner} with score ${top3[i].score}`,
      );
    });
    players.forEach((p) => {
      p.sendAction(new SendWinnersAction(this.winners));
    });
  }

  roundResponseHandler(action: AnyRoundAction, player: Player): boolean {
    // only the host can end the game from the winner round
    if (player.isHost) {
      // Force-complete all non-host players so Promise.all resolves
      Object.values(this.game.players).forEach((p) => {
        if (p.id !== player.id) {
          this.game.forceCompletePlayer(p.id);
        }
      });
      this.game.endGame();
      return true;
    }
    return false;
  }

  sendReconnectState(player: Player): void {
    player.sendAction(new SendWinnersAction(this.winners));
  }
}
