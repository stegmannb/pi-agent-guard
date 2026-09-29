# Reviewer integration acceptance

The reviewer is optional and remains `off` by default. This document records how to reproduce the offline acceptance checks and how to run a separate, explicitly requested model evaluation. A passing fixture test demonstrates Guard integration, not model judgment quality.

## Offline acceptance

Run `npm ci --ignore-scripts && npm run verify` from the repository root. The test script selects `test/*.test.ts` explicitly so the fixture extension under `test/fixtures/` is not mistaken for the whole suite. No model credentials, external systems, or executable candidate commands are needed. `nix build .#pi-guard --no-link` independently checks packaging.

| Contract | Reproducible evidence |
| --- | --- |
| Pattern allow, effective deny in compound Bash, specific ask, fallback ask, and `guard_check` parity | `test/extension.test.ts`, `test/evaluator.test.ts`, `test/evaluation-corpus.test.ts` |
| Four reviewer outcomes, neutral ask, explanations, validated alternatives, exact override, no unchanged denial loop | `test/auto-review.test.ts`, `test/reviewer.test.ts` |
| Missing policy, model, auth or context; invalid and empty output; provider and deadline failures | `test/reviewer.test.ts`, `test/auto-review.test.ts` |
| Role separation and command or tool-output injection | `test/reviewer.test.ts`, `test/evaluation-corpus.test.ts` |
| Session picker search, selection, main-follow, cancellation, persisted branch choice and unchanged main settings | `test/reviewer-model.test.ts`, including the Pi 0.86.1 native picker adapter |
| Exact session grant, changed command or cwd, new policy deny | `test/auto-review.test.ts`, `test/extension.test.ts` |
| Terminal countdown, pause on input, explicit resume, feedback, narrow dialog, RPC final-choice fallback and late response | `test/auto-review.test.ts` |

The ten cases in `eval/reviewer-cases.ts` pair an operator policy and user task with the complete active rule set, cwd, command, expected pattern action, and expected reviewer class with a concrete reason. `test/evaluation-corpus.test.ts` passes them through registered Guard hooks and `guard_check`, supplies a fake provider response, and uses only a controlled executor stub. A denied or expired candidate has no execution side effect. It verifies routing, context and result handling; its expected judgments are **not** measured model accuracy.

## Actual Pi terminal observations

Smoke-tested with `@earendil-works/pi-coding-agent` 0.86.1, the checkout extension loaded explicitly, and no external command or model request. `/guard model` opened Pi's native searchable selector. Searching `gpt-4.1-mini`, selecting it, and then using **Alt+M** to follow the main model left Pi's main model unchanged. The 0.86.1 constructor uses `ModelRuntime`, whereas the older SDK uses `SettingsManager` and `ModelRegistry`; the test suite exercises both paths.

The `test/fixtures/approval-smoke-extension.ts` command `/guard-ui-smoke` opens the real Guard approval dialog with a long command, multiline reason, all applicable session/project/global choices, feedback, and three alternatives; it never executes that command. At 80×24 the nine flat choices were simultaneously visible. At 40×12 they remained reachable by list scrolling; PageUp/PageDown scrolled command and reason, the selected broad-allow scope appeared on a separate line, and the remaining seconds stayed visible. Input paused the timeout and only `Resume timeout` restarted it. The narrow layout is dense: options below the fold require navigation, and the user should read the scope line before choosing a persistent rule. No choice was removed or placed in a submenu. The fixed-width rendering regression is asserted in `test/auto-review.test.ts`.

This terminal observation is separate from RPC. Pi's standard RPC selector carries the flat labels and final selection but does not report intermediate key activity, so Guard suspends the approval timeout there. `test/auto-review.test.ts` verifies the offered labels, recommendation order, and valid final choice. It does not claim native terminal focus rendering for arbitrary RPC clients.

## Optional live judgment evaluation

Only an operator choosing a configured model should run this from a repository checkout with its development dependencies installed:

```bash
node eval/run.ts --live --model <provider>/<model-id> > reviewer-results.jsonl
```

The runner refuses to send requests without both flags. It loads the same curated cases, constructs the same reviewer context, and uses Pi 0.86.1's configured model runtime and credentials. It requests judgments in `observe` mode and never executes a proposed or alternative command. The JSON Lines output contains case ID, expected and observed classes and reasons, category, latency in milliseconds, and any returned usage information (tokens or cost when the provider reports them). The summary separates false allows, unnecessary denies or asks, invalid model responses, and technical failures such as auth, provider or timeout errors. Other class disagreements remain visible per case. A false allow, invalid response, or technical failure makes the process exit nonzero; inspect all disagreements and reasons before using a model for real decisions. The runner does not activate `auto` or change Guard settings.

Live results depend on the chosen model, credentials, policy and date. No live model quality or safety rate is claimed by the offline suite. Review the output against the concrete user task and policy; an expected class is a test oracle, not a replacement for human authorization. Stop evaluation when every case has a recorded outcome and each disagreement or technical error is classified. Do not infer permission to deploy or publish from these results.

## Boundaries

The reviewer sees only fallback-ask Bash calls. Commands already allowed by patterns do not pass through it, and a later sandbox may still reject a Guard allow. Global reviewer policy and settings must be protected by the host sandbox or deployment permissions; Guard runs in the same Pi process. Reviewer input contains visible conversation evidence but not hidden reasoning. A too-large mandatory policy or current multimodal instruction produces a conservative error rather than a fabricated allow. Saving a broad human rule deliberately changes future pattern behavior, whereas reviewer allow and `Allow once` do not.
