import type { Conference, LifecycleState } from '../api/client.ts';

/**
 * How a lifecycle state and a date span are shown, in one place so the list and the detail view
 * cannot describe the same conference differently.
 */

const LABELS: Record<LifecycleState, string> = {
  draft: 'Draft',
  published: 'Published',
  archived: 'Archived',
};

/**
 * The state, as a badge.
 *
 * Archived conferences must be distinguished from active ones by more than wording (FR9), so the
 * badge carries its own colour treatment and the surrounding card is restyled too. The text is
 * still there – colour alone would exclude anyone who cannot see the difference.
 */
export function LifecycleBadge({ state }: { state: LifecycleState }): React.JSX.Element {
  return (
    <span className={`badge badge--${state}`} data-testid={`badge-${state}`}>
      {LABELS[state]}
    </span>
  );
}

/**
 * The span, rendered from the naive date strings themselves.
 *
 * Deliberately not `new Date(conference.startDate)`: that parses a bare 'YYYY-MM-DD' as UTC
 * midnight and then renders it in the browser's timezone, so a conference starting on the 14th
 * displays as the 13th for anyone west of UTC. A calendar day has no timezone, so nothing here
 * gives it one.
 */
export function formatSpan(conference: Pick<Conference, 'startDate' | 'endDate'>): string {
  return conference.startDate === conference.endDate
    ? conference.startDate
    : `${conference.startDate} – ${conference.endDate}`;
}
