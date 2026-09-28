import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getModel } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { GuardBootstrap } from "../src/index.ts";
import type {
	SnapshotRequest,
	SnapshotResponse,
} from "../src/protection-snapshot.ts";
import { loadRealGuard } from "./fixtures/protection-sdk.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-protection-")));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
const initialEnv = {
	agent: process.env.PI_CODING_AGENT_DIR,
	guard: process.env.PI_GUARD,
};
const originalCwd = process.cwd();
const settingsPath = join(agentDir, "settings.json");
let registerGuard: typeof import("../src/index.ts").registerGuard;
const settings = {
	guard: {
		rules: { bash: { "*": "ask", echo: "allow", rm: "deny" } },
		profiles: { strict: { bash: "deny" } },
	},
};

before(async () => {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_GUARD;
	registerGuard = (await import("../index.ts")).default;
});
beforeEach(() => {
	writeFileSync(settingsPath, JSON.stringify(settings));
	delete process.env.PI_GUARD;
});
after(() => {
	process.chdir(originalCwd);
	for (const [name, value] of [
		["PI_CODING_AGENT_DIR", initialEnv.agent],
		["PI_GUARD", initialEnv.guard],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

function directory() {
	return mkdtempSync(join(root, "worktree-"));
}
function project(cwd: string, value: unknown) {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify(value));
}
function unsupported(response: SnapshotResponse, reason: string) {
	assert.equal(response.status, "unsupported");
	if (response.status === "unsupported") assert.equal(response.reason, reason);
}
function ready(response: SnapshotResponse) {
	assert.equal(response.status, "ready", JSON.stringify(response));
	assert.ok(response.status === "ready");
	return response;
}

type Handler = (
	event: Record<string, unknown>,
	ctx: ExtensionContext,
) => Promise<unknown>;
function harness(cwd = directory(), bootstrap?: GuardBootstrap) {
	const hooks = new Map<string, Handler>();
	const commands = new Map<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<void>
	>();
	const tools = new Map<string, ToolDefinition>();
	let listener: ((request: unknown) => void) | undefined;
	let sessionId: string = randomUUID();
	const branch: unknown[] = [];
	let prompts = 0;
	const model = structuredClone(getModel("openai", "gpt-4o-mini"));
	const ctx = {
		cwd,
		hasUI: true,
		model,
		modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
		ui: {
			setStatus() {},
			notify() {},
			theme: { fg: (_: string, value: string) => value },
			select: async () => {
				prompts++;
				return "Allow";
			},
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, handler: Handler) => hooks.set(name, handler),
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: (
			name: string,
			command: {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		) => commands.set(name, command.handler),
		appendEntry: (customType: string, data: unknown) =>
			branch.push({ type: "custom", customType, data }),
		events: {
			on: (name: string, handler: (request: unknown) => void) => {
				assert.equal(name, "pasa:protection:snapshot:v1");
				listener = handler;
			},
			emit() {},
		},
	} as unknown as ExtensionAPI;
	process.chdir(cwd);
	try {
		registerGuard(pi, bootstrap);
	} finally {
		process.chdir(originalCwd);
	}
	function emit(request: unknown) {
		assert.ok(listener);
		listener(request);
	}
	function snapshot(targetCwd = cwd, expectedSessionId = sessionId) {
		let response: SnapshotResponse | undefined;
		emit({
			version: 1,
			requestId: randomUUID(),
			protectionId: "pi-agent-guard",
			expectedSessionId,
			targetCwd,
			respond: (value: SnapshotResponse) => {
				assert.equal(response, undefined);
				response = value;
			},
		});
		assert.ok(response);
		return response;
	}
	async function event(type: string, extra: Record<string, unknown> = {}) {
		const handler = hooks.get(type);
		assert.ok(handler);
		return handler({ type, ...extra }, ctx);
	}
	async function command(args: string) {
		const handler = commands.get("guard");
		assert.ok(handler);
		return handler(args, ctx as ExtensionCommandContext);
	}
	return {
		ctx,
		snapshot,
		event,
		command,
		emit,
		tools,
		branch,
		model,
		prompts: () => prompts,
		session: () => sessionId,
		replaceSession: () => {
			sessionId = randomUUID();
		},
	};
}

test("registered Guard binds repeatable live readiness and equivalent target worktree without prompts", async () => {
	const fake = harness();
	const target = directory();
	unsupported(fake.snapshot(target), "NOT_INITIALIZED");
	await fake.event("session_start");
	const first = ready(fake.snapshot(target));
	const second = ready(fake.snapshot(target));
	assert.deepEqual(first.binding, second.binding);
	assert.equal(first.binding.cwd, fake.ctx.cwd);
	assert.equal(first.replay.verifiedCwd, target);
	assert.equal(first.stateDigest, second.stateDigest);
	assert.equal(first.stateDigest, first.replay.stateDigest);
	assert.match(first.stateDigest, /^[a-f0-9]{64}$/);
	assert.ok(
		first.codeFiles.some((file) => file.path.endsWith("src/auto-review.ts")),
	);
	assert.ok(first.codeFiles.some((file) => file.path.endsWith("/index.ts")));
	assert.equal(fake.prompts(), 0);
	assert.deepEqual(
		[...fake.tools.keys()],
		["guard_check", "guard_require_decision"],
	);
	for (const ref of [...first.codeFiles, ...first.configurationFiles])
		assert.equal(
			ref.sha256,
			createHash("sha256").update(readFileSync(ref.path)).digest("hex"),
		);
});

test("real Pi 0.73 SDK and separate child independently initialize the same file-backed policy", async () => {
	const cwd = directory();
	const target = directory();
	process.chdir(cwd);
	try {
		const parent = await loadRealGuard(cwd);
		try {
			unsupported(parent.snapshot(target), "NOT_INITIALIZED");
			await parent.session.bindExtensions({});
			const snapshot = ready(parent.snapshot(target));
			const output = execFileSync(
				process.execPath,
				[
					fileURLToPath(
						new URL("./fixtures/protection-child.ts", import.meta.url),
					),
				],
				{ cwd: target, env: process.env, encoding: "utf8" },
			);
			const child = ready(JSON.parse(output.trim()));
			assert.equal(child.stateDigest, snapshot.replay.stateDigest);
			assert.equal(child.binding.cwd, target);
			assert.notEqual(child.binding.sessionId, snapshot.binding.sessionId);
			assert.deepEqual(child.codeFiles, snapshot.codeFiles);
			assert.deepEqual(child.configurationFiles, snapshot.configurationFiles);
			assert.deepEqual(child.environment, snapshot.environment);
			await parent.session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
			unsupported(parent.snapshot(target), "NOT_INITIALIZED");
		} finally {
			parent.session.dispose();
		}
	} finally {
		process.chdir(originalCwd);
	}
});

test("additional, missing and changed target project settings refuse; equal files replay", async () => {
	const fake = harness();
	const target = directory();
	await fake.event("session_start");
	project(target, { guard: { rules: { bash: "deny" } } });
	unsupported(fake.snapshot(target), "CWD_UNREPRODUCIBLE");
	const cwd = directory();
	project(cwd, { guard: { rules: { bash: "deny" } } });
	const withProject = harness(cwd);
	await withProject.event("session_start");
	ready(withProject.snapshot(target));
	unsupported(withProject.snapshot(directory()), "CWD_UNREPRODUCIBLE");
	project(target, { guard: { rules: { bash: "allow" } } });
	unsupported(withProject.snapshot(target), "CWD_UNREPRODUCIBLE");
});

test("parent file edits, newly introduced project configs and removed configs are drift", async () => {
	const fake = harness();
	await fake.event("session_start");
	ready(fake.snapshot());
	project(fake.ctx.cwd, {});
	unsupported(fake.snapshot(), "CONFIG_DRIFT");
	const loaded = harness();
	await loaded.event("session_start");
	writeFileSync(settingsPath, JSON.stringify({ guard: { rules: "allow" } }));
	unsupported(loaded.snapshot(), "CONFIG_DRIFT");
	const deleted = harness();
	await deleted.event("session_start");
	rmSync(settingsPath);
	unsupported(deleted.snapshot(), "CONFIG_DRIFT");
});

test("loaded config is captured at registration, not delayed until session_start", async () => {
	const fake = harness();
	writeFileSync(settingsPath, JSON.stringify({ guard: { rules: "deny" } }));
	await fake.event("session_start");
	unsupported(fake.snapshot(), "CONFIG_DRIFT");
});

test("environment rules are effective, fingerprinted and drift checked without credential env hashes", async () => {
	process.env.PI_GUARD = JSON.stringify({ bash: "deny" });
	const fake = harness();
	await fake.event("session_start");
	const response = ready(fake.snapshot());
	assert.deepEqual(
		response.environment.map((entry) => entry.name),
		["PI_CODING_AGENT_DIR", "HOME", "PI_GUARD"],
	);
	process.env.PI_GUARD = JSON.stringify({ bash: "allow" });
	unsupported(fake.snapshot(), "CONFIG_DRIFT");
});

test("session and lifecycle transitions invalidate captures without snapshot resets", async () => {
	const fake = harness();
	await fake.event("session_start");
	const initial = ready(fake.snapshot());
	unsupported(fake.snapshot(fake.ctx.cwd, "wrong"), "SESSION_MISMATCH");
	fake.replaceSession();
	unsupported(fake.snapshot(), "SESSION_MISMATCH");
	await fake.event("session_start");
	assert.ok(
		ready(fake.snapshot()).binding.generation > initial.binding.generation,
	);
	await fake.command("profile strict");
	unsupported(fake.snapshot(), "RUNTIME_MUTATION");
	await fake.command("profile off");
	unsupported(fake.snapshot(), "RUNTIME_MUTATION");
	await fake.event("session_start");
	ready(fake.snapshot());
	await fake.event("session_before_tree");
	unsupported(fake.snapshot(), "RUNTIME_MUTATION");
	await fake.event("session_tree");
	unsupported(fake.snapshot(), "RUNTIME_MUTATION");
	await fake.event("session_shutdown");
	unsupported(fake.snapshot(), "NOT_INITIALIZED");
});

test("failed session_start and reentrant snapshot during initialization cannot be ready", async () => {
	const fake = harness();
	const statuses: SnapshotResponse[] = [];
	fake.ctx.ui.setStatus = () => {
		statuses.push(fake.snapshot());
		throw new Error("private error text");
	};
	await assert.rejects(fake.event("session_start"), /private error/);
	unsupported(statuses[0] as SnapshotResponse, "NOT_INITIALIZED");
	const response = fake.snapshot();
	unsupported(response, "INITIALIZATION_FAILED");
	assert.doesNotMatch(JSON.stringify(response), /private error/);
});

test("toggle round trip remains unsupported and snapshots leave Guard disabled", async () => {
	const fake = harness();
	await fake.event("session_start");
	await fake.command("toggle");
	unsupported(fake.snapshot(), "DISABLED");
	unsupported(fake.snapshot(), "DISABLED");
	await fake.command("toggle");
	unsupported(fake.snapshot(), "RUNTIME_MUTATION");
});

test("custom bootstrap remains unsupported even when values match disk", async () => {
	const fake = harness(directory(), { startupCwd: directory() });
	await fake.event("session_start");
	unsupported(fake.snapshot(), "UNBACKED_CONFIGURATION");
	const inherited = harness(
		directory(),
		Object.create({
			autoReview: {
				review: () => {
					throw new Error("must not run");
				},
			},
		}),
	);
	await inherited.event("session_start");
	unsupported(inherited.snapshot(), "UNBACKED_CONFIGURATION");
	const empty = harness(directory(), {});
	await empty.event("session_start");
	unsupported(empty.snapshot(), "UNBACKED_CONFIGURATION");
});

test("stored reviewer override is not silently discarded", async () => {
	const fake = harness();
	fake.branch.push({
		type: "custom",
		customType: "pi-guard-reviewer-model",
		data: { model: "test/reviewer" },
	});
	await fake.event("session_start");
	unsupported(fake.snapshot(), "RUNTIME_MUTATION");
	assert.equal(fake.branch.length, 1);
});

test("pending legacy approval blocks snapshot and its session grant remains effective", async () => {
	const fake = harness();
	await fake.event("session_start");
	let answer: ((value: string) => void) | undefined;
	let choices: string[] = [];
	fake.ctx.ui.select = async (_title, items) => {
		choices = items;
		return new Promise<string>((resolve) => {
			answer = resolve;
		});
	};
	const pending = fake.event("tool_call", {
		toolName: "bash",
		toolCallId: "approval",
		input: { command: "mysterytool" },
	});
	await Promise.resolve();
	assert.ok(answer);
	unsupported(fake.snapshot(), "RUNTIME_MUTATION");
	const sessionChoice = choices.find((choice) => /session/i.test(choice));
	assert.ok(sessionChoice);
	answer(sessionChoice);
	await pending;
	unsupported(fake.snapshot(), "RUNTIME_MUTATION");
	fake.ctx.ui.select = async () => {
		throw new Error("Existing session grant was lost");
	};
	assert.equal(
		await fake.event("tool_call", {
			toolName: "bash",
			toolCallId: "still-allowed",
			input: { command: "mysterytool" },
		}),
		undefined,
	);
});

test("policyFile hashes and effective reviewer model are live, without auth material", async () => {
	const policyFile = join(agentDir, "policy.txt");
	writeFileSync(policyFile, "Ask before changing remote state");
	writeFileSync(
		settingsPath,
		JSON.stringify({
			guard: {
				reviewer: {
					mode: "auto",
					model: "openai/gpt-4o-mini",
					policyFile: "policy.txt",
				},
			},
		}),
	);
	const fake = harness();
	await fake.event("session_start");
	const snapshot = ready(fake.snapshot());
	assert.ok(
		snapshot.configurationFiles.some((file) => file.path === policyFile),
	);
	assert.doesNotMatch(
		JSON.stringify(snapshot),
		/Ask before|test\/reviewer|auth\.json/,
	);
	fake.model.id = "different";
	unsupported(fake.snapshot(), "RUNTIME_MUTATION");
	const drift = harness();
	await drift.event("session_start");
	writeFileSync(policyFile, "Other policy");
	unsupported(drift.snapshot(), "CONFIG_DRIFT");
});

test("credential-bearing settings are refused without their values or hashes", async () => {
	const value = "private-api-key-sentinel";
	writeFileSync(settingsPath, JSON.stringify({ ...settings, apiKey: value }));
	const fake = harness();
	await fake.event("session_start");
	const response = fake.snapshot();
	unsupported(response, "UNBACKED_CONFIGURATION");
	assert.doesNotMatch(
		JSON.stringify(response),
		/private-api-key|configurationFiles|environment/,
	);
});

test("canonical target is required", async () => {
	const fake = harness();
	await fake.event("session_start");
	const link = join(root, randomUUID());
	symlinkSync(fake.ctx.cwd, link);
	unsupported(fake.snapshot(link), "CWD_UNREPRODUCIBLE");
});

test("request validation, protection routing and duplicate callbacks are bounded", async () => {
	const fake = harness();
	await fake.event("session_start");
	let replies = 0;
	const request: SnapshotRequest = {
		version: 1,
		requestId: randomUUID(),
		protectionId: "pi-agent-guard",
		expectedSessionId: fake.session(),
		targetCwd: fake.ctx.cwd,
		respond: () => {
			replies++;
		},
	};
	fake.emit({ ...request, protectionId: "pi-agent-sandbox" });
	fake.emit({ ...request, version: 2 });
	fake.emit(null);
	assert.equal(replies, 0);
	fake.emit(request);
	fake.emit({ ...request });
	assert.equal(replies, 1);
	const throwing = {
		...request,
		requestId: randomUUID(),
		respond: () => {
			replies++;
			throw new Error("callback");
		},
	};
	assert.throws(() => fake.emit(throwing), /callback/);
	fake.emit(throwing);
	assert.equal(replies, 2);
});

test("real registration refuses code drift before/after load and missing deployment metadata", () => {
	for (const [mode, reason] of [
		["before", "UNBACKED_CONFIGURATION"],
		["after", "CONFIG_DRIFT"],
		["missing", "UNBACKED_CONFIGURATION"],
		["incomplete", "UNBACKED_CONFIGURATION"],
	]) {
		const copy = directory();
		for (const name of [
			"index.ts",
			"src",
			"package.json",
			"pnpm-lock.yaml",
			"protection-code.json",
		])
			cpSync(join(originalCwd, name), join(copy, name), { recursive: true });
		symlinkSync(join(originalCwd, "node_modules"), join(copy, "node_modules"));
		assert.ok(mode && reason);
		const result = execFileSync(
			process.execPath,
			[
				fileURLToPath(
					new URL("./fixtures/protection-code-drift.ts", import.meta.url),
				),
				copy,
				mode,
			],
			{ cwd: copy, encoding: "utf8" },
		);
		unsupported(JSON.parse(result), reason);
	}
});

test("restored required decision remains pending after unsupported snapshots", async () => {
	const fake = harness();
	fake.branch.push({
		type: "custom",
		customType: "pi-guard-required-decision",
		data: {
			status: "pending",
			request: {
				id: "decision",
				sessionId: fake.session(),
				question: "Which target?",
				reason: "Need scope",
				options: [
					{ key: "one", label: "One" },
					{ key: "two", label: "Two" },
				],
			},
		},
	});
	await fake.event("session_start");
	unsupported(fake.snapshot(), "RUNTIME_MUTATION");
	const blocked = (await fake.event("tool_call", {
		toolName: "bash",
		input: { command: "echo yes" },
	})) as { block: boolean; reason: string };
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /decision.*pending/);
	assert.equal(fake.branch.length, 1);
});

test("invalid configuration and disabled Guard cannot claim readiness", async () => {
	writeFileSync(settingsPath, JSON.stringify({ guard: { enabled: false } }));
	const disabled = harness();
	await disabled.event("session_start");
	unsupported(disabled.snapshot(), "DISABLED");
	writeFileSync(
		settingsPath,
		JSON.stringify({ guard: { enabled: "not-boolean" } }),
	);
	const invalid = harness();
	await invalid.event("session_start");
	unsupported(invalid.snapshot(), "UNBACKED_CONFIGURATION");
});

test("custom reviewer model definitions, main selection and headers are unbacked", async () => {
	writeFileSync(
		settingsPath,
		JSON.stringify({
			guard: {
				reviewer: {
					mode: "auto",
					model: "openai/gpt-4o-mini",
					policy: "Allow reads",
				},
			},
		}),
	);
	const custom = harness();
	custom.model.baseUrl = "https://custom.invalid";
	await custom.event("session_start");
	unsupported(custom.snapshot(), "UNBACKED_CONFIGURATION");
	const headers = harness();
	headers.model.headers = { authorization: "private-credential" };
	await headers.event("session_start");
	const response = headers.snapshot();
	unsupported(response, "UNBACKED_CONFIGURATION");
	assert.doesNotMatch(
		JSON.stringify(response),
		/private-credential|authorization/,
	);
	writeFileSync(
		settingsPath,
		JSON.stringify({
			guard: {
				reviewer: { mode: "auto", model: "main", policy: "Allow reads" },
			},
		}),
	);
	const main = harness();
	await main.event("session_start");
	unsupported(main.snapshot(), "UNBACKED_CONFIGURATION");
});

test("non-directory and nonexistent target cwd refuse", async () => {
	const fake = harness();
	await fake.event("session_start");
	unsupported(fake.snapshot(settingsPath), "CWD_UNREPRODUCIBLE");
	unsupported(fake.snapshot(join(root, "missing")), "CWD_UNREPRODUCIBLE");
});

test("switch and fork remain unsupported until a completed session_start", async () => {
	for (const transition of ["switch", "fork"]) {
		const fake = harness();
		await fake.event("session_start");
		const initial = ready(fake.snapshot());
		await fake.event(`session_before_${transition}`);
		unsupported(fake.snapshot(), "RUNTIME_MUTATION");
		fake.replaceSession();
		await fake.event(`session_${transition}`);
		unsupported(fake.snapshot(), "RUNTIME_MUTATION");
		await fake.event("session_start");
		assert.ok(
			ready(fake.snapshot()).binding.generation > initial.binding.generation,
		);
	}
});

test("symlink config replacement is drift even if file contents are equal", async () => {
	const cwd = directory();
	mkdirSync(join(cwd, ".pi"));
	const first = join(root, randomUUID());
	const second = join(root, randomUUID());
	writeFileSync(first, "{}");
	writeFileSync(second, "{}");
	const link = join(cwd, ".pi/settings.json");
	symlinkSync(first, link);
	const fake = harness(cwd);
	await fake.event("session_start");
	ready(fake.snapshot());
	rmSync(link);
	symlinkSync(second, link);
	unsupported(fake.snapshot(), "CONFIG_DRIFT");
});
