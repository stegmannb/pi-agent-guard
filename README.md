# pi-guard

**Permission system for [pi](https://github.com/mariozechner/pi-coding-agent) tools**

pi-guard intercepts tool calls and prompts for approval before executing potentially dangerous operations. It provides fine-grained, pattern-based permissions for bash commands, file access, and any custom tool — with sensible defaults that let you start safely.

## Features

- **Bash command matching** — Parses shell commands with an AST parser, handles pipes, subshells, wrapper commands (`sudo`, `xargs`, `bash -c`, `find -exec`), and supports glob tokens in rules
- **Path matching** — Glob patterns for file read/write/edit permissions
- **Extensible** — Add matchers for any tool with `exact`, `glob`, or `bash` matching
- **Sensible defaults** — Reading is safe, writing is dangerous. Works out of the box
- **Layered configuration** — Default → user → project → env → profile → session, with provenance for the effective rules
- **Policy inspection** — The `guard_check` tool explains the active policy or dry-runs a proposed tool call without side effects
- **Non-interactive support** — Denied commands are silently blocked in CI/CD; use `PI_GUARD` env var for automation
- **Session rules** — "Always allow for this session" without modifying config files

## Examples

When a tool call is covered by an `ask` rule, pi-guard intercepts it and prompts for approval. Commands get reformatted and abridged to make them easier to review. Allowed commands get ✔, unauthorized ones get ✖.

When the agent runs:

```bash
rm -rf dist/
```

The prompt looks like:

```
⚠️ Unapproved Commands

✖ rm -rf dist/

→ Allow
  Always allow rm (this session)
  Reject
```

For commands with pipes and subshells, each sub-command is checked independently. When the agent runs:

```bash
TOKEN=$(curl -s https://api.example.com/token | jq -r .access_token) && \
curl -H "Authorization: Bearer $TOKEN" https://api.example.com/data
```

The prompt looks like:

```
⚠️ Unapproved Commands

✔ TOKEN=$(...) &&
✖ curl -s https://api.example.com/token |
✔ jq -r .access_token

✖ curl -H "Authorization: Bearer $TOKEN" https://api.example.com/data

→ Allow
  Always allow curl (this session)
  Reject
```

Wrapper commands (`xargs`, `find -exec`) are expanded — the wrapper gets ✔, the inner command is checked on its own line. When the agent runs:

```bash
grep -rl 'TODO' src/ | xargs sed --in-place 's/TODO/DONE/g'
```

The prompt looks like:

```
⚠️ Unapproved Commands

✔ grep -rl 'TODO' src/ |
✔ xargs ...
✖ sed --in-place s/TODO/DONE/g

→ Allow
  Always allow sed (this session)
  Reject
```

Or with `find -exec`:

```bash
find src/ -name '*.test.ts' -exec rm {} \;
```

The prompt looks like:

```
⚠️ Unapproved Commands

✔ find src/ -name *.test.ts -exec ...
✖ rm {}

→ Allow
  Always allow rm (this session)
  Reject
```

For file operations, there's no command to parse — the prompt shows the path being accessed:

```
⚠️ Write Permission Required

src/lib/config.ts

→ Allow
  Always allow write (this session)
  Reject
```

For custom tools, the prompt shows the matched parameter value:

```
⚠️ web_fetch Permission Required

https://api.github.com/repos/jdiamond/pi-guard/issues

→ Allow
  Always allow web_fetch (this session)
  Reject
```

In non-interactive mode (e.g., CI), unauthorized commands are silently blocked without a prompt.

A `deny` result is final for the complete tool call. If any command in a pipeline, subshell, wrapper, or compound expression is denied, pi-guard blocks the tool call before opening an approval prompt.

## Install

```bash
pi install npm:pi-guard
```

## Run the current checkout with Nix

The flake provides an isolated pi executable that loads exactly the packaged
pi-guard source from the current checkout:

```bash
nix run .
```

Arguments after `--` are forwarded to pi:

```bash
nix run . -- --model sonnet:high
```

The runner uses the configured `PI_CODING_AGENT_DIR` for authentication, models,
and guard settings. It starts pi with extension discovery disabled and then loads
only this flake's pi-guard package, so an already installed pi-guard version cannot
be loaded alongside the checkout. Other extensions are intentionally absent from
this isolated development run; pass additional explicit `--extension` arguments
when an integration test requires them.

The runner is available on x86_64 Linux, aarch64 Linux, and Apple Silicon macOS.
The standalone pi-guard package remains available on Intel macOS.

## Configuration

Configure in `$PI_CODING_AGENT_DIR/settings.json` (defaults to `~/.pi/agent/settings.json`) or `.pi/settings.json` (project-level):

```json
{
  "guard": {
    "enabled": true,
    "matchers": {
      "spawn": { "param": "agent", "type": "exact" },
      "webfetch": { "param": "url", "type": "glob" }
    },
    "rules": {
      "*": "ask",
      "bash": {
        "*": "ask",
        "git status": "allow",
        "git log": "allow",
        "rm": "deny"
      },
      "read": {
        "*": "allow",
        "**/*.env": "deny",
        "**/*.pem": "deny"
      },
      "write": { "*": "ask" },
      "edit": { "*": "ask" },
      "spawn": {
        "build": "allow",
        "test": "allow",
        "*": "deny"
      },
      "webfetch": {
        "*": "ask",
        "https://github.com/*": "allow"
      }
    }
  }
}
```

### Reviewer adapter (not yet connected to tool enforcement)

The optional reviewer is configured **only** in the global
`$PI_CODING_AGENT_DIR/settings.json`. Project settings and `PI_GUARD` may add
pattern rules, but cannot configure the reviewer. The adapter is available to
extensions through `createReviewerRequest()` and `reviewGuardRequest()`; a later
integration will connect it to the approval dialog. Setting `mode` to `auto`
today does not approve tool calls.

```json
{
  "guard": {
    "reviewer": {
      "mode": "observe",
      "model": "main",
      "policyFile": "guard-reviewer-policy.txt",
      "reviewTimeoutMs": 60000,
      "approvalTimeoutMs": 120000
    }
  }
}
```

`mode` is `off` (default), `observe`, or `auto`; `model` is `main` (default)
or a Pi model registry `provider/id`. Use either inline `policy` or
`policyFile`, which is resolved relative to the global settings directory and
read when the extension starts or reloads. A nonempty plaintext policy is
required for `observe` and `auto`. `reviewTimeoutMs` is a positive, finite
deadline (default 60 seconds). `approvalTimeoutMs` is a positive, finite
deadline (default 120 seconds); `null` disables the future approval-dialog
timeout. Invalid reviewer settings disable review and report a warning without
replacing existing pattern rules.
The adapter accepts a per-call model override for the later session picker;
it snapshots that choice and the global settings before resolving credentials.

Use `/guard model` in the terminal to search Pi's available models with the
same model selector and keyboard navigation as the main picker. The picker
shows the current reviewer source and model. Press **Alt+M** to follow the
current main model again, or use `/guard model main`. To select directly, use
`/guard model <provider>/<model-id>`; the model ID may itself contain `/`.
`/guard model status` reports the source and resolved model. The Guard status
line and `/guard list` show the same information.

A session choice takes precedence over the global `guard.reviewer.model`,
which defaults to `main`; `main` follows subsequent changes of the working
model. The choice is stored on the current Pi session branch, survives resume,
and is inherited only by forks from that branch. A new independent session
starts with the global setting. Selecting a model never writes Pi's main-model
defaults or changes its active model. RPC uses a standard selection dialog;
print/JSON modes require a direct `/guard model` argument and do not open a
picker. The reviewer adapter can capture a selected model per call, so a call
already in flight keeps its model when the session choice changes. Connecting
the adapter to live tool enforcement is a separate follow-up (HL-0374); until
then, session selections are stored and displayed but do not authorize tools.

For example, `guard-reviewer-policy.txt` could contain:

```text
Approve read-only repository inspection needed for the user's current task.
Ask before network writes or changing files. Deny commands that delete data.
When suggesting a safer Bash command, explain how its effect differs.
If authorization is uncertain, ask the user.
```

The reviewer receives the original tool input, working directory, evaluator
finding, all active Guard rules with their layers, provenance, overrides, and
matcher semantics, plus visible conversation evidence tagged by role and
source. Hidden reasoning and hidden extension messages are excluded. Older
conversation may be dropped to fit the model; the request marks that history
as incomplete. The rules and operator policy are never truncated: if they do
not fit, review returns a technical error. The request limit is 128 KiB of
UTF-8 text, further constrained by the selected model's context window with
2,048 tokens reserved for output. The model output cap is 2,048 tokens.
Multimodal content in the current user instruction cannot be represented by
this text-only adapter and causes a technical error. Tool output and project
content are evidence, not authority to grant permission; the operator policy
and actual user task determine authorized effects.

The adapter calls Pi's model registry and authentication path directly, with
no tools or subagent extension. It makes one model call and accepts only a
strict JSON judgment: `allow`, `deny`, or `ask`, always with a nonempty English
reason. `ask` may recommend `allow` or `deny`; it may include up to three Bash
alternatives with a complete input, reason, and changed-effect description.
Any alternative still needs a fresh deterministic Guard evaluation. Timeout,
abort, missing model or credentials, context overflow, provider error, or
invalid output never produces an approval.

### Shorthand

Disable all checks:

```json
{ "guard": { "enabled": false } }
```

Whole-tool action (no pattern matching needed):

```json
{ "guard": { "rules": { "write": "allow" } } }
```

### Environment variable

Set `PI_GUARD` to inject rules from outside (e.g., by pi-spawn or CI/CD):

```bash
PI_GUARD='{"*":"deny","bash":{"git diff":"allow"}}'
```

## Matchers

Matchers define how to extract and match input from a tool call. Each matcher has a `param` (which tool parameter to extract) and a `type` (how to match).

| Type | Description | Use case |
|------|-------------|----------|
| `bash` | Parse command, extract all commands, subsequence match | Bash commands |
| `glob` | `*` and `**` matching (paths, URLs) | File paths, URLs |
| `exact` | String equality | Enum values, agent names |

Tools without a matcher get simple allow/ask/deny for the whole tool.

### Bash matching

1. Parse the command with the unbash AST parser
2. Extract all commands from the AST (handles pipes, subshells, command substitutions, process substitutions, heredocs, `if`/`while`/`for`/`case`, functions)
3. Expand wrapper commands (`xargs rm` → `xargs` + `rm`, `sudo rm` → `sudo` + `rm`, `bash -c 'rm -rf /'` → `bash -c` + `rm`, `find -exec rm {} \;` → `find -exec` + `rm`)
4. For each command, check rules using **subsequence matching** — rule tokens must appear in order, extra arguments are allowed

> [!TIP]
> `"git log"` matches `git log`, `git log --oneline`, and `git log --oneline -10`. This means you can allow a command without enumerating every flag combination.

#### Wildcard tokens in bash rules

Tokens containing `*` or `?` are matched as globs against the corresponding command argument:

```json
"sed": "allow",
"sed -i*": "ask",
"sed --in-place*": "ask"
```

| Command | Result | Reason |
|---------|--------|--------|
| `sed -E 's/old/new/'` | allow | `sed` rule, no `-i` flag |
| `sed -i 's/old/new/'` | ask | `-i` matches glob `-i*` |
| `sed -i.bak 's/old/new/'` | ask | `-i.bak` matches glob `-i*` |

This only applies to `*`/`?` **inside** rule tokens. The bare `"*"` key is the catch-all for any command (see [Rule precedence](#rule-precedence)).

### Glob matching

Standard glob patterns:
- `*` matches anything except `/`
- `**` matches anything including `/`
- `?` matches a single character
- `~` expands to home directory

### Exact matching

Simple string equality. Rule `"build"` only matches input `build`.

## Actions

Each permission rule resolves to one of:

| Action | Behavior |
|--------|----------|
| `allow` | Run without approval |
| `ask` | Prompt for approval (block in non-interactive mode) |
| `deny` | Block the complete tool call before approval UI opens |

## Inspecting the active policy

pi-guard registers a read-only `guard_check` tool for agents. It uses the same policy snapshot and evaluator as real tool execution.

Use `mode: "check"` to evaluate a proposed tool call:

```json
{
  "mode": "check",
  "tool": "bash",
  "input": { "command": "git status" }
}
```

The result includes the extracted input, whether the guard is enabled, the effective action, the enforcement disposition, review eligibility, the winning rule and its source layer, a policy version, and per-command results for Bash. Parser and input errors are returned explicitly. A disposition of `bypass` means the guard is disabled; it is distinct from an `allow` policy decision.

Use `mode: "rules"` to inspect the merged policy:

```json
{
  "mode": "rules",
  "tool": "bash",
  "commandPrefix": "git"
}
```

The optional filters reduce the displayed rules only; they do not change the policy version or recompute decisions. The response contains every policy layer, rule origin, overridden rules, effective rules, matcher semantics, and the active profile. `/guard list` presents the same runtime snapshot in a human-readable form.

`guard_check` never executes a command, opens approval UI, or modifies session or persistent rules. Its result covers pi-guard only; another sandbox or extension can still reject an allowed call.

User, project, and `PI_GUARD` sources are captured when the extension starts. Profile selection, session rules, and the session-only enabled override are applied dynamically and produce a new policy version.

When an exact session grant is present, the snapshot keeps its tool, complete input, and working directory unchanged. It can allow only an otherwise `ask` result with the same input and directory; a `deny` remains authoritative. Exact grants are included in `guard_check`, `/guard list`, and the policy version.

## Rule precedence

```
default → user config → project config → env (PI_GUARD) → profile → session rules
```

**Last match wins** within a tool's rules. Put the catch-all `"*"` first, specific rules after:

```json
"bash": {
  "*": "ask",
  "git status": "allow",
  "git log": "allow",
  "rm": "deny"
}
```

## Default rules

See [src/defaults.ts](src/defaults.ts) for the built-in defaults.

The defaults follow a simple principle: **reading is safe, writing is dangerous**. Read-only bash commands (`ls`, `cat`, `git log`, `grep`, etc.) are allowed, while anything that modifies state asks for approval. Note that `sed` is allowed by default, but `sed -i*` (in-place edit) is set to `ask` since it modifies files. File reads are mostly allowed except for sensitive patterns (`*.env`, `*.pem`). All edits and writes require approval.

> [!TIP]
> To trust the agent with file modifications (useful in containers or trusted environments):
> ```json
> {
>   "guard": {
>     "rules": { "edit": "allow", "write": "allow" }
>   }
> }
> ```

## Profiles

Profiles let you define named rule overlays and switch between them during a session. Only one profile can be active at a time.

```json
{
  "guard": {
    "profiles": {
      "read-write": {
        "edit": { "*": "allow" },
        "write": { "*": "allow" }
      }
    }
  }
}
```

Activate with `/guard profile read-write`, deactivate with `/guard profile off`.

> [!WARNING]
> Profiles are layered between env and session rules. A profile with `"*": "allow"` will override specific rules from earlier layers (like `"rm": "deny"`) because `"*"` always matches last and wins.

### Shortcuts

Define custom slash commands for quick access to guard actions:

```json
{
  "guard": {
    "profiles": {
      "read-write": {
        "edit": { "*": "allow" },
        "write": { "*": "allow" }
      }
    },
    "shortcuts": {
      "rw": "profile read-write",
      "ro": "profile off",
      "gt": "toggle"
    }
  }
}
```

Now `/rw` activates the read-write profile, `/ro` deactivates it, and `/gt` toggles the guard.

Shortcuts can reference any guard subcommand: `profile`, `list`, or `toggle`.

## Commands

| Command | Description |
|---------|-------------|
| `/guard-toggle` | Toggle guard on/off for this session |
| `/guard list` | Show current rules by provenance layer |
| `/guard profile` | Show active profile and available profiles |
| `/guard profile <name>` | Activate a profile |
| `/guard profile off` | Deactivate current profile |
