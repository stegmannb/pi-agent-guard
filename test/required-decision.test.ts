import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ToolCallEvent,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/defaults.ts";
import { registerGuard } from "../src/index.ts";

function harness(hasUI = true, persisted = true) {
	const hooks = new Map<
		string,
		(event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>
	>();
	const commands = new Map<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<void>
	>();
	const tools = new Map<string, ToolDefinition>();
	const branches = new Map<
		string,
		Array<{
			type: string;
			customType?: string;
			data?: unknown;
			message?: unknown;
		}>
	>();
	const messages: string[] = [];
	const notifications: string[] = [];
	let sessionId = "session-a";
	let branchName = "main";
	let aborted = 0;
	let authenticated = true;
	let select: (
		title: string,
		options: string[],
		signal?: AbortSignal,
	) => Promise<string | undefined> = async (_title, options) => options[0];
	const branchKey = () => `${sessionId}/${branchName}`;
	const branch = () => branches.get(branchKey()) ?? [];
	const pi = {
		on(
			name: string,
			handler: (
				event: unknown,
				ctx: ExtensionCommandContext,
			) => Promise<unknown>,
		) {
			hooks.set(name, handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerCommand(
			name: string,
			command: {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			},
		) {
			commands.set(name, command.handler);
		},
		appendEntry(customType: string, data: unknown) {
			branches.set(branchKey(), [
				...branch(),
				{ type: "custom", customType, data },
			]);
		},
		sendUserMessage(message: string) {
			messages.push(message);
		},
		events: { emit() {} },
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI,
		cwd: "/workspace",
		model: { provider: "fake", id: "model" },
		modelRegistry: { hasConfiguredAuth: () => authenticated },
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => (persisted ? "/tmp/session.jsonl" : undefined),
			getBranch: () => branch(),
		},
		abort: () => {
			aborted++;
		},
		ui: {
			select: (
				title: string,
				options: string[],
				opts?: { signal?: AbortSignal },
			) => select(title, options, opts?.signal),
			notify: (message: string) => notifications.push(message),
			setStatus() {},
			theme: { fg: (_color: string, text: string) => text },
		},
	} as unknown as ExtensionCommandContext;
	registerGuard(pi, {
		loaded: {
			config: {
				enabled: true,
				matchers: DEFAULT_CONFIG.matchers,
				rules: { bash: { "*": "ask", echo: "allow" } },
			},
		},
		projectResult: null,
		startupCwd: "/workspace",
	});
	const input = {
		question: "Which environment should be used?",
		reason: "The request does not identify the target.",
		options: [
			{ key: "staging", label: "Staging" },
			{ key: "production", label: "Production" },
		],
	};
	async function preflight(
		toolName: string,
		toolCallId: string,
		eventInput: unknown,
	) {
		return hooks.get("tool_call")?.(
			{
				type: "tool_call",
				toolName,
				toolCallId,
				input: eventInput,
			} as ToolCallEvent,
			ctx,
		);
	}
	async function execute(toolCallId: string, signal?: AbortSignal) {
		const tool = tools.get("guard_require_decision");
		assert.ok(tool);
		return tool.execute(toolCallId, input, signal, undefined, ctx);
	}
	return {
		ctx,
		input,
		preflight,
		execute,
		hooks,
		commands,
		messages,
		notifications,
		branch,
		appendUserMessage(text: string) {
			branches.set(branchKey(), [
				...branch(),
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text }] },
				},
			]);
		},
		setSelect(fn: typeof select) {
			select = fn;
		},
		setSession(id: string) {
			sessionId = id;
		},
		setBranch(name: string) {
			branchName = name;
		},
		setAuthenticated(value: boolean) {
			authenticated = value;
		},
		aborted: () => aborted,
	};
}

