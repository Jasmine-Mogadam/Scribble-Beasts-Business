import {
  ActionEnum,
  AnyRoundAction,
  SendDrawingAction,
  SendPresenterChangeAction,
} from '../../../../../shared/actions/index.js';
import { PresentRound } from '../../../../../shared/rounds/index.js';
import { ServerRound } from './ServerRound.js';
import { Mixin } from 'ts-mixer';
import { Player } from '../Player.js';
import { randomInt } from 'crypto';
import { RoundEnum } from '../../../../../shared/rounds/index.js';

export class ServerPresentRound extends Mixin(ServerRound, PresentRound) {
  expectedActions = [
    ActionEnum.PRESENTER_CHANGE,
    ActionEnum.PRESENTER_START,
    ActionEnum.PRESENTER_END,
    ActionEnum.SEND_DRAWING,
  ];
  presenters: Player[] = [];
  players: Player[] = [];
  currentPresenter: Player | undefined;
  presenterTimeoutSeconds = 0;
  presenterTimer: ReturnType<typeof setTimeout> | undefined;
  presenterStartedAt = 0;
  disconnectedPresenterWatcher: ReturnType<typeof setInterval> | undefined;

  cleanup(): void {
    this.#cleanupTimers();
  }

  #cleanupTimers() {
    if (this.presenterTimer) {
      clearTimeout(this.presenterTimer);
      this.presenterTimer = undefined;
    }
    if (this.disconnectedPresenterWatcher) {
      clearInterval(this.disconnectedPresenterWatcher);
      this.disconnectedPresenterWatcher = undefined;
    }
  }

  #currentConnectedPresenters(): Player[] {
    return this.presenters.filter((p) => !p.disconnected);
  }

  #choosePresenter(presenters: Player[]): Player {
    return presenters[randomInt(0, presenters.length)];
  }

  #broadcastPresenterChange(presenter: Player) {
    this.players.forEach((p) => {
      p.sendAction(
        new SendPresenterChangeAction(presenter.name, this.presenterTimeoutSeconds),
      );
      p.sendAction(new SendDrawingAction(presenter.lastUploadedImage));
    });
  }

  #startPresenter(presenter: Player) {
    this.currentPresenter = presenter;
    this.presenterStartedAt = Date.now();
    this.#broadcastPresenterChange(presenter);
    if (this.presenterTimer) {
      clearTimeout(this.presenterTimer);
    }
    this.presenterTimer = setTimeout(() => {
      // If this presenter timed out, move on.
      this.#advanceFromPresenter(presenter);
    }, this.presenterTimeoutSeconds * 1000);
  }

  #finishRound() {
    this.#cleanupTimers();
    this.players.forEach((p) => this.game.forceCompletePlayer(p.id));
  }

  #advanceFromPresenter(presenter: Player): boolean {
    // Ignore stale timer/action callbacks from previous presenters.
    if (!this.currentPresenter || this.currentPresenter.id !== presenter.id) {
      return false;
    }

    this.presenters = this.presenters.filter((p) => p.id !== presenter.id);
    const nextPresenters = this.#currentConnectedPresenters();

    if (nextPresenters.length === 0) {
      this.#finishRound();
      return true;
    }

    const nextPresenter = this.#choosePresenter(nextPresenters);
    this.#startPresenter(nextPresenter);
    return false;
  }

  setup(players: Player[]): void {
    // unchanging list of all players
    this.players = players.slice();
    // this list will change
    this.presenters = players.slice();
    const customPresenterTimeout =
      this.game.settings.roundTimers[RoundEnum.PRESENT];
    this.presenterTimeoutSeconds =
      customPresenterTimeout && customPresenterTimeout > 0
        ? customPresenterTimeout
        : this.timeout;

    const connectedPresenters = this.#currentConnectedPresenters();
    if (connectedPresenters.length === 0) {
      this.#finishRound();
      return;
    }

    this.#startPresenter(this.#choosePresenter(connectedPresenters));

    // If the active presenter disconnects mid-turn, skip them immediately.
    this.disconnectedPresenterWatcher = setInterval(() => {
      if (this.currentPresenter?.disconnected) {
        this.#advanceFromPresenter(this.currentPresenter);
      }
    }, 250);
  }

  roundResponseHandler(action: AnyRoundAction, player: Player): boolean {
    if (action.type !== ActionEnum.PRESENTER_END) {
      return false;
    }

    // Only the active connected presenter can end their presentation.
    if (
      !this.currentPresenter ||
      this.currentPresenter.id !== player.id ||
      player.disconnected
    ) {
      return false;
    }

    return this.#advanceFromPresenter(player);
  }

  sendReconnectState(player: Player): void {
    if (this.currentPresenter) {
      const elapsed = (Date.now() - this.presenterStartedAt) / 1000;
      const remaining = Math.max(0, Math.ceil(this.presenterTimeoutSeconds - elapsed));
      player.sendAction(
        new SendPresenterChangeAction(this.currentPresenter.name, remaining),
      );
      player.sendAction(new SendDrawingAction(this.currentPresenter.lastUploadedImage));
    }
  }
}
