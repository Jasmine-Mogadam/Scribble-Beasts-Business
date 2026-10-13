import { RoundEnum } from '../rounds/index.js';

export type SoundMode = 'separate' | 'shared' | 'none';

export interface RoomSettings {
  /** Allow players to vote for their own beast. Always forced on for 2-player games. */
  allowSelfVote: boolean;
  /**
   * Interludes — video segments between rounds.
   * TODO: implement skip logic in round sequencing
   */
  skipIntro: boolean;
  /**
   * Skip tutorial overlays shown at the start of drawing rounds.
   * TODO: implement tutorial overlay logic in drawing rounds
   */
  skipTutorials: boolean;
  /**
   * How interlude/intro audio should play.
   * - 'separate': each player's device plays audio independently (best for remote play)
   * - 'shared': audio plays through the host's speakers only (best for in-person play)
   * - 'none': no audio plays
   * TODO: implement sound playback logic
   */
  soundMode: SoundMode;
  /** Show captions/subtitles during the intro video. */
  captions: boolean;
  /** Per-round timeout overrides in seconds. Keys are RoundEnum values. 0 = use default. */
  roundTimers: Partial<Record<RoundEnum, number>>;
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  allowSelfVote: false,
  skipIntro: false,
  skipTutorials: false,
  soundMode: 'separate',
  captions: true,
  roundTimers: {},
};

const MAX_ROUND_TIMER_SECONDS = 60 * 60;

/**
 * Coerce untrusted input (client payloads, localStorage) into valid RoomSettings.
 * Unknown keys are dropped and round timers must be finite, positive numbers.
 */
export function normalizeRoomSettings(settings?: Partial<RoomSettings> | null): RoomSettings {
  const source = (settings && typeof settings === 'object' ? settings : {}) as Partial<RoomSettings>;
  const roundTimers: Partial<Record<RoundEnum, number>> = {};
  const rawTimers = source.roundTimers;
  if (rawTimers && typeof rawTimers === 'object') {
    for (const [round, value] of Object.entries(rawTimers)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        roundTimers[round as RoundEnum] = Math.min(Math.round(value), MAX_ROUND_TIMER_SECONDS);
      }
    }
  }
  return {
    allowSelfVote: !!source.allowSelfVote,
    skipIntro: !!source.skipIntro,
    skipTutorials: !!source.skipTutorials,
    soundMode:
      source.soundMode === 'shared' || source.soundMode === 'none'
        ? source.soundMode
        : 'separate',
    captions: source.captions === undefined ? DEFAULT_ROOM_SETTINGS.captions : !!source.captions,
    roundTimers,
  };
}
