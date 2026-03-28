# pi-guard

General-purpose permission system for pi tools. Handles permissions for bash and file tools (read/edit/write) with extensible matchers for custom tools.

## Overview

pi-guard intercepts tool calls and checks them against permission rules before execution. Tools have **matchers** that define how to extract and match input, and **rules** that define what's allowed.

Built-in matchers for `bash`, `read`, `edit`, and `write`. Other tools can be guarded by configuring matchers in settings.

## Installation

```bash
npm install pi-guard
```

Add to your `~/.pi/agent/extensions/pi-guard.ts`:

```typescript
import guard from "pi-guard";
export default [guard];
```

## Configuration

Configure in `~/.pi/agent/settings.json`:

```json
{
  "guard": {
    "enabled": true,
    "matchers": {
      "webfetch": { "param": "url", "type": "glob" },
      "spawn": { "param": "agent", "type": "exact" }
    },
    "rules": {
      "*": "ask",
      "bash": {
        "*": "ask",
        "git *": "allow",
        "rm *": "deny"
      },
      "read": {
        "*": "allow",
        "*.env": "deny",
        "*.pem": "deny"
      },
      "edit": { "*": "ask" },
      "write": { "*": "ask" },
      "webfetch": {
        "*": "ask",
        "https://github.com/*": "allow"
      },
      "spawn": {
        "build": "allow",
        "test": "allow",
        "*": "deny"
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
{ "guard": { "rules": { "bash": "allow" } } }
```

### Environment Variable

Set `PI_GUARD` to inject rules from outside (e.g., by pi-spawn or CI/CD):

```bash
PI_GUARD='{"*":"deny","bash":{"git diff":"allow"}}'
```

## Matchers

Matchers define how to extract and match input from a tool call:

```typescript
interface Matcher {
  param: string;                      // Tool parameter to extract
  type: "bash" | "glob" | "exact";    // How to match
}
```

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
DEFAULT_CONFIG → user config → project config → PI_GUARD → session rules
```

**Last match wins** within a tool's rules. Put catch-all `"*"` first, specific rules after:

```json
"bash": {
  "*": "ask",
  "git *": "allow"
}
```

## Actions

Each permission rule resolves to one of:
- `"allow"` — run without approval
- `"ask"` — prompt for approval (or block in non-interactive mode)
- `"deny"` — block the action

## Commands

### `/guard`

Manage pi-guard security settings.

```
/guard toggle    # Enable/disable guard
/guard list      # Show current rules
```

## Default Rules

```typescript
{
  bash: {
    "*": "ask",
    cat: "allow",
    cd: "allow",
    echo: "allow",
    find: "allow",
    grep: "allow",
    head: "allow",
    ls: "allow",
    pwd: "allow",
    rg: "allow",
    "git blame": "allow",
    "git branch --show-current": "allow",
    "git diff": "allow",
    "git log": "allow",
    "git show": "allow",
    "git status": "allow",
  },
  read: {
    "*": "allow",
    "*.env": "deny",
    "*.pem": "deny",
  },
  edit: { "*": "ask" },
  write: { "*": "ask" },
}
```

## License

MIT