import { z } from "zod";
import type { NormalizedPacket } from "./types.js";

export const MAX_PROVENANCE_EVIDENCE_REFS = 64;

const MAX_ITEM_CHARS = 8_000;
const MAX_ITEMS_PER_SECTION = 100;
const MAX_REFS_PER_ITEM = 32;
const MAX_RENDERED_CHARS = 64_000;

const NonEmptyText = z.string().trim().min(1).max(MAX_ITEM_CHARS);
const EvidenceRefs = z.array(NonEmptyText).min(1).max(MAX_REFS_PER_ITEM);
const items = <T extends z.ZodType>(schema: T) => z.array(schema).max(MAX_ITEMS_PER_SECTION);

const TextItemSchema = z
  .object({
    text: NonEmptyText,
    evidenceRefs: EvidenceRefs,
  })
  .strict();

const ObjectiveItemSchema = TextItemSchema;
const ConstraintItemSchema = TextItemSchema;
const CompletedWorkItemSchema = z
  .object({
    work: NonEmptyText,
    result: NonEmptyText,
    verification: NonEmptyText,
    evidenceRefs: EvidenceRefs,
  })
  .strict();
const DiscoveryItemSchema = z
  .object({
    discovery: NonEmptyText,
    evidence: NonEmptyText,
    implication: NonEmptyText,
    evidenceRefs: EvidenceRefs,
  })
  .strict();
const DecisionItemSchema = z
  .object({
    decision: NonEmptyText,
    rationale: NonEmptyText,
    evidenceRefs: EvidenceRefs,
  })
  .strict();
const CurrentStateItemSchema = z
  .object({
    state: NonEmptyText,
    evidenceRefs: EvidenceRefs,
  })
  .strict();
const RejectedApproachItemSchema = z
  .object({
    approach: NonEmptyText,
    rationale: NonEmptyText,
    evidenceRefs: EvidenceRefs,
  })
  .strict();
const OpenIssueItemSchema = z
  .object({
    issue: NonEmptyText,
    evidenceRefs: EvidenceRefs,
  })
  .strict();
const NextActionItemSchema = z
  .object({
    action: NonEmptyText,
    evidenceRefs: EvidenceRefs,
  })
  .strict();
const ContinuityItemSchema = z
  .object({
    data: NonEmptyText,
    evidenceRefs: EvidenceRefs,
  })
  .strict();
const FileItemSchema = z
  .object({
    path: NonEmptyText,
    evidenceRefs: EvidenceRefs,
  })
  .strict();

const checkpointShape = {
  objective: items(ObjectiveItemSchema),
  constraints: items(ConstraintItemSchema),
  completedWork: items(CompletedWorkItemSchema),
  discoveries: items(DiscoveryItemSchema),
  decisions: items(DecisionItemSchema),
  currentState: items(CurrentStateItemSchema),
  rejectedApproaches: items(RejectedApproachItemSchema),
  openIssues: items(OpenIssueItemSchema),
  nextActions: items(NextActionItemSchema),
  continuityData: items(ContinuityItemSchema),
  modifiedFiles: items(FileItemSchema),
  referencedFiles: items(FileItemSchema),
};

function checkpointSchema() {
  return z.object(checkpointShape).strict().superRefine((value, context) => {
    if (Object.values(value).every((section) => section.length === 0)) {
      context.addIssue({ code: "custom", message: "Checkpoint cannot be entirely empty" });
    }
  });
}

/** Exhaustive first-pass extraction from the normalized evidence packet. */
export const EvidenceInventorySchema = checkpointSchema();

/** Complete inventory after correction and supersession auditing. */
export const AuditedInventorySchema = checkpointSchema();

/** Concise data from which the continuation checkpoint is rendered. */
export const CompressedCheckpointSchema = checkpointSchema();
export const CheckpointSchema = CompressedCheckpointSchema;

export type EvidenceInventory = z.infer<typeof EvidenceInventorySchema>;
export type AuditedInventory = z.infer<typeof AuditedInventorySchema>;
export type CompressedCheckpoint = z.infer<typeof CompressedCheckpointSchema>;
export type Checkpoint = CompressedCheckpoint;

export function parseModelJson(raw: string): unknown {
  const source = raw.trim();
  const fenced = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(source);
  const json = fenced ? fenced[1] : source;

  if (!fenced && source.includes("```")) {
    throw new Error("Expected raw JSON or one JSON fence with no surrounding prose");
  }

  try {
    return JSON.parse(json ?? "");
  } catch (error) {
    throw new Error("Model output is not valid JSON", { cause: error });
  }
}

