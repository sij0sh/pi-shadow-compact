/**
 * Checkpoint schema, structural validation, rendering, and checkpoint-model
 * resolution. Construction and verification run as tool-calling agents
 * (see checkpoint-agent.ts); this module owns the shape they produce.
 */
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelsSimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ShadowCompactConfig } from "./config.js";
import type { FileDetails } from "./working-context.js";

const MAX_ITEM_CHARS = 8_000;
const MAX_ITEMS_PER_SECTION = 100;
const MAX_REFS_PER_ITEM = 32;
const MAX_RENDERED_CHARS = 64_000;

/**
 * Single source of truth for the checkpoint section list: the submit-tool JSON
 * schema (checkpoint-agent.ts) and the persisted-entry key set (persist.ts)
 * are both derived from it.
 */
export const SECTIONS = [
  "objective",
  "constraints",
  "completedWork",
  "currentState",
  "decisions",
  "openIssues",
  "nextActions",
  "criticalContext",
  "modifiedFiles",
  "referencedFiles",
] as const;

export type SectionName = (typeof SECTIONS)[number];

export interface CheckpointItem {
  text: string;
  evidenceRefs: string[];
}

/**
 * Verification ledger (refactor §8). Answers only what has actually been
 * verified vs explicitly not, so "implemented X" cannot silently become
 * "X works" across compactions.
 */
export type VerificationStatus = "verified" | "unverified";

export interface VerificationItem {
  text: string;
  status: VerificationStatus;
  evidenceRefs: string[];
}

/**
 * Compact handoff representation (refactor §8). Gives the acting agent the
 * goal, approach, and immediate next step without consuming the whole
 * checkpoint; the builder must keep it accurate and the verifier audits it.
 */
export interface ContinuationState {
  currentGoal: string;
  currentApproach: string;
  immediateNextStep: string;
}

export const VERIFICATION_SECTION = "verificationState" as const;
export const CONTINUATION_KEY = "continuationState" as const;

export type Checkpoint = Record<SectionName, CheckpointItem[]> & {
  verificationState: VerificationItem[];
  continuationState: ContinuationState;
};

export function emptyContinuationState(): ContinuationState {
  return { currentGoal: "", currentApproach: "", immediateNextStep: "" };
}

export interface CompletionInterface {
  complete(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): Promise<AssistantMessage>;
}
export function resolveSummarizerModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  config: ShadowCompactConfig,
): Model<Api> {
  const configured = config.summarizerModel;
  const model = configured.provider
    ? ctx.modelRegistry.find(configured.provider, configured.id)
    : ctx.model;
  if (model) return model;
  const name = configured.provider
    ? `${configured.provider}/${configured.id}`
    : "current Pi session model";
  throw new Error(`Summary model not found: ${name}`);
}

/**
 * Resolves the second-pass verification model. A configured
 * `verificationModel` pair wins; otherwise the verifier reuses the resolved
 * summarizer model, so verification stays on with no config change.
 */
export function resolveVerificationModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  config: ShadowCompactConfig,
): Model<Api> {
  const configured = config.verificationModel;
  if (!configured || !configured.provider) return resolveSummarizerModel(ctx, config);
  const model = ctx.modelRegistry.find(configured.provider, configured.id);
  if (model) return model;
  throw new Error(`Verification model not found: ${configured.provider}/${configured.id}`);
}

/**
 * Structural validation for structured checkpoints (notably the
 * checkpoint-agent `submit_checkpoint` tool payload).
 */
export function validateCheckpointObject(value: unknown, knownRefs: Set<string>): Checkpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Checkpoint must be a JSON object");
  }
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (
      !SECTIONS.includes(key as SectionName) &&
      key !== VERIFICATION_SECTION &&
      key !== CONTINUATION_KEY
    ) {
      throw new Error(
        `Unexpected checkpoint key: ${key}. A checkpoint holds sections only; submit-tool arguments belong beside checkpoint, not inside it.`,
      );
    }
  }
  const checkpoint = {} as Checkpoint;
  let total = 0;
  for (const section of SECTIONS) {
    checkpoint[section] = parseSection(source, section, knownRefs);
    total += checkpoint[section].length;
  }
  // New sections are optional at parse time so checkpoints produced before
  // the schema addition (and canned test fixtures) keep loading; the
  // checkpoint-agent submit path requires them explicitly.
  checkpoint.verificationState = parseVerificationSection(source, knownRefs);
  total += checkpoint.verificationState.length;
  checkpoint.continuationState = parseContinuationState(source);
  if (total === 0) throw new Error("Checkpoint cannot be entirely empty");
  return checkpoint;
}

