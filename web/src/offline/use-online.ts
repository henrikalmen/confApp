import { useEffect, useState } from 'react';

/**
 * Whether the browser believes it has a connection.
 *
 * **A hint, never a gate on rendering.** `navigator.onLine` reports the link, not reachability: it
 * is `true` behind a captive portal and on dead venue wifi, and it is the single most common way an
 * offline path comes to hang forever waiting for a request that will not arrive. So it is used for
 * exactly two things – disabling a mutating affordance that is certain to fail, and prompting a
 * refresh attempt when the link returns – and for neither of the decisions that matter. What
 * decides whether the Schedule comes from the network or the cache is whether the *request*
 * succeeded (S10 → Constraints & Gotchas).
 *
 * Extracted from `LeaveConferenceControl`, where S08 first needed it, so the join control, the
 * leave control and the schedule refresh all read the same signal rather than three copies of it.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const update = (): void => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return online;
}
