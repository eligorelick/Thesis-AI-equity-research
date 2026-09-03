/**
 * Stage C — the adversarial protocol: which case the judge reads first, how long
 * each case may be, and what the two sides said about their own strength.
 *
 * WS7 (DECISIONS D-20). Three defects this module fixes, all of them structural
 * rather than model-quality problems:
 *
 *  1. POSITION. `judgeUserTurns` always wrote BULL CASE then BEAR CASE. First
 *     position in a long prompt is a known advantage, and it was handed to the
 *     same side on every report ever generated. The order is now drawn from a
 *     per-job seed, so it varies across reports and is reproducible within one.
 *  2. VOLUME. Nothing bounded either case, so the side that wrote more got more
 *     of the judge's attention for free. Both sides are now capped at the same
 *     character budget, the cap is stated in the analyst prompt, it is enforced
 *     here (truncated WITH a disclosure, never silently dropped), and the judge
 *     is told both lengths so it can see that they are comparable.
 *  3. SELF-ASSESSMENT. Neither analyst had a way to say "my side is thin", so
 *     the judge could not tell a genuinely strong case from a well-written weak
 *     one. `case_strength` (1-5, rubric in the prompt) is now carried into the
 *     judge turn.
 *
 * Pure functions — no clock, no network, no LLM, no `process.env` read at call
 * time other than through {@link resolveJudgeOrderSetting}'s explicit argument.
 * Everything here is deterministic in (setting, seed, cases).
 */

import type { ManifestEntry } from "@/types/core";
import type {
  AnalystCase,
  AnalystCasePresentation,
  JudgeOrder,
  JudgeOrderSetting,
  JudgeProtocol,
  JudgeReconciliation,
  JudgeOutput,
} from "@/report/schema";
import { fnv1a32, truncateWithDisclosure } from "@/pipeline/stageC/payload";

/* ------------------------------------------------------------------------ *
 * Order setting
 * ------------------------------------------------------------------------ */

export const JUDGE_ORDER_SETTINGS = [
  "random",
  "bull-first",
  "bear-first",
  "both",
] as const satisfies readonly JudgeOrderSetting[];

/**
 * Default `THESIS_JUDGE_ORDER`. `random` costs exactly one judge pass, which is
 * why it is the default; `both` costs TWO judge passes on every report.
 */
export const DEFAULT_JUDGE_ORDER_SETTING: JudgeOrderSetting = "random";

/** Env var name, so callers and docs never spell it twice. */
export const JUDGE_ORDER_ENV_KEY = "THESIS_JUDGE_ORDER";

/** How many judge provider passes each setting costs. `both` is the expensive one. */
export const JUDGE_PASSES_PER_SETTING: Record<JudgeOrderSetting, 1 | 2> = {
  random: 1,
  "bull-first": 1,
  "bear-first": 1,
  both: 2,
};

/**
 * Parse a `THESIS_JUDGE_ORDER` value. An unset/blank value is the default; an
 * UNRECOGNIZED value also degrades to the default rather than failing a run —
 * position order is a fairness control, and refusing to produce a report because
 * a typo appeared in one env var would be worse than running the safe default.
 * The degrade is disclosed: {@link buildJudgeProtocolNote} names the setting in
 * force, so a typo shows up as "random" in the report rather than silently.
 */
export function resolveJudgeOrderSetting(
  raw: string | undefined | null,
): JudgeOrderSetting {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value.length === 0) return DEFAULT_JUDGE_ORDER_SETTING;
  return (JUDGE_ORDER_SETTINGS as readonly string[]).includes(value)
    ? (value as JudgeOrderSetting)
    : DEFAULT_JUDGE_ORDER_SETTING;
}

/**
 * Pick the order the judge actually sees. Deterministic in `seed`: the same job
 * re-run (a resume, a judge retry, the preflight request validation that has to
 * reproduce the exact forthcoming request) always draws the same order.
 *
 * The draw is the PARITY OF THE WHOLE 32-bit FNV-1a word of the seed. That is
 * not a cryptographic shuffle and does not need to be: it needs to be unbiased
 * ACROSS jobs and stable WITHIN one. It was previously the LOW BIT alone, which
 * is unbiased over UUIDs (measured 49.7% over 20,000) but is a parity function
 * of the input bytes — FNV's prime is odd, so the multiply never changes bit 0
 * — and therefore alternates deterministically for SEQUENTIAL seeds. Job ids
 * are UUIDs today; folding every bit in keeps the draw unpredictable if they
 * ever stop being. `both` draws its primary the same way and mirrors it.
 */
