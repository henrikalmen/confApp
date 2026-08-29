import { AppError, ERROR_CODES } from '../errors.ts';

/**
 * The Round field rules (FR1), and the refusals a person reads when they are broken.
 *
 * Every message names the rule it enforces and what is permitted instead – "a poll needs at least
 * two options" and the limit that was exceeded, never "invalid input". The Facilitator is
 * mid-authoring and has to know which value to change, and the entered values stay in the form.
 *
 * The two-level Activity model is stated here exactly as `docs/UBIQUITOUS_LANGUAGE.md`
 * #session-activities states it and as the `round` table constrains it: **kind** names the Activity
 * (`PostItRound` / `VotingRound`), **purpose** names what a Voting Round is *for* (`Poll`). The
 * deferred Prioritization and Rating purposes are added to `VOTING_ROUND_PURPOSES` below and to the
 * `round_purpose_known` CHECK, and to nothing else.
 *
 * The route's JSON schema has already established that the fields are present and are of the right
 * JSON types by the time anything here runs; these are the business rules on top of that shape.
 */

/** Exactly two Activities. A Poll is a *purpose*, never a kind. */
export const ROUND_KINDS = ['PostItRound', 'VotingRound'] as const;
export type RoundKind = (typeof ROUND_KINDS)[number];

/** Poll only, for now. Prioritization and Rating are deferred purposes, each its own later slice. */
export const VOTING_ROUND_PURPOSES = ['Poll'] as const;
export type RoundPurpose = (typeof VOTING_ROUND_PURPOSES)[number];

export const ROUND_STATES = ['open', 'closed'] as const;
export type RoundState = (typeof ROUND_STATES)[number];

export const PROMPT_MAX_LENGTH = 500;
export const OPTION_LABEL_MAX_LENGTH = 120;
export const MINIMUM_POLL_OPTIONS = 2;

export function isRoundKind(value: unknown): value is RoundKind {
  return typeof value === 'string' && (ROUND_KINDS as readonly string[]).includes(value);
}

export function isRoundPurpose(value: unknown): value is RoundPurpose {
  return typeof value === 'string' && (VOTING_ROUND_PURPOSES as readonly string[]).includes(value);
}

export interface RoundDetailsInput {
  kind: string;
  purpose?: string | null;
  prompt: string;
  options?: string[];
}

/** Validated and normalised – the values that should actually be stored. */
export interface RoundDetails {
  kind: RoundKind;
  purpose: RoundPurpose | null;
  prompt: string;
  /** Empty for a Post-it Round; at least two distinct labels, in authored order, for a Poll. */
  options: string[];
}

function refusal(
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  ...fields: string[]
): AppError {
  return new AppError(
    code,
    400,
    message,
    fields.map((field) => ({ field, message })),
  );
}

/**
 * The kind, the purpose, and the relationship between them – one decision, because the two fields
 * are only meaningful together.
 */
function validateKindAndPurpose(input: RoundDetailsInput): {
  kind: RoundKind;
  purpose: RoundPurpose | null;
} {
  if (!isRoundKind(input.kind)) {
    throw refusal(
      ERROR_CODES.ROUND_KIND_INVALID,
      `A round is either a ${ROUND_KINDS.join(' or a ')}.`,
      'kind',
    );
  }

  const purpose = input.purpose ?? null;

  if (input.kind === 'PostItRound') {
    if (purpose !== null && purpose !== '') {
      throw refusal(
        ERROR_CODES.ROUND_KIND_INVALID,
        'A post-it round has no purpose to choose – a purpose describes what a voting round is for.',
        'purpose',
      );
    }
    return { kind: 'PostItRound', purpose: null };
  }

  if (!isRoundPurpose(purpose)) {
    throw refusal(
      ERROR_CODES.ROUND_KIND_INVALID,
      `A voting round needs a purpose, and the only one available is ` +
        `${VOTING_ROUND_PURPOSES.join(' or ')}.`,
      'purpose',
    );
  }

  return { kind: 'VotingRound', purpose };
}

/**
 * Length as PostgreSQL counts it.
 *
 * `char_length` counts **code points**; JavaScript's `.length` counts UTF-16 code units, so a
 * string of 300 emoji measures 600 here and 300 there. The API is the tighter of the two either
 * way, so nothing unwritable slipped through – but the refusal named a number the person could not
 * see on their screen, and the two layers have to state the same limit for stating it twice to mean
 * anything.
 */
function characters(value: string): number {
  return [...value].length;
}

function validatePrompt(input: RoundDetailsInput, kind: RoundKind): string {
  const noun = kind === 'VotingRound' ? 'question' : 'prompt';
  const prompt = input.prompt.trim();

  if (prompt === '') {
    throw refusal(ERROR_CODES.ROUND_PROMPT_INVALID, `A round ${noun} is required.`, 'prompt');
  }
  if (characters(prompt) > PROMPT_MAX_LENGTH) {
    throw refusal(
      ERROR_CODES.ROUND_PROMPT_INVALID,
      `A round ${noun} can be at most ${PROMPT_MAX_LENGTH} characters, and this one is ` +
        `${characters(prompt)}.`,
      'prompt',
    );
  }
  return prompt;
}

/**
 * The Poll's answer options: at least two, each real, and no two the same.
 *
 * Order is preserved exactly as given – the ballots will point at these rows, and a Poll whose
 * options reshuffled between authoring and voting would be a different question.
 */
function validateOptions(input: RoundDetailsInput, kind: RoundKind): string[] {
  const given = input.options ?? [];

  if (kind === 'PostItRound') {
    if (given.length > 0) {
      throw refusal(
        ERROR_CODES.ROUND_OPTIONS_INVALID,
        'A post-it round has no answer options – participants write their own post-its.',
        'options',
      );
    }
    return [];
  }

  const labels = given.map((label) => label.trim());

  if (labels.length < MINIMUM_POLL_OPTIONS) {
    throw refusal(
      ERROR_CODES.ROUND_OPTIONS_INVALID,
      `A poll needs at least ${MINIMUM_POLL_OPTIONS} answer options, and this one has ` +
        `${labels.length}.`,
      'options',
    );
  }

  for (const label of labels) {
    if (label === '') {
      throw refusal(
        ERROR_CODES.ROUND_OPTIONS_INVALID,
        'Every answer option needs a label, and one of these is blank.',
        'options',
      );
    }
    if (characters(label) > OPTION_LABEL_MAX_LENGTH) {
      throw refusal(
        ERROR_CODES.ROUND_OPTIONS_INVALID,
        `An answer option can be at most ${OPTION_LABEL_MAX_LENGTH} characters, and "` +
          `${[...label].slice(0, 20).join('')}…" is ${characters(label)}.`,
        'options',
      );
    }
  }

  // Compared exactly as stored, so this refusal and the table's own unique constraint agree about
  // what "the same option twice" means.
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) {
      throw refusal(
        ERROR_CODES.ROUND_OPTIONS_INVALID,
        `Two answer options are both labelled "${label}", so there would be nothing to choose ` +
          'between them. Give each option its own label.',
        'options',
      );
    }
    seen.add(label);
  }

  return labels;
}

export function validateRoundDetails(input: RoundDetailsInput): RoundDetails {
  const { kind, purpose } = validateKindAndPurpose(input);
  return {
    kind,
    purpose,
    prompt: validatePrompt(input, kind),
    options: validateOptions(input, kind),
  };
}
