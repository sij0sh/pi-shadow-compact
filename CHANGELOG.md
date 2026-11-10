# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- One `SECTIONS` list derives the checkpoint tool schema, validation,
  rendering, and persisted-entry keys (was three copies).
- One `checkpointStalenessReason` rule backs swaps, restore, and native
  recovery, and one sync drops unservable checkpoints at `turn_start`,
  `context`, `turn_end`, idle settle, and persist.
- Builder and verifier agents share one runner bootstrap; the two compaction
  paths share one projection helper.
- `checkpoint.ts` folded into `summary.ts`, `prepare.ts` into
  `working-context.ts` (17 → 15 modules).
- `PreparedResult` is the persisted checkpoint: a published result is appended
  as-is and restore hands the entry straight back, so `toPersistedCheckpoint`
  and `toPreparedResult` no longer exist.
- Verifier accept and repair share one validation rule; evidence reads and
  coverage are checked for both regardless of `targetSummaryChars`.
- One settings surface validates every file and env setting; env-only knobs
  keep their names and messages are uniform.

### Removed

- `swapThresholdPercent` and `SHADOW_COMPACT_HARD_THRESHOLD_PERCENT`. It never
  gated a swap; a ready checkpoint always served. Configs or env vars that set
  it now fail validation instead of silently accepting a dead knob.
- `SHADOW_COMPACT_ACTION_FIRST` render arm (dead experiment toggle).
- v1/v2 checkpoint read path. Only the current schema version restores; older
  entries are ignored, so a session upgraded from a pre-v3 release starts cold
  once. `CHECKPOINT_CUSTOM_TYPE_LEGACY` and the per-version readers are gone.
- `state.active` getter and `isAtOrAboveNativeFallback`: the getter was
  only ever read by its own test (`publishedSwapped` still exposes the
  transition), and the predicate existed inline in the hook.
- `request-trace.ts` (190-line always-on provider observer). The
  `acting_request` trace event, the payload clamp warning, and the
  `context_with_system`/`before_provider_request`/`after_provider_response`/
  `provider_stream_event`/`message_end` hooks are gone with it.

## [0.2.2] - 2026-11-09

### Added

- GitHub Actions CI (typecheck, tests, bundle build on Node 22 and 24).
- Dependabot for npm and GitHub Actions updates.
- `.nvmrc` pinning Node 22.23.4.
- MIT `LICENSE` file.
- Prettier configuration and `format` scripts.

### Changed

- README Node requirement now matches the `engines` field.
- Project compaction and verification models use
  `commandcode/deepseek/deepseek-v4.1-flash`.

## [0.2.1] - 2026-10-21

### Fixed

- Keep near-miss checkpoint summaries up to a hard cap.
- Reject bare-string checkpoint items with actionable schema guidance.

### Changed

- Require Node versions patched for the eMudhra CA incident.

## [0.2.0] - 2026-10-14

### Added

- Request budget diagnostics for acting-request output starvation.
- Shared safe budget and termination telemetry across trace modules.

### Fixed

- Bound private reads and transcript growth.

[Unreleased]: https://github.com/sij0sh/pi-shadow-compact/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/sij0sh/pi-shadow-compact/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/sij0sh/pi-shadow-compact/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/sij0sh/pi-shadow-compact/releases/tag/v0.2.0
