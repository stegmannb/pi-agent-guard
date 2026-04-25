import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { parse as parseBash, type Script } from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import {
	resolveBashAction,
	resolveExactAction,
	resolveGlobAction,
} from "./matching.ts";
import {
	buildApprovalPrompt,
	buildCustomApprovalPrompt,
	buildFileApprovalPrompt,
} from "./prompt.ts";
import { getCommandArgs, getCommandName } from "./resolve.ts";
import type { Action, CommandRef, ToolCallInput } from "./types.ts";
import { expandWrapperCommands } from "./wrappers.ts";

export async function handleInteractiveApproval(
	pi: ExtensionAPI,
	tool: string,
	input: ToolCallInput,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | undefined> {
	// Build appropriate prompt based on tool
	const value = String(
		input[
			tool === "bash"
				? "command"
				: tool === "read" || tool === "edit" || tool === "write"
					? "path"
					: (Object.keys(input)[0] ?? "input")
		],
	);
	const prompt = buildCustomApprovalPrompt(tool, value);

	pi.events.emit("nudge", { body: `${tool} needs approval` });

	const alwaysLabel = `Always allow ${tool} (this session)`;
	const choice = await ctx.ui.select(prompt, ["Allow", alwaysLabel, "Reject"]);

	if (choice === alwaysLabel) {
		sessionRules[tool] = { ...sessionRules[tool], "*": "allow" };
		return;
	}

	if (choice !== "Allow") {
		return {
			block: true,
			reason: `[Blocked by pi-guard: User rejected this invocation]`,
		};
	}
}

export async function handleBashTool(
	pi: ExtensionAPI,
	tool: string,
	rawCmd: string,
	toolRules: Record<string, Action>,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | undefined> {
	let ast: Script | undefined;
	try {
		ast = parseBash(rawCmd);
	} catch {
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `[Blocked by pi-guard: Failed to parse command safely]`,
			};
		}

		pi.events.emit("nudge", { body: "Command needs approval" });
		const confirmed = await ctx.ui.confirm(
			"⚠️ Could Not Parse Command Safely",
			"\nAllow anyway?",
		);

		if (!confirmed) {
			return {
				block: true,
				reason: `[Blocked by pi-guard: User rejected this invocation]`,
			};
		}

		return;
	}

	const { commands: allCommands, expandedWrappers } = expandWrapperCommands(
		extractAllCommandsFromAST(ast, rawCmd),
	);
	if (allCommands.length === 0) return;

	const unauthorizedCommands: CommandRef[] = [];

	for (const cmd of allCommands) {
		const name = getCommandName(cmd);
		const args = getCommandArgs(cmd);
		const action = resolveBashAction(name, args, toolRules);
		if (action !== "allow") {
			unauthorizedCommands.push(cmd);
		}
	}

	if (unauthorizedCommands.length === 0) return;

	if (!ctx.hasUI) {
		// Non-interactive: check first unauthorized command's action
		// biome-ignore lint/style/noNonNullAssertion: guarded by length check above
		const firstCmd = unauthorizedCommands[0]!;
		const name = getCommandName(firstCmd);
		const args = getCommandArgs(firstCmd);
		const action = resolveBashAction(name, args, toolRules);

		if (action === "deny") {
			return {
				block: true,
				reason: `[Blocked by pi-guard: Security policy]`,
			};
		}

		return {
			block: true,
			reason: `[Blocked by pi-guard: No interactive session available]`,
		};
	}

	// Interactive: prompt user
	// Show expanded wrappers with `...` replacing the sub-command portion
	// to avoid redundancy (e.g. "xargs rm" + "rm" → "xargs ..." + "rm").
	const uniqueBaseNames = Array.from(
		new Set(unauthorizedCommands.map(getCommandName)),
	);
	const alwaysLabel = `Always allow ${uniqueBaseNames.join(", ")} (this session)`;

	pi.events.emit("nudge", { body: "Command needs approval" });
	const choice = await ctx.ui.select(
		buildApprovalPrompt(
			allCommands,
			unauthorizedCommands,
			undefined,
			expandedWrappers,
		),
		["Allow", alwaysLabel, "Reject"],
	);

	if (choice === alwaysLabel) {
		sessionRules[tool] = sessionRules[tool] ?? {};
		for (const name of uniqueBaseNames) {
			// biome-ignore lint/style/noNonNullAssertion: initialized on line above
			sessionRules[tool]![name] = "allow";
		}
		return;
	}

	if (choice !== "Allow") {
		return {
			block: true,
			reason: `[Blocked by pi-guard: User rejected this invocation]`,
		};
	}
}

async function handleToolApproval(
	pi: ExtensionAPI,
	tool: string,
	action: Action | undefined,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
	prompt: string,
): Promise<{ block: true; reason: string } | undefined> {
	if (action === "allow") return;
	if (action === "deny") {
		return { block: true, reason: "[Blocked by pi-guard: Security policy]" };
	}
	if (!ctx.hasUI) {
		return {
			block: true,
			reason: "[Blocked by pi-guard: No interactive session available]",
		};
	}
	const alwaysLabel = `Always allow ${tool} (this session)`;
	pi.events.emit("nudge", { body: `${tool} needs approval` });
	const choice = await ctx.ui.select(prompt, ["Allow", alwaysLabel, "Reject"]);
	if (choice === alwaysLabel) {
		sessionRules[tool] = { ...sessionRules[tool], "*": "allow" };
		return;
	}
	if (choice !== "Allow") {
		return {
			block: true,
			reason: "[Blocked by pi-guard: User rejected this invocation]",
		};
	}
}

export async function handleGlobTool(
	pi: ExtensionAPI,
	tool: string,
	path: string,
	toolRules: Record<string, Action>,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | undefined> {
	return handleToolApproval(
		pi,
		tool,
		resolveGlobAction(path, toolRules),
		ctx,
		sessionRules,
		buildFileApprovalPrompt(tool, path),
	);
}

export async function handleExactTool(
	pi: ExtensionAPI,
	tool: string,
	value: string,
	toolRules: Record<string, Action>,
	ctx: ExtensionContext,
	sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | undefined> {
	return handleToolApproval(
		pi,
		tool,
		resolveExactAction(value, toolRules),
		ctx,
		sessionRules,
		buildCustomApprovalPrompt(tool, value),
	);
}