function parseVerificationSection(
  source: Record<string, unknown>,
  knownRefs: Set<string>,
): VerificationItem[] {
  const value = source[VERIFICATION_SECTION];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Checkpoint section ${VERIFICATION_SECTION} must be an array`);
  }
  if (value.length > MAX_ITEMS_PER_SECTION) {
    throw new Error(`Checkpoint section ${VERIFICATION_SECTION} exceeds ${MAX_ITEMS_PER_SECTION} items`);
  }
  return value.map((item, index) => parseVerificationItem(item, index, knownRefs));
}

function parseVerificationItem(
  value: unknown,
  index: number,
  knownRefs: Set<string>,
): VerificationItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const received = Array.isArray(value) ? "array" : typeof value;
    throw new Error(
      `Item ${index} in ${VERIFICATION_SECTION} must be an object like {"text": "...", "status": "verified", "evidenceRefs": ["E0001"]}, got ${received}`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "text" && key !== "status" && key !== "evidenceRefs") {
      throw new Error(`Item ${index} in ${VERIFICATION_SECTION} has unexpected key: ${key}`);
    }
  }
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) throw new Error(`Item ${index} in ${VERIFICATION_SECTION} has empty text`);
  if (text.length > MAX_ITEM_CHARS) {
    throw new Error(`Item ${index} in ${VERIFICATION_SECTION} exceeds text limit`);
  }
  if (record.status !== "verified" && record.status !== "unverified") {
    throw new Error(`Item ${index} in ${VERIFICATION_SECTION} needs status verified or unverified`);
  }
  const refs = record.evidenceRefs;
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Error(`Item ${index} in ${VERIFICATION_SECTION} needs at least one evidenceRef`);
  }
  if (refs.length > MAX_REFS_PER_ITEM) {
    throw new Error(`Item ${index} in ${VERIFICATION_SECTION} exceeds ${MAX_REFS_PER_ITEM} evidenceRefs`);
  }
  for (const ref of refs) {
    if (typeof ref !== "string" || !knownRefs.has(ref)) {
      throw new Error(`Unknown evidence reference: ${String(ref)}`);
    }
  }
  return { text, status: record.status, evidenceRefs: refs as string[] };
}

const CONTINUATION_FIELDS = ["currentGoal", "currentApproach", "immediateNextStep"] as const;

function parseContinuationState(source: Record<string, unknown>): ContinuationState {
  const value = source[CONTINUATION_KEY];
  if (value === undefined) return emptyContinuationState();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Checkpoint section ${CONTINUATION_KEY} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(CONTINUATION_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`Checkpoint section ${CONTINUATION_KEY} has unexpected key: ${key}`);
    }
  }
  const state = emptyContinuationState();
  for (const field of CONTINUATION_FIELDS) {
    const text = typeof record[field] === "string" ? (record[field] as string).trim() : "";
    if (!text) throw new Error(`Checkpoint section ${CONTINUATION_KEY}.${field} must be a non-empty string`);
    if (text.length > MAX_ITEM_CHARS) {
      throw new Error(`Checkpoint section ${CONTINUATION_KEY}.${field} exceeds text limit`);
    }
    state[field] = text;
  }
  return state;
}

function parseSection(
  source: Record<string, unknown>,
  section: SectionName,
  knownRefs: Set<string>,
): CheckpointItem[] {
  const value = source[section];
  if (value === undefined && section === "objective") {
    throw new Error(`Missing checkpoint section: ${section}`);
  }
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Checkpoint section ${section} must be an array`);
  if (value.length > MAX_ITEMS_PER_SECTION) {
    throw new Error(`Checkpoint section ${section} exceeds ${MAX_ITEMS_PER_SECTION} items`);
  }
  return value.map((item, index) => parseItem(item, section, index, knownRefs));
}

function parseItem(
  value: unknown,
  section: SectionName,
  index: number,
  knownRefs: Set<string>,
): CheckpointItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const received = Array.isArray(value) ? "array" : typeof value;
    throw new Error(
      `Item ${index} in ${section} must be an object like {"text": "...", "evidenceRefs": ["E0001"]}, got ${received}: resubmit the same entry as an object, never a bare string`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "text" && key !== "evidenceRefs") {
      throw new Error(`Item ${index} in ${section} has unexpected key: ${key}`);
    }
  }
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) throw new Error(`Item ${index} in ${section} has empty text`);
  if (text.length > MAX_ITEM_CHARS) throw new Error(`Item ${index} in ${section} exceeds text limit`);

  const refs = record.evidenceRefs;
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Error(`Item ${index} in ${section} needs at least one evidenceRef`);
  }
  if (refs.length > MAX_REFS_PER_ITEM) {
    throw new Error(`Item ${index} in ${section} exceeds ${MAX_REFS_PER_ITEM} evidenceRefs`);
  }
  for (const ref of refs) {
    if (typeof ref !== "string" || !knownRefs.has(ref)) {
      throw new Error(`Unknown evidence reference: ${String(ref)}`);
    }
  }
  return { text, evidenceRefs: refs as string[] };
}

