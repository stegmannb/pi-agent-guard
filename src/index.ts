import { Type } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
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
import type { GuardContext, ToolCallInput } from "./types.ts";

export { parseGuardArgs };

interface LoadedStartupConfig extends LoadedConfigResult {
	envRules?: GuardContext["staticPolicy"]["envRules"];
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
	const warnings = [loaded.warning, projectResult?.warning].filter(Boolean);
	if (warnings.length > 0) console.warn(`[pi-guard] ${warnings.join("; ")}`);

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

	function updateGuardStatus(ctx: ExtensionContext): void {
		const snapshot = buildPolicySnapshot(context);
		if (!snapshot.guardEnabled) {
			ctx.ui.setStatus("guard", "⚠️ Guard: off");
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
			ctx.ui.theme.fg("accent", `🛡️ Guard: ${count} bash rules`),
		);
	}

	for (const [shortcut, subcommand] of Object.entries(
		context.config.shortcuts ?? {},
	)) {
		if (!subcommand) continue;
		pi.registerCommand(shortcut, {
			description: `pi-guard shortcut: ${subcommand}`,
			handler: async (_args, ctx) => {
				const { action, target } = parseGuardArgs(subcommand);
				const result = handleGuardCommand(action, target, context);
				ctx.ui.notify(result.message, result.type);
				updateGuardStatus(ctx);
			},
		});
	}

	pi.registerCommand("guard", {
		description: "Manage pi-guard security settings",
		handler: async (args, ctx) => {
			const { action, target } = parseGuardArgs(args);
			const result = handleGuardCommand(action, target, context);
			ctx.ui.notify(result.message, result.type);
			updateGuardStatus(ctx);
		},
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
	pi.on("session_start", async (_event, ctx) => updateGuardStatus(ctx));
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "guard_check") return;
		const snapshot = buildPolicySnapshot(context);
		const evaluated = evaluateToolCall(
			snapshot,
			event.toolName,
			event.input as ToolCallInput,
			ctx.cwd,
		);
		return enforceToolEvaluation(pi, evaluated, ctx, context.sessionRules);
	});
}

export default registerGuard;