export function resolveJudgeOrder(
  setting: JudgeOrderSetting,
  seed: string,
): { order: JudgeOrder; secondaryOrder: JudgeOrder | null } {
  if (setting === "bull-first") return { order: "bull-first", secondaryOrder: null };
  if (setting === "bear-first") return { order: "bear-first", secondaryOrder: null };
  const drawn: JudgeOrder = seedParity(seed) === 1 ? "bear-first" : "bull-first";
  return {
    order: drawn,
    secondaryOrder: setting === "both" ? oppositeOrder(drawn) : null,
  };
}

/** XOR-fold of all 32 bits of the seed's FNV-1a word down to one bit. */
function seedParity(seed: string): 0 | 1 {
  let word = Number.parseInt(fnv1a32(seed), 16);
  word ^= word >>> 16;
  word ^= word >>> 8;
  word ^= word >>> 4;
  word ^= word >>> 2;
  word ^= word >>> 1;
  return (word & 1) as 0 | 1;
}

/**
 * Short, stable fingerprint of the seed for the READER-FACING sentence. The
 * seed is the job id; printing it into the Markdown and print-HTML headers put
 * a live identifier into a file a user may forward, for no reader benefit — the
 * fingerprint is enough to see that two reports drew different seeds, and
 * `judgeProtocol.seed` still carries the exact value in the report JSON.
 */
export function judgeSeedFingerprint(seed: string): string {
  return fnv1a32(seed);
}

export function oppositeOrder(order: JudgeOrder): JudgeOrder {
  return order === "bull-first" ? "bear-first" : "bull-first";
}

/* ------------------------------------------------------------------------ *
 * Length cap
 * ------------------------------------------------------------------------ */

/**
 * Per-side character cap on the SERIALIZED analyst case as the judge receives it.
 *
 * Derived from what the pass already allows, not invented: an analyst pass is
 * capped at `ANALYST_MAX_TOKENS` = 64,000 output tokens, of which live runs put
 * ~80% in thinking and the ANALYST_CASE JSON itself at 4-6K tokens (passes.ts's
 * own measurement note). At the ~4 chars/token ratio this codebase already uses
 * for its text budgets (payload.ts PAYLOAD_BUDGETS), 6K tokens is ~24,000
 * characters. So 24,000 is the TOP of the measured band: a normal case is never
 * touched, and a runaway one is bounded at parity with the other side.
 *
 * The cap is stated verbatim in the analyst prompt (prompts.ts), so a case that
 * gets truncated here was told the limit first.
 */
export const ANALYST_CASE_CHAR_CAP = 24_000;

/**
 * Order in which whole entries are dropped when a case exceeds the cap: least
 * load-bearing first. `thesis` is last and never emptied — a case with no thesis
 * is not a case. `priceTarget` is never dropped (it is one small object and the
 * judge needs both sides' targets to compare them at all).
 */
const TRIM_ORDER = [
  "evidence",
  "catalysts",
  "risksToCase",
  "keyDrivers",
  "thesis",
] as const;

export interface CappedAnalystCase {
  /** The case as the judge will receive it (a copy; the input is never mutated). */
  value: AnalystCase;
  presentation: AnalystCasePresentation;
  /** Human sentence naming exactly what was removed; empty when nothing was. */
  disclosure: string;
}

function serializedLength(value: AnalystCase): number {
  return JSON.stringify(value).length;
}

function claimTexts(value: AnalystCase): { text: string }[] {
  return [
    ...value.thesis,
    ...value.keyDrivers,
    ...value.risksToCase,
    ...value.catalysts,
  ];
}

/**
 * Enforce {@link ANALYST_CASE_CHAR_CAP} on one side.
 *
 * Truncation is DISCLOSED, never silent: the returned presentation carries the
 * original and final lengths and the number of dropped entries, the returned
 * `disclosure` becomes a missing-data manifest entry, and the judge turn itself
 * says the case was truncated. Two stages, in this order:
 *
 *  1. Drop trailing entries, cheapest field first (see {@link TRIM_ORDER}),
 *     never below one entry per field. Dropping a whole claim keeps every
 *     surviving claim's citation intact, which matters more than keeping a
 *     larger number of half-sentences.
 *  2. If a single pathological claim still blows the budget, shorten the claim
 *     TEXTS with the payload module's truncation marker so what remains is
 *     visibly cut rather than quietly reworded.
 */
