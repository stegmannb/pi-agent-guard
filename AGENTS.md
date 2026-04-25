pi-guard is a pi extension that adds permission gating for tools. It intercepts `tool_call` events and prompts the user before executing commands or file operations based on configurable rules.

**Default behavior:** see `src/defaults.ts`

**Rule precedence (last match wins):** default → user config → project config → PI_GUARD env var → session rules

**Testing:** `node --test test/<file>.ts` for a single test file, `npm test` for the full suite

**Type checking:** `npm run typecheck`

**Linting:** `npm run lint` to check, `npm run lint:fix` to auto-fix, `npm run lint -- <file>` for a single file

**Formatting:** `npm run format:check` to check, `npm run format` for auto-fix, `npm run format -- <file>` for a single file

**Check (static only):** `npm run check` (typecheck + lint + format:check)

**Verify (everything):** `npm run verify` (check + test)

**No `npx` or `tsx`.** This project uses Node's built-in type stripping. For single-file targeting, use scripts like `npm run lint -- <file>` passthrough. Never reach for `npx` or `tsx` as a workaround.
