# Protection snapshot v1

Guard registers `pasa:protection:snapshot:v1` on the trusted local Pi EventBus.
This is an instance API for a process host such as PASA. It is not an agent tool,
permission grant, inventory API, or transport protocol. A host must independently
verify its actual loaded extension inventory and classify every extension.

Load the package's `index.ts` normally and finish `session_start` before asking
for a snapshot. The public Pi 0.73 SDK integration test loads this entrypoint with
`DefaultResourceLoader`, binds a real session, then repeats initialization in a
separate child process without executing a model prompt.

## Request and response

The authoritative TypeScript types are `SnapshotRequest` and `SnapshotResponse`
in `src/protection-snapshot.ts`. Send this object through the local event bus:

```ts
pi.events.emit("pasa:protection:snapshot:v1", {
  version: 1,
  requestId: crypto.randomUUID(),
  protectionId: "pi-agent-guard",
  expectedSessionId: ctx.sessionManager.getSessionId(),
  targetCwd: canonicalChildCwd,
  respond(response) {
    // Validate identity, status, binding and all fingerprints here.
  },
});
```

The handler answers synchronously and at most once per request ID for the life
of this registered instance. Requests for another protection, malformed requests,
and duplicate IDs receive no response. The consumer must impose a deadline and
refuse missing, duplicate, mismatched or unsupported replies. A throwing callback
is not retried. No snapshot operation executes a tool, prompt, approval dialog,
or configuration write.

A ready reply contains:

- `version`, `requestId`, `protectionId` and `status: "ready"`;
- `binding` with the live parent session ID, canonical parent cwd and generation;
- `enabled: true`, `initialized: true` and `stateDigest`;
- `codeFiles` and `configurationFiles`, each containing only canonical absolute
  paths and SHA-256 fingerprints;
- `environment`, containing fingerprints for `PI_GUARD`, `PI_CODING_AGENT_DIR`
  and `HOME`, including an explicit absent-value representation;
- `replay` with `kind: "file-backed"`, the verified child cwd and expected child
  state digest.

The digest includes the live policy snapshot, configured profiles/shortcuts,
resolved reviewer policy and noncredential reviewer model definition. Records
are normalized to ordered key/value pairs and undefined properties are omitted
before hashing JSON. Rule order is significant, so sorting rule keys would be
incorrect. Session IDs, generation and cwd are in the binding, outside this
policy digest. The child computes its own digest after its own initialization.
It never receives an expected digest to echo.

## File-backed replay and cwd resolution

The adapter observes the bytes actually consumed by the existing global,
project, environment and reviewer policy-file loaders. It retains missing-file
observations too. Before every reply it checks these observations, runs the
actual configuration resolvers again for both parent and target cwd, and compares
their effective states and configuration-file roles. Edits behind a live Guard
are drift, not replacement live policy.

Different parent and child worktrees are supported when their effective policy,
config file contents and file-presence observations agree. Missing or extra
project settings refuse even when they would currently have no rule effect.
The target must already exist and be a canonical realpath. No file is copied and
no parent state is changed to make a target pass.

`configurationFiles` identifies the parent files. A consumer comparing separate
but equal `.pi/settings.json` files must map that project reference from the
parent cwd to the child cwd before comparing hashes. Global settings and policy
files must retain their shared identity. With no project settings, the references
are directly comparable across worktrees. The host must recheck the parent after
child initialization and before authorizing its first prompt, and repeat this for
every new process or follow-up. Child-side checks are also required before every
prompt. A ready snapshot is evidence at a point in time, not a filesystem lock.

## Loaded code and deployment manifest

`protection-code.json` is checked-in deployment metadata, generated from the
entrypoint's complete local TypeScript import/export graph. The generator uses
the TypeScript parser, follows local imports including type dependencies, rejects
unknown package imports and dynamic loading, and requires the load hook before
each local module body. The manifest includes package metadata, the lockfile and all files of the installed `minimatch`/`unbash` dependencies, including their transitive packages. Runtime validation checks complete file membership as well as hashes; an incomplete manifest or newly added dependency file refuses readiness.
Pi's peer APIs are supplied by the trusted SDK host; the host owns their provenance.

Every local module imports `src/loaded-code.ts` first. That module reads and
validates the manifest once before Guard code runs and retains those fingerprints
through cached imports and later registrations. Missing, stale or unreadable
metadata refuses readiness. Every reply rechecks all captured code files,
including the manifest. It never scans today's source and presents those hashes
as proof of previously loaded code. Copy the manifest with `index.ts`, `src`,
`package.json` and `pnpm-lock.yaml` when packaging a file-backed deployment.

After modifying production source, package metadata or the lockfile, run:

```sh
pnpm run format
pnpm run protection:manifest
pnpm run verify
```

`verify` checks manifest exactness as well as types, lint, formatting and tests.
The Forgejo test workflow performs a frozen install and this same verification
with the repository's locked Nix tool inputs. Existing publish/tag/release
workflows are unchanged.

## Unsupported states and lifecycle

Unsupported replies contain identity fields and one fixed reason code, without
raw exceptions, configuration text, credentials, authentication files or API-key
environment fingerprints.

