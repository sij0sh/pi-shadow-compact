# pi-shadow-compact

Proactive, evidence-grounded compaction for Pi.

The extension prepares a continuation checkpoint in the background after the live session reaches a configurable soft threshold. It reconstructs the active branch from Pi's persisted JSONL when available. It preserves useful tool evidence. It runs a private three-stage summary conversation with up to one corrective retry per stage.

The live Pi session receives no tools, skills, prompt snippets, messages, or system-prompt additions from this extension.

## Behavior

1. Pi becomes fully idle at or above the soft compaction threshold.
2. The extension asks Pi for its native compaction boundary and cancels that probe before mutation.
3. The extension reads the captured active branch from session JSONL.
4. It normalizes only evidence before Pi's `firstKeptEntryId`.
5. It runs private extract, audit, and compression requests through Pi's model registry.
6. It waits after the checkpoint becomes ready.
7. The next user or RPC prompt runs a real native compaction before Pi processes that prompt.
8. The compaction replaces pre-boundary history with the prepared checkpoint.
9. Pi retains the recent tail from `firstKeptEntryId` verbatim.

The extension does not wait for Pi's native threshold. The real compaction normally happens slightly above the configured soft threshold.

New messages can be added while preparation runs. Pi retains those messages together with the original native recent-token tail.

Manual, threshold, and overflow compactions use the same checkpoint pipeline when needed. Pi's native summarizer remains the fallback when custom preparation fails.

## Configuration

The extension reads configuration from the active project's path:

```text
.pi/shadow-compact.json
```

In the project where Pi will run, start from the tracked example:

```bash
mkdir -p /path/to/project/.pi
cp .pi/shadow-compact.example.json /path/to/project/.pi/shadow-compact.json
```

Git ignores the local configuration file. You do not need to publish personal model choices.

```json
{
  "softCompactThresholdPercent": 60,
  "summarizerModel": {
    "provider": "",
    "id": ""
  }
}
```

### Soft threshold

`softCompactThresholdPercent` accepts a number from `1` through `99`.

The default is `60`.

A lower value gives detached preparation more time to finish. A higher value avoids summaries for shorter sessions.

### Summarizer model

When `summarizerModel.provider` and `summarizerModel.id` are blank, the extension uses the current Pi session model.

To select a different model, set both fields to an exact provider and model ID registered in Pi:

```json
{
  "softCompactThresholdPercent": 60,
  "summarizerModel": {
    "provider": "my-provider",
    "id": "my-model-id"
  }
}
```

Pi resolves the pair through the live model registry. This includes models from the user-level custom model registry file:

```text
~/.pi/agent/models.json
```

Use a key under `providers` as the provider ID. Use the corresponding `models[].id` as the model ID. Both values must match exactly. The model must have usable authentication.

Model IDs can contain `/` or `:`, so provider and ID use separate fields. Do not copy a personal `models.json` into this repository because that file can contain credentials.

After changing `shadow-compact.json`, run `/reload` or restart Pi. After changing `models.json`, open `/model` first. Then run `/reload` or restart Pi.

Invalid configuration produces an error notification and disables soft preparation until the next reload.

Untrusted projects do not load project configuration. They use the 60% threshold and current session model.

## Pi compaction settings

Pi still controls the retained tail and emergency threshold. Put this object in `~/.pi/agent/settings.json` or the project's `.pi/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

`keepRecentTokens` controls the verbatim recent tail.

`reserveTokens` controls Pi's native late auto-compaction threshold.

## Build

Requirements:

- Node.js 22.19 or newer.
- Pi 0.84.4 or a compatible release.

```bash
npm ci
npm run check
```

The build creates:

```text
dist/shadow-compact.js
```

Zod is bundled into the distributable. Pi runtime packages remain external and resolve from the Pi harness.

## Install

Install globally:

```bash
mkdir -p ~/.pi/agent/extensions
cp dist/shadow-compact.js ~/.pi/agent/extensions/shadow-compact.js
```

Or install for one project:

```bash
mkdir -p .pi/extensions
cp /path/to/pi-shadow-compact/dist/shadow-compact.js .pi/extensions/shadow-compact.js
```

Restart Pi or run `/reload`.

## Summary pipeline

The extension uses persisted JSONL as its primary source. It falls back to Pi's captured active branch for ephemeral sessions or a missing session file.

The normalized transcript retains bounded semantic evidence from:

- User and assistant text.
- Reads and searches.
- Shell commands and output.
- Compiler and test failures.
- Edits, writes, and diffs.
- Unknown tools.
- Custom context messages.
- Active-path branch summaries.

It removes thinking blocks, images, provider metadata, old compaction entries, and common secret formats.

The private model conversation performs:

1. An exhaustive evidence inventory.
2. An omission and contradiction audit.
3. A concise checkpoint compression.

Every factual item must cite an evidence ID from the normalized packet. Code validates those references and renders the final Markdown. Evidence IDs are not included in the live model context.

## Large sessions

When the normalized raw branch exceeds the private input limit, the extension uses the latest prior checkpoint plus the newest pre-boundary raw evidence that fits.

If no safe packet can be formed, Pi uses its native summarizer.

Chunked map/reduce compaction is intentionally deferred.

## Limitations

Pi exposes the exact native preparation only during `session_before_compact`. The extension starts and immediately cancels a manual compaction to capture that preparation. The probe does not append a compaction entry, but some Pi interfaces may briefly display compaction status.

Extension slash commands run before Pi's `input` event. They may bypass ready-summary adoption until the next normal user or RPC prompt.

Secret redaction is defensive and heuristic. Do not treat it as a substitute for keeping secrets out of conversation history.
