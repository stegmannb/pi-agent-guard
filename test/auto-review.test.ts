import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import {
	type ApprovalClock,
	ApprovalDialog,
	type ApprovalOutcome,
	approvalOptions,
	askApproval,
} from "../src/approval-dialog.ts";
import { AutoReviewController } from "../src/auto-review.ts";
import { DEFAULT_CONFIG } from "../src/defaults.ts";
import { evaluateToolCall } from "../src/evaluator.ts";
import { buildPolicySnapshot } from "../src/policy.ts";
import type { ReviewerResult } from "../src/reviewer.ts";
import type { ReviewerConfig } from "../src/reviewer-config.ts";
import type { GuardContext } from "../src/types.ts";

function controlledClock() {
	let time = 0;
	let tick: (() => void) | undefined;
	const clock: ApprovalClock = {
		now: () => time,
		every: (_ms, callback) => {
			tick = callback;
			return () => {
				tick = undefined;
			};
		},
	};
	return {
		clock,
		advance(ms: number) {
			time += ms;
			tick?.();
		},
	};
}

function baseConfig(mode: ReviewerConfig["mode"] = "auto"): ReviewerConfig {
	return {
		mode,
		model: "main",
		policy: "Allow authorized read-only inspection; ask when uncertain.",
		reviewTimeoutMs: 60_000,
		approvalTimeoutMs: 120_000,
	};
}

function setup(
	options: {
		mode?: ReviewerConfig["mode"];
		hasUI?: boolean;
		rules?: GuardContext["config"]["rules"];
		result?: ReviewerResult;
		ask?: ApprovalOutcome;
	} = {},
) {
	const context: GuardContext = {
		config: {
			enabled: true,
			matchers: DEFAULT_CONFIG.matchers,
			rules: options.rules ?? {
				bash: { "*": "ask", echo: "allow", rm: "deny" },
			},
		},
		staticPolicy: {
			userRules: options.rules ?? {
				bash: { "*": "ask", echo: "allow", rm: "deny" },
			},
			projectRules: {},
			envRules: undefined,
			projectConfigPresent: false,
		},
		activeProfile: undefined,
		sessionRules: {},
		exactSessionGrants: [],
	};
	const audit: unknown[] = [];
	const messages: unknown[] = [];
	let reviewCalls = 0;
	let askCalls = 0;
	let lastPresentation: unknown;
	const pi = {
		appendEntry: (_type: string, entry: unknown) => audit.push(entry),
		sendMessage: (message: unknown) => messages.push(message),
		events: { emit() {} },
	} as unknown as ExtensionAPI;
	const model = { provider: "fake", id: "main", maxTokens: 4096 };
	const ctx = {
		hasUI: options.hasUI ?? true,
		cwd: "/workspace",
		model,
		modelRegistry: {
			find: () => model,
			hasConfiguredAuth: () => true,
		},
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "Inspect the repository" }],
					},
				},
			],
		},
		ui: {
			select: async () => "Allow",
			setStatus() {},
			notify() {},
			theme: { fg: (_color: string, value: string) => value },
		},
	} as unknown as ExtensionContext;
	const reviewerResult: ReviewerResult = options.result ?? {
		ok: true,
		mode: options.mode ?? "auto",
		model: "fake/main",
		judgment: {
			decision: "allow",
			recommendation: null,
			reason: "Authorized inspection.",
			alternatives: [],
		},
	};
	const controller = new AutoReviewController(
		pi,
		context,
		baseConfig(options.mode),
		{
			review: async () => {
				reviewCalls++;
				return reviewerResult;
			},
			ask: async (_ctx, presentation) => {
				askCalls++;
				lastPresentation = presentation;
				return options.ask ?? { kind: "choice", choice: "allow-once" };
			},
		},
	);
	async function call(command: string, id = "call-1", cwd = "/workspace") {
		(ctx as { cwd: string }).cwd = cwd;
		const snapshot = buildPolicySnapshot(context);
		const evaluated = evaluateToolCall(snapshot, "bash", { command }, cwd);
		const event = {
			type: "tool_call",
			toolName: "bash",
			toolCallId: id,
			input: { command },
		} as ToolCallEvent;
		return controller.handle(event, ctx, snapshot, evaluated);
	}
	return {
		controller,
		context,
		ctx,
		call,
		audit,
		messages,
		reviewCalls: () => reviewCalls,
		askCalls: () => askCalls,
		presentation: () => lastPresentation,
	};
}

