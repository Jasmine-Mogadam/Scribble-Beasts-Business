import { initializeRounds } from './rounds/Rounds.js';
import { ServerRound } from './rounds/ServerRound.js';
import { Player } from './Player.js';
import {
  ActionEnum,
  Actions,
  AnyAction,
  AnyRoundAction,
  RoundScoped,
  SendDrawingAction,
} from '../../../../shared/actions/index.js';
import { Round, RoundEnum } from '../../../../shared/rounds/index.js';
import { DEFAULT_ROOM_SETTINGS, type RoomSettings } from '../../../../shared/settings/index.js';

/** Time between the final END_ROUND and the next START_ROUND. */
const BETWEEN_ROUNDS_MS = 300;
/** After the round timer expires, how long clients get to submit their work. */
const GRACE_PERIOD_MS = 2000;
const INTRO_SAFETY_TIMEOUT_MS = 120 * 1000;

export class Game {
  #sendActionToAllPlayers: (action: AnyAction) => void;
  #backToLobby: () => void;
  #playerResolvers: Map<string, (v: boolean) => void> = new Map();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  roundsLeft: ServerRound[];
  currentRound: ServerRound | undefined;
  currentRoundNumber: number = 0;
  currentRoundTimeout: number = 0;
  roundStartTime: number = 0;
  /** True between this round's final END_ROUND and the next START_ROUND */
  betweenRounds = false;
  introPlaying = false;
  ended = false;
  /** Player ids that finished the current round */
  completedPlayers = new Set<string>();
  players: Player[];
  playerDrawings: Record<string, string> = {};
  settings: RoomSettings;
  constructor(
    players: Player[],
    sendActionToAllPlayers: (action: AnyAction) => void,
    backToLobby: () => void,
    settings: RoomSettings = DEFAULT_ROOM_SETTINGS,
  ) {
    this.players = players;
    this.#sendActionToAllPlayers = sendActionToAllPlayers;
    this.#backToLobby = backToLobby;
    this.settings = settings;
    this.roundsLeft = initializeRounds(this);
  }

