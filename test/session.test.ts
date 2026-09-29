import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/defaults.ts";

type Event = {
	type: string;
	toolName?: string;
	input?: Record<string, unknown>;
	reason?: "new" | "resume" | "reload" | "fork";
};
type EventHandler = (event: Event, ctx: ExtensionContext) => Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

test("guard resets session state and blocks denied bash commands", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-session-"));
	const projectDir = path.join(agentDir, "project");
	fs.mkdirSync(projectDir);
	const oldCwd = process.cwd();
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldEnvRules = process.env.PI_GUARD;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_GUARD;
	process.chdir(projectDir);
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			guard: {
				rules: {
					bash: { "*": "ask", "git push": "deny", "find /": "deny" },
				},
				profiles: { relaxed: { bash: { "git push": "allow" } } },
			},
		}),
	);

	try {
		const { default: registerGuard } = await import("../src/index.ts");
		const handlers = new Map<string, EventHandler>();
		const commands = new Map<string, CommandHandler>();
		const pi = {
			on: (event: string, handler: EventHandler) =>
				handlers.set(event, handler),
			registerTool: () => undefined,
			registerCommand: (name: string, command: { handler: CommandHandler }) =>
				commands.set(name, command.handler),
			appendEntry: () => undefined,
			events: { emit: () => undefined },
		} as unknown as ExtensionAPI;
		let approvalCount = 0;
		let sessionId = "session-a";
		let pendingSelection: ((choice: string) => void) | undefined;
		let deferApproval = false;
		const statuses: string[] = [];
		const notices: string[] = [];
		const activeStatus = `🛡️ Guard: ${Object.keys(DEFAULT_CONFIG.rules.bash).length + 2} bash rules`;
		const ctx = {
			cwd: projectDir,
			hasUI: true,
			sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
			ui: {
				select: async (_prompt: string, choices: string[]) => {
					approvalCount++;
					if (deferApproval) {
						return new Promise<string>((resolve) => {
							pendingSelection = resolve;
						});
					}
					return choices[1];
				},
				notify: (message: string) => notices.push(message),
				setStatus: (_key: string, value: string) => statuses.push(value),
				theme: { fg: (_color: string, value: string) => value },
			},
		} as unknown as ExtensionContext;

		registerGuard(pi);
		const toolCall = handlers.get("tool_call");
		const sessionStart = handlers.get("session_start");
		const sessionSwitch = handlers.get("session_switch");
		const sessionFork = handlers.get("session_fork");
		const modelSelect = handlers.get("model_select");
		const sessionShutdown = handlers.get("session_shutdown");
		const guardCommand = commands.get("guard");
		const toggleCommand = commands.get("guard-toggle");
		assert.ok(toolCall);
		assert.ok(sessionStart);
		assert.ok(sessionSwitch);
		assert.ok(sessionFork);
		assert.ok(modelSelect);
		assert.ok(sessionShutdown);
		assert.ok(guardCommand);
		assert.ok(toggleCommand);

		const bash = (command: string) =>
			toolCall(
				{ type: "tool_call", toolName: "bash", input: { command } },
				ctx,
			);
		const rootScan = 'find / -maxdepth 4 -iname "config" -path "*Projects*"';

		await sessionStart({ type: "session_start" }, ctx);
		assert.equal(statuses.at(-1), activeStatus);
		await guardCommand("model main", ctx);
		assert.match(notices.at(-1) ?? "", /Reviewer model selected/);
		assert.equal(statuses.at(-1), activeStatus);
		await guardCommand("model status", ctx);
		assert.match(notices.at(-1) ?? "", /Reviewer model:/);
		assert.equal(statuses.at(-1), activeStatus);
		await modelSelect({ type: "model_select" }, ctx);
		assert.equal(statuses.at(-1), activeStatus);
		await bash("git commit -m test");
		assert.equal(approvalCount, 1);
		assert.deepEqual(await bash(rootScan), {
			block: true,
			reason: "[Blocked by pi-guard: Security policy]",
		});
		assert.equal(await bash("git push"), undefined);

		sessionId = "session-b";
		await sessionStart({ type: "session_start", reason: "new" }, ctx);
		assert.equal(statuses.at(-1), activeStatus);
		assert.deepEqual(await bash("git push"), {
			block: true,
			reason: "[Blocked by pi-guard: Security policy]",
		});
		assert.deepEqual(await bash(rootScan), {
			block: true,
			reason: "[Blocked by pi-guard: Security policy]",
		});
		assert.equal(approvalCount, 1);

		await bash("git commit -m test");
		assert.equal(approvalCount, 2);
		assert.equal(await bash("git push"), undefined);
		sessionId = "session-c";
		await sessionSwitch({ type: "session_switch", reason: "new" }, ctx);
		assert.equal(statuses.at(-1), activeStatus);
		assert.deepEqual(await bash("git push"), {
			block: true,
			reason: "[Blocked by pi-guard: Security policy]",
		});
		assert.equal(approvalCount, 2);

		assert.deepEqual(await bash("git commit -m test && git push"), {
			block: true,
			reason: "[Blocked by pi-guard: Security policy]",
		});
		assert.equal(approvalCount, 2);

		await toggleCommand("", ctx);
		assert.equal(statuses.at(-1), "⚠️ Guard: off");
		assert.equal(await bash("git push"), undefined);
		sessionId = "session-d";
		await sessionSwitch({ type: "session_switch", reason: "resume" }, ctx);
		assert.equal(statuses.at(-1), activeStatus);
		assert.deepEqual(await bash("git push"), {
			block: true,
			reason: "[Blocked by pi-guard: Security policy]",
		});

		await guardCommand("profile relaxed", ctx);
		assert.equal(await bash("git push"), undefined);
		sessionId = "session-e";
		await sessionFork({ type: "session_fork" }, ctx);
		assert.equal(statuses.at(-1), activeStatus);
		assert.deepEqual(await bash("git push"), {
			block: true,
			reason: "[Blocked by pi-guard: Security policy]",
		});

		deferApproval = true;
		const staleCall = bash("git commit -m stale");
		await Promise.resolve();
		assert.ok(pendingSelection);
		await guardCommand("profile relaxed", ctx);
		await toggleCommand("", ctx);
		assert.equal(statuses.at(-1), "⚠️ Guard: off");
		await sessionShutdown({ type: "session_shutdown" }, ctx);
		sessionId = "session-f";
		pendingSelection("Allow globally  \u2192  settings.json");
		assert.deepEqual(await staleCall, {
			block: true,
			reason: "[Blocked by pi-guard: Session changed during approval]",
		});
		const saved = JSON.parse(
			fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"),
		);
		assert.equal(saved.guard.rules.bash.git, undefined);
		assert.deepEqual(await bash("git push"), {
			block: true,
			reason: "[Blocked by pi-guard: Session is no longer active]",
		});

		deferApproval = false;
		await sessionStart({ type: "session_start", reason: "reload" }, ctx);
		assert.equal(statuses.at(-1), activeStatus);
		assert.deepEqual(await bash(rootScan), {
			block: true,
			reason: "[Blocked by pi-guard: Security policy]",
		});
		assert.deepEqual(await bash("git push"), {
			block: true,
			reason: "[Blocked by pi-guard: Security policy]",
		});
		await bash("git commit -m resumed");
		assert.equal(await bash("git push"), undefined);
		sessionId = "session-g";
		await sessionStart({ type: "session_start", reason: "resume" }, ctx);
		assert.equal(statuses.at(-1), activeStatus);
		assert.deepEqual(await bash("git push"), {
			block: true,
			reason: "[Blocked by pi-guard: Security policy]",
		});

		fs.writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				guard: {
					rules: {
						bash: {
							"*": "ask",
							"git push": "allow",
							"find /": "deny",
							curl: "allow",
						},
					},
				},
			}),
		);
		fs.mkdirSync(path.join(projectDir, ".pi"));
		fs.writeFileSync(
			path.join(projectDir, ".pi", "settings.json"),
			JSON.stringify({ guard: { rules: { bash: { "git push": "deny" } } } }),
		);
		registerGuard(pi);
		const replacementToolCall = handlers.get("tool_call");
		const replacementStart = handlers.get("session_start");
		assert.ok(replacementToolCall);
		assert.ok(replacementStart);
		await replacementStart({ type: "session_start", reason: "new" }, ctx);
		assert.equal(
			await replacementToolCall(
				{
					type: "tool_call",
					toolName: "bash",
					input: { command: "curl example.com" },
				},
				ctx,
			),
			undefined,
		);
		assert.deepEqual(
			await replacementToolCall(
				{ type: "tool_call", toolName: "bash", input: { command: "git push" } },
				ctx,
			),
			{
				block: true,
				reason: "[Blocked by pi-guard: Security policy]",
			},
		);
	} finally {
		process.chdir(oldCwd);
		if (oldAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
		if (oldEnvRules === undefined) {
			delete process.env.PI_GUARD;
		} else {
			process.env.PI_GUARD = oldEnvRules;
		}
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
