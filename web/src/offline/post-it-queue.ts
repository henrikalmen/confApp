import { POST_IT_QUEUE, cacheIdentity, exclusively, transact } from './schedule-cache.ts';

/**
 * Post-its typed with no connection, held on the device until they reach the board.
 *
 * **The second of the two offline capabilities this product has, and the last** (`AGENTS.md`:
 * schedule reads and post-it queueing, nothing else). What is held here is one kind of thing: text
 * somebody typed into a Round the app had *already rendered open* from the server. No Vote is ever
 * held – a ballot stored beside its owner's identity is a link between a Member and their answer,
 * which is forbidden at the storage level wherever the storage is – and no Round lifecycle action,
 * schedule edit, join or leave has a path through here either. There is no merge, no conflict
 * resolution and no general deferred-write mechanism: an item is sent once, and again if that
 * attempt failed, and that is the whole of it.
 *
 * **It is a store in S10's database, not a database of its own** – see `schedule-cache.ts`. The
 * consequences are the point: one upgrade path, one mutual-exclusion chain, and one purge, so a
 * shared tablet that empties the Schedule empties this in the same transaction rather than through
 * a second teardown somebody has to remember to register.
 *
 * **The key carries the `sub`**, exactly as the schedule cache's does – the OIDC subject claim and
 * never an email (`AGENTS.md`). Two employees on one tablet are two disjoint key spaces, and a
 * listing filters on the `sub` half before it returns anything, so no code path can read out an
 * item written under a different identity. With nobody signed in there is no key, and a write is
 * dropped rather than landing under a guessed one.
 *
 * **What decides that an item is held is a request failing**, never `navigator.onLine` – that
 * signal is `true` behind a captive portal and on dead venue wifi (`use-online.ts`). The caller
 * submits first; this module is what happens when the submission could not be delivered.
 */

/**
 * One Post-it waiting on the device.
 *
 * `submissionId` is minted once, when the item is first held, and stored *with* it – so it is
 * identical across every attempt and across a force-quit, rather than regenerated per send. That is
 * what makes an attempt whose response was lost and the retry that follows it one contribution: the
 * API refuses the repeat through a `(round_id, submission_id)` database constraint and answers with
 * the Post-it already stored.
 *
 * `refusal` is the server's own sentence, set only when a send was refused in a way that can never
 * succeed – its Round is gone. It is what brings the text back to its author instead of leaving it
 * retrying forever, and the item stays on the device until they have acted on it.
 *
 * There is deliberately **no author** on this shape. A queued item is sent under whichever
 * credential is signed in when it drains, which is the only safe answer on a shared tablet, and an
 * author copied in here would be a second opinion the API would ignore anyway.
 */
export interface QueuedPostIt {
  submissionId: string;
  conferenceId: string;
  sessionId: string;
  roundId: string;
  text: string;
  /**
   * The device clock when the item was held, used to keep the queue in the order it was typed.
   *
   * An ordering key and nothing else: it is never rendered, never compared with a server value and
   * never turned into a time. Nothing on this device knows what the venue's clock said.
   */
  heldAt: number;
  refusal: string | null;
}

/**
 * A fresh submission identity. A `uuid`, because that is what the API's schema accepts.
 *
 * `crypto.randomUUID` is **undefined outside a secure context**, and this app is smoke-tested over
 * plain `http://` on the venue LAN as a matter of course. A throw here would escape the compose
 * handler before its `catch`, so the submit would do nothing and say nothing - the one outcome the
 * whole story exists to prevent. `getRandomValues` is available in every context, so the fallback
 * builds the same version-4 shape from it rather than reaching for a weaker identifier.
 */
export function mintSubmissionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Version 4 and the RFC 4122 variant, so the value is a uuid the API's schema accepts.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function keyFor(sub: string, submissionId: string): [string, string] {
  return [sub, submissionId];
}

/**
 * Holds one Post-it for later, under the signed-in subject.
 *
 * Resolves `false` when there is nobody signed in or storage refused it – the caller then still has
 * the typed text on screen and has lost nothing, which is the outcome that matters. `put`, so a
 * second hold of the same submission identity replaces rather than duplicates.
 */
