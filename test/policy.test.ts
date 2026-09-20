import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEffectiveRules } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/defaults.ts";
import { buildPolicySnapshot, filterPolicySnapshot } from "../src/policy.ts";
import type { ExactSessionGrant, GuardContext, Rules } from "../src/types.ts";

function context(
	options: {
		user?: Rules;
		project?: Rules;
		environment?: Rules;
		profile?: Rules;
		session?: Record<string, Record<string, "allow" | "ask" | "deny">>;
		exactSessionGrants?: ExactSessionGrant[];
		enabled?: boolean;
	} = {},
): GuardContext {
	return {
		config: {
			enabled: options.enabled ?? true,
			matchers: DEFAULT_CONFIG.matchers,
			rules: options.user ?? {},
			...(options.profile ? { profiles: { active: options.profile } } : {}),
		},
		staticPolicy: {
			userRules: options.user ?? {},
			projectRules: options.project ?? {},
			envRules: options.environment,
			projectConfigPresent: options.project !== undefined,
		},
		activeProfile: options.profile ? "active" : undefined,
		sessionRules: options.session ?? {},
		exactSessionGrants: options.exactSessionGrants ?? [],
	};
}

test("policy snapshot preserves effective merge semantics and provenance", () => {
	const guard = context({
		user: { bash: { "git status": "ask", git: "allow" } },
		project: { bash: { "git status": "deny" } },
		profile: { bash: { "git log": "ask" } },
		session: { bash: { "git status": "allow" } },
	});
	const snapshot = buildPolicySnapshot(guard);
	const expected = buildEffectiveRules(
		guard.staticPolicy.userRules,
		guard.staticPolicy.projectRules,
		guard.staticPolicy.envRules,
		guard.config.profiles?.active,
		guard.sessionRules,
	);
	assert.deepEqual(snapshot.effectiveRules, expected);
	assert.ok(
		snapshot.effectiveOrigins.some(
			(origin) =>
				origin.layer === "session" &&
				origin.tool === "bash" &&
				origin.pattern === "git status" &&
				origin.action === "allow",
		),
	);
	assert.ok(
		snapshot.overrides.some(
			(entry) =>
				entry.scope === "tool:bash:pattern:git status" &&
				entry.replaced.layer === "project" &&
				entry.replacement.layer === "session",
		),
	);
});

test("blanket actions retain existing short-circuit behavior", () => {
	const guard = context({
		user: "deny",
		project: { bash: { "git status": "allow" } },
		environment: "ask",
		profile: { bash: { "git log": "allow" } },
	});
	const snapshot = buildPolicySnapshot(guard);
	assert.equal(snapshot.effectiveRules, "ask");
	assert.deepEqual(snapshot.effectiveOrigins, [
		{ layer: "environment", action: "ask" },
	]);
	assert.ok(snapshot.overrides.length > 0);
	assert.ok(
		snapshot.overrides.some(
			(entry) =>
				entry.replaced.layer === "user" &&
				entry.replaced.action === "deny" &&
				entry.replacement.layer === "environment",
		),
	);
});

test("policy version follows profile, session and enabled state", () => {
	const guard = context({ profile: { bash: { "git push": "deny" } } });
	const initial = buildPolicySnapshot(guard).policyVersion;
	guard.activeProfile = undefined;
	const withoutProfile = buildPolicySnapshot(guard).policyVersion;
	guard.sessionRules.bash = { "git status": "allow" };
	const withSession = buildPolicySnapshot(guard).policyVersion;
	guard.sessionEnabled = false;
	const disabled = buildPolicySnapshot(guard).policyVersion;
	guard.exactSessionGrants.push({
		tool: "bash",
		input: { command: "git status" },
		cwd: "/repo",
	});
	const withExactGrant = buildPolicySnapshot(guard).policyVersion;
	assert.notEqual(initial, withoutProfile);
	assert.notEqual(withoutProfile, withSession);
	assert.notEqual(withSession, disabled);
	assert.notEqual(disabled, withExactGrant);
});

test("rule filters do not recompute the policy decision", () => {
	const snapshot = buildPolicySnapshot(
		context({ user: { bash: { "git status": "allow", "git push": "deny" } } }),
	);
	const filtered = filterPolicySnapshot(snapshot, {
		tool: "bash",
		commandPrefix: "git status",
	});
	assert.equal(filtered.policyVersion, snapshot.policyVersion);
	assert.ok(typeof filtered.effectiveRules === "object");
	if (typeof filtered.effectiveRules === "object") {
		assert.deepEqual(filtered.effectiveRules.bash, { "git status": "allow" });
	}
});

test("missing project config is represented as an inactive layer", () => {
	const snapshot = buildPolicySnapshot(context());
	const project = snapshot.layers.find((layer) => layer.name === "project");
	assert.ok(project);
	assert.equal(project.active, false);
	assert.equal(project.rules, undefined);
});
