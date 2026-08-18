import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthenticatedCaller, WithAuth } from '../auth/with-auth.ts';
import type { UserRepository } from '../auth/users.ts';
import { AppError, ERROR_CODES } from '../errors.ts';
import type { ConferenceAuthorization } from '../conferences/authorization.ts';
import type { Conference, ConferenceRepository } from '../conferences/conference-repository.ts';
import type {
  ConferenceMember,
  GrantableRole,
  RoleRepository,
} from '../conferences/role-repository.ts';
import { GRANTABLE_ROLES } from '../conferences/role-repository.ts';
import type { MembershipRepository } from '../conferences/membership-repository.ts';
import { assertEditable } from '../conferences/lifecycle.ts';
import type { SessionRepository } from '../sessions/session-repository.ts';

/**
 * The Admin's member-and-roles surface: who is in this Conference, what they may do, and which
 * Sessions the Presenters/Facilitators cover.
 *
 * Every endpoint here runs the same steps in the same order, and the order is the point:
 *
 *   1. `withAuth` resolves the caller (S02);
 *   2. `requireConferenceRole(..., 'Admin')` – the canonical check, never an inline comparison.
 *      Managing roles is conference-wide authority, so a Presenter/Facilitator is refused here for
 *      their own conference exactly as an Attendee is (Acceptance Scenario S03);
 *   3. the archived guard, through S03's exported `assertEditable` rather than a re-derived
 *      lifecycle comparison – archiving makes a Conference read-only, and that includes its roles;
 *   4. the target is resolved to a `sub`, and only then is anything written.
 *
 * The last-Admin rule is deliberately *not* in that list. It cannot be a step here, because a check
 * in a handler and a delete in a repository are two round trips with nothing holding between them –
 * two Admins revoking each other simultaneously would both pass it. It lives inside the revoking
 * transaction, under the Conference row lock (`role-repository.ts`).
 *
 * Two of the endpoints below end a Membership rather than a role (S08): the caller's own, and a
 * named member's. They run the same steps in the same order as the rest – the leave endpoint asks
 * the canonical check for the lowest rank there is, because its subject is the caller themselves –
 * and both then hand the whole write to one revocation operation (`membership-repository.ts`).
 * Nothing is evicted: authority is re-derived from Membership on every request, so a revoked member
 * is refused at their next one with no session invalidation, push or connection teardown anywhere.
 *
 * Nothing is remembered between requests – no roster, no resolved target, no permission cache. The
 * API runs as several container replicas with no request affinity (ADR-004).
 */

export interface MemberRouteDependencies {
  withAuth: WithAuth;
  conferences: ConferenceRepository;
  sessions: SessionRepository;
  roles: RoleRepository;
  /** The one revocation path, shared by leaving and by being removed (S08). */
  membership: MembershipRepository;
  users: UserRepository;
  authorization: ConferenceAuthorization;
}

const conferenceParamsSchema = {
  type: 'object',
  required: ['conferenceId'],
  properties: { conferenceId: { type: 'string', format: 'uuid' } },
} as const;

/**
 * The grantable roles, as the wire accepts them.
 *
 * Two values, not three: Attendee is not grantable because it is not a grant – it *is* Membership,
 * written by joining (`docs/UBIQUITOUS_LANGUAGE.md`). And there is no `Presenter` or `Facilitator`
 * here, because there is one role for both: the enum is the wire-format half of that guarantee,
 * beside the database check constraint and the TypeScript union.
 */
const roleSchema = { type: 'string', enum: [...GRANTABLE_ROLES] } as const;

const grantBodySchema = {
  type: 'object',
  required: ['email', 'role'],
  additionalProperties: false,
  properties: {
    // The address is a *lookup input*, resolved to a `sub` before anything is written. `maxLength`
    // is not a validation of the address: it stops a caller making the server scan a megabyte.
    email: { type: 'string', minLength: 1, maxLength: 320 },
    role: roleSchema,
  },
} as const;

const revokeParamsSchema = {
  type: 'object',
  required: ['conferenceId', 'userSub', 'role'],
  properties: {
    conferenceId: { type: 'string', format: 'uuid' },
    userSub: { type: 'string', minLength: 1 },
    role: roleSchema,
  },
} as const;

