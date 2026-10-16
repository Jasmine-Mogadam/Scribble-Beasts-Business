import { render } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import EotwRound from '../lib/components/rounds/EotwRound.svelte';
import { eotwCard } from '../lib/GameState';

vi.mock('../lib/ClientWebsocket', () => ({
  default: {
    sendAction: vi.fn(),
    addActionListener: vi.fn(() => vi.fn()),
    removeActionListener: vi.fn(),
  },
}));

describe('EotwRound', () => {
  it('renders without crashing before the card has arrived (it can lag START_ROUND, e.g. after a reconnect)', () => {
    eotwCard.set(undefined as any);
    expect(() => render(EotwRound)).not.toThrow();
  });

  it('shows the card once it arrives', async () => {
    eotwCard.set(undefined as any);
    const { findByText } = render(EotwRound);
    eotwCard.set({ id: 1, image: '/images/eotw/1.png', description: 'Giant moon' } as any);
    expect(await findByText('Giant moon')).toBeTruthy();
  });
});
