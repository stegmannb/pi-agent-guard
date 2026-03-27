# pi-guard Plan

General-purpose permission system for pi tools, replacing pi-unbash. Handles permissions for bash and file tools (read/edit/write), extensible to other tools via matchers.

## Overview

pi-guard intercepts tool calls and checks them against permission rules before execution. Tools have **matchers** that define how to extract and match input, and **rules** that define what's allowed.

Built-in matchers for bash, read, edit, write. Other tools can be guarded by configuring matchers in settings.

## Configuration Format

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
      "bash": { "*": "ask", "git *": "allow", "rm *": "deny" },
      "read": { "*": "allow", "*.env": "deny", "*.pem": "deny" },
      "edit": { "*": "ask" },
      "write": { "*": "ask" },
      "webfetch": { "*": "ask", "https://github.com/*": "allow" },
      "spawn": { "build": "allow", "test": "allow", "*": "deny" }
    }
  }
}
```

**Shorthand:**
```json
{ "guard": { "enabled": false } }                 // disable all checks
```
```json
{ "guard": { "rules": { "bash": "allow" } } }     // whole-tool (no pattern needed)
```

`matchers` is optional - defaults from DEFAULT_CONFIG.

## Matchers

Matchers define how to extract and match input from a tool call:

```typescript
interface Matcher {
  param: string;                      // Tool parameter to extract (e.g., "command", "path", "url")
  type: "bash" | "glob" | "exact";    // How to match
}
```

**Matcher types:**

| Type | Description | Use case |
|------|-------------|----------|
| `bash` | Parse command, extract all commands, subsequence match | Bash commands |
| `glob` | `*` and `**` matching (paths, URLs) | File paths, URLs |
| `exact` | String equality | Enum values, agent names |

**Tools without a matcher** get simple allow/ask/deny for the whole tool - no pattern matching needed.

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

## Environment Variable

Set `PI_GUARD` to inject rules from outside (e.g., by pi-spawn or CI/CD):

```
PI_GUARD='{"*":"deny","bash":{"git diff":"allow"}}'
```

Merged as highest-priority layer.

## Rule Precedence

```
DEFAULT_CONFIG → user config → project config → PI_GUARD → session rules
```

**Last match wins** within a tool's rules. Put catch-all `"*"` first, specific rules after:
```json
"bash": {
  "*": "ask",           // checked first
  "git *": "allow"      // checked second, wins for git commands
}
```

## Actions

Each permission rule resolves to one of:
- `"allow"` — run without approval
- `"ask"` — prompt for approval (or block in non-interactive mode)
- `"deny"` — block the action

## Feedback Context

When the permission system blocks or allows a tool call, it injects context into the tool result so the agent understands what happened.

### Tool Result Enrichment

**On approval (interactive - user selected "Allow"):**
```
[Approved: "git diff main...feature"]
```

**On approval (non-interactive - rule matched):**
```
[Allowed by rule: "git *" → allow]
```

**On denial (interactive - user selected "Reject"):**
```
[Denied: "rm -rf node_modules"]
User rejected this invocation. You may propose alternatives or wait for further instructions.
```

**On denial (non-interactive - rule matched):**
```
[Blocked by rule: "rm -rf node_modules"]
Rule matched: "rm *" → deny
This operation is blocked by security policy. Do not retry.
```

**On denial (non-interactive - default policy):**
```
[Blocked: "curl https://api.example.com"]
No matching allow rule and no interactive session available.
Do not retry.
```

### Interactive vs Non-Interactive

- **Interactive (has UI)**: User is present, soft framing: "User rejected" implies conversational reject
- **Non-interactive (print/JSON mode)**: No user to guide, hard framing: "Do not retry" prevents wasted turns

## Source Files

```
pi-guard/
├── src/
│   ├── index.ts        # Main extension, tool_call hook
│   ├── matchers.ts     # Built-in matchers (bash, glob, exact)
│   ├── matching.ts     # Subsequence match, glob match algorithms
│   ├── config.ts       # Load/merge config + DEFAULT_CONFIG
│   ├── prompt.ts       # UI for approval prompts
│   └── types.ts        # Interfaces (GuardConfig, Matcher, etc.)
├── package.json
└── README.md
```

## Default Config

```typescript
export const DEFAULT_CONFIG: GuardConfig = {
  enabled: true,
  matchers: {
    bash: { param: "command", type: "bash" },
    read: { param: "path", type: "glob" },
    edit: { param: "path", type: "glob" },
    write: { param: "path", type: "glob" },
  },
  rules: {
    "*": "ask",
    "bash": {
      "*": "ask",
      "cat": "allow",
      "cd": "allow",
      "echo": "allow",
      "find": "allow",
      "grep": "allow",
      "head": "allow",
      "ls": "allow",
      "pwd": "allow",
      "rg": "allow",
      "git blame": "allow",
      "git branch --show-current": "allow",
      "git diff": "allow",
      "git log": "allow",
      "git show": "allow",
      "git status": "allow",
    },
    "read": {
      "*": "allow",
      "*.env": "deny",
      "*.pem": "deny",
    },
    "edit": {
      "*": "ask",
    },
    "write": {
      "*": "ask",
    },
  },
};
```

## Implementation Steps

1. Copy pi-unbash source to pi-guard directory
2. Rename `unbash` config key to `guard`
3. Use `PI_GUARD` env var (no backward compat)
4. Extract config logic from `index.ts` → `config.ts`
5. Create `matching.ts` with subsequence + glob match algorithms
6. Create `matchers.ts` with built-in matchers (bash, glob, exact)
7. Create `types.ts` with GuardConfig, Matcher interfaces
8. Refactor `index.ts` to use matchers and support read/edit/write tools
9. Add `deny` action support (currently only `allow`/`ask`)
10. Publish to npm as `pi-guard`

## Migration from pi-unbash

Clean break - no backward compatibility:
- New package: `pi-guard`
- New env var: `PI_GUARD`
- New settings key: `"guard"`
- New command: `/guard`