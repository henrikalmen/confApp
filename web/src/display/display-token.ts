/**
 * The token, read out of the path the projector was given.
 *
 * `/display/<token>` – a **path segment**, never a query parameter. A `Response` keeps its own URL
 * and a navigate-mode service-worker branch caches the query string, which is how the OIDC `?code=`
 * once reached Cache Storage (`docs/LEARNINGS.md#service-workers--cache-storage`); a bearer
 * credential in a query string is the same defect with a longer life, and query strings are also
 * where credentials habitually end up in access logs and referrer headers.
 *
 * No shape check happens here, on purpose, and none happens on the API side either. A value that
 * could not be a token has to reach the same neutral refusal as a real-but-dead one: anything that
 * told those two apart would be an oracle over confApp's data, handed to a browser holding no
 * credential (`api/src/routes/display.ts`). The only value this function refuses is *no value at
 * all*, which is not a guess about a token - it is a URL that names none.
 */
export function displayTokenFrom(pathname: string): string | null {
  const match = /^\/display\/([^/?#]+)\/?$/.exec(pathname);
  const raw = match?.[1];
  if (raw === undefined || raw === '') return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // A path that is not valid percent-encoding is not a token; it is also not worth a distinct
    // message, so it joins the single "this board is not available" answer.
    return null;
  }
}