export function capAnalystCase(
  input: AnalystCase,
  capChars: number = ANALYST_CASE_CHAR_CAP,
): CappedAnalystCase {
  const originalChars = serializedLength(input);
  const value = structuredClone(input) as AnalystCase;
  const strength = typeof input.case_strength === "number" ? input.case_strength : null;

  if (originalChars <= capChars) {
    return {
      value,
      presentation: {
        chars: originalChars,
        originalChars,
        capChars,
        truncated: false,
        droppedItems: 0,
        caseStrength: strength,
      },
      disclosure: "",
    };
  }

  let droppedItems = 0;
  const arrays: Record<(typeof TRIM_ORDER)[number], { length: number; pop: () => unknown }> = {
    evidence: value.evidence,
    catalysts: value.catalysts,
    risksToCase: value.risksToCase,
    keyDrivers: value.keyDrivers,
    thesis: value.thesis,
  };
  while (serializedLength(value) > capChars) {
    const field = TRIM_ORDER.find((key) => arrays[key].length > 1);
    if (field === undefined) break;
    arrays[field].pop();
    droppedItems += 1;
  }

  let textsTruncated = 0;
  if (serializedLength(value) > capChars) {
    // Every remaining claim shares what is left of the budget equally. The
    // structural overhead (keys, sources, price target) is what serializing
    // costs regardless, so measure it once and divide the remainder.
    const texts = claimTexts(value);
    const textChars = texts.reduce((sum, claim) => sum + claim.text.length, 0);
    const overhead = serializedLength(value) - textChars;
    const budgetPerText = Math.max(
      40,
      Math.floor((capChars - overhead) / Math.max(1, texts.length)),
    );
    for (const claim of texts) {
      if (claim.text.length <= budgetPerText) continue;
      claim.text = truncateWithDisclosure(claim.text, budgetPerText).text;
      textsTruncated += 1;
    }
  }

  const chars = serializedLength(value);
  const parts = [
    `${originalChars} chars exceeded the ${capChars}-char per-side cap`,
  ];
  if (droppedItems > 0) {
    parts.push(`${droppedItems} trailing entr${droppedItems === 1 ? "y was" : "ies were"} dropped`);
  }
  if (textsTruncated > 0) {
    parts.push(`${textsTruncated} claim text${textsTruncated === 1 ? " was" : "s were"} shortened`);
  }
  parts.push(`the judge received ${chars} chars`);
  return {
    value,
    presentation: {
      chars,
      originalChars,
      capChars,
      truncated: true,
      droppedItems,
      caseStrength: strength,
    },
    disclosure: `${parts.join("; ")}.`,
  };
}

/* ------------------------------------------------------------------------ *
 * The presentation the judge turn is built from
 * ------------------------------------------------------------------------ */

export interface JudgePresentation {
  setting: JudgeOrderSetting;
  order: JudgeOrder;
  secondaryOrder: JudgeOrder | null;
  seed: string;
  bull: CappedAnalystCase;
  bear: CappedAnalystCase;
}

/**
 * Everything the judge request needs, derived deterministically from the setting,
 * the seed and the two cases. Called by both the request builder (which the
 * runner's preflight uses to validate the EXACT forthcoming request) and the
 * pass runner, so the two can never disagree.
 */
export function buildJudgePresentation(args: {
  setting: JudgeOrderSetting;
  seed: string;
  bull: AnalystCase;
  bear: AnalystCase;
  capChars?: number;
}): JudgePresentation {
  const { order, secondaryOrder } = resolveJudgeOrder(args.setting, args.seed);
  return {
    setting: args.setting,
    order,
    secondaryOrder,
    seed: args.seed,
    bull: capAnalystCase(args.bull, args.capChars),
    bear: capAnalystCase(args.bear, args.capChars),
  };
}

/** The two case blocks in the order the judge will read them. */
export function orderedSides(order: JudgeOrder): ["bull" | "bear", "bull" | "bear"] {
  return order === "bull-first" ? ["bull", "bear"] : ["bear", "bull"];
}

/**
 * The line the judge reads above each case: its length, the shared cap, whether
 * it was truncated, and the analyst's own strength score. Stated for BOTH sides
 * before either case so "the longer one must have more behind it" is not
 * available as an inference.
 */
