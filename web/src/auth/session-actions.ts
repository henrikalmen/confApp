/**
 * The session action a view may need, supplied by `AuthProvider` rather than reached for.
 *
 * The same shape as `setTokenSource` in the API client and `setCacheIdentity` in the offline
 * store, for the same reason: the attendee panel is rendered directly in a dozen tests with no
 * provider around it, and a `useAuth()` call inside it would make every one of those a sign-in
 * test. This keeps the panel a component that takes a Schedule and renders it.
 *
 * It defaults to doing nothing, so a tree with no auth wired renders exactly as before – which is
 * what a view-level test of the Schedule is actually about.
 */

/**
 * Starts an interactive sign-in – a top-level navigation, so never invoked while offline.
 *
 * **Renewal is deliberately not here.** It is not a thing a view decides: it may fire only once
 * the API has been shown to answer, and `AuthProvider` owns that judgement for the whole app off
 * the API client's credential-missing seam. A view-held renewal seam is exactly what left every
 * non-attendee surface without one.
 */
export type SignInRequest = () => void;

let signIn: SignInRequest = () => {};

export function setSessionActions(actions: { signIn: SignInRequest }): void {
  signIn = actions.signIn;
}

export function requestSignIn(): void {
  signIn();
}