test("auto allow uses review only for fallback asks and appends reason to the original result", async () => {
	const fake = setup();
	assert.equal(await fake.call("echo ok"), undefined);
	assert.equal(fake.reviewCalls(), 0);
	assert.equal(await fake.call("mysteryctl inspect"), undefined);
	assert.equal(fake.reviewCalls(), 1);
	const result = fake.controller.toolResult({
		type: "tool_result",
		toolName: "bash",
		toolCallId: "call-1",
		input: { command: "mysteryctl inspect" },
		content: [{ type: "text", text: "original output" }],
		details: undefined,
		isError: false,
	} as ToolResultEvent);
	assert.equal(result?.content?.[0]?.type, "text");
	assert.match(
		(result?.content?.[1] as { text: string }).text,
		/Authorized inspection/,
	);
	assert.equal(fake.askCalls(), 0);
	assert.equal(fake.audit.length, 1);
});

test("pattern deny and specific ask never invoke reviewer", async () => {
	const fake = setup();
	assert.equal(
		(await fake.call("echo ok && rm -rf / && git status"))?.block,
		true,
	);
	assert.equal(fake.reviewCalls(), 0);
	assert.equal((fake.audit[0] as { source: string }).source, "policy");
	const specific = setup({
		rules: { bash: { "*": "ask", "git push": "ask" } },
		hasUI: false,
	});
	assert.equal((await specific.call("git push origin main"))?.block, true);
	assert.equal(specific.reviewCalls(), 0);
});

test("auto deny explains, prevents unchanged repeat, and permits a one-time exact override", async () => {
	const fake = setup({
		result: {
			ok: true,
			mode: "auto",
			model: "fake/main",
			judgment: {
				decision: "deny",
				recommendation: null,
				reason: "Publishing is outside the user task.",
				alternatives: [
					{
						tool: "bash",
						input: { command: "git status" },
						reason: "Inspect only.",
						changedEffect: "No remote write.",
					},
				],
			},
		},
	});
	const first = await fake.call("git push origin main");
	assert.match(first?.reason ?? "", /Publishing is outside/);
	assert.match(first?.reason ?? "", /guard: allow/);
	const second = await fake.call("git push origin main", "call-2");
	assert.match(second?.reason ?? "", /repeated request/);
	assert.equal(fake.reviewCalls(), 1);
	const requestId = /request ([0-9a-f-]{36})/.exec(first?.reason ?? "")?.[1];
	assert.ok(requestId);
	assert.equal(fake.controller.approve(requestId, fake.ctx).ok, true);
	// A slash command may itself count as user input; the override stays bound to
	// the exact invocation while the repeat limiter starts a new turn.
	fake.controller.newUserInput();
	assert.equal(await fake.call("git push origin main", "call-3"), undefined);
	assert.equal(fake.reviewCalls(), 1);
	const changed = await fake.call("git push origin other", "call-4");
	assert.equal(changed?.block, true);
	assert.equal(fake.reviewCalls(), 2);
});

