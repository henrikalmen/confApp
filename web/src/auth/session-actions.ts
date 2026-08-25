/**
 * The two session actions a view may need, supplied by `AuthProvider` rather than reached for.
 *
 * The same shape as `setTokenSource` in the API client and `setCacheIdentity` in the offline
 * store, for the same reason: the attendee panel is rendered directly in a dozen tests with no
 * provider around it, and a `useAuth()` call inside it would make every one of those a sign-in
 * test. This keeps the panel a component that takes a Schedule and renders it.
 *
 * Both default to doing nothing, so a tree with no auth wired renders exactly as before – which
 * is what a view-level test of the Schedule is actually about.
 */

/** Starts DR04's silent renewal. Invoked only where the API has just been shown to answer. */
export type RenewalRequest = () => Promise<void> | void;
/** Starts an interactive sign-in – a top-level navigation, so never invoked while offline. */
export type SignInRequest = () => void;

let renewal: RenewalRequest = () => {};
let signIn: SignInRequest = () => {};

export function setSessionActions(actions: { renew: RenewalRequest; signIn: SignInRequest }): void {
  renewal = actions.renew;
  signIn = actions.signIn;
}

export async function requestRenewal(): Promise<void> {
  await renewal();
}

export function requestSignIn(): void {
  signIn();
}
