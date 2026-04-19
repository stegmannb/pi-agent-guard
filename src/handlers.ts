import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import { getCommandName, getCommandArgs } from "./resolve.ts";
import { buildApprovalPrompt, buildFileApprovalPrompt, buildCustomApprovalPrompt } from "./prompt.ts";
import { resolveBashAction, resolveGlobAction, resolveExactAction } from "./matching.ts";
import type { Action, CommandRef, ToolCallInput } from "./types.ts";

export async function handleInteractiveApproval(
  pi: ExtensionAPI,
  tool: string,
  input: ToolCallInput,
  ctx: ExtensionContext,
  sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | void> {
  // Build appropriate prompt based on tool
  const value = String(input[tool === "bash" ? "command" : tool === "read" || tool === "edit" || tool === "write" ? "path" : Object.keys(input)[0] ?? "input"]);
  const prompt = buildCustomApprovalPrompt(tool, value);

  pi.events.emit("nudge", { body: `${tool} needs approval` });

  const alwaysLabel = `Always allow ${tool} (this session)`;
  const choice = await ctx.ui.select(prompt, ["Allow", alwaysLabel, "Reject"]);

  if (choice === alwaysLabel) {
    sessionRules[tool] = { ...sessionRules[tool], "*": "allow" };
    return;
  }

  if (choice !== "Allow") {
    return { block: true, reason: `[Blocked by pi-guard: User rejected this invocation]` };
  }
}

export async function handleBashTool(
  pi: ExtensionAPI,
  tool: string,
  rawCmd: string,
  toolRules: Record<string, Action>,
  ctx: ExtensionContext,
  sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | void> {
  let ast;
  try {
    ast = parseBash(rawCmd);
  } catch {
    if (!ctx.hasUI) {
      return { block: true, reason: `[Blocked by pi-guard: Failed to parse command safely]` };
    }

    pi.events.emit("nudge", { body: "Command needs approval" });
    const confirmed = await ctx.ui.confirm(
      "⚠️ Could Not Parse Command Safely",
      "\nAllow anyway?",
    );

    if (!confirmed) {
      return { block: true, reason: `[Blocked by pi-guard: User rejected this invocation]` };
    }

    return;
  }

  const allCommands = extractAllCommandsFromAST(ast, rawCmd);
  if (allCommands.length === 0) return;

  // Merge session rules with config rules
  const mergedRules: Record<string, Action> = { ...toolRules };
  if (sessionRules[tool]) {
    Object.assign(mergedRules, sessionRules[tool]);
  }

  const unauthorizedCommands: CommandRef[] = [];

  for (const cmd of allCommands) {
    const name = getCommandName(cmd);
    const args = getCommandArgs(cmd);
    const action = resolveBashAction(name, args, mergedRules);
    if (action !== "allow") {
      unauthorizedCommands.push(cmd);
    }
  }

  if (unauthorizedCommands.length === 0) return;

  if (!ctx.hasUI) {
    // Non-interactive: check first unauthorized command's action
    const firstCmd = unauthorizedCommands[0]!;
    const name = getCommandName(firstCmd);
    const args = getCommandArgs(firstCmd);
    const action = resolveBashAction(name, args, mergedRules);

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
  const uniqueBaseNames = Array.from(new Set(unauthorizedCommands.map(getCommandName)));
  const alwaysLabel = `Always allow ${uniqueBaseNames.join(", ")} (this session)`;

  pi.events.emit("nudge", { body: "Command needs approval" });
  const choice = await ctx.ui.select(
    buildApprovalPrompt(allCommands, unauthorizedCommands),
    ["Allow", alwaysLabel, "Reject"],
  );

  if (choice === alwaysLabel) {
    sessionRules[tool] = sessionRules[tool] ?? {};
    for (const name of uniqueBaseNames) {
      sessionRules[tool]![name] = "allow";
    }
    return;
  }

  if (choice !== "Allow") {
    return { block: true, reason: `[Blocked by pi-guard: User rejected this invocation]` };
  }
}

/** Shared approval flow for rule-based tool handlers (glob, exact). */
async function handleToolApproval(
  pi: ExtensionAPI,
  tool: string,
  displayValue: string,
  action: Action | undefined,
  ctx: ExtensionContext,
  sessionRules: Record<string, Record<string, Action>>,
  buildPrompt: (tool: string, value: string) => string,
): Promise<{ block: true; reason: string } | void> {
  if (action === "allow") return;
  if (action === "deny") {
    return { block: true, reason: "[Blocked by pi-guard: Security policy]" };
  }
  if (!ctx.hasUI) {
    return { block: true, reason: "[Blocked by pi-guard: No interactive session available]" };
  }
  const prompt = buildPrompt(tool, displayValue);
  const alwaysLabel = `Always allow ${tool} (this session)`;
  pi.events.emit("nudge", { body: `${tool} needs approval` });
  const choice = await ctx.ui.select(prompt, ["Allow", alwaysLabel, "Reject"]);
  if (choice === alwaysLabel) {
    sessionRules[tool] = { ...sessionRules[tool], "*": "allow" };
    return;
  }
  if (choice !== "Allow") {
    return { block: true, reason: "[Blocked by pi-guard: User rejected this invocation]" };
  }
}

export async function handleGlobTool(
  pi: ExtensionAPI,
  tool: string,
  path: string,
  toolRules: Record<string, Action>,
  ctx: ExtensionContext,
  sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | void> {
  const mergedRules: Record<string, Action> = { ...toolRules };
  if (sessionRules[tool]) Object.assign(mergedRules, sessionRules[tool]);
  return handleToolApproval(pi, tool, path, resolveGlobAction(path, mergedRules), ctx, sessionRules, buildFileApprovalPrompt);
}

export async function handleExactTool(
  pi: ExtensionAPI,
  tool: string,
  value: string,
  toolRules: Record<string, Action>,
  ctx: ExtensionContext,
  sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | void> {
  const mergedRules: Record<string, Action> = { ...toolRules };
  if (sessionRules[tool]) Object.assign(mergedRules, sessionRules[tool]);
  return handleToolApproval(pi, tool, value, resolveExactAction(value, mergedRules), ctx, sessionRules, buildCustomApprovalPrompt);
}