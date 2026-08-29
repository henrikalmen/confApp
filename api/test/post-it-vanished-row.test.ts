import { describe, expect, it } from 'vitest';
import { createPostItRepository } from '../src/rounds/post-it-repository.ts';
import { fakeDatabase } from './fake-db.ts';

/**
 * What happens when a Post-it is written and is gone before it can be read back.
 *
 * `contribute` and `edit` each write in one statement and hydrate the result in a second, so there
 * is a window between them. Its author removing the Post-it from another device lands in exactly
 * that window - the same person on a phone and a laptop is an ordinary configuration in a room, not
 * an exotic race - and both paths used to `throw new Error(...)`, which the error handler turned
 * into a 500. The contributor was told the API had broken when what actually happened is that they
 * got what they asked for and then undid it.
 *
 * **Driven with a stand-in database rather than against PostgreSQL**, because the window is between
 * two statements and cannot be hit deterministically from outside. What is under test is the
 * *mapping* - which outcome a null hydrate produces - and that is a property of this module, not of
 * the database. The SQL itself is covered against real PostgreSQL in `post-it.integration.test.ts`.
 */
describe('a post-it that vanishes between the write and the read-back', () => {
  const CONFERENCE = '11111111-1111-4111-8111-111111111111';
  const SESSION = '22222222-2222-4222-8222-222222222222';
  const ROUND = '33333333-3333-4333-8333-333333333333';
  const POST_IT = '44444444-4444-4444-8444-444444444444';
  const ADA = 'google-sub-ada';

  /**
   * Answers the write with a row and the read-back with nothing - which is precisely the state a
   * concurrent delete leaves behind. Every other statement answers empty, so nothing else in the
   * module can accidentally satisfy the assertion.
   */
  function writeSucceedsThenRowIsGone() {
    return fakeDatabase((text) => {
      if (/insert into post_it/i.test(text)) return [{ id: POST_IT, round_id: ROUND }];
      if (/^\s*update post_it/im.test(text)) return [{ id: POST_IT }];
      // The hydrate, and anything else: the row is no longer there.
      return [];
    });
  }

  it('answers a contribution with success and nothing to return, never an internal error', async () => {
    const postIts = createPostItRepository(writeSucceedsThenRowIsGone());

    const result = await postIts.contribute(CONFERENCE, SESSION, ROUND, ADA, 'Handover gaps');

    // `gone`, which the route renders as 200 with `postIt: null`. The write happened; there is
    // simply nothing left to show, and nothing went wrong.
    expect(result.outcome).toBe('gone');
  });

  it('answers a correction with "no longer there", never an internal error', async () => {
    const postIts = createPostItRepository(writeSucceedsThenRowIsGone());

    const result = await postIts.edit(CONFERENCE, SESSION, ROUND, POST_IT, ADA, 'Corrected');

    // `missing`, which the route already has the sentence for: the post-it is not where the caller
    // thinks it is, which is exactly what their next read will find.
    expect(result.outcome).toBe('missing');
  });
});
