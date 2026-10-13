import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

const sendAction = vi.fn();
vi.mock('../lib/ClientWebsocket', () => ({
  default: {
    sendAction: (a: unknown) => sendAction(a),
    addActionListener: vi.fn(() => vi.fn()),
    removeActionListener: vi.fn(),
  },
}));

import {
  roundStore,
  startNextRound,
  endCurrentRound,
  jumpToRound,
  resetRoundStore,
} from '../lib/stores/roundStore';

describe('roundStore', () => {
  beforeEach(() => {
    sendAction.mockClear();
    resetRoundStore();
  });

  it('START_ROUND with a round number jumps there even if one was missed', () => {
    startNextRound(30, 1);
    startNextRound(30, 3); // missed round 2 while reconnecting
    expect(get(roundStore).number).toBe(2);
  });

  it('a slow end for the previous round cannot end the new round', () => {
    startNextRound(30, 1);
    startNextRound(30, 2);
    endCurrentRound(undefined, 1); // async submit from round 1 resolving late
    expect(get(roundStore).ongoing).toBe(true);
    expect(sendAction).not.toHaveBeenCalled();
  });

  it('sends END_ROUND once per round, stamped with the round number', () => {
    startNextRound(30, 1);
    endCurrentRound();
    endCurrentRound();
    expect(sendAction).toHaveBeenCalledTimes(1);
    expect(sendAction.mock.calls[0][0].payload).toEqual({ roundNumber: 1 });
    expect(get(roundStore).ongoing).toBe(false);
  });

  it('rejoining a round you already finished shows the waiting screen', () => {
    jumpToRound(2, 10, true);
    expect(get(roundStore)).toMatchObject({
      number: 2,
      ongoing: false,
      timeLeft: 10,
    });
    endCurrentRound();
    expect(sendAction).not.toHaveBeenCalled();
  });
});