test("a human override cannot survive a later pattern deny", async () => {
	const fake = setup({
		result: {
			ok: true,
			mode: "auto",
			model: "fake/main",
			judgment: {
				decision: "deny",
				recommendation: null,
				reason: "Remote write needs approval.",
				alternatives: [],
			},
		},
	});
	const denied = await fake.call("git push origin main");
	const requestId = /request ([0-9a-f-]{36})/.exec(denied?.reason ?? "")?.[1];
	assert.ok(requestId);
	fake.context.sessionRules.bash = { "git push": "deny" };
	assert.equal(fake.controller.approve(requestId, fake.ctx).ok, false);
	const next = await fake.call("git push origin main", "call-next");
	assert.match(next?.reason ?? "", /Security policy/);
	assert.equal(fake.reviewCalls(), 1);
});

test("a one-time override follows the resolved main model, not only its setting", async () => {
	const fake = setup({
		result: {
			ok: true,
			mode: "auto",
			model: "fake/main",
			judgment: {
				decision: "deny",
				recommendation: null,
				reason: "Confirm the remote first.",
				alternatives: [],
			},
		},
	});
	const denied = await fake.call("git push origin main");
	const requestId = /request ([0-9a-f-]{36})/.exec(denied?.reason ?? "")?.[1];
	assert.ok(requestId);
	(fake.ctx as { model: { provider: string; id: string } }).model = {
		provider: "fake",
		id: "different",
	};
	assert.equal(fake.controller.approve(requestId, fake.ctx).ok, false);
	assert.match(
		(await fake.call("git push origin main", "changed-model"))?.reason ?? "",
		/Confirm the remote first/,
	);
	assert.equal(fake.reviewCalls(), 2);
});

test("observe keeps human approval and no UI blocks even if reviewer says allow", async () => {
	const interactive = setup({
		mode: "observe",
		ask: { kind: "choice", choice: "allow-once" },
	});
	assert.equal(await interactive.call("mysteryctl inspect"), undefined);
	assert.equal(interactive.askCalls(), 1);
	const headless = setup({ mode: "observe", hasUI: false });
	assert.match(
		(await headless.call("mysteryctl inspect"))?.reason ?? "",
		/Human approval required/,
	);
	assert.equal(headless.askCalls(), 0);
});

test("suggest allow asks with Allow once selected, while neutral ask has no recommendation", async () => {
	for (const recommendation of ["allow", null] as const) {
		const fake = setup({
			result: {
				ok: true,
				mode: "auto",
				model: "fake/main",
				judgment: {
					decision: "ask",
					recommendation,
					reason: "Ask the operator.",
					alternatives: [],
				},
			},
			ask: { kind: "choice", choice: "deny" },
		});
		assert.match(
			(await fake.call("mysteryctl inspect"))?.reason ?? "",
			/Ask the operator/,
		);
		assert.equal(fake.askCalls(), 1);
		assert.equal(
			(fake.presentation() as { recommendation: string | null }).recommendation,
			recommendation,
		);
	}
});

test("submitted human feedback permits another review of the same command", async () => {
	const fake = setup({
		result: {
			ok: true,
			mode: "auto",
			model: "fake/main",
			judgment: {
				decision: "ask",
				recommendation: null,
				reason: "Check the destination.",
				alternatives: [],
			},
		},
		ask: { kind: "feedback", text: "Use the staging remote." },
	});
	assert.match(
		(await fake.call("mysteryctl publish"))?.reason ?? "",
		/Use the staging remote/,
	);
	assert.match(
		(await fake.call("mysteryctl publish", "second"))?.reason ?? "",
		/Use the staging remote/,
	);
	assert.equal(fake.reviewCalls(), 2);
});

