# pi-guard

General-purpose permission system for pi tools. Handles permissions for bash and file tools (read/edit/write) with extensible matchers for custom tools.

## Overview

pi-guard intercepts tool calls and checks them against permission rules before execution.

**rules** define what's allowed. **matchers** define how to match tool calls to rules.

Built-in matchers for `bash`, `read`, `write`, and `edit`. Other tools can be guarded by configuring matchers in settings.

## Installation

```bash
pi install npm:pi-guard
```

## Configuration

Configure in `~/.pi/agent/settings.json`:

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

### Shorthand

Disable all checks:
```json
{ "guard": { "enabled": false } }
```

Whole-tool action (no pattern matching needed):
```json
{ "guard": { "rules": { "write": "allow" } } }
```

### Environment Variable

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

## Matching Algorithms

### Bash (type: "bash")

1. Parse command with unbash AST parser
2. Extract all commands from the AST
3. For each command, check rules using subsequence matching
4. Tokens in rule must appear in order, extra arguments allowed

Example: `"git log"` matches `git log`, `git log --oneline`, `git log --oneline -10`

### Glob (type: "glob")

Standard glob matching:
- `*` matches anything except `/`
- `**` matches anything including `/`
- `?` matches single character
- `~` expands to home directory

### Exact (type: "exact")

Simple string equality. Rule `"build"` only matches input `build`.

## Rule Precedence

```
default → user config → project config → env (PI_GUARD) → profile → session rules
```

**Last match wins** within a tool's rules. Put catch-all `"*"` first, specific rules after:

```json
"bash": {
  "*": "ask",
  "git status": "allow",
  "git log": "allow",
  "rm": "deny"
}
```

## Actions

Each permission rule resolves to one of:
- `"allow"` — run without approval
- `"ask"` — prompt for approval (or block in non-interactive mode)
- `"deny"` — block the action

## Default Rules

See [src/defaults.ts](src/defaults.ts) for the built-in default rules.

The defaults follow a simple principle: **reading is safe, writing is dangerous**. Bash commands that only read (ls, cat, git log) are allowed, while anything that modifies state asks for approval. File reads are mostly allowed except for sensitive patterns (*.env, *.pem). All edits and writes require approval since they change the codebase.

To trust the agent with file modifications (useful in containers or trusted environments), allow all edits and writes:

```json
{
  "guard": {
    "rules": {
      "edit": "allow",
      "write": "allow"
    }
  }
}
```

## Profiles

Profiles let you define named rule overlays that can be activated during a session. This is useful for switching between permission modes without editing config. Only one profile can be active at a time — activating a new one replaces the previous.

Profiles are layered between env (`PI_GUARD`) and session rules in the precedence chain. Rules are merged in layer order with last-match-wins semantics, so a profile with `"*": "allow"` will override any specific rules from earlier layers (like `"rm": "deny"`) — `"*"` always matches last and wins.

For example, define a profile that allows writes so you can switch to it when you want to make changes:

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

Activate it with `/guard profile read-write` and deactivate with `/guard profile off`.

### Profile Commands

```
/guard profile           # Show active profile and available profiles
/guard profile <name>    # Activate a profile by name
/guard profile off       # Deactivate current profile
```

### Shortcuts

Shortcuts are custom commands that execute guard subcommands, so you don't have to type commands like `/guard profile read-write` every time:

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
      "yolo": "disable",
      "safe": "enable"
    }
  }
}
```

Now `/rw` activates the read-write profile, `/ro` deactivates it, and `/yolo`/`/safe` quickly toggle the guard off and on.

Shortcuts can reference any guard subcommand: `profile`, `list`, `toggle`, `enable`, or `disable`.

## Commands

### `/guard`

Manage pi-guard security settings.

```
/guard enable           # Enable guard
/guard disable          # Disable guard
/guard toggle           # Toggle guard on/off
/guard list             # Show current rules
/guard profile          # Show active profile and available profiles
/guard profile <name>   # Activate a profile by name
/guard profile off      # Deactivate current profile
```

## License

MIT
