import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolDefinition,
	ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { reviewerCases } from "../eval/reviewer-cases.ts";
import { DEFAULT_CONFIG } from "../src/defaults.ts";
import { registerGuard } from "../src/index.ts";
import {
	type ReviewerDependencies,
	reviewGuardRequest,
} from "../src/reviewer.ts";

const model = {
	id: "fixture",
	provider: "test",
	name: "Offline fixture",
	api: "openai-completions",
	baseUrl: "http://localhost.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4000,
} as NonNullable<ExtensionContext["model"]>;

test("curated reviewer corpus traverses the registered hooks without executing commands", async (t) => {
	for (const fixture of reviewerCases) {
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the case checks one end-to-end hook lifecycle with conditional assertions for each reviewer outcome.
		await t.test(fixture.id, async () => {
			const hooks = new Map<
				string,
				(event: unknown, ctx: ExtensionContext) => Promise<unknown>
			>();
			const tools = new Map<string, ToolDefinition>();
			const audit: unknown[] = [];
			let providerCalls = 0;
			let executorCalls = 0;
			let providerPrompt: Record<string, unknown> | undefined;
			const pi = {
				on(
					name: string,
					handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>,
				) {
					hooks.set(name, handler);
				},
				registerTool(tool: ToolDefinition) {
					tools.set(tool.name, tool);
				},
				registerCommand() {},
				appendEntry(_type: string, entry: unknown) {
					audit.push(entry);
				},
				sendMessage() {},
				events: { emit() {} },
			} as unknown as ExtensionAPI;
			const branch = [
				{
					type: "message",
					message: { role: "user", content: fixture.userTask, timestamp: 1 },
				},
				...(fixture.toolOutput
					? [
							{
								type: "message",
								message: {
									role: "toolResult",
									toolName: "bash",
									content: [{ type: "text", text: fixture.toolOutput }],
									timestamp: 2,
								},
							},
						]
					: []),
			];
			const ctx = {
				hasUI: false,
				cwd: fixture.cwd,
				model,
				modelRegistry: {
					find: (provider: string, id: string) =>
						provider === "test" && id === "fixture" ? model : undefined,
					hasConfiguredAuth: () => true,
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline" }),
				},
				sessionManager: {
					getSessionId: () => `fixture-${fixture.id}`,
					getBranch: () => branch,
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
						rules: fixture.rules,
					},
					reviewer: {
						mode: "auto",
						model: "main",
						policy: fixture.policy,
						reviewTimeoutMs: 60_000,
						approvalTimeoutMs: 120_000,
					},
				},
				projectResult: null,
				startupCwd: fixture.cwd,
				autoReview: {
					review: (request, config, dependencies, signal, override) =>
						reviewGuardRequest(
							request,
							config,
							{
								...dependencies,
								complete: (async (_model, context) => {
									providerCalls++;
									assert.deepEqual(context.tools, []);
									providerPrompt = JSON.parse(
										context.messages[0]?.content as string,
									) as Record<string, unknown>;
									return {
										stopReason: "stop",
										content: [
											{
												type: "text",
												text: JSON.stringify(fixture.expectedJudgment),
											},
										],
									};
								}) as NonNullable<ReviewerDependencies["complete"]>,
							},
							signal,
							override,
						),
				},
			});

			const check = tools.get("guard_check");
			assert.ok(check);
			const dryRun = await check.execute(
				"dry-run",
				{
					mode: "check",
					tool: "bash",
					input: { command: fixture.command },
				},
				undefined,
				undefined,
				ctx,
			);
			const details = dryRun.details as {
				patternAction: string;
				reviewEligible: boolean;
			};
			assert.equal(details.patternAction, fixture.expectedPattern);
			assert.equal(details.reviewEligible, fixture.expectedReview);
			assert.equal(providerCalls, 0);
			assert.equal(executorCalls, 0);

			const toolCall = hooks.get("tool_call");
			assert.ok(toolCall);
			const result = (await toolCall(
				{
					type: "tool_call",
					toolName: "bash",
					toolCallId: `call-${fixture.id}`,
					input: { command: fixture.command },
				} as ToolCallEvent,
				ctx,
			)) as { block?: boolean; reason?: string } | undefined;
			assert.equal(providerCalls, fixture.expectedReview ? 1 : 0);
			if (fixture.expectedReview) {
				assert.equal(providerPrompt?.operatorPolicy, fixture.policy);
				assert.equal(providerPrompt?.userTask, fixture.userTask);
				assert.deepEqual(
					(providerPrompt?.proposedCall as { input: unknown }).input,
					{ command: fixture.command },
				);
				assert.ok(
					(providerPrompt?.guardRules as { layers: unknown[] }).layers.length >
						0,
				);
				if (fixture.toolOutput)
					assert.match(
						JSON.stringify(providerPrompt?.conversation),
						/toolResult|tool/,
					);
			}
			const admitted = result === undefined;
			if (admitted) {
				// This is a controlled executor stub. No shell command is launched.
				executorCalls++;
				const toolResult = hooks.get("tool_result");
				assert.ok(toolResult);
				const augmented = (await toolResult(
					{
						type: "tool_result",
						toolName: "bash",
						toolCallId: `call-${fixture.id}`,
						input: { command: fixture.command },
						content: [{ type: "text", text: "stub output" }],
						details: undefined,
						isError: false,
					} as ToolResultEvent,
					ctx,
				)) as { content?: Array<{ text: string }> } | undefined;
				if (fixture.expectedJudgment?.decision === "allow") {
					assert.equal(augmented?.content?.[0]?.text, "stub output");
					assert.match(
						augmented?.content?.[1]?.text ?? "",
						new RegExp(fixture.expectedJudgment.reason),
					);
				}
			} else {
				assert.equal(executorCalls, 0);
				assert.equal(result?.block, true);
				if (fixture.expectedJudgment?.decision === "deny")
					assert.match(
						result?.reason ?? "",
						/Blocked by pi-guard: reviewer deny/,
					);
			}
			assert.ok(audit.length <= 1);
		});
	}
});
