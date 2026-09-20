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
	let selectCalls = 0;
	const pi = {
		on(event: string, handler: ToolCallHandler) {
			if (event === "tool_call") toolCallHandler = handler;
		},
		registerTool(tool: ToolDefinition) {
			if (tool.name === "guard_check") guardCheck = tool;
		},
		registerCommand() {},
		events: { emit() {} },
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI,
		cwd: "/workspace",
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
