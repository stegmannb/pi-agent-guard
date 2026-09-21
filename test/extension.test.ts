import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/defaults.ts";
import { registerGuard } from "../src/index.ts";

type ToolCallHandler = (
	event: ToolCallEvent,
	ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined>;

function harness(hasUI = true) {
	let toolCallHandler: ToolCallHandler | undefined;
	let guardCheck: ToolDefinition | undefined;
	const hooks = new Map<string, ToolCallHandler>();
	let selectCalls = 0;
	const pi = {
		on(event: string, handler: ToolCallHandler) {
			hooks.set(event, handler);
			if (event === "tool_call") toolCallHandler = handler;
		},
		registerTool(tool: ToolDefinition) {
			if (tool.name === "guard_check") guardCheck = tool;
		},
		registerCommand() {},
		appendEntry() {},
		events: { emit() {} },
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI,
		cwd: "/workspace",
		sessionManager: { getSessionId: () => "session-test", getBranch: () => [] },
		ui: {
			select: async () => {
				selectCalls++;
				return "Allow";
			},
			confirm: async () => false,
			setStatus() {},
			notify() {},
			theme: { fg: (_color: string, value: string) => value },
		},
	} as unknown as ExtensionContext;
	registerGuard(pi, {
		loaded: {
			config: {
				enabled: true,
				matchers: DEFAULT_CONFIG.matchers,
				rules: { bash: { "*": "ask", echo: "allow", rm: "deny" } },
			},
		},
		projectResult: null,
		startupCwd: "/workspace",
	});
	return {
		ctx,
		getHandler() {
			assert.ok(toolCallHandler);
			return toolCallHandler;
		},
		getGuardCheck() {
			assert.ok(guardCheck);
			return guardCheck;
		},
		getHook(name: string) {
			const hook = hooks.get(name);
			assert.ok(hook);
			return hook;
		},
		selectCalls: () => selectCalls,
	};
}

test("tool_call blocks a compound deny before opening UI", async () => {
	const fake = harness();
	const result = await fake.getHandler()(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-1",
			input: { command: "echo ok && rm -rf / && curl example.com" },
		} as ToolCallEvent,
		fake.ctx,
	);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Security policy/);
	assert.equal(fake.selectCalls(), 0);
});

test("tool_call keeps a known deny final when another part fails to parse", async () => {
	const fake = harness();
	const result = await fake.getHandler()(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-deny-parser",
			input: {
				command: `rm -rf / && bash -c "echo 'unterminated"`,
			},
		} as ToolCallEvent,
		fake.ctx,
	);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Security policy/);
	assert.equal(fake.selectCalls(), 0);
});

test("tool_call blocks a known deny beside a top-level parser diagnostic", async () => {
	const fake = harness();
	const result = await fake.getHandler()(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-deny-top-level-parser",
			input: {
				command: "rm -rf / && echo 'unterminated",
			},
		} as ToolCallEvent,
		fake.ctx,
	);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Security policy/);
	assert.equal(fake.selectCalls(), 0);
});

test("a non-interactive ask blocks without opening UI", async () => {
	const fake = harness(false);
	const result = await fake.getHandler()(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-noninteractive",
			input: { command: "curl example.com" },
		} as ToolCallEvent,
		fake.ctx,
	);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /No interactive session/);
	assert.equal(fake.selectCalls(), 0);
});

test("tool_call uses UI for an ask and guard_check remains read-only", async () => {
	const fake = harness();
	const result = await fake.getHandler()(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-2",
			input: { command: "curl example.com" },
		} as ToolCallEvent,
		fake.ctx,
	);
	assert.equal(result, undefined);
	assert.equal(fake.selectCalls(), 1);

	const guardCheck = fake.getGuardCheck();
	const toolResult = await guardCheck.execute(
		"check-1",
		{ mode: "check", tool: "bash", input: { command: "rm -rf /" } },
		undefined,
		undefined,
		fake.ctx,
	);
	assert.equal(
		(toolResult.details as { patternAction?: string }).patternAction,
		"deny",
	);
	assert.equal((toolResult.details as { cwd?: string }).cwd, "/workspace");
	assert.equal(fake.selectCalls(), 1);

	const hookResult = await fake.getHandler()(
		{
			type: "tool_call",
			toolName: "guard_check",
			toolCallId: "check-1",
			input: { mode: "rules" },
		} as ToolCallEvent,
		fake.ctx,
	);
	assert.equal(hookResult, undefined);
	assert.equal(fake.selectCalls(), 1);
});