test("failed project save blocks execution without adding a broad session rule", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-guard-bad-settings-"));
	const settingsDir = path.join(cwd, ".pi");
	mkdirSync(settingsDir);
	const settingsPath = path.join(settingsDir, "settings.json");
	writeFileSync(settingsPath, "{ invalid json");
	try {
		const fake = setup({
			result: {
				ok: true,
				mode: "auto",
				model: "fake/main",
				judgment: {
					decision: "ask",
					recommendation: null,
					reason: "Confirm this command.",
					alternatives: [],
				},
			},
			ask: { kind: "choice", choice: "allow-project" },
		});
		const response = await fake.call("mysteryctl inspect", "save-fail", cwd);
		assert.match(response?.reason ?? "", /selected rule could not be saved/);
		assert.deepEqual(fake.context.sessionRules.bash, {});
		assert.equal(readFileSync(settingsPath, "utf8"), "{ invalid json");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("auto headless allow proceeds and records available usage without raw command", async () => {
	const fake = setup({
		hasUI: false,
		result: {
			ok: true,
			mode: "auto",
			model: "fake/main",
			usage: {
				input: 12,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: {
					input: 0.001,
					output: 0.002,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.003,
				},
			},
			judgment: {
				decision: "allow",
				recommendation: null,
				reason: "Read-only inspection.",
				alternatives: [],
			},
		},
	});
	assert.equal(await fake.call("mysteryctl inspect"), undefined);
	assert.equal(fake.askCalls(), 0);
	const audit = fake.audit[0] as {
		usage: { totalTokens: number };
		command?: string;
	};
	assert.equal(audit.usage.totalTokens, 15);
	assert.equal(audit.command, undefined);
});

test("suggest deny selects Deny, while explicit session approval has exact scope", async () => {
	const fake = setup({
		result: {
			ok: true,
			mode: "auto",
			model: "fake/main",
			judgment: {
				decision: "ask",
				recommendation: "deny",
				reason: "Check the destination.",
				alternatives: [],
			},
		},
		ask: { kind: "choice", choice: "allow-session" },
	});
	assert.equal(await fake.call("git push origin main"), undefined);
	assert.equal(
		(fake.presentation() as { recommendation: string }).recommendation,
		"deny",
	);
	const snapshot = buildPolicySnapshot(fake.context);
	assert.equal(
		evaluateToolCall(
			snapshot,
			"bash",
			{ command: "git push origin main" },
			"/workspace",
		).result.disposition,
		"allow",
	);
	assert.equal(
		evaluateToolCall(
			snapshot,
			"bash",
			{ command: "git push origin other" },
			"/workspace",
		).result.disposition,
		"ask",
	);
	for (const command of [
		"git push upstream main",
		"git push origin feature",
		"git push --force origin main",
		"git push origin main > output.txt",
		"git push origin main | cat",
		"(git push origin main)",
	]) {
		assert.equal(
			evaluateToolCall(snapshot, "bash", { command }, "/workspace").result
				.disposition,
			"ask",
			command,
		);
	}
	assert.equal(
		evaluateToolCall(
			snapshot,
			"bash",
			{ command: "git push origin main" },
			"/other",
		).result.disposition,
		"ask",
	);
	assert.equal(
		evaluateToolCall(snapshot, "bash", { command: "rm -rf /" }, "/workspace")
			.result.disposition,
		"deny",
	);
});

test("literal glob characters in an exact session grant never match expanded input", async () => {
	const fake = setup({
		result: {
			ok: true,
			mode: "auto",
			model: "fake/main",
			judgment: {
				decision: "ask",
				recommendation: null,
				reason: "Confirm inspection.",
				alternatives: [],
			},
		},
		ask: { kind: "choice", choice: "allow-session" },
	});
	assert.equal(await fake.call('mysteryctl inspect "*.txt"'), undefined);
	const snapshot = buildPolicySnapshot(fake.context);
	assert.equal(
		evaluateToolCall(
			snapshot,
			"bash",
			{ command: 'mysteryctl inspect "*.txt"' },
			"/workspace",
		).result.disposition,
		"allow",
	);
	assert.equal(
		evaluateToolCall(
			snapshot,
			"bash",
			{ command: "mysteryctl inspect a.txt" },
			"/workspace",
		).result.disposition,
		"ask",
	);
});

test("technical failure asks conservatively and normal approval timeout blocks", async () => {
	const fake = setup({
		result: { ok: false, error: "timeout", reason: "Reviewer timed out." },
		ask: { kind: "timeout" },
	});
	const response = await fake.call("mysteryctl inspect");
	assert.match(response?.reason ?? "", /approval_timeout/);
	assert.equal(fake.askCalls(), 1);
	assert.equal(
		(fake.audit[0] as { humanDecision: string }).humanDecision,
		"approval_timeout",
	);
});

test("off mode never calls reviewer", async () => {
	const fake = setup({ mode: "off", hasUI: false });
	assert.equal((await fake.call("mysteryctl inspect"))?.block, true);
	assert.equal(fake.reviewCalls(), 0);
});

test("session change aborts a pending review and clears grants", async () => {
	const fake = setup();
	const controller = new AutoReviewController(
		{ appendEntry() {}, events: { emit() {} } } as unknown as ExtensionAPI,
		fake.context,
		baseConfig(),
		{
			review: async (_request, _config, _dependencies, signal) =>
				new Promise((resolve) => {
					signal?.addEventListener(
						"abort",
						() => resolve({ ok: false, error: "aborted", reason: "cancelled" }),
						{ once: true },
					);
				}),
		},
	);
	const snapshot = buildPolicySnapshot(fake.context);
	const evaluated = evaluateToolCall(
		snapshot,
		"bash",
		{ command: "mysteryctl inspect" },
		"/workspace",
	);
	const pending = controller.handle(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "pending",
			input: { command: "mysteryctl inspect" },
		} as ToolCallEvent,
		fake.ctx,
		snapshot,
		evaluated,
	);
	controller.sessionChanged();
	assert.match((await pending)?.reason ?? "", /Session or policy changed/);
	assert.deepEqual(fake.context.exactSessionGrants, []);
});

test("a canceled transition aborts pending work but retains existing session grants", async () => {
	const fake = setup({
		result: {
			ok: true,
			mode: "auto",
			model: "fake/main",
			judgment: {
				decision: "ask",
				recommendation: null,
				reason: "Confirm once.",
				alternatives: [],
			},
		},
		ask: { kind: "choice", choice: "allow-session" },
	});
	assert.equal(await fake.call("mysteryctl inspect"), undefined);
	assert.equal(fake.context.exactSessionGrants.length, 1);
	fake.controller.abortPending();
	assert.equal(fake.context.exactSessionGrants.length, 1);
	fake.controller.branchChanged();
	assert.equal(fake.context.exactSessionGrants.length, 1);
	const snapshot = buildPolicySnapshot(fake.context);
	assert.equal(
		evaluateToolCall(
			snapshot,
			"bash",
			{ command: "mysteryctl inspect" },
			"/workspace",
		).result.disposition,
		"allow",
	);
	fake.controller.sessionChanged();
	assert.equal(fake.context.exactSessionGrants.length, 0);
});

test("a policy change before reviewer completion cannot admit a stale allow", async () => {
	const fake = setup();
	let complete: ((result: ReviewerResult) => void) | undefined;
	const controller = new AutoReviewController(
		{ appendEntry() {}, events: { emit() {} } } as unknown as ExtensionAPI,
		fake.context,
		baseConfig(),
		{
			review: async () =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		},
	);
	const snapshot = buildPolicySnapshot(fake.context);
	const event = {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "stale-policy",
		input: { command: "mysteryctl inspect" },
	} as ToolCallEvent;
	const pending = controller.handle(
		event,
		fake.ctx,
		snapshot,
		evaluateToolCall(snapshot, "bash", event.input, "/workspace"),
	);
	fake.context.sessionRules.bash = { mysteryctl: "deny" };
	assert.ok(complete);
	complete({
		ok: true,
		mode: "auto",
		model: "fake/main",
		judgment: {
			decision: "allow",
			recommendation: null,
			reason: "Inspection is authorized.",
			alternatives: [],
		},
	});
	assert.match((await pending)?.reason ?? "", /Session or policy changed/);
});

test("terminal dialog pauses on navigation and resumes only by explicit option", async () => {
	const tui = { terminal: { rows: 40 }, requestRender() {} };
	const time = controlledClock();
	let result: ApprovalOutcome | undefined;
	const dialog = new ApprovalDialog(
		tui as never,
		{
			command: "git push origin main",
			cwd: "/workspace",
			recommendation: "deny",
			reason: "Check destination",
			options: approvalOptions(false, false, []),
			timeoutMs: 200,
		},
		(value) => {
			result = value;
		},
		undefined,
		time.clock,
	);
	assert.match(dialog.render(80).join("\n"), /Auto-deny in 1 s/);
	dialog.handleInput("\x1b[B");
	assert.match(dialog.render(80).join("\n"), /Timeout paused/);
	time.advance(230);
	assert.equal(result, undefined);
	dialog.handleInput("\x1b[6~");
	assert.match(dialog.render(80).join("\n"), /Timeout paused/);
	// Select the flat Resume timeout option.
	dialog.handleInput("\x1b[B");
	dialog.handleInput("\r");
	assert.match(dialog.render(80).join("\n"), /Auto-deny/);
	time.advance(200);
	assert.deepEqual(result, { kind: "timeout" });
	dialog.dispose();
});

test("countdown shrinks from the right and stays frozen through input and repaint", () => {
	const tui = { terminal: { rows: 30 }, requestRender() {} };
	const time = controlledClock();
	const dialog = new ApprovalDialog(
		tui as never,
		{
			command: "mysteryctl inspect",
			cwd: "/workspace",
			recommendation: "allow",
			reason: "Inspect only.",
			options: approvalOptions(false, false, []),
			timeoutMs: 4000,
		},
		() => {},
		undefined,
		time.clock,
	);
	assert.match(dialog.render(80).join("\n"), /█{20}\] Auto-deny in 4 s/);
	time.advance(1000);
	assert.match(dialog.render(80).join("\n"), /█{15}░{5}\] Auto-deny in 3 s/);
	dialog.handleInput("\x1b[6~");
	const paused = dialog.render(80).join("\n");
	assert.match(paused, /Timeout paused · 3 s remaining/);
	dialog.handleInput("\x1b[200~notes\x1b[201~");
	time.advance(5000);
	assert.equal(dialog.render(80).join("\n"), paused);
	dialog.dispose();
});

