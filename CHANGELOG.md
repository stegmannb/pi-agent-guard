# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- `globMatch` now matches dot files (e.g., `*.env` matches `.env`) thanks to @tdiam

### Changed

- Default rules for `read` now use `**/*.env` and `**/*.pem` to deny access in nested directories too, thanks to @tdiam

## [1.2.0] - 2026-04-19

### Added

- **Profiles** — Named rule overlays that can be activated during a session. Useful for switching between permission modes (e.g., read-only vs read-write) without editing config.
- **Shortcuts** — Custom commands that activate profiles or deactivate them. Define `/rw` to activate a "read-write" profile, `/ro` to deactivate.
- `/guard profile` — Show active profile and available profiles
- `/guard profile <name>` — Activate a profile by name
- `/guard profile off` — Deactivate current profile
- `/guard enable` — Enable guard
- `/guard disable` — Disable guard

### Changed

- `/guard list` now shows rules organized by provenance layer (default → user → project → environment → profile → session) instead of merged effective rules.
- Rule precedence corrected: `default → user → project → env → profile → session`. Session rules now correctly override env (`PI_GUARD`).
- Configuration (user, project, env) is now loaded once at extension startup instead of on every tool call, improving performance.

## [1.1.0] - 2026-04-01

### Added

- Safe bash commands — whitelisted commands that bypass permission checks (`echo`, `printf`, `true`, `false`, `pwd`, `cd`, etc.)
- `gh` CLI support — built-in matcher for GitHub CLI commands with subsequence matching
- `find -exec` rule — requires explicit approval for `find -exec` commands
- Matchers and rules for optional tools `grep`, `find`, and `ls`
- GitHub Actions workflow for trusted npm publishing via OIDC

### Fixed

- `/guard list` now shows effective rules (previously showed only base config)

### Changed

- Consolidated default configuration into `defaults.ts` for single source of truth
- Simplified README

## [1.0.0] - 2026-03-28

### Added

- General-purpose permission system for pi tools, replacing `pi-unbash`.
- Built-in matchers for core tools:
  - `bash` — Parses commands with unbash AST parser, extracts all commands, uses subsequence matching. Rule tokens must appear in order but extra flags/arguments are permitted. Example: `"git log"` matches `git log`, `git log --oneline`, `git log --oneline -10`.
  - `glob` — Standard glob matching with `*` and `**` support, `?` for single character, and `~` home directory expansion. For file paths, URLs, etc.
  - `exact` — Simple string equality for enum values, agent names, etc.
- Extensible matchers via configuration — add permission checking for any tool by defining a `param` and `type` in settings.
- Three permission actions: `allow` (run without approval), `ask` (prompt user), `deny` (block the action).
- Rule precedence in merge order: `DEFAULT_CONFIG → user config → project config → PI_GUARD → session rules`. Last match wins within each layer.
- `PI_GUARD` environment variable for injecting rules from outside (e.g., CI/CD, pi-spawn).
- Project-level settings from `.pi/settings.json` — share team rules via version control.
- `/guard toggle` — Enable or disable the guard system.
- `/guard list` — Display current configuration including all rule layers.
- Session-scoped approvals — "Always allow X (this session)" option in approval prompts without persisting to disk.
- Comprehensive bash command extraction — handles pipes, subshells, command substitutions, process substitutions, redirects, heredocs, arithmetic expansions, and control flow structures (`if`, `while`, `for`, `case`, functions).
- Smart command display — path-aware elision for long paths, preserves original quoting, handles heredocs and redirects.
- Block messages for user rejection vs security policy vs non-interactive mode.