/** A named member of a Conference. The target is a `sub`, never an address (ADR-002). */
const memberParamsSchema = {
  type: 'object',
  required: ['conferenceId', 'userSub'],
  properties: {
    conferenceId: { type: 'string', format: 'uuid' },
    userSub: { type: 'string', minLength: 1 },
  },
} as const;

const assignParamsSchema = {
  type: 'object',
  required: ['conferenceId', 'sessionId'],
  properties: {
    conferenceId: { type: 'string', format: 'uuid' },
    sessionId: { type: 'string', format: 'uuid' },
  },
} as const;

const unassignParamsSchema = {
  type: 'object',
  required: ['conferenceId', 'sessionId', 'userSub'],
  properties: {
    conferenceId: { type: 'string', format: 'uuid' },
    sessionId: { type: 'string', format: 'uuid' },
    userSub: { type: 'string', minLength: 1 },
  },
} as const;

const assignBodySchema = {
  type: 'object',
  required: ['userSub'],
  additionalProperties: false,
  // The target of an assignment is picked from the member list, so it arrives as the `sub` that
  // list carries. There is no email path here: the address is only ever needed where somebody is
  // being named who is not on screen yet, which is the grant.
  properties: { userSub: { type: 'string', minLength: 1 } },
} as const;

interface ConferenceParams {
  conferenceId: string;
}

interface MemberParams extends ConferenceParams {
  userSub: string;
}

interface RevokeParams extends MemberParams {
  role: GrantableRole;
}

interface AssignParams extends ConferenceParams {
  sessionId: string;
}

interface UnassignParams extends AssignParams {
  userSub: string;
}

interface GrantBody {
  email: string;
  role: GrantableRole;
}

function targetNotSignedIn(email: string): AppError {
  return new AppError(
    ERROR_CODES.ROLE_TARGET_NOT_SIGNED_IN,
    409,
    `Nobody has signed in to confApp as ${email} yet. Ask them to sign in once with their ` +
      'company Google account, then assign the role.',
  );
}

/**
 * The address names more than one confApp user, so no single `sub` can be resolved.
 *
 * Reachable because an address that is freed and reissued belongs to two different people and both
 * keep their row (`app_user` carries no unique index on email, deliberately). Refused rather than
 * resolved by picking one, because the row picked would be a guess and the assignment is keyed on
 * the `sub` that guess produced.
 */
function targetAmbiguous(email: string): AppError {
  return new AppError(
    ERROR_CODES.ROLE_TARGET_AMBIGUOUS,
    409,
    `More than one confApp account currently uses ${email}, so it does not identify one person. ` +
      'Pick them from the member list instead.',
  );
}

function targetNotAMember(email: string): AppError {
  return new AppError(
    ERROR_CODES.ROLE_TARGET_NOT_A_MEMBER,
    409,
    `${email} has not joined this conference, so there is no role to give them here. ` +
      'Share the join code with them first.',
  );
}

