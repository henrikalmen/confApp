import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { POLL_INTERVAL_MS, useWatermarkPoll } from '../src/poll/use-watermark-poll.ts';

/**
 * The one watermark-poll loop, and the two views that are call sites of it (S02 TI08).
 *
 * The Structural Criterion is "exactly one implementation, and **both** existing call sites are
 * migrated onto it". This file proves both halves and deliberately pairs them: the file-list
 * assertion below could pass on a repository where the loop had been extracted and then quietly
 * broken, so the behavioural tests exercise the extracted loop's four decisions directly, and
 * `AttendeeScheduleRefresh.test.tsx` (unchanged, S09's own suite) plus `PostItBoard.test.tsx` prove
 * that each of the two views still refreshes through it. A file list is only as good as its longest
 * omission (`docs/LEARNINGS.md#testing`).
 */

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, '..', 'src');

function sourcesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function relative(path: string): string {
  return path.replace(webSrc, '').replace(/\\/g, '/');
}

// ---------- the structural half ----------

describe('the shared watermark poll', () => {
  const sources = sourcesUnder(webSrc).map((path) => ({
    relative: relative(path),
    code: withoutComments(readFileSync(path, 'utf8')),
  }));

  /**
   * **One implementation.** Only one module registers the visibility/focus/online triggers, holds
   * the in-flight flag and owns an interval that polls.
   */
  it('is declared in exactly one module', () => {
    const declaring = sources
      .filter((entry) => /export function useWatermarkPoll/.test(entry.code))
      .map((entry) => entry.relative);
    expect(declaring).toEqual(['/poll/use-watermark-poll.ts']);

    /*
     * `visibilitychange` and `focus` are the poll's alone: nothing else in this application has a
     * reason to act on the view being looked at again. `online` is deliberately **not** in this
     * list - the offline layer's connectivity flag and the terminal-offline retry both listen for
     * it legitimately, and folding them in would make this guard about connectivity rather than
     * about how many poll loops exist.
     */
    const triggers = sources
      .filter((entry) => /addEventListener\(\s*'(visibilitychange|focus)'/.test(entry.code))
      .map((entry) => entry.relative);
    expect(triggers).toEqual(['/poll/use-watermark-poll.ts']);

    /*
     * The overlap latch - the flag that says "a tick is already out" - lives in the loop and
     * nowhere else.
     *
     * Matched as an **exact identifier**, case-sensitive, rather than as a substring: JavaScript
     * identifiers are case-sensitive, and `inFlight` is this loop's own. A compound like
     * `voteInFlight` on the activities panel is a different identifier and a different mechanism -
     * a write guard on a button press, which starts on a tap, ends on a response and schedules
     * nothing. Narrowing rather than dropping, because the property being guarded is still real: a
     * second loop cannot keep a latch under either of these names, and cannot avoid one without
     * also tripping the timer, cadence and listener assertions above.
     */
    const inFlight = sources
      .filter((entry) => /\binFlight\b|pollingRef/.test(entry.code))
      .map((entry) => entry.relative);
    expect(inFlight).toEqual(['/poll/use-watermark-poll.ts']);
  });

  /**
   * **Every call site, and only these.** The attendee Schedule view the loop came from; the Session
   * Activities view, whose own refresh S01 built and this story retired; and the organizer Schedule
   * view, added 2026-08-29 so a co-organizer's change reaches the person composing the schedule
   * (`plan.json#sharedDecisions` → "Near-live propagation: one cursor").
   *
   * **A call site is not a mechanism, and this list growing is not the thing to be afraid of.** What
   * must stay singular is the implementation, and that is asserted above and independently of this:
   * one timer, one cadence constant, one in-flight latch, one visibility/focus/online registration.
   * Those tests are untouched. This one stays an exact list rather than a minimum so that a *fourth*
   * consumer nobody decided on still has to be looked at - which is the property it actually holds.
   */
  it('has exactly the call sites the shared loop is meant to serve', () => {
    const callSites = sources
      .filter(
        (entry) =>
          /useWatermarkPoll\(/.test(entry.code) && entry.relative !== '/poll/use-watermark-poll.ts',
      )
      .map((entry) => entry.relative)
      .sort();
    expect(callSites).toEqual([
      '/activities/SessionActivitiesPanel.tsx',
      '/attendee/AttendeeSchedulePanel.tsx',
      '/schedule/SchedulePanel.tsx',
    ]);
  });

  /** S01's `refreshTick` prop is gone, not left standing beside the shared loop. */
  it('leaves no refresh-tick prop or activity counter behind', () => {
    for (const { relative: path, code } of sources) {
      expect(code, path).not.toMatch(/refreshTick|activityTick/);
    }
  });
});

// ---------- the behavioural half: the four decisions the module owns ----------

describe('the shared poll loop’s behaviour', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  function Probe({
    active,
    poll,
  }: {
    active: boolean;
    poll: (signal: AbortSignal) => Promise<void>;
  }): React.JSX.Element {
    useWatermarkPoll(active, poll);
    return <div data-testid="probe" />;
  }

  it('polls on the shared cadence while active, and not at all while inactive', async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => {});

    const view = render(<Probe active poll={poll} />);
    // One interval at a time, awaited: each poll has to settle before the next tick, which is the
    // in-flight guard doing its job rather than an artefact of the fake clock.
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS);
      });
    }
    expect(poll).toHaveBeenCalledTimes(3);

    view.rerender(<Probe active={false} poll={poll} />);
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    });
    expect(poll).toHaveBeenCalledTimes(3);
  });

  /**
   * At most one request in flight; a tick arriving while one is outstanding is **skipped**, not
   * queued. A slow network must not build a backlog that then arrives all at once.
   */
  it('skips a tick while a poll is still outstanding, and resumes when it settles', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const poll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    render(<Probe active poll={poll} />);
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 4);
    });
    expect(poll).toHaveBeenCalledTimes(1);

    // The outstanding poll's own settlement releases the flag.
    await act(async () => {
      release!();
    });
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
    });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  /** A rejected poll releases the flag too: one failure must not stop the loop forever. */
  it('keeps polling after a poll rejects', async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => {
      throw new Error('offline');
    });

    render(<Probe active poll={poll} />);
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
    });
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
    });
    expect(poll.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * Nothing is asked while the view is not being read, and becoming visible or focused refreshes
   * **immediately** rather than waiting out the next tick.
   */
  it('asks nothing while hidden, and refreshes at once on visibility, focus and online', async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => {});
    render(<Probe active poll={poll} />);

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(poll).toHaveBeenCalledTimes(0);

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    for (const [target, event] of [
      [document, 'visibilitychange'],
      [window, 'focus'],
      [window, 'online'],
    ] as const) {
      const before = poll.mock.calls.length;
      await act(async () => {
        target.dispatchEvent(new Event(event));
      });
      // Immediately, with no timer advanced at all.
      expect(poll.mock.calls.length, event).toBe(before + 1);
    }
  });

  /**
   * The signal is aborted on unmount, and the **in-flight flag is left to the aborted poll's own
   * settlement**. Clearing it from the cleanup could release a flag a newly started poll already
   * holds, which is precisely how the one-in-flight guarantee breaks.
   */
  it('aborts the in-flight poll on unmount', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const poll = vi.fn(async (signal: AbortSignal) => {
      signals.push(signal);
      await new Promise<void>(() => {});
    });

    const view = render(<Probe active poll={poll} />);
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
    });
    expect(signals[0]!.aborted).toBe(false);

    view.unmount();
    expect(signals[0]!.aborted).toBe(true);
  });

  /** A rebuilt callback tears the loop down and aborts what the previous one had in flight. */
  it('aborts the previous callback’s request when the callback identity changes', () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const make = () => async (signal: AbortSignal) => {
      signals.push(signal);
      await new Promise<void>(() => {});
    };

    const view = render(<Probe active poll={make()} />);
    act(() => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS);
    });
    view.rerender(<Probe active poll={make()} />);

    expect(signals[0]!.aborted).toBe(true);
  });
});
