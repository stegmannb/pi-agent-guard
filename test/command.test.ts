import assert from "node:assert/strict";
import { test } from "node:test";
import { buildListOutput, handleGuardCommand } from "../src/commands.ts";
import { DEFAULT_CONFIG } from "../src/defaults.ts";
import { parseGuardArgs } from "../src/index.ts";
import { buildPolicySnapshot } from "../src/policy.ts";
import type { GuardContext } from "../src/types.ts";

test("parseGuardArgs", async (t) => {
	await t.test("parses single-token target", () => {
		assert.deepEqual(parseGuardArgs("allow git"), {
			action: "allow",
			target: "git",
		});
	});

	await t.test("parses multi-token target", () => {
		assert.deepEqual(parseGuardArgs("allow git status"), {
			action: "allow",
			target: "git status",
		});
	});

	await t.test("parses tool with pattern", () => {
		assert.deepEqual(parseGuardArgs("allow bash git *"), {
			action: "allow",
			target: "bash git *",
		});
		assert.deepEqual(parseGuardArgs("deny bash rm *"), {
			action: "deny",
			target: "bash rm *",
		});
	});

	await t.test("collapses extra whitespace", () => {
		assert.deepEqual(
			parseGuardArgs("  deny   git   branch   --show-current  "),
			{
				action: "deny",
				target: "git branch --show-current",
			},
		);
	});

	await t.test("returns empty target when action has no argument", () => {
		assert.deepEqual(parseGuardArgs("toggle"), {
			action: "toggle",
			target: "",
		});
	});

	await t.test("parses list action with no target", () => {
		assert.deepEqual(parseGuardArgs("list"), { action: "list", target: "" });
	});

	await t.test("returns empty action/target for empty input", () => {
		assert.deepEqual(parseGuardArgs("   "), { action: "", target: "" });
	});

	await t.test("handles glob patterns in target", () => {
		assert.deepEqual(parseGuardArgs("allow read *.ts"), {
			action: "allow",
			target: "read *.ts",
		});
		assert.deepEqual(parseGuardArgs("deny write ~/.ssh/*"), {
			action: "deny",
			target: "write ~/.ssh/*",
		});
	});
});

test("guard list renders the current runtime policy snapshot", () => {
	const context: GuardContext = {
		config: DEFAULT_CONFIG,
		staticPolicy: {
			userRules: {},
			projectRules: {},
			envRules: undefined,
			projectConfigPresent: false,
		},
		activeProfile: undefined,
		sessionRules: { bash: { git: "allow" } },
		exactSessionGrants: [
			{ tool: "bash", input: { command: "git push" }, cwd: "/repo" },
		],
	};
	const snapshot = buildPolicySnapshot(context);
	const result = handleGuardCommand("list", undefined, context);
	assert.equal(result.message, buildListOutput(snapshot));
	assert.match(result.message, new RegExp(snapshot.policyVersion));
	assert.match(result.message, /git: allow \[session\]/);
	assert.match(result.message, /bash @ \/repo: {"command":"git push"}/);
});