  /** setTimeout that is cancelled by abort(). */
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(() => {
      this.#timers.delete(handle);
      fn();
    }, ms);
    this.#timers.add(handle);
    return handle;
  }

  clearTimer(handle: ReturnType<typeof setTimeout> | undefined) {
    if (handle === undefined) return;
    clearTimeout(handle);
    this.#timers.delete(handle);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((res) => this.setTimer(res, ms));
  }

  async startGame() {
    if (!this.settings.skipIntro) {
      await this.playIntro();
    }
    if (this.ended) return;
    this.nextRound();
  }

  /**
   * Broadcast INTRO_START and wait for the host to confirm INTRO_END (either
   * because the video finished naturally or the host clicked skip). A safety
   * timeout prevents the game from hanging if the host disconnects mid-intro.
   */
  async playIntro() {
    console.log('[Game] Playing intro, waiting for host INTRO_END');
    this.introPlaying = true;
    this.#sendActionToAllPlayers(new Actions.IntroStart());

    await new Promise<void>((resolve) => {
      let resolved = false;
      const removers: (() => void)[] = [];
      const finish = () => {
        if (resolved) return;
        resolved = true;
        this.introPlaying = false;
        removers.forEach((remove) => remove());
        this.clearTimer(safety);
        resolve();
      };

      const safety = this.setTimer(() => {
        console.log('[Game] Intro safety timeout reached');
        this.#sendActionToAllPlayers(new Actions.IntroEnd());
        finish();
      }, INTRO_SAFETY_TIMEOUT_MS);

      // Accept INTRO_END from whoever is host at the time (host may change on disconnect)
      this.players.forEach((p) =>
        removers.push(
          p.addActionListener(ActionEnum.INTRO_END, () => {
            if (!p.isHost) return;
            console.log(`[Game] INTRO_END received from host ${p.name}`);
            // Tell everyone the intro is over so non-host clients hide it.
            this.#sendActionToAllPlayers(new Actions.IntroEnd());
            finish();
          }),
        ),
      );
    });
  }

  async nextRound() {
    if (this.ended) return;
    this.currentRound = this.roundsLeft.shift();
    this.currentRoundNumber++;

    if (this.currentRound === undefined) {
      return this.endGame();
    }

    const roundBase = this.currentRound as unknown as Round;
    const customTimer = this.settings.roundTimers[roundBase.roundType];
    const baseTimeout =
      customTimer && customTimer > 0 ? customTimer : roundBase.timeout;
    const timeout =
      roundBase.roundType === RoundEnum.PRESENT
        ? baseTimeout * this.players.filter((p) => !p.disconnected).length
        : baseTimeout;

    this.currentRoundTimeout = timeout;
    this.roundStartTime = Date.now();
    this.completedPlayers = new Set();
    this.betweenRounds = false;

    // setup() sends the round's data (starting image, EOTW card, beasts, …) and
    // MUST come before START_ROUND: round components read that data once, when
    // they mount. Round numbers keep any earlier-arriving data from being misapplied.
    this.currentRound.setup(this.players);
    this.#sendActionToAllPlayers(new Actions.StartRound(timeout, this.currentRoundNumber));

    await this.waitForRoundEnd(
      this.currentRound.expectedActions,
      this.currentRound.roundResponseHandler.bind(this.currentRound),
      timeout,
    );
    this.currentRound.cleanup();
    if (this.ended) return;

    this.betweenRounds = true;
    console.log(`[Game] Round ${this.currentRoundNumber} complete. Sending post-wait EndRound. Connected: [${this.connectedNames()}]`);
    this.#sendActionToAllPlayers(new Actions.EndRound(this.currentRoundNumber));
    await this.#sleep(BETWEEN_ROUNDS_MS);

    console.log(`[Game] Advancing to next round. Connected: [${this.connectedNames()}]`);
    this.nextRound();
  }

  connectedNames(): string {
    return this.players
      .filter((p) => !p.disconnected)
      .map((p) => p.name)
      .join(', ');
  }

  /** Round actions stamped with another round's number are stale and must be ignored. */
  #isForCurrentRound(action: AnyRoundAction): boolean {
    const roundNumber = (action.payload as RoundScoped | undefined)?.roundNumber;
    return roundNumber === undefined || roundNumber === this.currentRoundNumber;
  }

  async waitForRoundEnd(
    expectedActions: ActionEnum[],
    roundHandler: (action: AnyRoundAction, player: Player) => boolean,
    timeout: number, // in seconds
  ) {
    const removers: (() => void)[] = [];
    const roundNumber = this.currentRoundNumber;
    const playerPromises = this.players.map(
      (p) =>
        new Promise<boolean>((res) => {
          const complete = () => {
            this.completedPlayers.add(p.id);
            this.#playerResolvers.delete(p.id);
            res(true);
          };
          this.#playerResolvers.set(p.id, complete);
          // player finished early or client timeout
          expectedActions.forEach((actionType) =>
            removers.push(
              p.addActionListener<AnyRoundAction>(actionType, (action) => {
                if (!this.#isForCurrentRound(action)) {
                  console.log(`[Game] Ignoring stale ${action.type} from ${p.name} (round ${(action.payload as RoundScoped).roundNumber}, current ${this.currentRoundNumber})`);
                  return;
                }
                if (this.completedPlayers.has(p.id)) return;
                if (
                  action.type === ActionEnum.SEND_DRAWING &&
                  (action as SendDrawingAction).payload.autosave
                ) {
                  // Tab closing/refreshing: keep their work, don't mark them done
                  this.currentRound?.autosave((action as SendDrawingAction).payload.image, p);
                  return;
                }
                if (action.type === ActionEnum.SEND_DRAWING) {
                  this.playerDrawings[p.id] = (
                    action as SendDrawingAction
                  ).payload.image;
                }
                if (roundHandler(action, p)) {
                  this.players.forEach((other) => {
                    if (other.id !== p.id && !other.disconnected) {
                      other.sendAction(new Actions.PlayerDone(p.name));
                    }
                  });
                  complete();
                }
              }),
            ),
          );
        }),
    );

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const waitForTimeout = new Promise((res) => {
      timeoutHandle = this.setTimer(() => res('timeout'), timeout * 1000);
    });
    const winner = await Promise.race([
      Promise.all(playerPromises),
      waitForTimeout,
    ]);
    this.clearTimer(timeoutHandle);

    // If timeout won, we give players a grace period to respond to our EndRound signal
    if (winner === 'timeout' && !this.ended) {
      console.log(`[Game] Round ${roundNumber} timed out. Sending EndRound to all. Connected: [${this.connectedNames()}]`);
      this.#sendActionToAllPlayers(new Actions.EndRound(roundNumber));

      let graceHandle: ReturnType<typeof setTimeout> | undefined;
      const gracePeriod = new Promise((res) => {
        graceHandle = this.setTimer(() => res('grace_timeout'), GRACE_PERIOD_MS);
      });

      const graceWinner = await Promise.race([Promise.all(playerPromises), gracePeriod]);
      this.clearTimer(graceHandle);
      console.log(`[Game] Round ${roundNumber} grace period ended (${graceWinner === 'grace_timeout' ? 'grace timeout' : 'all responded'})`);
    } else {
      console.log(`[Game] Round ${roundNumber} all players finished before timeout`);
    }

    this.#playerResolvers.clear();
    removers.forEach((remove) => remove());
  }

  forceCompletePlayer(playerId: string): void {
    this.#playerResolvers.get(playerId)?.(true);
  }

  /** Send everything a (re)connecting player needs to resume exactly where the game is. */
  sendReconnectState(player: Player): void {
    if (this.introPlaying || this.currentRoundNumber === 0) {
      player.sendAction(new Actions.StartGame());
      if (this.introPlaying) player.sendAction(new Actions.IntroStart());
      return;
    }
    const playersDone = this.players
      .filter((p) => this.completedPlayers.has(p.id))
      .map((p) => p.name);
    // Round data first, START_GAME last: the round component mounts on
    // START_GAME and reads this data once, so it must already be in the stores.
    const lastDrawing = this.playerDrawings[player.id];
    if (lastDrawing) {
      player.sendAction(new Actions.SendDrawing(lastDrawing));
    }
    this.currentRound?.sendReconnectState(player);
    player.sendAction(
      new Actions.StartGame(this.currentRoundNumber, this.getRemainingTime(), {
        roundDone: this.betweenRounds || this.completedPlayers.has(player.id),
        playersDone,
      }),
    );
  }

  /** Stop all game timers (room destroyed). Pending awaits simply never resume. */
  abort(): void {
    this.ended = true;
    this.currentRound?.cleanup();
    this.#timers.forEach((handle) => clearTimeout(handle));
    this.#timers.clear();
    this.#playerResolvers.forEach((resolve) => resolve(true));
    this.#playerResolvers.clear();
  }

  endGame() {
    if (this.ended) return;
    this.ended = true;
    this.currentRound?.cleanup();
    this.#playerResolvers.forEach((resolve) => resolve(true));
    this.#backToLobby();
  }

  getRemainingTime(): number {
    if (!this.currentRound || this.betweenRounds) return 0;
    const elapsed = (Date.now() - this.roundStartTime) / 1000;
    return Math.max(0, Math.ceil(this.currentRoundTimeout - elapsed));
  }
}