| Reason | Meaning |
| --- | --- |
| `NOT_INITIALIZED` | Before completed `session_start`, during initialization or after shutdown. |
| `INITIALIZATION_FAILED` | Guard's `session_start` threw. |
| `SESSION_MISMATCH` | The request or live context refers to another session. |
| `DISABLED` | Guard is effectively disabled. Snapshotting never enables it. |
| `RUNTIME_MUTATION` | Session/profile/enablement/reviewer override, pending or retained approval/decision state, active tool approval, or unsupported lifecycle transition. |
| `CONFIG_DRIFT` | Loaded code, consumed config, config presence, environment or parent resolver no longer matches the captured instance. |
| `CWD_UNREPRODUCIBLE` | Target cwd is noncanonical or its actual resolution is not equivalent. |
| `UNBACKED_CONFIGURATION` | Custom bootstrap, unknown code closure, invalid configuration, credential-bearing settings, custom model config, unreproducible reviewer model or unexpected inspection failure. |

V1 refuses any explicitly supplied `GuardBootstrap` object, including injected approval/reviewer
callbacks and configuration that happens to equal disk. It also refuses active
reviewers following the main model and custom `models.json` configurations.
Fixed reviewer models must resolve successfully and match the complete built-in
model definition supplied by the host Pi AI package. Custom definitions refuse. Model headers and credential-bearing URLs are unsupported. Only a
hash of the resulting reviewer state is returned. Settings with explicit
credential/auth fields refuse before file references are emitted.

The adapter detects changes to the live policy and reviewer state. Mutation
history remains unsupported until a genuine new `session_start`; toggling back
or deactivating a profile cannot restore an earlier capture. It does not reset
Guard. Existing Guard lifecycle handlers retain their original session-reset
behavior. Switch/fork/tree transitions are unsupported until completed
`session_start`, including cancelled transitions. Generations increase across
initialization, transitions, tool approval windows and observed mutations.
Repeated read-only snapshots leave policy and generation unchanged.

The tests cover a real SDK parent/child, equivalent and differing worktrees,
load-time configuration drift, new/missing files, reviewer policy/model changes,
startup failure, lifecycle transitions, pending approval races, preserved session
grants, credential redaction, unknown deployment metadata and response deduplication.

## Biome on Nix Node in musl containers

The test runner can use glibc-linked Nix Node while the surrounding container's
`ldd` reports musl. Biome 2.4.11 otherwise selects the musl executable, although
pnpm installed the glibc executable for that Node process. The version-bound pnpm
patch in `patches/@biomejs__biome@2.4.11.patch` checks a positive
`process.report.getReport().header.glibcVersionRuntime` first. If the report is
missing, has no glibc evidence, or throws, the original `ldd` fallback still runs.
Non-Linux platforms and `BIOME_BINARY` keep their original selection paths.

`test/biome-loader.test.ts` executes the entire installed loader with controlled
host facts and a mocked process launch, then also launches the actual local
native executable. The patch binding is in `pnpm-workspace.yaml`, which both the
CI's pnpm 10 and the Nix package's pnpm 11 read. Frozen installation verifies the
patch metadata. Reassess the patch when updating Biome; do not remove a failing
check or change package versions to work around libc selection.

Selecting the glibc binary does not supply its ELF interpreter. The original
Linux x64 npm binary requests `/lib64/ld-linux-x86-64.so.2`, which an Alpine
container may lack even when Nix Node runs successfully. CI therefore builds
`nix build .#biome-ci --no-link --print-out-paths` and sets `BIOME_BINARY` to that
package's `bin/biome` before running the unchanged checks through pnpm.

`nix/biome-ci.nix` fetches the original platform-specific npm archive at exactly
2.4.11. Evaluation requires the version to match `package.json` and its SHA-512
to match the archive's `pnpm-lock.yaml` entry. The locked Nixpkgs Biome package
is 2.4.15 and is not used. Linux `autoPatchelfHook` sets the interpreter to the
locked Nix glibc and resolves `libgcc_s.so.1` from Nix GCC. With the current
x64 lock, these are glibc 2.42-61 and GCC 15.2.0; glibc supplies `libpthread`,
`libm`, `libdl`, and `libc`. No container `/lib` or `/usr/lib` installation is
needed. The package records the actual interpreter, RPATH, and resolved library
paths in `nix-support/elf-runtime`, which CI prints. ASLR addresses are omitted
from that reproducible record.

The package build executes `--version`, requires exactly `Version: 2.4.11`,
and verifies that a real parser invocation rejects invalid JavaScript. The
installed-loader test also starts the selected native binary and checks its
exact version. Missing interpreters, unresolved libraries, fetch/hash mismatch,
or a version mismatch fail the build; lint and format checks remain mandatory.
Darwin packages use the corresponding unchanged npm binary for local checks.
This package is a CI tool only and does not enter Guard's runtime code manifest.

The lockfile assertion uses a literal substring search. Do not replace it with
`lib.hasInfix`: that function wraps the whole input in a regular expression,
which overflows Linux Nix 2.31.5's stack on this 104-KB lockfile during evaluation.
The literal check still requires the exact platform, version, and archive hash.