test("RPC uses a flat standard selector without an autonomous approval timeout", async () => {
	let title = "";
	let options: string[] = [];
	let selectOptions: unknown;
	const ctx = {
		hasUI: true,
		ui: {
			custom: async () => undefined,
			select: async (label: string, choices: string[], opts: unknown) => {
				title = label;
				options = choices;
				selectOptions = opts;
				return "Deny";
			},
		},
	} as unknown as ExtensionContext;
	const result = await askApproval(ctx, {
		command: "git push origin main",
		cwd: "/workspace",
		recommendation: "deny",
		reason: "Check destination",
		options: approvalOptions(true, true, [
			{ input: { command: "git status" } },
		]),
		timeoutMs: 10,
	});
	assert.deepEqual(result, { kind: "choice", choice: "deny" });
	assert.match(title, /Timeout paused: input activity unavailable/);
	assert.equal(options[0], "Deny");
	assert.ok(
		options.some((option) =>
			option.includes(
				"Allow for this session — Exact command · current directory · this session",
			),
		),
	);
	assert.ok(
		options.some((option) =>
			option.includes("Allow for this project — Save command-name rules"),
		),
	);
	assert.ok(
		options.some((option) =>
			option.includes("Allow globally — Save command-name rules"),
		),
	);
	assert.ok(
		options.some((option) =>
			option.startsWith("Return alternative 1 to agent"),
		),
	);
	assert.equal((selectOptions as { timeout?: number }).timeout, undefined);
});

