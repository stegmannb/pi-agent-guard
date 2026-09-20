import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/defaults.ts";
import { evaluateToolCall } from "../src/evaluator.ts";
import { buildPolicySnapshot } from "../src/policy.ts";
import type { ExactSessionGrant, GuardContext, Rules } from "../src/types.ts";

function snapshot(
	rules: Rules,
	enabled = true,
	exactSessionGrants: ExactSessionGrant[] = [],
) {
	const context: GuardContext = {
		config: {
			enabled,
			matchers: {
				...DEFAULT_CONFIG.matchers,
				spawn: { param: "agent", type: "exact" },
			},
			rules,
		},
		staticPolicy: {
			userRules: rules,
			projectRules: {},
			envRules: undefined,
			projectConfigPresent: false,
		},
		activeProfile: undefined,
		sessionRules: {},
		exactSessionGrants,
	};
	return buildPolicySnapshot(context);
}

test("compound bash deny wins before later asks", () => {
	const result = evaluateToolCall(
		snapshot({ bash: { "*": "ask", echo: "allow", rm: "deny" } }),
		"bash",
		{ command: "echo ok && rm -rf / && curl example.com" },
	).result;
	assert.equal(result.patternAction, "deny");
	assert.equal(result.disposition, "deny");
	assert.equal(result.reviewEligible, false);
	assert.equal(result.winningRule?.pattern, "rm");
	assert.deepEqual(
		result.commands?.map((command) => command.action),
		["allow", "deny", "ask"],
	);
});

test("wrapper and nested commands use the same evaluator", () => {
	const result = evaluateToolCall(
		snapshot({
			bash: { "*": "ask", find: "allow", xargs: "allow", rm: "deny" },
		}),
		"bash",
		{ command: "find src -type f -print0 | xargs -0 rm" },
	).result;
	assert.equal(result.patternAction, "deny");
	assert.ok(result.commands?.some((command) => command.name === "rm"));
});

test("a deny inside a pipeline and command substitution blocks the whole call", () => {
	const result = evaluateToolCall(
		snapshot({
			bash: { "*": "ask", cat: "allow", echo: "allow", rm: "deny" },
		}),
		"bash",
		{ command: 'echo "$(rm -rf build)" | cat' },
	).result;
	assert.equal(result.patternAction, "deny");
	assert.equal(result.disposition, "deny");
	assert.equal(result.winningRule?.pattern, "rm");
	assert.ok(result.commands?.some((command) => command.name === "rm"));
});

test("only catch-all bash asks are review eligible", () => {
	const catchAll = evaluateToolCall(
		snapshot({ bash: { "*": "ask", echo: "allow" } }),
		"bash",
		{ command: "curl example.com" },
	).result;
	const specific = evaluateToolCall(
		snapshot({ bash: { "*": "allow", "git push": "ask" } }),
		"bash",
		{ command: "git push origin main" },
	).result;
	assert.equal(catchAll.reviewEligible, true);
	assert.equal(catchAll.winningRule?.pattern, "*");
	assert.equal(specific.reviewEligible, false);
	assert.equal(specific.winningRule?.pattern, "git push");
});

test("a custom tool with a bash matcher is never review eligible", () => {
	const policy = snapshot({ run_script: { "*": "ask" } });
	policy.matchers.run_script = { param: "command", type: "bash" };
	const result = evaluateToolCall(policy, "run_script", {
		command: "unknown-command",
	}).result;
	assert.equal(result.patternAction, "ask");
	assert.equal(result.reviewEligible, false);
});

test("parse failures are explicit and never review eligible", () => {
	const result = evaluateToolCall(snapshot({ bash: { "*": "ask" } }), "bash", {
		command: "echo 'unterminated",
	}).result;
	assert.equal(result.patternAction, "ask");
	assert.equal(result.reviewEligible, false);
	assert.ok(result.parserError);
});

test("embedded wrapper parser diagnostics disable review", () => {
	const result = evaluateToolCall(
		snapshot({ bash: { "*": "ask", bash: "allow" } }),
		"bash",
		{ command: `bash -c "unknown 'unterminated"` },
	).result;
	assert.equal(result.patternAction, "ask");
	assert.equal(result.reviewEligible, false);
	assert.match(result.parserError ?? "", /embedded command/);
});

test("a known deny wins over a separate embedded parser error", () => {
	const result = evaluateToolCall(
		snapshot({ bash: { "*": "ask", rm: "deny" } }),
		"bash",
		{ command: `rm -rf / && bash -c "echo 'unterminated"` },
	).result;
	assert.equal(result.patternAction, "deny");
	assert.equal(result.disposition, "deny");
	assert.equal(result.winningRule?.pattern, "rm");
	assert.ok(result.parserError);
});