function resultText(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

function pendingId(fake: ReturnType<typeof harness>): string {
	const data = fake.branch().at(-1)?.data as
		| { request?: { id?: string } }
		| undefined;
	assert.ok(data?.request?.id);
	return data.request.id;
}

test("terminal and RPC dialogs wait without approval timeout and block parallel work", async () => {
	for (const mode of ["terminal", "rpc"]) {
		const fake = harness(true);
		let finish: ((choice: string) => void) | undefined;
		fake.setSelect(async (title, options, signal) => {
			assert.match(title, /Which environment/);
			assert.deepEqual(options, [
				"staging: Staging",
				"production: Production",
				"Cancel",
			]);
			assert.equal(signal?.aborted, false);
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		assert.equal(
			await fake.preflight("guard_require_decision", mode, fake.input),
			undefined,
		);
		assert.match(
			String(
				(
					(await fake.preflight("bash", "sibling", {
						command: "echo safe",
					})) as { reason: string }
				).reason,
			),
			/Required user decision/,
		);
		const wait = fake.execute(mode);
		assert.ok(finish);
		assert.equal(fake.aborted(), 0);
		assert.equal(
			(await fake.preflight(
				"guard_require_decision",
				"duplicate",
				fake.input,
			)) && true,
			true,
		);
		finish("production: Production");
		const result = await wait;
		assert.match(resultText(result), /human selected production/);
		assert.equal(
			(fake.branch().at(-1)?.data as { status: string }).status,
			"answered",
		);
		assert.equal(
			await fake.preflight("bash", "after", { command: "echo safe" }),
			undefined,
		);
	}
});

test("cancel and tool abort clear the request without granting an answer", async () => {
	for (const cancelBySignal of [false, true]) {
		const fake = harness();
		const controller = new AbortController();
		fake.setSelect(async (_title, _options, signal) => {
			if (!cancelBySignal) return "Cancel";
			return new Promise((resolve) => {
				signal?.addEventListener("abort", () => resolve(undefined), {
					once: true,
				});
			});
		});
		await fake.preflight("guard_require_decision", "ask", fake.input);
		const run = fake.execute("ask", controller.signal);
		if (cancelBySignal) controller.abort();
		assert.match(resultText(await run), /cancelled/);
		assert.equal(
			(fake.branch().at(-1)?.data as { status: string }).status,
			"cancelled",
		);
		assert.equal(fake.messages.length, 0);
	}
});

test("headless mode stops, restores same session and accepts one human slash answer", async () => {
	const fake = harness(false);
	await fake.preflight("guard_require_decision", "ask", fake.input);
	const originalError = console.error;
	let stderr = "";
	console.error = (...parts: unknown[]) => {
		stderr += parts.join(" ");
	};
	let result: Awaited<ReturnType<typeof fake.execute>>;
	try {
		result = await fake.execute("ask");
	} finally {
		console.error = originalError;
	}
	const id = pendingId(fake);
	assert.equal(fake.aborted(), 1);
	assert.equal((result.details as { persisted: boolean }).persisted, true);
	assert.match(resultText(result), new RegExp(id));
	assert.match(stderr, new RegExp(id));
	assert.match(stderr, /Which environment should be used/);
	assert.equal(
		(
			(await fake.hooks.get("input")?.(
				{ type: "input", text: "continue anyway", source: "interactive" },
				fake.ctx,
			)) as { action: string }
		).action,
		"handled",
	);
	await fake.hooks.get("tool_result")?.(
		{
			type: "tool_result",
			toolName: "guard_require_decision",
			toolCallId: "ask",
		},
		fake.ctx,
	);
	assert.match(
		(
			(await fake.preflight("bash", "blocked", { command: "echo safe" })) as {
				reason: string;
			}
		).reason,
		/Required user decision/,
	);
	await fake.hooks.get("session_start")?.({ type: "session_start" }, fake.ctx);
	assert.match(fake.notifications.at(-1) ?? "", new RegExp(id));
	const command = fake.commands.get("guard");
	assert.ok(command);
	await command(`answer wrong production`, fake.ctx);
	assert.equal(fake.messages.length, 0);
	await command(`answer ${id} invalid`, fake.ctx);
	assert.equal(fake.messages.length, 0);
	await command(
		`answer ${id} production use only the approved target`,
		fake.ctx,
	);
	assert.match(
		fake.messages[0] ?? "",
		/Additional context: use only the approved target/,
	);
	assert.equal(
		(
			(await fake.hooks.get("input")?.(
				{ type: "input", text: "another request", source: "rpc" },
				fake.ctx,
			)) as { action: string }
		).action,
		"handled",
	);
	assert.equal(
		await fake.hooks.get("input")?.(
			{ type: "input", text: fake.messages[0], source: "extension" },
			fake.ctx,
		),
		undefined,
	);
	assert.equal(
		(fake.branch().at(-1)?.data as { status: string }).status,
		"submitted",
	);
	await fake.hooks.get("message_end")?.(
		{
			type: "message_end",
			message: {
				role: "user",
				content: [{ type: "text", text: fake.messages[0] }],
			},
		},
		fake.ctx,
	);
	await fake.hooks.get("message_start")?.(
		{ type: "message_start", message: { role: "assistant" } },
		fake.ctx,
	);
	assert.equal(
		(fake.branch().at(-1)?.data as { status: string }).status,
		"answered",
	);
	await command(`answer ${id} staging`, fake.ctx);
	assert.equal(fake.messages.length, 1);
	assert.equal(
		await fake.preflight("bash", "after", { command: "echo safe" }),
		undefined,
	);
});

test("foreign sessions and branches cannot answer a pending request", async () => {
	const fake = harness(false);
	await fake.preflight("guard_require_decision", "ask", fake.input);
	await fake.execute("ask");
	const id = pendingId(fake);
	const command = fake.commands.get("guard");
	assert.ok(command);
	// A separate session has no matching request, even if the same command ID is supplied.
	fake.setSession("session-b");
	await fake.hooks.get("session_switch")?.(
		{ type: "session_switch" },
		fake.ctx,
	);
	await command(`answer ${id} staging`, fake.ctx);
	assert.equal(fake.messages.length, 0);
	fake.setSession("session-a");
	fake.setBranch("other");
	await fake.hooks.get("session_tree")?.({ type: "session_tree" }, fake.ctx);
	await command(`answer ${id} staging`, fake.ctx);
	assert.equal(fake.messages.length, 0);
	fake.setBranch("main");
	await fake.hooks.get("session_tree")?.({ type: "session_tree" }, fake.ctx);
	await command(`answer ${id} staging`, fake.ctx);
	assert.equal(fake.messages.length, 1);
});

test("an unavailable model leaves the human answer retryable", async () => {
	const fake = harness(false);
	const originalError = console.error;
	console.error = () => undefined;
	try {
		await fake.preflight("guard_require_decision", "ask", fake.input);
		await fake.execute("ask");
	} finally {
		console.error = originalError;
	}
	const id = pendingId(fake);
	fake.setAuthenticated(false);
	const command = fake.commands.get("guard");
	assert.ok(command);
	await command(`answer ${id} staging`, fake.ctx);
	assert.equal(fake.messages.length, 0);
	assert.equal(
		(fake.branch().at(-1)?.data as { status: string }).status,
		"pending",
	);
	fake.setAuthenticated(true);
	await command(`answer ${id} staging`, fake.ctx);
	assert.equal(fake.messages.length, 1);
});

test("a submitted answer survives a failed delivery and a delivered user message resolves it on resume", async () => {
	const fake = harness(false);
	const originalError = console.error;
	console.error = () => undefined;
	try {
		await fake.preflight("guard_require_decision", "ask", fake.input);
		await fake.execute("ask");
	} finally {
		console.error = originalError;
	}
	const id = pendingId(fake);
	const command = fake.commands.get("guard");
	assert.ok(command);
	await command(`answer ${id} staging`, fake.ctx);
	assert.equal(
		(fake.branch().at(-1)?.data as { status: string }).status,
		"submitted",
	);
	await fake.hooks.get("session_start")?.({ type: "session_start" }, fake.ctx);
	assert.match(fake.notifications.at(-1) ?? "", new RegExp(id));
	await command(`answer ${id} production`, fake.ctx);
	assert.equal(fake.messages.length, 2);
	fake.appendUserMessage(fake.messages[1] ?? "");
	await fake.hooks.get("session_start")?.({ type: "session_start" }, fake.ctx);
	assert.equal(
		await fake.preflight("bash", "after", { command: "echo safe" }),
		undefined,
	);
	await command(`answer ${id} staging`, fake.ctx);
	assert.equal(fake.messages.length, 2);
});

test("invalid questions and options are rejected before execution", async () => {
	const fake = harness();
	assert.match(
		(
			(await fake.preflight("guard_require_decision", "bad", {
				question: " ",
				reason: "why",
				options: fake.input.options,
			})) as { reason: string }
		).reason,
		/non-empty question/,
	);
	assert.match(
		(
			(await fake.preflight("guard_require_decision", "bad2", {
				...fake.input,
				options: [
					{ key: "same", label: "A" },
					{ key: "same", label: "B" },
				],
			})) as { reason: string }
		).reason,
		/distinct keyed options/,
	);
	assert.equal(fake.branch().length, 0);
});

test("another extension blocking the reserved call releases the gate", async () => {
	const fake = harness();
	await fake.preflight("guard_require_decision", "blocked-by-peer", fake.input);
	assert.match(
		(
			(await fake.preflight("bash", "sibling", { command: "echo safe" })) as {
				reason: string;
			}
		).reason,
		/Required user decision/,
	);
	await fake.hooks.get("tool_result")?.(
		{
			type: "tool_result",
			toolName: "guard_require_decision",
			toolCallId: "blocked-by-peer",
		},
		fake.ctx,
	);
	assert.equal(fake.branch().length, 0);
	assert.equal(
		await fake.preflight("bash", "after", { command: "echo safe" }),
		undefined,
	);
});

test("a work tool before the decision in the same assistant message is blocked", async () => {
	const fake = harness();
	const sessionManager = fake.ctx.sessionManager as {
		getBranch: () => unknown[];
	};
	sessionManager.getBranch = () => [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "bash" },
					{ type: "toolCall", name: "guard_require_decision" },
				],
			},
		},
	];
	assert.match(
		(
			(await fake.preflight("bash", "first", { command: "echo safe" })) as {
				reason: string;
			}
		).reason,
		/only tool call/,
	);
	assert.equal(
		await fake.preflight("guard_require_decision", "ask", fake.input),
		undefined,
	);
});

test("switching sessions dismisses and cancels an active dialog", async () => {
	const fake = harness();
	let finish: ((answer: string | undefined) => void) | undefined;
	fake.setSelect(
		async () =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await fake.preflight("guard_require_decision", "ask", fake.input);
	const waiting = fake.execute("ask");
	assert.ok(finish);
	await fake.hooks.get("session_before_switch")?.(
		{ type: "session_before_switch" },
		fake.ctx,
	);
	finish("staging: Staging");
	assert.match(resultText(await waiting), /interrupted/);
	assert.equal(
		(fake.branch().at(-1)?.data as { status: string }).status,
		"cancelled",
	);
	await fake.hooks.get("session_start")?.({ type: "session_start" }, fake.ctx);
	assert.equal(
		await fake.preflight("bash", "after", { command: "echo safe" }),
		undefined,
	);
});

test("headless no-session mode reports that the request cannot survive exit", async () => {
	const fake = harness(false, false);
	await fake.preflight("guard_require_decision", "ask", fake.input);
	const result = await fake.execute("ask");
	assert.equal((result.details as { persisted: boolean }).persisted, false);
	assert.match(resultText(result), /no durable storage/);
	assert.equal(fake.aborted(), 1);
});
