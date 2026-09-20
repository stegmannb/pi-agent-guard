import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	GLOBAL_SETTINGS_PATH,
	getProjectSettingsPath,
	isConfigWritable,
	saveRule,
} from "./config.ts";
import type { EvaluatedToolCall } from "./evaluator.ts";
import {
	buildApprovalPrompt,
	buildCustomApprovalPrompt,
	buildFileApprovalPrompt,
} from "./prompt.ts";
import { getCommandName } from "./resolve.ts";
import type { Action, ToolCallInput } from "./types.ts";

type BlockResult = { block: true; reason: string };

function block(reason: string): BlockResult {
	return { block: true, reason: `[Blocked by pi-guard: ${reason}]` };
}

function inputValue(tool: string, input: ToolCallInput): string {
	const key =
		tool === "bash"
			? "command"
			: tool === "read" || tool === "edit" || tool === "write"
				? "path"
				: (Object.keys(input)[0] ?? "input");
	return String(input[key]);
}

async function handleBashParseFailure(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<BlockResult | undefined> {
	if (!ctx.hasUI) return block("Failed to parse command safely");

	pi.events.emit("nudge", { body: "Command needs approval" });
	const confirmed = await ctx.ui.confirm(
		"⚠️ Could Not Parse Command Safely",
		"\nAllow anyway?",
	);
	return confirmed ? undefined : block("User rejected this invocation");
}

function saveBashAllowRules(
	sessionRules: Record<string, Record<string, Action>>,
	tool: string,
	commandNames: string[],
	configPath?: string,
): void {
	sessionRules[tool] = sessionRules[tool] ?? {};
	for (const name of commandNames) {
		if (configPath) saveRule(configPath, tool, name, "allow");
		sessionRules[tool][name] = "allow";
	}
}

async function handleInteractiveBash(
	pi: ExtensionAPI,
	evaluated: EvaluatedToolCall,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
): Promise<BlockResult | undefined> {
	const bash = evaluated.bash;
	if (!bash) return block("Internal evaluation error");
	const tool = evaluated.result.tool;
	const uniqueBaseNames = Array.from(
		new Set(bash.askCommands.map(getCommandName)),
	);
	const alwaysLabel = `Always allow ${uniqueBaseNames.join(", ")} (this session)`;
	const projectPath = getProjectSettingsPath(ctx.cwd);
	const globalWritable = isConfigWritable(GLOBAL_SETTINGS_PATH);
	const choices = [
		"Allow",
		alwaysLabel,
		"Allow for this project  →  .pi/settings.json",
		...(globalWritable ? ["Allow globally  →  settings.json"] : []),
		"Reject",
	];

	pi.events.emit("nudge", { body: "Command needs approval" });
	const choice = await ctx.ui.select(
		buildApprovalPrompt(
			bash.allCommands,
			bash.askCommands,
			undefined,
			bash.expandedWrappers,
		),
		choices,
	);

	if (choice === alwaysLabel) {
		saveBashAllowRules(sessionRules, tool, uniqueBaseNames);
		return;
	}
	if (choice?.startsWith("Allow for this project")) {
		saveBashAllowRules(sessionRules, tool, uniqueBaseNames, projectPath);
		return;
	}
	if (globalWritable && choice?.startsWith("Allow globally")) {
		saveBashAllowRules(
			sessionRules,
			tool,
			uniqueBaseNames,
			GLOBAL_SETTINGS_PATH,
		);
		return;
	}
	return choice === "Allow"
		? undefined
		: block("User rejected this invocation");
}

async function handleInteractiveTool(
	pi: ExtensionAPI,
	evaluated: EvaluatedToolCall,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
): Promise<BlockResult | undefined> {
	const { tool, input } = evaluated.result;
	const value = inputValue(tool, input);
	const prompt =
		tool === "read" || tool === "edit" || tool === "write"
			? buildFileApprovalPrompt(tool, value)
			: buildCustomApprovalPrompt(tool, value);
	const alwaysLabel = `Always allow ${tool} (this session)`;
	pi.events.emit("nudge", { body: `${tool} needs approval` });
	const choice = await ctx.ui.select(prompt, ["Allow", alwaysLabel, "Reject"]);
	if (choice === alwaysLabel) {
		sessionRules[tool] = { ...sessionRules[tool], "*": "allow" };
		return;
	}
	return choice === "Allow"
		? undefined
		: block("User rejected this invocation");
}

/** Enforce a result produced by the common policy evaluator. */
export async function enforceToolEvaluation(
	pi: ExtensionAPI,
	evaluated: EvaluatedToolCall,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
): Promise<BlockResult | undefined> {
	const { result } = evaluated;
	if (result.disposition === "bypass" || result.disposition === "allow") return;
	if (result.disposition === "deny") return block("Security policy");
	if (result.parserError) return handleBashParseFailure(pi, ctx);
	if (!ctx.hasUI) return block("No interactive session available");
	if (evaluated.bash) {
		return handleInteractiveBash(pi, evaluated, ctx, sessionRules);
	}
	return handleInteractiveTool(pi, evaluated, ctx, sessionRules);
}
