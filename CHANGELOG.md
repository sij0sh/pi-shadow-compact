# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
