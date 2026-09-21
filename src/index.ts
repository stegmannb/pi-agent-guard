import { Type } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { handleGuardCommand, parseGuardArgs } from "./commands.ts";
import {
	type LoadedConfigResult,
	loadConfig,
	loadProjectConfig,
} from "./config.ts";
import { evaluateToolCall } from "./evaluator.ts";
import { enforceToolEvaluation } from "./handlers.ts";
import { buildPolicySnapshot, filterPolicySnapshot } from "./policy.ts";
import {
	DEFAULT_REVIEWER_CONFIG,
	type ReviewerConfig,
} from "./reviewer-config.ts";
import {
	formatReviewerModelStatus,
	pickReviewerModel,
	resolveReviewerModel,
	setReviewerSessionModel,
} from "./reviewer-model.ts";
import type { GuardContext, ToolCallInput } from "./types.ts";

export {
	captureReviewerConversation,
	createReviewerRequest,
	parseReviewerJudgment,
	reviewGuardRequest,
} from "./reviewer.ts";
export { loadReviewerConfigFromSettings } from "./reviewer-config.ts";
export {
	readSessionModelOverride,
	resolveReviewerModel,
	setReviewerSessionModel,
} from "./reviewer-model.ts";
export { parseGuardArgs };

interface LoadedStartupConfig extends LoadedConfigResult {
	envRules?: GuardContext["staticPolicy"]["envRules"];
	reviewerError?: string;
	reviewer?: ReviewerConfig;
}

export interface GuardBootstrap {
	loaded?: LoadedStartupConfig;
	projectResult?: LoadedConfigResult | null;
	startupCwd?: string;
}

function jsonToolResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}