test("a known deny wins over a top-level parser diagnostic", () => {
	const result = evaluateToolCall(
		snapshot({ bash: { "*": "ask", echo: "allow", rm: "deny" } }),
		"bash",
		{ command: "rm -rf / && echo 'unterminated" },
	).result;
	assert.equal(result.patternAction, "deny");
	assert.equal(result.disposition, "deny");
	assert.equal(result.winningRule?.pattern, "rm");
	assert.match(result.parserError ?? "", /unterminated single quote/);
	assert.deepEqual(
		result.commands?.map((command) => command.name),
		["rm", "echo"],
	);
});

test("blanket bash actions still return parser and command findings", () => {
	const policy = snapshot({ bash: "ask" });
	const valid = evaluateToolCall(policy, "bash", { command: "echo ok" }).result;
	assert.equal(valid.patternAction, "ask");
	assert.equal(valid.reviewEligible, false);
	assert.equal(valid.winningRule?.scope, "tool");
	assert.deepEqual(
		valid.commands?.map((command) => command.name),
		["echo"],
	);

	const global = evaluateToolCall(snapshot("ask"), "bash", {
		command: "echo ok",
	}).result;
	assert.equal(global.patternAction, "ask");
	assert.equal(global.winningRule?.scope, "global");
	assert.equal(global.reviewEligible, false);
	assert.deepEqual(
		global.commands?.map((command) => command.name),
		["echo"],
	);

	const blanketDeny = evaluateToolCall(snapshot({ bash: "deny" }), "bash", {
		command: "ONLY_ASSIGNMENT=value",
	}).result;
	assert.equal(blanketDeny.patternAction, "deny");
	assert.equal(blanketDeny.disposition, "deny");

	const invalid = evaluateToolCall(policy, "bash", {
		command: "echo 'unterminated",
	}).result;
	assert.equal(invalid.patternAction, "ask");
	assert.ok(invalid.parserError);
});

test("exact session grants apply only to the same input and cwd after denies", () => {
	const input = { command: "git push origin main" };
	const grant = { tool: "bash", input, cwd: "/repo" };
	const policy = snapshot({ bash: { "*": "ask" } }, true, [grant]);
	const granted = evaluateToolCall(
		policy,
		"bash",
		{ ...input },
		"/repo",
	).result;
	assert.equal(granted.patternAction, "ask");
	assert.equal(granted.disposition, "allow");
	assert.equal(granted.reviewEligible, false);
	assert.deepEqual(granted.exactSessionGrant, grant);
	assert.equal(
		evaluateToolCall(policy, "bash", input, "/other").result.disposition,
		"ask",
	);
	assert.equal(
		evaluateToolCall(
			policy,
			"bash",
			{ command: "git push origin other" },
			"/repo",
		).result.disposition,
		"ask",
	);

	const denied = snapshot({ bash: { "*": "ask", rm: "deny" } }, true, [
		{ tool: "bash", input: { command: "rm -rf build" }, cwd: "/repo" },
	]);
	const deniedResult = evaluateToolCall(
		denied,
		"bash",
		{ command: "rm -rf build" },
		"/repo",
	).result;
	assert.equal(deniedResult.disposition, "deny");
	assert.equal(deniedResult.exactSessionGrant, undefined);
});

test("glob, exact, unknown and disabled cases expose routing", () => {
	const rules = {
		read: { "*": "allow", "**/*.pem": "deny" },
		spawn: { "*": "ask", build: "allow" },
	} as const;
	const enabled = snapshot(rules);
	assert.equal(
		evaluateToolCall(enabled, "read", { path: "/tmp/key.pem" }).result
			.patternAction,
		"deny",
	);
	assert.equal(
		evaluateToolCall(enabled, "spawn", { agent: "build" }).result.patternAction,
		"allow",
	);
	assert.equal(
		evaluateToolCall(enabled, "custom", { value: "anything" }).result
			.patternAction,
		"allow",
	);
	assert.equal(
		evaluateToolCall(snapshot(rules, false), "read", {
			path: "/tmp/key.pem",
		}).result.disposition,
		"bypass",
	);
});

test("invalid matcher input is reported without changing legacy forwarding", () => {
	const result = evaluateToolCall(snapshot({ bash: { "*": "deny" } }), "bash", {
		command: 42,
	}).result;
	assert.equal(result.patternAction, "allow");
	assert.equal(result.disposition, "allow");
	assert.ok(result.inputError);
});
