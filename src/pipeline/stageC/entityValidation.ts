export type CanonicalEntityKind = "drug" | "trial-program" | "acquisition-target";
export type EntityAliasStatus = "supported" | "unsupported";

export interface EntityAlias {
  value: string;
  status: EntityAliasStatus;
}

export interface CanonicalEntityRecord {
  id: string;
  kind: CanonicalEntityKind;
  canonicalName: string;
  aliases: readonly EntityAlias[];
  primarySourceIds: readonly string[];
  /** Trial programs use this to pin the drug they actually evaluate. */
  relatedEntityId?: string;
}

export interface EntityRegistry {
  symbol: string;
  records: readonly CanonicalEntityRecord[];
}

export type EntityIssueCode =
  | "unsupported-alias"
  | "primary-source-required"
  | "relationship-conflict";

export interface EntityIssue {
  code: EntityIssueCode;
  text: string;
  canonicalName: string;
  observed: string;
  sourceId: string | null;
  recordId: string;
  expectedEntityId?: string;
}

export interface EntityMention {
  recordId: string;
  canonicalName: string;
  observed: string;
  status: EntityAliasStatus;
}

export interface EntityValidationResult {
  mentions: EntityMention[];
  issues: EntityIssue[];
}

export interface EntityDisagreementLike {
  kind: string;
  topic: string;
  bullView: string;
  bearView: string;
  judgeResolution: string;
}

const LILLY_Q1_2026 =
  "https://investor.lilly.com/news-releases/news-release-details/lilly-reports-first-quarter-2026-financial-results-raises-full";
const FOUNDAYO_RELEASE =
  "https://investor.lilly.com/news-releases/news-release-details/foundayotm-orforglipron-lillys-new-oral-glp-1-pill-weight-loss";
const ACHIEVE_RELEASE =
  "https://investor.lilly.com/news-releases/news-release-details/achieve-4-longest-phase-3-study-lillys-foundayo-orforglipron";
const RETATRUTIDE_RELEASE =
  "https://investor.lilly.com/news-releases/news-release-details/lilly-present-new-data-foundayo-mounjaro-and-retatrutide";
const ORNA_RELEASE =
  "https://investor.lilly.com/news-releases/news-release-details/lilly-acquire-orna-therapeutics-advance-cell-therapies";
const CENTESSA_RELEASE =
  "https://investor.lilly.com/news-releases/news-release-details/lilly-acquire-centessa-pharmaceuticals-advance-treatments-sleep";
const KELONIA_RELEASE =
  "https://investor.lilly.com/news-releases/news-release-details/lilly-acquire-kelonia-therapeutics-advance-vivo-car-t-cell";
const AJAX_RELEASE =
  "https://investor.lilly.com/node/54166/pdf";
const ATAI_RELEASE =
  "https://investor.lilly.com/news-releases/news-release-details/lilly-acquire-ataibeckley-advance-therapies-treatment-resistant";

/** Primary-source-backed records needed by the observed LLY report conflicts. */
export const LLY_ENTITY_REGISTRY: EntityRegistry = {
  symbol: "LLY",
  records: [
    {
      id: "drug.foundayo",
      kind: "drug",
      canonicalName: "Foundayo (orforglipron)",
      aliases: [
        { value: "Foundayo", status: "supported" },
        { value: "orforglipron", status: "supported" },
      ],
      primarySourceIds: [FOUNDAYO_RELEASE, ACHIEVE_RELEASE, LILLY_Q1_2026],
    },
    {
      id: "drug.retatrutide",
      kind: "drug",
      canonicalName: "retatrutide",
      aliases: [{ value: "retatrutide", status: "supported" }],
      primarySourceIds: [RETATRUTIDE_RELEASE, LILLY_Q1_2026],
    },
    {
      id: "trial.attain",
      kind: "trial-program",
      canonicalName: "ATTAIN",
      aliases: [{ value: "ATTAIN", status: "supported" }],
      relatedEntityId: "drug.foundayo",
      primarySourceIds: [FOUNDAYO_RELEASE],
    },
    {
      id: "trial.achieve",
      kind: "trial-program",
      canonicalName: "ACHIEVE",
      aliases: [{ value: "ACHIEVE", status: "supported" }],
      relatedEntityId: "drug.foundayo",
      primarySourceIds: [ACHIEVE_RELEASE, RETATRUTIDE_RELEASE],
    },
    {
      id: "trial.triumph",
      kind: "trial-program",
      canonicalName: "TRIUMPH",
      aliases: [{ value: "TRIUMPH", status: "supported" }],
      relatedEntityId: "drug.retatrutide",
      primarySourceIds: [RETATRUTIDE_RELEASE],
    },
    {
      id: "trial.transcend",
      kind: "trial-program",
      canonicalName: "TRANSCEND",
      aliases: [{ value: "TRANSCEND", status: "supported" }],
      relatedEntityId: "drug.retatrutide",
      primarySourceIds: [RETATRUTIDE_RELEASE],
    },
    acquisition("acquisition.orna", "Orna Therapeutics", ["Orna", "Orna Therapeutics"], [], [ORNA_RELEASE, LILLY_Q1_2026]),
    acquisition(
      "acquisition.centessa",
      "Centessa Pharmaceuticals",
      ["Centessa", "Centessa Pharmaceuticals"],
      [],
      [CENTESSA_RELEASE, LILLY_Q1_2026],
    ),
    acquisition(
      "acquisition.kelonia",
      "Kelonia Therapeutics",
      ["Kelonia", "Kelonia Therapeutics"],
      [],
      [KELONIA_RELEASE, LILLY_Q1_2026],
    ),
    acquisition("acquisition.ajax", "Ajax Therapeutics", ["Ajax", "Ajax Therapeutics"], [], [AJAX_RELEASE, LILLY_Q1_2026]),
    acquisition("acquisition.atai", "AtaiBeckley", ["AtaiBeckley"], [], [ATAI_RELEASE]),
  ],
};

