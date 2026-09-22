import { formatCommand, truncate } from "./format.ts";
import type { CommandRef, GuardEvaluation, WinningRule } from "./types.ts";
import { formatWrapperDisplay } from "./wrappers.ts";

export interface ApprovalPromptOptions {
	maxLength?: number;
	argMaxLength?: number;
}

function describeApprovalRule(
	rule: WinningRule | undefined,
	tool: string,
): string {
	if (!rule) return "No rule matched; approval is required by default.";
	if (rule.scope === "global")
		return `Global policy (${rule.layer}) requires approval.`;
	if (rule.scope === "tool")
		return `Rule for ${tool} (${rule.layer}) requires approval.`;
	return `Rule ${JSON.stringify(rule.pattern)} for ${tool} (${rule.layer}) requires approval.`;
}

/** Explain the policy decision without presenting it as the agent's intent. */
export function approvalReasons(result: GuardEvaluation): string[] {
	const askCommands = result.commands?.filter(
		(command) => command.action === "ask",
	);
	const rules = askCommands?.length
		? askCommands.map((command) => command.winningRule)
		: [result.winningRule];
	return [
		...new Set(rules.map((rule) => describeApprovalRule(rule, result.tool))),
	];
}

export function buildApprovalPrompt(
	allCommands: CommandRef[],
	unauthorizedCommands: CommandRef[],
	options?: ApprovalPromptOptions,
	expandedWrappers?: Set<CommandRef>,
): string {
	const unauthorizedSet = new Set(unauthorizedCommands);
	const lines: string[] = [];

	let prevGroup: number | undefined;

	for (const command of allCommands) {
		// Insert blank line between groups
		if (prevGroup !== undefined && command.group !== prevGroup) {
			lines.push("");
		}
		prevGroup = command.group;

		const marker = unauthorizedSet.has(command) ? "✖" : "✔";
		const display = expandedWrappers?.has(command)
			? formatWrapperDisplay(command)
			: formatCommand(command, options);
		const line = `${marker} ${display}`;
		lines.push(command.joiner ? `${line} ${command.joiner}` : line);
	}

	return ["⚠️ Unapproved Commands", "", ...lines].join("\n");
}

/** Build prompt for file operations (read/edit/write). */
export function buildFileApprovalPrompt(
	tool: string,
	path: string,
	options?: { maxLength?: number },
): string {
	const maxLength = options?.maxLength ?? 120;
	return `⚠️ ${tool.charAt(0).toUpperCase() + tool.slice(1)} Permission Required\n\n${truncate(path, maxLength)}`;
}

/** Build prompt for custom tools with exact matchers. */
export function buildCustomApprovalPrompt(
	tool: string,
	input: string,
	options?: { maxLength?: number },
): string {
	const maxLength = options?.maxLength ?? 120;
	return `⚠️ ${tool} Permission Required\n\n${truncate(input, maxLength)}`;
}