test("tree navigation invalidates pending legacy approval without clearing session rules", async () => {
	const fake = harness();
	let answer: ((choice: string) => void) | undefined;
	const ui = fake.ctx.ui as {
		select: (_prompt: string, choices: string[]) => Promise<string>;
	};
	ui.select = async (_prompt, choices) => choices[1] ?? "Reject";
	assert.equal(
		await fake.getHandler()(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "session-grant",
				input: { command: "mysteryctl inspect" },
			} as ToolCallEvent,
			fake.ctx,
		),
		undefined,
	);
	ui.select = async () =>
		new Promise<string>((resolve) => {
			answer = resolve;
		});
	const pending = fake.getHandler()(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "old-branch",
			input: { command: "otherctl inspect" },
		} as ToolCallEvent,
		fake.ctx,
	);
	await Promise.resolve();
	assert.ok(answer);
	await fake.getHook("session_before_tree")(
		{ type: "session_before_tree" } as unknown as ToolCallEvent,
		fake.ctx,
	);
	await fake.getHook("session_tree")(
		{ type: "session_tree" } as unknown as ToolCallEvent,
		fake.ctx,
	);
	answer("Allow");
	assert.match(
		(await pending)?.reason ?? "",
		/Session changed during approval/,
	);
	ui.select = async () => {
		throw new Error("A session grant should not reopen the dialog.");
	};
	assert.equal(
		await fake.getHandler()(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "still-granted",
				input: { command: "mysteryctl inspect" },
			} as ToolCallEvent,
			fake.ctx,
		),
		undefined,
	);
});

test("an exact session approval is visible to guard_check through the live evaluator", async () => {
	let toolCall: ToolCallHandler | undefined;
	let guardCheck: ToolDefinition | undefined;
	const reviewerGrants: unknown[] = [];
	const pi = {
		on(event: string, handler: ToolCallHandler) {
			if (event === "tool_call") toolCall = handler;
		},
		registerTool(tool: ToolDefinition) {
			if (tool.name === "guard_check") guardCheck = tool;
		},
		registerCommand() {},
		appendEntry() {},
		events: { emit() {} },
	} as unknown as ExtensionAPI;
	const model = { provider: "fake", id: "main", maxTokens: 4096 };
	const ctx = {
		hasUI: true,
		cwd: "/workspace",
		model,
		modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
		sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
		ui: {
			setStatus() {},
			notify() {},
			theme: { fg: (_color: string, value: string) => value },
		},
	} as unknown as ExtensionContext;
	registerGuard(pi, {
		loaded: {
			config: {
				enabled: true,
				matchers: DEFAULT_CONFIG.matchers,
				rules: { bash: { "*": "ask" } },
			},
			reviewer: {
				mode: "auto",
				model: "main",
				policy: "Ask before remote changes",
				reviewTimeoutMs: 60_000,
				approvalTimeoutMs: 120_000,
			},
		},
		projectResult: null,
		startupCwd: "/workspace",
		autoReview: {
			review: async (request) => {
				reviewerGrants.push(request.policySnapshot.exactSessionGrants);
				return {
					ok: true,
					mode: "auto",
					model: "fake/main",
					judgment: {
						decision: "ask",
						recommendation: null,
						reason: "Confirm this invocation.",
						alternatives: [],
					},
				};
			},
			ask: async () => ({ kind: "choice", choice: "allow-session" }),
		},
	});
	assert.ok(toolCall);
	assert.ok(guardCheck);
	assert.equal(
		await toolCall(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "approval",
				input: { command: "git push origin main" },
			} as ToolCallEvent,
			ctx,
		),
		undefined,
	);
	const exact = await guardCheck.execute(
		"check-exact",
		{ mode: "check", tool: "bash", input: { command: "git push origin main" } },
		undefined,
		undefined,
		ctx,
	);
	assert.equal((exact.details as { disposition: string }).disposition, "allow");
	const changed = await guardCheck.execute(
		"check-changed",
		{
			mode: "check",
			tool: "bash",
			input: { command: "git push origin other" },
		},
		undefined,
		undefined,
		ctx,
	);
	assert.equal((changed.details as { disposition: string }).disposition, "ask");
	const rules = await guardCheck.execute(
		"check-rules",
		{ mode: "rules" },
		undefined,
		undefined,
		ctx,
	);
	assert.match(JSON.stringify(rules.details), /git push origin main/);
	assert.equal(
		await toolCall(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "next-review",
				input: { command: "git push origin other" },
			} as ToolCallEvent,
			ctx,
		),
		undefined,
	);
	assert.match(JSON.stringify(reviewerGrants[1]), /git push origin main/);
});