test("RPC maps full scope labels and rejects answers outside the offered choices", async () => {
	let response = "";
	const ctx = {
		hasUI: true,
		ui: {
			custom: async () => undefined,
			select: async (_title: string, choices: string[]) => {
				return response === "session"
					? choices.find((choice) =>
							choice.startsWith("Allow for this session"),
						)
					: response;
			},
		},
	} as unknown as ExtensionContext;
	const presentation = {
		command: "mysteryctl inspect",
		cwd: "/workspace",
		recommendation: null,
		reason: "Confirm.",
		options: approvalOptions(true, true, []),
		timeoutMs: 100,
	} as const;
	response = "session";
	assert.deepEqual(await askApproval(ctx, presentation), {
		kind: "choice",
		choice: "allow-session",
	});
	response = "Allow globally";
	assert.deepEqual(await askApproval(ctx, presentation), { kind: "cancel" });
});

test("an opened custom dialog with no final result is cancellation", async () => {
	const ctx = {
		hasUI: true,
		ui: {
			custom: async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: unknown,
				) => unknown,
			) => {
				factory(
					{ terminal: { rows: 30 }, requestRender() {} },
					{},
					{},
					() => {},
				);
				return undefined;
			},
		},
	} as unknown as ExtensionContext;
	assert.deepEqual(
		await askApproval(ctx, {
			command: "mysteryctl inspect",
			cwd: "/workspace",
			recommendation: null,
			reason: "Uncertain.",
			options: approvalOptions(false, false, []),
			timeoutMs: null,
		}),
		{ kind: "cancel" },
	);
});