export async function holdPostIt(item: Omit<QueuedPostIt, 'refusal'>): Promise<boolean> {
  const sub = cacheIdentity();
  if (sub === null) return false;

  const stored: QueuedPostIt = { ...item, refusal: null };
  const result = await exclusively(() =>
    transact([POST_IT_QUEUE], 'readwrite', (transaction) =>
      transaction.objectStore(POST_IT_QUEUE).put(stored, keyFor(sub, item.submissionId)),
    ),
  );
  return result !== null;
}

/**
 * Everything held for one employee, oldest first.
 *
 * The keys are read and filtered on their `sub` half before any value is fetched, so an item
 * belonging to somebody else cannot be returned even by a caller that asked for everything – the
 * same discipline as `readCachedSchedulesFor`.
 */
export async function listQueuedPostIts(
  sub: string | null = cacheIdentity(),
): Promise<QueuedPostIt[]> {
  if (sub === null) return [];

  const keys = await queuedKeys();
  const mine = keys.filter(
    (key): key is [string, string] =>
      Array.isArray(key) && key.length === 2 && key[0] === sub && typeof key[1] === 'string',
  );

  const items = await Promise.all(
    mine.map((key) =>
      transact<QueuedPostIt | undefined>([POST_IT_QUEUE], 'readonly', (transaction) =>
        transaction.objectStore(POST_IT_QUEUE).get(key),
      ),
    ),
  );

  return items
    .filter((item): item is QueuedPostIt => usable(item))
    .sort((left, right) => left.heldAt - right.heldAt);
}

/**
 * Whether an item can still do the one job it is stored for: be sent.
 *
 * Storage outlives code, so an entry written by an earlier build can be missing a field this one
 * needs. Such an item is treated as absent rather than sent with `undefined` in the payload – the
 * same "a corrupt entry is a miss" rule the schedule cache applies.
 */
function usable(item: QueuedPostIt | null | undefined): item is QueuedPostIt {
  if (item === null || item === undefined) return false;
  return (
    typeof item.submissionId === 'string' &&
    typeof item.conferenceId === 'string' &&
    typeof item.sessionId === 'string' &&
    typeof item.roundId === 'string' &&
    typeof item.text === 'string'
  );
}

/** The item is on the board, or its author has dismissed it. Either way it leaves the device. */
export async function dropQueuedPostIt(
  submissionId: string,
  sub: string | null = cacheIdentity(),
): Promise<void> {
  if (sub === null) return;
  await exclusively(() =>
    transact([POST_IT_QUEUE], 'readwrite', (transaction) =>
      transaction.objectStore(POST_IT_QUEUE).delete(keyFor(sub, submissionId)),
    ),
  );
}

/**
 * Records why an item will never be sent, so its author sees their text and a reason.
 *
 * The item stays. Discarding it on the refusal would be the silent loss FR6 forbids: the text is
 * the thing worth keeping, and it leaves the device when the person who typed it says so.
 */
export async function markQueuedPostItRefused(
  submissionId: string,
  refusal: string,
  sub: string | null = cacheIdentity(),
): Promise<void> {
  if (sub === null) return;
  await exclusively(async () => {
    const key = keyFor(sub, submissionId);
    const item = await transact<QueuedPostIt | undefined>(
      [POST_IT_QUEUE],
      'readonly',
      (transaction) => transaction.objectStore(POST_IT_QUEUE).get(key),
    );
    if (!usable(item)) return;

    await transact([POST_IT_QUEUE], 'readwrite', (transaction) =>
      transaction.objectStore(POST_IT_QUEUE).put({ ...item, refusal }, key),
    );
  });
}

/**
 * Every key in the store, so a test can assert emptiness rather than absence of a rendering.
 *
 * Deliberately **unfiltered**, and only ever used to prove a negative: "nothing of the previous
 * signer's is left anywhere in here" is a statement about the whole store, and a listing narrowed
 * to the caller's own `sub` could not make it. Keys carry no post-it text - reading one out needs
 * `listQueuedPostIts`, which does filter.
 */
export async function queuedKeys(): Promise<IDBValidKey[]> {
  const keys = await transact<IDBValidKey[]>([POST_IT_QUEUE], 'readonly', (transaction) =>
    transaction.objectStore(POST_IT_QUEUE).getAllKeys(),
  );
  return keys ?? [];
}