export function caseLengthBanner(presentation: JudgePresentation): string {
  const line = (side: "bull" | "bear", capped: CappedAnalystCase): string => {
    const p = capped.presentation;
    const strength = p.caseStrength === null
      ? "self-assessed strength: not supplied"
      : `self-assessed strength ${p.caseStrength}/5`;
    return (
      `- ${side.toUpperCase()}: ${p.chars} characters of the ${p.capChars}-character cap` +
      `${p.truncated ? ` (TRUNCATED from ${p.originalChars}; ${p.droppedItems} entries dropped)` : ""}` +
      `; ${strength}.`
    );
  };
  return [
    "CASE LENGTHS AND SELF-ASSESSMENTS (both sides, before you read either case):",
    line("bull", presentation.bull),
    line("bear", presentation.bear),
    "Length is not evidence. A longer case is not a stronger case; both sides were held to the",
    "same character cap and told so. `case_strength` is each analyst's own 1-5 score for its own",
    "side against a stated rubric — it is a self-report, not a measurement. You MAY discount a",
    "side that scored itself low, or one whose cited evidence does not support the score it",
    "claimed. You MUST NOT prefer a side for being longer, for being first, or for being second.",
  ].join("\n");
}

/* ------------------------------------------------------------------------ *
 * `both` reconciliation
 * ------------------------------------------------------------------------ */

const GRADE_ASPECTS = [
  "fundamentals",
  "valuation",
  "technicals",
  "quality",
  "leadership",
  "moat",
  "balanceSheet",
] as const;

/**
 * The fields two `both`-mode judge passes must agree on. See
 * {@link JudgeReconciliationSchema} for why these and not the prose.
 */
export function reconciliationFields(): string[] {
  return [
    ...GRADE_ASPECTS.map((aspect) => `verdict.gradeStrip.${aspect}.grade`),
    "valuation.scenarios.bull.probability",
    "valuation.scenarios.base.probability",
    "valuation.scenarios.bear.probability",
  ];
}

function comparableValues(output: JudgeOutput): Map<string, string> {
  const values = new Map<string, string>();
  for (const aspect of GRADE_ASPECTS) {
    const block = output.verdict.gradeStrip[aspect];
    values.set(
      `verdict.gradeStrip.${aspect}.grade`,
      block === undefined ? "absent" : block.grade,
    );
  }
  for (const name of ["bull", "base", "bear"] as const) {
    const scenario = output.valuation.scenarios.find((entry) => entry.name === name);
    values.set(
      `valuation.scenarios.${name}.probability`,
      scenario?.probability == null ? "absent" : scenario.probability.toFixed(2),
    );
  }
  return values;
}

/**
 * Compare the primary (seeded-order) judge output with the mirrored one.
 * The primary always wins — the report is one document and averaging two model
 * outputs would invent a third that neither pass produced. Disagreement is
 * disclosed, not resolved.
 */
export function reconcileJudgeOutputs(
  primary: JudgeOutput,
  secondary: JudgeOutput,
  secondaryOrder: JudgeOrder,
): JudgeReconciliation {
  const left = comparableValues(primary);
  const right = comparableValues(secondary);
  const disagreements = [...left.entries()].flatMap(([field, value]) => {
    const other = right.get(field) ?? "absent";
    return value === other ? [] : [{ field, primary: value, secondary: other }];
  });
  const agreed = disagreements.length === 0;
  return {
    performed: true,
    secondaryOrder,
    agreed,
    comparedFields: reconciliationFields(),
    disagreements,
    note: agreed
      ? `Both judge passes (${oppositeOrder(secondaryOrder)} and ${secondaryOrder}) produced the same section grades and scenario probabilities.`
      : `The two judge passes differed on ${disagreements.length} of ${left.size} compared field(s); the ${oppositeOrder(secondaryOrder)} pass is the report and the differences are listed here, so the affected grades are known to be order-sensitive.`,
  };
}

/** Reconciliation that did not happen, with the reason a reader can act on. */
export function reconciliationNotPerformed(reason: string): JudgeReconciliation {
  return {
    performed: false,
    secondaryOrder: null,
    agreed: false,
    comparedFields: reconciliationFields(),
    disagreements: [],
    note: `The mirrored judge pass did not produce a comparable output, so no order-sensitivity check was made: ${reason}`,
  };
}

/* ------------------------------------------------------------------------ *
 * Draft -> completed protocol
 * ------------------------------------------------------------------------ */

/**
 * What the judge pass knows about the protocol. The two facts it does NOT know
 * — which model families actually served the analyst and judge passes, and the
 * reader-facing sentence built from all of it — are filled at report assembly,
 * where the settled cost entries name the effective models.
 */