function safeText(value: string): string {
  return value.replace(/\s*\r?\n+\s*/g, " ").trim();
}

export function renderCheckpoint(checkpoint: Checkpoint): string {
  const sections = SECTIONS.map((section) => {
    const title = section
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^./, (char) => char.toUpperCase());
    const lines = checkpoint[section].map((item) => `- ${safeText(item.text)}`);
    return `## ${title}\n${lines.length ? lines.join("\n") : "(none)"}`;
  });
  // Schema additions render only when populated, so checkpoints produced
  // before them keep their exact legacy rendering.
  const verification = checkpoint.verificationState ?? [];
  if (verification.length > 0) {
    const lines = verification.map((item) => `- [${item.status}] ${safeText(item.text)}`);
    sections.push(`## Verification State\n${lines.join("\n")}`);
  }
  const continuation = checkpoint.continuationState;
  if (continuation && (continuation.currentGoal || continuation.currentApproach || continuation.immediateNextStep)) {
    sections.push(
      `## Continuation\n- Goal: ${safeText(continuation.currentGoal) || "(none)"}\n- Approach: ${safeText(continuation.currentApproach) || "(none)"}\n- Next: ${safeText(continuation.immediateNextStep) || "(none)"}`,
    );
  }
  const rendered = `# Continuation Checkpoint\n\n${sections.join("\n\n")}\n`;
  if (rendered.length > MAX_RENDERED_CHARS) throw new Error("Rendered checkpoint exceeds size limit");
  return rendered;
}

/** Combines the summarizer and verifier model usages into one checkpoint cost. */
export function combineUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    ...(a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined
      ? { cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0) }
      : {}),
    ...(a.reasoning !== undefined || b.reasoning !== undefined
      ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }
      : {}),
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

/**
 * Durable checkpoint data model (refactor §2, §9, §24).
 *
 * A checkpoint is evidence-grounded against the durable session, and
 * `coverage` states precisely how far that grounding extends. The summary
 * text is a rendering; the structured checkpoint is the durable object.
 */

/**
 * Current durable checkpoint schema version. Only this version is readable:
 * pre-v3 entries (the removed historic-turn subsystem, `historicTurns`,
 * relevance prompt versions) are ignored on restore rather than migrated.
 */
export const CHECKPOINT_SCHEMA_VERSION = 3;

/** Prompt versions carried by every checkpoint. */
export const SUMMARY_PROMPT_VERSION = 3;
export const VERIFIER_PROMPT_VERSION = 3;

export interface PromptVersions {
  summaryPromptVersion: number;
  verifierPromptVersion: number;
}

export function currentPromptVersions(): PromptVersions {
  return {
    summaryPromptVersion: SUMMARY_PROMPT_VERSION,
    verifierPromptVersion: VERIFIER_PROMPT_VERSION,
  };
}

/**
 * Where a checkpoint's evidence grounding starts and ends.
 *
 * - `sourceStartEntryId`: oldest session entry eligible as evidence (null
 *   when the checkpoint covers from the session start).
 * - `coverageEndEntryId`: the summary is guaranteed to represent session
 *   history through this entry. Never inferred from when generation
 *   completed: a checkpoint triggered at 60% that finishes at 79% covers
 *   only what its agent actually inspected.
 * - `preparedAtLeafId`: branch leaf when preparation started.
 * - `publishedAtLeafId`: branch leaf when the checkpoint published (the
 *   session kept moving while the agent worked).
 */
export interface CheckpointCoverage {
  sourceStartEntryId: string | null;
  coverageEndEntryId: string;
  preparedAtLeafId: string;
  publishedAtLeafId: string;
}

export interface ShadowCheckpoint {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  structured: Checkpoint;
  rendered: string;
  coverage: CheckpointCoverage;
  generatedAt: number;
  prompts: PromptVersions;
  usage?: Usage;
  details?: FileDetails;
}

/**
 * Builds coverage for a freshly generated checkpoint. The agent-supplied
 * `coverageEndEntryId` is authoritative; the leaves record branch movement
 * during generation so the swap can prove a gap-free tail.
 */
export function buildCoverage(options: {
  sourceStartEntryId: string | null;
  coverageEndEntryId: string;
  preparedAtLeafId: string;
  publishedAtLeafId: string;
}): CheckpointCoverage {
  return {
    sourceStartEntryId: options.sourceStartEntryId,
    coverageEndEntryId: options.coverageEndEntryId,
    preparedAtLeafId: options.preparedAtLeafId,
    publishedAtLeafId: options.publishedAtLeafId,
  };
}
