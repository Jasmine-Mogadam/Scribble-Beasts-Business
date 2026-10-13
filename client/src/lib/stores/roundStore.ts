import { get, writable } from 'svelte/store';
import { Actions, type AnyRoundAction } from '@shared/actions';
import ClientWebsocket from '../ClientWebsocket';
import { Round, Rounds } from '@shared/rounds';

export interface RoundState {
  /** 0-indexed position in Rounds (server round number - 1) */
  number: number;
  current: Round;
  ongoing: boolean;
  timeLeft: number;
  /** Seconds the round lasted when this client entered it */
  duration: number;
}

export const roundStore = writable<RoundState>({
  number: -1,
  current: Rounds[0],
  ongoing: true,
  timeLeft: Rounds[0].timeout,
  duration: Rounds[0].timeout,
});

/** The server's 1-indexed number for the round this client is in. */
export function currentServerRound(): number {
  return get(roundStore).number + 1;
}

/** Round numbers this client already sent END_ROUND for. */
let endedRound = -1;

/**
 * Finish the current round locally and tell the server (once per round).
 * @param roundNumber the server round this end belongs to; if the client has
 *   already moved past it (slow async submit), nothing happens.
 */
export function endCurrentRound(action?: AnyRoundAction, roundNumber = currentServerRound()) {
  const state = get(roundStore);
  if (roundNumber !== state.number + 1) {
    console.log(`[roundStore] ignoring endCurrentRound for stale round ${roundNumber} (now ${state.number + 1})`);
    return;
  }
  console.log(
    `[roundStore] endCurrentRound called. ongoing=${state.ongoing}, round=${state.number}`,
  );
  if (state.ongoing) {
    roundStore.update((s) => ({ ...s, ongoing: false }));
  }

  if (action) {
    ClientWebsocket.sendAction(stampRound(action, roundNumber));
  } else if (endedRound !== roundNumber) {
    endedRound = roundNumber;
    ClientWebsocket.sendAction(new Actions.EndRound(roundNumber));
  }
}

/** Attach the server round number to a round-scoped action. */
export function stampRound<T extends { payload: object }>(action: T, roundNumber = currentServerRound()): T {
  return { ...action, payload: { ...action.payload, roundNumber } };
}

/**
 * Enter a new round. When the server provides the round number we jump straight
 * to it, so a client that missed a START_ROUND can never drift onto the wrong round.
 */
export function startNextRound(timeout: number, roundNumber?: number) {
  const prev = get(roundStore);
  const index = roundNumber !== undefined ? roundNumber - 1 : prev.number + 1;
  console.log(`[roundStore] startNextRound. prev=${prev.number}, now=${index}, timeout=${timeout}`);
  roundStore.set({
    ongoing: true,
    number: index,
    current: Rounds[index] || prev.current,
    timeLeft: timeout,
    duration: timeout,
  });
}

export function resetRoundStore() {
  endedRound = -1;
  roundStore.set({
    number: -1,
    current: Rounds[0],
    ongoing: false,
    timeLeft: Rounds[0].timeout,
    duration: Rounds[0].timeout,
  });
}

/** Rejoin a round in progress (reconnect / refresh). */
export function jumpToRound(roundNumber: number, timeout: number, done = false) {
  console.log(`[roundStore] jumpToRound called. roundNumber=${roundNumber}, timeout=${timeout}, done=${done}`);
  roundStore.update((state) => {
    let current = Rounds[roundNumber];
    let actualRoundNumber = roundNumber;

    if (!current) {
      if (roundNumber < 0) {
        // set to first round
        current = Rounds[0];
        actualRoundNumber = 0;
      } else {
        // set to last round
        current = Rounds[Rounds.length - 1];
        actualRoundNumber = Rounds.length - 1;
      }
      console.log(
        `Round ${roundNumber} is out of bounds. Jumping to round ${actualRoundNumber}.`
      );
    }

    // Same round still running locally (network blip): keep the component
    // mounted so in-progress work (canvas strokes) is not thrown away.
    const sameRound = state.number === actualRoundNumber;
    return {
      ...state,
      ongoing: !done,
      number: actualRoundNumber,
      current,
      timeLeft: timeout,
      duration: sameRound ? state.duration : timeout,
    };
  });
  if (done) endedRound = actualServerRound(roundNumber);
}

function actualServerRound(index: number) {
  return Math.min(Math.max(index, 0), Rounds.length - 1) + 1;
}