export interface JudgeProtocolDraft {
  setting: JudgeOrderSetting;
  order: JudgeOrder;
  seed: string;
  /** Null only on a RECOVERED protocol — see {@link recoveredJudgeProtocolDraft}. */
  bull: AnalystCasePresentation | null;
  bear: AnalystCasePresentation | null;
  reconciliation?: JudgeReconciliation;
  /** Manifest disclosures the protocol itself produced (truncation, and more). */
  disclosures: ManifestEntry[];
}

/**
 * The protocol as much as it can be RECONSTRUCTED after the fact, for a report
 * whose judge output was replayed from a durable synthesize artifact: the judge
 * pass never ran in this process, so nothing recorded the protocol it ran under.
 *
 * Order, setting and seed survive because the draw is deterministic in (setting,
 * seed) — the same two inputs the original pass used, so the same order comes
 * back unless the operator changed `THESIS_JUDGE_ORDER` between the two
 * processes. The per-side lengths, truncations and self-assessments do not
 * survive: they are facts about two analyst cases this process never saw. They
 * are reported as null and DISCLOSED — in the reader sentence and as a warn
 * manifest entry — rather than fabricated or, as before, dropped along with the
 * entire protocol block with no error and no gap entry.
 */
export function recoveredJudgeProtocolDraft(args: {
  setting: JudgeOrderSetting;
  seed: string;
}): JudgeProtocolDraft {
  const { order } = resolveJudgeOrder(args.setting, args.seed);
  return {
    setting: args.setting,
    order,
    seed: args.seed,
    bull: null,
    bear: null,
    disclosures: [
      {
        field: "llm.judge.protocol-recovered",
        reason:
          "The judge output for this report was replayed from a durable artifact rather than " +
          `produced in this run, so the judgement protocol was reconstructed from the job seed and ` +
          `${JUDGE_ORDER_ENV_KEY}=${args.setting} rather than recorded by the pass that ran. The case ` +
          "order above is what that pair draws; the two case lengths against the shared cap, whether " +
          "either was truncated, and both analysts' self-assessed case strength are not recoverable " +
          "and are not reported.",
        severity: "warn",
        attemptedSources: ["anthropic"],
      },
    ],
  };
}

export function buildJudgeProtocolDraft(
  presentation: JudgePresentation,
): JudgeProtocolDraft {
  const disclosures: ManifestEntry[] = [];
  for (const side of ["bull", "bear"] as const) {
    const capped = presentation[side];
    if (capped.presentation.truncated) {
      disclosures.push({
        field: `llm.${side}.length-cap`,
        reason: `The ${side} case was truncated before the judge saw it: ${capped.disclosure} Both sides share the same cap so neither can win on volume.`,
        severity: "warn",
        attemptedSources: ["anthropic"],
      });
    }
  }
  return {
    setting: presentation.setting,
    order: presentation.order,
    seed: presentation.seed,
    bull: presentation.bull.presentation,
    bear: presentation.bear.presentation,
    disclosures,
  };
}

/** Attach a `both`-mode reconciliation result and its manifest disclosure. */
export function withReconciliation(
  draft: JudgeProtocolDraft,
  reconciliation: JudgeReconciliation,
): JudgeProtocolDraft {
  const disclosures = [...draft.disclosures];
  if (!reconciliation.performed) {
    disclosures.push({
      field: "llm.judge.order-reconciliation",
      reason: reconciliation.note,
      severity: "warn",
      attemptedSources: ["anthropic"],
    });
  } else if (!reconciliation.agreed) {
    for (const disagreement of reconciliation.disagreements) {
      disclosures.push({
        field: `llm.judge.order-sensitive.${disagreement.field}`,
        reason: `Running the judge with the cases in the opposite order changed this field: ${disagreement.field} was "${disagreement.primary}" in the reported pass and "${disagreement.secondary}" in the mirrored pass. The reported pass stands; the field is order-sensitive.`,
        severity: "warn",
        attemptedSources: ["anthropic"],
      });
    }
  }
  return { ...draft, reconciliation, disclosures };
}

/**
 * Re-stamp a STORED protocol with the model families the final execution list
 * names, rebuilding the reader sentence from them.
 *
 * The families are the one fact the judge pass cannot know: which model actually
 * served each step is settled after it. Stage C's verify path assembles the
 * report before the runner's execution metadata exists, so the block it stores
 * always says "not shared"; the runner re-stamps it in reconcileMeta, where the
 * effective model per step is finally known.
 */
