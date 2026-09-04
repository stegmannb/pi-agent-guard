# Forgejo Tier 0

This repository is a Tier-0 command-security boundary. Forgejo is the primary
development platform; GitHub is a mirror. Changes to
command extraction, wrapper expansion, rule matching, configuration precedence,
or bypass handling can change which agent tool calls execute without a prompt.

Every Forgejo pull request must produce these exact checks on its current head:

- `ci / policy (pull_request)`
- `ci / typecheck (pull_request)`
- `ci / lint (pull_request)`
- `ci / format (pull_request)`
- `ci / test (pull_request)`

The jobs are unconditional, credentialless, and run from an ephemeral copy of
the exact pull-request head. Dependency installation and protected npm-script
execution use the committed pnpm lockfile and patches with lifecycle hooks disabled; policy also
rejects `pre*`/`post*` hooks for the verification chain and freezes the
repository npm configuration. Each gate selects the pinned Nix Bash explicitly
as npm's script shell. Installation uses the frozen lockfile without lifecycle
hooks. The test gate
runs the complete `npm run verify` contract, including the negative
command-extraction, denial, nested-wrapper, and precedence fixtures.

The Forgejo release profile is `none`. Forgejo workflows must not run on pushes,
create tags, publish packages, create Forgejo Releases, or receive publishing
credentials. The existing `.github/workflows/publish.yml` GitHub/npm contract is
a separate external release boundary and is deliberately unchanged by HL-0197.

Before merge, the Owner must configure and read back `main` protection: direct
and administrator pushes disabled, one current approval from
`Bastian/Reviewers`, stale approvals dismissed, unresolved change requests and
official review requests blocking, all five exact contexts required, and only
rebase/fast-forward merge paths enabled. The `agent review` check is required
in addition to the five CI checks. All Git tags must be protected with an empty
allowlist, and Forgejo Releases and Packages must be disabled. Record the audit
in `.forgejo/tier0.yaml`. Repeat the administrative readback
after Forgejo upgrades, protection changes, and by 2026-09-30.
