import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface SnapshotIdentity {
  sessionFile?: string;
  sessionId: string;
  leafId: string;
  firstKeptEntryId: string;
}

export interface SessionSnapshot extends SnapshotIdentity {
  cwd: string;
  branch: SessionEntry[];
  sourceEntries: SessionEntry[];
  previousSummary?: string;
  source: "jsonl" | "branchEntries";
}

export interface NormalizedEvidence {
  evidenceId: string;
  sourceEntryId: string;
  kind:
    | "user"
    | "assistant"
    | "tool_call"
    | "tool_result"
    | "branch_summary"
    | "custom_message"
    | "bash"
    | "previous_checkpoint";
  text: string;
}

export interface NormalizedPacket {
  evidence: NormalizedEvidence[];
  digest: string;
  truncated: boolean;
  usedPreviousCheckpointFallback: boolean;
}

export interface SummaryResult {
  summary: string;
  usage: Usage;
  provenance: {
    digest: string;
    evidenceCount: number;
    truncated: boolean;
    usedPreviousCheckpointFallback: boolean;
    evidenceRefs: string[];
  };
}
