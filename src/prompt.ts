import { formatCommand, truncate } from "./format.ts";
import type { CommandRef } from "./types.ts";

export interface ApprovalPromptOptions {
	maxLength?: number;
	argMaxLength?: number;
}

export function buildApprovalPrompt(
	allCommands: CommandRef[],
	unauthorizedCommands: CommandRef[],
	options?: ApprovalPromptOptions,
): string {
	const unauthorizedSet = new Set(unauthorizedCommands);
	const lines = allCommands.map((command) => {
		const marker = unauthorizedSet.has(command) ? "✖" : "✔";
		return `${marker} ${formatCommand(command, options)}`;
	});

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