export function registerMemberRoutes(
  app: FastifyInstance,
  {
    withAuth,
    conferences,
    sessions,
    roles,
    membership,
    users,
    authorization,
  }: MemberRouteDependencies,
): void {
  /**
   * Loads a Conference the caller has already been authorized to administer.
   *
   * Authorization runs *first*, so this refuses only where an Admin's Conference has since been
   * removed. A caller with no role never reaches it – they were refused by the check without
   * learning whether the id exists at all, let alone who is in it.
   */
  async function loadAdministered(
    request: FastifyRequest,
    caller: AuthenticatedCaller,
  ): Promise<Conference> {
    const { conferenceId } = request.params as ConferenceParams;
    await authorization.requireConferenceRole(caller, conferenceId, 'Admin');

    const conference = await conferences.findById(conferenceId);
    if (conference === null) {
      throw new AppError(
        ERROR_CODES.CONFERENCE_NOT_FOUND,
        404,
        'That conference no longer exists.',
      );
    }
    return conference;
  }

  /** A role change: authorized, and refused outright on an archived Conference. */
  async function loadChangeable(
    request: FastifyRequest,
    caller: AuthenticatedCaller,
  ): Promise<Conference> {
    const conference = await loadAdministered(request, caller);
    // S03's exported guard, not a re-derivation of what "archived" means here, so archived
    // semantics stay in one place across the lifecycle, the schedule and the roles.
    assertEditable(conference);
    return conference;
  }

  /**
   * Loads a Conference the caller is *in*, for the one endpoint whose subject is the caller
   * themselves rather than somebody they administer.
   *
   * The check is the same canonical one every other endpoint here uses, asking for the lowest rank
   * there is – which Membership itself satisfies, since Attendee *is* Membership. A caller who has
   * not joined is refused by it without learning whether the id names a real Conference, exactly as
   * they are everywhere else in this module. There is no inline comparison and no second seam.
   */
  async function loadJoined(
    request: FastifyRequest,
    caller: AuthenticatedCaller,
  ): Promise<Conference> {
    const { conferenceId } = request.params as ConferenceParams;
    await authorization.requireConferenceRole(caller, conferenceId, 'Attendee');

    const conference = await conferences.findById(conferenceId);
    if (conference === null) {
      throw new AppError(
        ERROR_CODES.CONFERENCE_NOT_FOUND,
        404,
        'That conference no longer exists.',
      );
    }
    return conference;
  }

  /**
   * The whole roster in one payload: every member with their roles and Sessions, and every Session
   * with its holders.
   *
   * Both directions from one read, because the surface needs both and they are the same three rows
   * seen from either end. A Session's holders are inverted from the members rather than queried
   * again, so the two halves cannot disagree with each other.
   */
  async function roster(conference: Conference): Promise<Record<string, unknown>> {
    const members = await roles.listMembers(conference.id);
    const schedule = await sessions.listForConference(conference.id);

    const holders = new Map<string, string[]>();
    for (const member of members) {
      for (const sessionId of member.sessionIds) {
        holders.set(sessionId, [...(holders.get(sessionId) ?? []), member.sub]);
      }
    }

    return {
      conferenceId: conference.id,
      lifecycleState: conference.lifecycleState,
      members: members.map((member: ConferenceMember) => ({
        sub: member.sub,
        displayName: member.displayName,
        email: member.email,
        roles: member.roles,
        sessionIds: member.sessionIds,
      })),
      sessions: schedule.map((session) => ({
        id: session.id,
        title: session.title,
        kind: session.kind,
        day: session.day,
        startTime: session.startTime,
        endTime: session.endTime,
        // Zero is a valid answer and stays valid: a Session needs no holder to be published, and
        // one may be assigned at any point during the Conference (S07 → owner decision).
        holders: holders.get(session.id) ?? [],
      })),
    };
  }

  /**
   * The member list, derived from Membership.
   *
   * It therefore contains the Conference's creator from the moment it exists – S03 seeds their
   * Membership alongside their Admin grant – so they are a grant, assignment and revocation target
   * like anybody else, with no special case anywhere in this module.
   *
   * Readable while archived. Archiving makes a Conference read-only, not invisible (FR9), and an
   * Admin still needs to see who ran what.
   */
  app.get('/api/conferences/:conferenceId/members', {
    schema: { params: conferenceParamsSchema },
    handler: withAuth(async (request, caller) => roster(await loadAdministered(request, caller))),
  });

  /**
   * Granting Admin or Presenter/Facilitator to a member of this Conference.
   *
   * The target is typed as an address and resolved to a `sub` here; what is stored, compared and
   * returned is the `sub`. The address is not written anywhere, which is what makes a later email
   * change a non-event for the assignment (Acceptance Scenario S07).
   *
   * The three ways this is refused are three different situations for the Admin, so they carry
   * three different codes: wait for them to sign in, pick somebody else, or share the join code.
   */
  app.post('/api/conferences/:conferenceId/members/roles', {
    schema: { params: conferenceParamsSchema, body: grantBodySchema },
    handler: withAuth(async (request, caller) => {
      const conference = await loadChangeable(request, caller);
      const { email, role } = request.body as GrantBody;

      const matches = await users.findByEmail(email);
      if (matches.length === 0) throw targetNotSignedIn(email);
      if (matches.length > 1) throw targetAmbiguous(email);

      const target = matches[0]!;
      if (!(await roles.isMember(conference.id, target.sub))) throw targetNotAMember(email);

      await roles.grant(conference.id, target.sub, role);
      return roster(conference);
    }),
  });

  /**
   * Revoking a role, identified by the `sub` the member list carries.
   *
   * No address is accepted here, and that is not an oversight: revocation always acts on somebody
   * already on screen, so routing it through an address would reintroduce the ambiguity the grant
   * has to handle for no benefit at all.
   *
   * Self-demotion is not a special case. An Admin removing their own Admin role is the same
   * operation as removing anybody's, and is refused by the same last-Admin rule when they are the
   * only one left (Acceptance Scenario S06).
   */
  app.delete('/api/conferences/:conferenceId/members/:userSub/roles/:role', {
    schema: { params: revokeParamsSchema },
    handler: withAuth(async (request, caller) => {
      const conference = await loadChangeable(request, caller);
      const { userSub, role } = request.params as RevokeParams;

      // The last-Admin rule fires inside this call, under the Conference row lock.
      await roles.revoke(conference.id, userSub, role);
      return roster(conference);
    }),
  });

  /**
   * Assigning a Presenter/Facilitator to one of this Conference's Sessions.
   *
   * Not gated on lifecycle state beyond the archived guard: a draft and a published Conference
   * accept assignments alike, and publishing is never blocked by a Session having no holder. FR2's
   * "zero or more assigned Presenters/Facilitators" is satisfied by zero, and members other than
   * the creator only exist after publish anyway – a pre-publish assignment step would be
   * unexecutable for anybody else (S07 → owner decision, recorded).
   */
  app.post('/api/conferences/:conferenceId/sessions/:sessionId/assignments', {
    schema: { params: assignParamsSchema, body: assignBodySchema },
    handler: withAuth(async (request, caller) => {
      const conference = await loadChangeable(request, caller);
      const { sessionId } = request.params as AssignParams;
      const { userSub } = request.body as { userSub: string };

      await roles.assignSession(conference.id, sessionId, userSub);
      return roster(conference);
    }),
  });

  app.delete('/api/conferences/:conferenceId/sessions/:sessionId/assignments/:userSub', {
    schema: { params: unassignParamsSchema },
    handler: withAuth(async (request, caller) => {
      const conference = await loadChangeable(request, caller);
      const { sessionId, userSub } = request.params as UnassignParams;

      await roles.unassignSession(conference.id, sessionId, userSub);
      return roster(conference);
    }),
  });

  // ---------- membership management (S08) ----------

  /**
   * Leaving: the caller ends their own Membership.
   *
   * The target is `caller.sub` from S02's verified context, and there is nowhere in this request to
   * put anybody else's – no body is read, and the path names no user. A caller cannot leave on
   * somebody else's behalf because there is no way to say whose Membership to end.
   *
   * The confirmation the PRD asks for is the client's, and can only be the client's: this API runs
   * as several container replicas with no request affinity (ADR-004), so a "pending leave" held
   * between two requests would be on one replica and absent from the next. What the server exposes
   * is one call that ends a Membership, and it is authorized, guarded and atomic on its own.
   */
  app.delete('/api/conferences/:conferenceId/membership', {
    schema: { params: conferenceParamsSchema },
    handler: withAuth(async (request, caller) => {
      const conference = await loadJoined(request, caller);
      // Archived is refused whatever the Admin count, so it is decided before the transaction.
      assertEditable(conference);

      // The last-Admin rule fires inside this call, under the Conference row lock.
      await membership.revoke(conference.id, caller.sub, 'left');

      // No roster: somebody who has just left is not entitled to read the member list they were on.
      return { conferenceId: conference.id, membership: 'ended' };
    }),
  });

  /**
   * Removing: an Admin of *this* Conference ends a named member's Membership.
   *
   * Idempotent by design. A target holding no Membership is not in the Conference at all – and
   * under the seeded model that also means no Role Assignment here – so the request succeeds
   * having deleted nothing, rather than returning an error a second click would produce (FR6 →
   * Error Handling). The roster comes back either way, so the Admin sees what the server holds.
   */
  app.delete('/api/conferences/:conferenceId/members/:userSub', {
    schema: { params: memberParamsSchema },
    handler: withAuth(async (request, caller) => {
      const conference = await loadChangeable(request, caller);
      const { userSub } = request.params as MemberParams;

      await membership.revoke(conference.id, userSub, 'removed');
      return roster(conference);
    }),
  });
}