function acquisition(
  id: string,
  canonicalName: string,
  supported: readonly string[],
  unsupported: readonly string[],
  primarySourceIds: readonly string[],
): CanonicalEntityRecord {
  return {
    id,
    kind: "acquisition-target",
    canonicalName,
    aliases: [
      ...supported.map((value) => ({ value, status: "supported" as const })),
      ...unsupported.map((value) => ({ value, status: "unsupported" as const })),
    ],
    primarySourceIds,
  };
}

function exactTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, "i").test(text);
}

function mentionsIn(text: string, registry: EntityRegistry): EntityMention[] {
  const mentions: EntityMention[] = [];
  const seen = new Set<string>();
  for (const record of registry.records) {
    for (const alias of record.aliases) {
      if (!exactTerm(text, alias.value)) continue;
      const key = `${record.id}\u0000${alias.value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mentions.push({
        recordId: record.id,
        canonicalName: record.canonicalName,
        observed: alias.value,
        status: alias.status,
      });
    }
  }
  return mentions;
}

export function validateEntityText(
  text: string,
  registry: EntityRegistry,
  sourceId: string | null,
): EntityValidationResult {
  const mentions = mentionsIn(text, registry);
  const issues: EntityIssue[] = [];
  for (const mention of mentions) {
    const record = registry.records.find((item) => item.id === mention.recordId)!;
    if (mention.status === "unsupported") {
      issues.push({
        code: "unsupported-alias",
        text: `Unsupported alias ${mention.observed}; canonical entity is ${record.canonicalName}`,
        canonicalName: record.canonicalName,
        observed: mention.observed,
        sourceId,
        recordId: record.id,
      });
    } else if (sourceId !== null && !record.primarySourceIds.includes(sourceId)) {
      issues.push({
        code: "primary-source-required",
        text: `${record.canonicalName} requires a registered primary source`,
        canonicalName: record.canonicalName,
        observed: mention.observed,
        sourceId,
        recordId: record.id,
      });
    }
  }

  const mentionedEntityIds = new Set(mentions.map((mention) => mention.recordId));
  const mentionedDrugs = registry.records.filter(
    (record) => record.kind === "drug" && mentionedEntityIds.has(record.id),
  );
  for (const trial of registry.records.filter(
    (record) => record.kind === "trial-program" && mentionedEntityIds.has(record.id),
  )) {
    if (!trial.relatedEntityId || mentionedDrugs.length === 0) continue;
    for (const drug of mentionedDrugs) {
      if (drug.id === trial.relatedEntityId) continue;
      const expected = registry.records.find((record) => record.id === trial.relatedEntityId);
      issues.push({
        code: "relationship-conflict",
        text: `${trial.canonicalName} is registered to ${expected?.canonicalName ?? trial.relatedEntityId}, not ${drug.canonicalName}`,
        canonicalName: `${trial.canonicalName} / ${expected?.canonicalName ?? trial.relatedEntityId}`,
        observed: `${trial.canonicalName} / ${drug.canonicalName}`,
        sourceId,
        recordId: trial.id,
        expectedEntityId: trial.relatedEntityId,
      });
    }
  }
  return { mentions, issues: dedupeIssues(issues) };
}

function dedupeIssues(issues: readonly EntityIssue[]): EntityIssue[] {
  const out = new Map<string, EntityIssue>();
  for (const issue of issues) {
    const key = `${issue.code}\u0000${issue.recordId}\u0000${issue.observed}`;
    if (!out.has(key)) out.set(key, issue);
  }
  return [...out.values()];
}

export function collectEntityConflicts(
  bullTexts: readonly string[],
  bearTexts: readonly string[],
  registry: EntityRegistry,
): EntityIssue[] {
  return dedupeIssues(
    [...bullTexts, ...bearTexts].flatMap((text) =>
      validateEntityText(text, registry, null).issues.filter(
        (issue) => issue.code !== "primary-source-required",
      ),
    ),
  );
}

/** Require explicit entity-kind judge coverage for every deterministic conflict. */
export function validateJudgeEntityResolution(
  conflicts: readonly EntityIssue[],
  disagreements: readonly EntityDisagreementLike[],
): EntityIssue[] {
  const resolutions = disagreements
    .filter((item) => item.kind === "entity")
    .map((item) => `${item.topic} ${item.bullView} ${item.bearView} ${item.judgeResolution}`.toLowerCase());
  return conflicts.filter((conflict) => {
    const recordTerms = conflict.canonicalName
      .split(/\s*\/\s*/)
      .map((term) => term.toLowerCase());
    return !resolutions.some((text) => recordTerms.every((term) => text.includes(term)));
  });
}