function evidenceIds(packet: NormalizedPacket): Set<string> {
  return new Set(packet.evidence.map((item) => item.evidenceId));
}

function schemaForPacket<T extends z.ZodType>(schema: T, packet: NormalizedPacket): T {
  const allowed = evidenceIds(packet);
  return schema.superRefine((value, context) => {
    visitEvidenceRefs(value, (ref, path) => {
      if (!allowed.has(ref)) {
        context.addIssue({
          code: "custom",
          message: `Unknown evidence reference: ${ref}`,
          path,
        });
      }
    });
  }) as T;
}

function visitEvidenceRefs(
  value: unknown,
  visit: (ref: string, path: (string | number)[]) => void,
  path: (string | number)[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitEvidenceRefs(item, visit, [...path, index]));
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (key === "evidenceRefs" && Array.isArray(child)) {
      child.forEach((ref, index) => {
        if (typeof ref === "string") visit(ref, [...childPath, index]);
      });
    } else {
      visitEvidenceRefs(child, visit, childPath);
    }
  }
}

function parseGrounded<T extends z.ZodType>(
  raw: string,
  schema: T,
  packet: NormalizedPacket,
): z.output<T> {
  return schemaForPacket(schema, packet).parse(parseModelJson(raw));
}

export function parseEvidenceInventory(
  raw: string,
  packet: NormalizedPacket,
): EvidenceInventory {
  return parseGrounded(raw, EvidenceInventorySchema, packet);
}

export function parseAuditedInventory(
  raw: string,
  packet: NormalizedPacket,
): AuditedInventory {
  return parseGrounded(raw, AuditedInventorySchema, packet);
}

export function parseCheckpoint(raw: string, packet: NormalizedPacket): Checkpoint {
  return parseGrounded(raw, CompressedCheckpointSchema, packet);
}

export function collectEvidenceRefs(
  checkpoint: Checkpoint,
  cap = MAX_PROVENANCE_EVIDENCE_REFS,
): string[] {
  if (!Number.isSafeInteger(cap) || cap < 0) throw new Error("Evidence reference cap must be a non-negative integer");

  const refs = new Set<string>();
  visitEvidenceRefs(checkpoint, (ref) => refs.add(ref));
  return [...refs].sort().slice(0, cap);
}

function safeText(value: string): string {
  return value.replace(/\s*\r?\n+\s*/g, " ").trim();
}

function section(title: string, lines: string[]): string {
  return `## ${title}\n${lines.length ? lines.join("\n") : "(none)"}`;
}

function bullets<T>(values: T[], render: (item: T) => string): string[] {
  return values.map((item) => `- ${safeText(render(item))}`);
}

/** Render only checkpoint content. Evidence references remain provenance-only. */
export function renderCheckpoint(checkpoint: Checkpoint): string {
  const sections = [
    section("Objective", bullets(checkpoint.objective, (item) => item.text)),
    section("Constraints and Preferences", bullets(checkpoint.constraints, (item) => item.text)),
    section(
      "Completed Work",
      bullets(
        checkpoint.completedWork,
        (item) => `${item.work}\n  - Result: ${item.result}\n  - Verification: ${item.verification}`,
      ),
    ),
    section(
      "Discoveries",
      bullets(
        checkpoint.discoveries,
        (item) => `${item.discovery}\n  - Evidence: ${item.evidence}\n  - Implication: ${item.implication}`,
      ),
    ),
    section(
      "Decisions",
      bullets(checkpoint.decisions, (item) => `${item.decision}\n  - Rationale: ${item.rationale}`),
    ),
    section("Current State", bullets(checkpoint.currentState, (item) => item.state)),
    section(
      "Rejected Approaches",
      bullets(checkpoint.rejectedApproaches, (item) => `${item.approach}\n  - Rationale: ${item.rationale}`),
    ),
    section("Open Issues", bullets(checkpoint.openIssues, (item) => item.issue)),
    section("Next Actions", bullets(checkpoint.nextActions, (item) => item.action)),
    section("Continuity Data", bullets(checkpoint.continuityData, (item) => item.data)),
    section("Modified Files", bullets(checkpoint.modifiedFiles, (item) => item.path)),
    section("Referenced Files", bullets(checkpoint.referencedFiles, (item) => item.path)),
  ];

  const rendered = `# Continuation Checkpoint\n\n${sections.join("\n\n")}\n`;
  if (rendered.length > MAX_RENDERED_CHARS) throw new Error("Rendered checkpoint exceeds size limit");
  return rendered;
}