export function restampSharedModelFamily(
  protocol: JudgeProtocol,
  sharedModelFamily: JudgeProtocol["sharedModelFamily"],
): JudgeProtocol {
  const rest: Record<string, unknown> = { ...protocol, sharedModelFamily };
  delete rest.note;
  const withoutNote = rest as unknown as Omit<JudgeProtocol, "note">;
  return { ...withoutNote, note: buildJudgeProtocolNote(withoutNote) };
}

/** Fill the model-family fact and the reader sentence, producing the stored block. */
export function completeJudgeProtocol(
  draft: JudgeProtocolDraft,
  sharedModelFamily: JudgeProtocol["sharedModelFamily"],
): JudgeProtocol {
  const withoutNote: Omit<JudgeProtocol, "note"> = {
    setting: draft.setting,
    order: draft.order,
    seed: draft.seed,
    bull: draft.bull,
    bear: draft.bear,
    sharedModelFamily,
    ...(draft.reconciliation === undefined ? {} : { reconciliation: draft.reconciliation }),
  };
  return { ...withoutNote, note: buildJudgeProtocolNote(withoutNote) };
}

/**
 * Manifest entries for the completed protocol: the order actually used (always
 * disclosed — a randomized control nobody can see is not a control), and the
 * shared-model-family warning when the judge graded its own family's output.
 */
export function judgeProtocolManifestEntries(protocol: JudgeProtocol): ManifestEntry[] {
  const entries: ManifestEntry[] = [
    {
      field: "llm.judge.case-order",
      reason: protocol.note,
      severity: "info",
      attemptedSources: ["anthropic"],
    },
  ];
  if (protocol.sharedModelFamily.shared) {
    entries.push({
      field: "llm.judge.model-family",
      reason: `The judge and both analyst passes ran on the ${protocol.sharedModelFamily.judgeFamily} model family, so the adjudication is not independent of the two cases it graded: the same family wrote and judged them.`,
      severity: "warn",
      attemptedSources: ["anthropic"],
    });
  }
  return entries;
}

/* ------------------------------------------------------------------------ *
 * The reader-facing sentence
 * ------------------------------------------------------------------------ */

/** One sentence per fact a reader needs about how this judgement was produced. */
export function buildJudgeProtocolNote(
  protocol: Omit<JudgeProtocol, "note">,
): string {
  const first = protocol.order === "bull-first" ? "bull" : "bear";
  const second = protocol.order === "bull-first" ? "bear" : "bull";
  const { bull, bear } = protocol;
  const sentences =
    bull === null || bear === null
      ? [
          // A RECOVERED protocol: reconstructed, not recorded. Saying "the judge
          // read X first" outright would assert something this process did not
          // observe, so the sentence says where the order came from instead.
          `The judge output was replayed from a durable artifact, so this protocol was reconstructed rather than recorded: with ${JUDGE_ORDER_ENV_KEY}=${protocol.setting} and seed ${judgeSeedFingerprint(protocol.seed)} the ${first} case is drawn to be read first and the ${second} case second.`,
          "Neither case's length against the shared cap, whether either was truncated, nor either analyst's self-assessed case strength was recoverable, so none of them is reported here.",
        ]
      : [
          `The judge read the ${first} case first and the ${second} case second (${JUDGE_ORDER_ENV_KEY}=${protocol.setting}, drawn from seed ${judgeSeedFingerprint(protocol.seed)}), so first position was not fixed to one side.`,
          `Both cases were capped at ${bull.capChars} characters: the bull case ran ${bull.chars}${bull.truncated ? " after truncation" : ""} and the bear case ${bear.chars}${bear.truncated ? " after truncation" : ""}, and the judge was told both lengths.`,
          `Self-assessed case strength (1-5, the analyst's own score for its own side): bull ${bull.caseStrength ?? "not supplied"}, bear ${bear.caseStrength ?? "not supplied"}.`,
        ];
  if (protocol.sharedModelFamily.shared) {
    sentences.push(
      `The judge ran on the ${protocol.sharedModelFamily.judgeFamily} model family — the same family that wrote both analyst cases — so it is grading output from its own family.`,
    );
  } else if (
    protocol.sharedModelFamily.analystFamily !== null &&
    protocol.sharedModelFamily.judgeFamily !== null
  ) {
    sentences.push(
      `The judge ran on the ${protocol.sharedModelFamily.judgeFamily} model family and the analysts on ${protocol.sharedModelFamily.analystFamily}.`,
    );
  }
  if (protocol.reconciliation !== undefined) {
    sentences.push(protocol.reconciliation.note);
  }
  return sentences.join(" ");
}