test("terminal feedback stays in the dialog and disables execution", async () => {
	const tui = { terminal: { rows: 25 }, requestRender() {} };
	const time = controlledClock();
	let result: ApprovalOutcome | undefined;
	const dialog = new ApprovalDialog(
		tui as never,
		{
			command: "mysteryctl publish",
			cwd: "/workspace",
			recommendation: null,
			reason: "Uncertain effect",
			options: approvalOptions(false, false, []),
			timeoutMs: 150,
		},
		(value) => {
			result = value;
		},
		undefined,
		time.clock,
	);
	// Deny starts selected; move to Give feedback, then paste text into its input.
	dialog.handleInput("\x1b[B");
	dialog.handleInput("\r");
	assert.match(dialog.render(60).join("\n"), /Feedback to agent/);
	dialog.handleInput("\x1b[200~Please inspect first\x1b[201~");
	time.advance(180);
	assert.equal(result, undefined);
	dialog.handleInput("\r");
	assert.deepEqual(result, { kind: "feedback", text: "Please inspect first" });
	dialog.dispose();
});

test("terminal approval with disabled timeout remains open until a choice", async () => {
	const tui = { terminal: { rows: 25 }, requestRender() {} };
	let result: ApprovalOutcome | undefined;
	const dialog = new ApprovalDialog(
		tui as never,
		{
			command: "mysteryctl inspect",
			cwd: "/workspace",
			recommendation: "allow",
			reason: "Read only",
			options: approvalOptions(false, false, []),
			timeoutMs: null,
		},
		(value) => {
			result = value;
		},
	);
	assert.match(dialog.render(60).join("\n"), /No timeout/);
	dialog.handleInput("\x1b[6~");
	assert.doesNotMatch(dialog.render(60).join("\n"), /Resume timeout/);
	assert.equal(result, undefined);
	dialog.handleInput("\r");
	assert.deepEqual(result, { kind: "choice", choice: "allow-once" });
	dialog.dispose();
});

