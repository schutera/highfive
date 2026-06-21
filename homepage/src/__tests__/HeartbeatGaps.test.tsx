import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { HeartbeatGap } from '@highfive/contracts';

import { HeartbeatGaps } from '../components/ModulePanel';

// Pins the #172-opt-3 heartbeat-gaps card against the real HeartbeatGap wire
// shape the backend assembles from duckdb-service's /heartbeats/:id/gaps. The
// silent windows the device itself can't report (power loss / hang / timeout).
// Realistic fixture (the contract under test), not a hand-guessed object —
// CLAUDE.md "Component tests ... must mount with a realistic fixture".

const gaps: HeartbeatGap[] = [
  { gapStart: '2026-06-01T02:00:00', gapEnd: '2026-06-01T06:00:00', gapSeconds: 14400 },
  { gapStart: '2026-06-01T00:00:00', gapEnd: '2026-06-01T01:45:00', gapSeconds: 6300 },
];

describe('HeartbeatGaps', () => {
  it('renders nothing when there are no gaps', () => {
    const { container } = render(<HeartbeatGaps gaps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders each gap with its humanised duration', () => {
    render(<HeartbeatGaps gaps={gaps} />);
    expect(screen.getByText('heartbeat gaps')).toBeInTheDocument();
    expect(screen.getByText('(2)')).toBeInTheDocument();
    // 14400 s -> "4h 0m"; the duration is the load-bearing derived field, not a
    // raw second count collapsed to undefined.
    expect(screen.getByText(/4h 0m gap/)).toBeInTheDocument();
    expect(screen.getByText(/1h 45m gap/)).toBeInTheDocument();
  });
});