test("registered tool_call uses session reviewer and tool_result keeps original output", async () => {
	const hooks = new Map<
		string,
		(event: unknown, ctx: ExtensionContext) => Promise<unknown>
	>();
	const sent: unknown[] = [];
	const audits: unknown[] = [];
	let reviews = 0;
	const pi = {
		on(
			event: string,
			handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>,
		) {
			hooks.set(event, handler);
		},
		registerTool() {},
		registerCommand() {},
		appendEntry(_type: string, entry: unknown) {
			audits.push(entry);
		},
		sendMessage(message: unknown) {
			sent.push(message);
		},
		events: { emit() {} },
	} as unknown as ExtensionAPI;
	const model = { provider: "fake", id: "main", maxTokens: 4096 };
	const ctx = {
		hasUI: false,
		cwd: "/workspace",
		model,
		modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
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
			setStatus() {},
			notify() {},
			theme: { fg: (_color: string, value: string) => value },
		},
	} as unknown as ExtensionContext;
	registerGuard(pi, {
		loaded: {
			config: {
				enabled: true,
				matchers: DEFAULT_CONFIG.matchers,
				rules: { bash: { "*": "ask" } },
			},
			reviewer: {
				mode: "auto",
				model: "main",
				policy: "Allow inspection",
				reviewTimeoutMs: 60_000,
				approvalTimeoutMs: 120_000,
			},
		},
		projectResult: null,
		startupCwd: "/workspace",
		autoReview: {
			review: async () => {
				reviews++;
				return {
					ok: true,
					mode: "auto",
					model: "fake/main",
					judgment: {
						decision: "allow",
						recommendation: null,
						reason: "Read-only inspection is authorized.",
						alternatives: [],
					},
				};
			},
		},
	});
	const toolCall = hooks.get("tool_call");
	assert.ok(toolCall);
	const allowed = await toolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-1",
			input: { command: "mysteryctl inspect" },
		},
		ctx,
	);
	assert.equal(allowed, undefined);
	assert.equal(reviews, 1);
	const toolResult = hooks.get("tool_result");
	assert.ok(toolResult);
	const augmented = (await toolResult(
		{
			type: "tool_result",
			toolName: "bash",
			toolCallId: "call-1",
			input: { command: "mysteryctl inspect" },
			content: [{ type: "text", text: "original" }],
			details: undefined,
			isError: false,
		},
		ctx,
	)) as { content: Array<{ text: string }> };
	assert.equal(augmented.content[0]?.text, "original");
	assert.match(
		augmented.content[1]?.text ?? "",
		/Read-only inspection is authorized/,
	);
	assert.equal(audits.length, 1);
	const second = await toolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-2",
			input: { command: "mysteryctl inspect" },
		},
		ctx,
	);
	assert.equal(second, undefined);
	await toolResult(
		{
			type: "tool_result",
			toolName: "bash",
			toolCallId: "call-2",
			input: { command: "mysteryctl inspect" },
			content: [{ type: "text", text: "tool failed" }],
			details: undefined,
			isError: true,
		},
		ctx,
	);
	assert.equal(sent.length, 1);
	assert.match(JSON.stringify(sent[0]), /Read-only inspection is authorized/);
	const third = await toolCall(
		{
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-3",
			input: { command: "mysteryctl inspect" },
		},
		ctx,
	);
	assert.equal(third, undefined);
	const executionEnd = hooks.get("tool_execution_end");
	assert.ok(executionEnd);
	await executionEnd(
		{ type: "tool_execution_end", toolCallId: "call-3", isError: true },
		ctx,
	);
	assert.equal(sent.length, 2);
	assert.match(JSON.stringify(sent[1]), /later gate or tool error/);
});