function registerGuardCheck(pi: ExtensionAPI, context: GuardContext): void {
	pi.registerTool({
		name: "guard_check",
		label: "Guard check",
		description:
			"Read the current pi-guard policy snapshot or evaluate a proposed tool call without executing it, opening approval UI, or changing rules.",
		promptSnippet: "Inspect pi-guard rules or dry-run a proposed tool call",
		promptGuidelines: [
			"Use guard_check before proposing a command when the applicable pi-guard rule is unclear.",
			"A guard_check allow result describes pi-guard only; another sandbox or extension may still block execution.",
		],
		parameters: Type.Object({
			mode: Type.Union([Type.Literal("check"), Type.Literal("rules")]),
			tool: Type.Optional(Type.String()),
			input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			commandPrefix: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = buildPolicySnapshot(context);
			if (params.mode === "rules") {
				return jsonToolResult(
					filterPolicySnapshot(snapshot, {
						...(params.tool ? { tool: params.tool } : {}),
						...(params.commandPrefix
							? { commandPrefix: params.commandPrefix }
							: {}),
					}),
				);
			}
			if (!params.tool || !params.input) {
				return jsonToolResult({
					error: 'mode "check" requires both tool and input',
					policyVersion: snapshot.policyVersion,
				});
			}
			return jsonToolResult(
				evaluateToolCall(snapshot, params.tool, params.input, ctx.cwd).result,
			);
		},
	});
}

export function registerGuard(
	pi: ExtensionAPI,
	bootstrap: GuardBootstrap = {},
): void {
	const loaded = bootstrap.loaded ?? loadConfig();
	const startupCwd = bootstrap.startupCwd ?? process.cwd();
	const projectResult =
		bootstrap.projectResult !== undefined
			? bootstrap.projectResult
			: loadProjectConfig(startupCwd);
	const warnings = [
		loaded.warning,
		loaded.reviewerError,
		projectResult?.warning,
	].filter(Boolean);
	if (warnings.length > 0) console.warn(`[pi-guard] ${warnings.join("; ")}`);
	const reviewerConfig = structuredClone(
		loaded.reviewer ?? DEFAULT_REVIEWER_CONFIG,
	);

	const context: GuardContext = {
		config: loaded.config,
		staticPolicy: {
			userRules: loaded.config.rules,
			projectRules: projectResult?.config.rules ?? {},
			envRules: loaded.envRules,
			projectConfigPresent: projectResult !== null,
		},
		activeProfile: undefined,
		sessionRules: {},
		exactSessionGrants: [],
	};
	let sessionGeneration = 0;
	let sessionActive = true;

	function resetSessionState(): void {
		sessionGeneration++;
		sessionActive = true;
		context.activeProfile = undefined;
		context.sessionRules = {};
		context.exactSessionGrants = [];
		delete context.sessionEnabled;
	}

	function reviewerStatus(ctx: ExtensionContext): string {
		return `Reviewer: ${reviewerConfig.mode} · ${formatReviewerModelStatus(resolveReviewerModel(reviewerConfig, ctx))}`;
	}

	function updateGuardStatus(ctx: ExtensionContext): void {
		const snapshot = buildPolicySnapshot(context);
		const modelStatus = reviewerStatus(ctx);
		if (!snapshot.guardEnabled) {
			ctx.ui.setStatus("guard", `⚠️ Guard: off · ${modelStatus}`);
			return;
		}
		const bashRules =
			typeof snapshot.effectiveRules === "object"
				? snapshot.effectiveRules.bash
				: snapshot.effectiveRules;
		const count =
			typeof bashRules === "object"
				? Object.keys(bashRules).length
				: bashRules
					? 1
					: 0;
		ctx.ui.setStatus(
			"guard",
			ctx.ui.theme.fg(
				"accent",
				`🛡️ Guard: ${count} bash rules · ${modelStatus}`,
			),
		);
	}

	function notifyUnavailableReviewerPicker(ctx: ExtensionCommandContext): void {
		if (!ctx.hasUI)
			ctx.ui.notify(
				"Reviewer model picker is unavailable here. Use /guard model main or /guard model <provider>/<model-id>.",
				"warning",
			);
	}

	function applyReviewerModelChoice(
		choice: string,
		ctx: ExtensionCommandContext,
	): void {
		const result = setReviewerSessionModel(pi, ctx, choice);
		ctx.ui.notify(
			result.ok
				? `Reviewer model selected for this session. ${reviewerStatus(ctx)}`
				: result.reason,
			result.ok ? "info" : "warning",
		);
		if (result.ok) updateGuardStatus(ctx);
	}

	async function runReviewerModelCommand(
		target: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (target === "status") {
			ctx.ui.notify(reviewerStatus(ctx), "info");
			return;
		}
		const generation = sessionGeneration;
		const choice = target || (await pickReviewerModel(ctx, reviewerConfig));
		if (!sessionActive || generation !== sessionGeneration) return;
		if (!choice) {
			if (!target) notifyUnavailableReviewerPicker(ctx);
			return;
		}
		applyReviewerModelChoice(choice, ctx);
	}

	async function runGuardCommand(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const { action, target } = parseGuardArgs(args);
		if (action === "model") return runReviewerModelCommand(target, ctx);
		const result = handleGuardCommand(action, target, context);
		const modelStatus = reviewerStatus(ctx);
		ctx.ui.notify(
			action === "list" || action === ""
				? `${result.message}\n\n${modelStatus}`
				: result.message,
			result.type,
		);
		updateGuardStatus(ctx);
	}

	for (const [shortcut, subcommand] of Object.entries(
		context.config.shortcuts ?? {},
	)) {
		if (!subcommand) continue;
		pi.registerCommand(shortcut, {
			description: `pi-guard shortcut: ${subcommand}`,
			handler: async (_args, ctx) => runGuardCommand(subcommand, ctx),
		});
	}

	pi.registerCommand("guard", {
		description: "Manage pi-guard security settings",
		handler: async (args, ctx) => runGuardCommand(args, ctx),
	});
	pi.registerCommand("guard-toggle", {
		description: "Toggle pi-guard on/off for this session",
		handler: async (_args, ctx) => {
			const result = handleGuardCommand("toggle", undefined, context);
			ctx.ui.notify(result.message, result.type);
			updateGuardStatus(ctx);
		},
	});

	registerGuardCheck(pi, context);
	pi.on("session_start", async (_event, ctx) => {
		resetSessionState();
		updateGuardStatus(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		resetSessionState();
		updateGuardStatus(ctx);
	});
	pi.on("session_fork", async (_event, ctx) => {
		resetSessionState();
		updateGuardStatus(ctx);
	});
	pi.on("session_shutdown", async () => {
		resetSessionState();
		sessionActive = false;
	});
	pi.on("session_tree", async (_event, ctx) => updateGuardStatus(ctx));
	pi.on("model_select", async (_event, ctx) => updateGuardStatus(ctx));
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "guard_check") return;
		if (!sessionActive)
			return {
				block: true,
				reason: "[Blocked by pi-guard: Session is no longer active]",
			};
		const generation = sessionGeneration;
		const sessionId = ctx.sessionManager.getSessionId();
		const isCurrentSession = () =>
			sessionActive &&
			sessionGeneration === generation &&
			ctx.sessionManager.getSessionId() === sessionId;
		const snapshot = buildPolicySnapshot(context);
		const evaluated = evaluateToolCall(
			snapshot,
			event.toolName,
			event.input as ToolCallInput,
			ctx.cwd,
		);
		const result = await enforceToolEvaluation(
			pi,
			evaluated,
			ctx,
			context.sessionRules,
			isCurrentSession,
		);
		return isCurrentSession()
			? result
			: {
					block: true,
					reason: "[Blocked by pi-guard: Session changed during approval]",
				};
	});
}

export default registerGuard;