test("narrow, low terminal keeps the flat options visible and scrolls long details", () => {
	const tui = { terminal: { rows: 12 }, requestRender() {} };
	const dialog = new ApprovalDialog(
		tui as never,
		{
			command:
				"git push origin main --force-with-lease && echo a very long command with multiple arguments",
			cwd: "/very/long/project/directory/that/wraps/in/a/narrow/terminal",
			recommendation: "deny",
			reason:
				"A long reason that explains the exact repository and the requested remote operation in several wrapped lines.",
			options: approvalOptions(true, true, [
				{ input: { command: "git status" } },
				{ input: { command: "git diff" } },
				{ input: { command: "git log -1" } },
			]),
			timeoutMs: null,
		},
		() => {},
	);
	const first = dialog.render(40);
	assert.ok(first.length <= 12);
	assert.match(first.join("\n"), /Deny/);
	assert.match(first.join("\n"), /PageUp\/PageDown/);
	dialog.handleInput("\x1b[6~");
	assert.match(dialog.render(40).join("\n"), /exact repository/);
	dialog.handleInput("\x1b[6~");
	assert.match(dialog.render(40).join("\n"), /&& echo a very long command/);
	dialog.dispose();
});

test("timeout wins over a late keypress exactly once", () => {
	const time = controlledClock();
	const tui = { terminal: { rows: 25 }, requestRender() {} };
	const outcomes: ApprovalOutcome[] = [];
	const dialog = new ApprovalDialog(
		tui as never,
		{
			command: "mysteryctl inspect",
			cwd: "/workspace",
			recommendation: "allow",
			reason: "Read only",
			options: approvalOptions(false, false, []),
			timeoutMs: 50,
		},
		(value) => outcomes.push(value),
		undefined,
		time.clock,
	);
	time.advance(50);
	dialog.handleInput("\r");
	assert.deepEqual(outcomes, [{ kind: "timeout" }]);
	dialog.dispose();
});

test("parallel reviewer results stay bound to their toolCall IDs", async () => {
	const fake = setup();
	const pending = new Map<string, (result: ReviewerResult) => void>();
	const controller = new AutoReviewController(
		{
			appendEntry() {},
			events: { emit() {} },
			sendMessage() {},
		} as unknown as ExtensionAPI,
		fake.context,
		baseConfig(),
		{
			review: async (request) =>
				new Promise((resolve) => {
					pending.set(String(request.input.command), resolve);
				}),
		},
	);
	function call(command: string, id: string) {
		const snapshot = buildPolicySnapshot(fake.context);
		return controller.handle(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: id,
				input: { command },
			} as ToolCallEvent,
			fake.ctx,
			snapshot,
			evaluateToolCall(snapshot, "bash", { command }, "/workspace"),
		);
	}
	const first = call("mysteryctl inspect", "one");
	const second = call("mysteryctl publish", "two");
	const deny = pending.get("mysteryctl publish");
	const allow = pending.get("mysteryctl inspect");
	assert.ok(deny);
	assert.ok(allow);
	deny({
		ok: true,
		mode: "auto",
		model: "fake/main",
		judgment: {
			decision: "deny",
			recommendation: null,
			reason: "Publishing is not authorized.",
			alternatives: [],
		},
	});
	allow({
		ok: true,
		mode: "auto",
		model: "fake/main",
		judgment: {
			decision: "allow",
			recommendation: null,
			reason: "Inspection is authorized.",
			alternatives: [],
		},
	});
	assert.match((await second)?.reason ?? "", /Publishing is not authorized/);
	assert.equal(await first, undefined);
	const result = controller.toolResult({
		type: "tool_result",
		toolName: "bash",
		toolCallId: "one",
		input: { command: "mysteryctl inspect" },
		content: [{ type: "text", text: "original" }],
		details: undefined,
		isError: false,
	} as ToolResultEvent);
	assert.match(
		(result?.content?.[1] as { text: string }).text,
		/Inspection is authorized/,
	);
	assert.equal(
		controller.toolResult({
			type: "tool_result",
			toolName: "bash",
			toolCallId: "two",
			input: { command: "mysteryctl publish" },
			content: [{ type: "text", text: "blocked" }],
			details: undefined,
			isError: true,
		} as ToolResultEvent),
		undefined,
	);
});
