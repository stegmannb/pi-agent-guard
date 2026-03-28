import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import { getCommandName, getCommandArgs } from "./resolve.ts";
import { formatCommand } from "./format.ts";
import { buildApprovalPrompt, buildFileApprovalPrompt, buildCustomApprovalPrompt } from "./prompt.ts";
import {
  loadConfig,
  saveConfig,
  loadProjectConfig,
  buildEffectiveRules,
} from "./config.ts";
import { resolveBashAction, resolveGlobAction, resolveExactAction, globMatch } from "./matching.ts";
import type { Action, ToolRules, CommandRef, ToolCallInput } from "./types.ts";

export function parseGuardArgs(args: string): { action: string; target: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "", target: "" };

  const [action = "", ...targetParts] = trimmed.split(/\s+/);
  const target = targetParts.join(" ").trim();

  return { action, target };
}

export default function (pi: ExtensionAPI) {
  const loaded = loadConfig();
  let config = loaded.config;
  let configWarning = loaded.warning;
  // Session rules are stored per-tool
  const sessionRules: Record<string, Record<string, Action>> = {};

  if (configWarning) {
    console.warn(`[pi-guard] ${configWarning}`);
  }

  // Settings Management Command
  pi.registerCommand("guard", {
    description: "Manage pi-guard security settings",
    handler: async (args, ctx) => {
      if (configWarning && ctx.hasUI) {
        ctx.ui.notify(`[pi-guard] ${configWarning}`, "warning");
        configWarning = undefined;
      }

      const { action, target } = parseGuardArgs(args);

      if (action === "allow" && target) {
        // Parse "tool pattern" format: "bash git *" -> tool: bash, pattern: "git *"
        const parts = target.split(/\s+/);
        const tool = parts[0];
        const pattern = parts.slice(1).join(" ");

        if (!tool) {
          ctx.ui.notify("Usage: /guard allow <tool> <pattern>", "warning");
          return;
        }

        const rules = config.rules;
        if (typeof rules === "string") {
          ctx.ui.notify("Cannot add rules when global rule is set", "warning");
          return;
        }

        const toolRules = rules[tool];
        if (typeof toolRules === "string") {
          // Replace whole-tool action with pattern-based rules
          (rules as Record<string, ToolRules>)[tool] = { "*": toolRules, [pattern || "*"]: "allow" };
        } else {
          (rules as Record<string, ToolRules>)[tool] = { ...toolRules as Record<string, Action>, [pattern || "*"]: "allow" };
        }

        // Merge session rules
        if (sessionRules[tool]) {
          (rules as Record<string, ToolRules>)[tool] = {
            ...(rules[tool] as Record<string, Action>),
            ...sessionRules[tool],
          };
        }

        ctx.ui.notify(`'${pattern || "*"}' added to allowed ${tool} patterns.`, "info");
      } else if (action === "deny" && target) {
        const parts = target.split(/\s+/);
        const tool = parts[0];
        const pattern = parts.slice(1).join(" ");

        if (!tool) {
          ctx.ui.notify("Usage: /guard deny <tool> <pattern>", "warning");
          return;
        }

        const rules = config.rules;
        if (typeof rules === "string") {
          ctx.ui.notify("Cannot add rules when global rule is set", "warning");
          return;
        }

        const toolRules = rules[tool];
        if (typeof toolRules === "string") {
          (rules as Record<string, ToolRules>)[tool] = { "*": toolRules, [pattern || "*"]: "deny" };
        } else {
          (rules as Record<string, ToolRules>)[tool] = { ...toolRules as Record<string, Action>, [pattern || "*"]: "deny" };
        }

        ctx.ui.notify(`'${pattern || "*"}' added to denied ${tool} patterns.`, "info");
      } else if (action === "toggle") {
        config.enabled = !config.enabled;
        saveConfig(config);
        ctx.ui.notify(`pi-guard is now ${config.enabled ? "ENABLED" : "DISABLED"}`, "info");
      } else if (action === "list") {
        const enabled = config.enabled ? "ENABLED" : "DISABLED";

        let output = `pi-guard: ${enabled}\n\n`;

        if (typeof config.rules === "string") {
          output += `Global rule: ${config.rules}\n`;
        } else {
          for (const [tool, rules] of Object.entries(config.rules)) {
            output += `${tool}:\n`;
            if (typeof rules === "string") {
              output += `  ${rules}\n`;
            } else {
              for (const [pattern, action] of Object.entries(rules)) {
                output += `  ${pattern}: ${action}\n`;
              }
            }
            output += "\n";
          }
        }

        if (Object.keys(sessionRules).length > 0) {
          output += "Session rules:\n";
          for (const [tool, rules] of Object.entries(sessionRules)) {
            output += `  ${tool}:\n`;
            for (const [pattern, action] of Object.entries(rules)) {
              output += `    ${pattern}: ${action}\n`;
            }
          }
        }

        ctx.ui.notify(output, "info");
      } else {
        ctx.ui.notify("Usage: /guard <allow|deny|toggle|list> [tool] [pattern]", "warning");
      }
    },
  });

  // The core interception hook
  pi.on("tool_call", async (event, ctx) => {
    if (configWarning && ctx.hasUI) {
      ctx.ui.notify(`[pi-guard] ${configWarning}`, "warning");
      configWarning = undefined;
    }

    if (!config.enabled) return;

    const tool = event.toolName;
    const input = event.input as ToolCallInput;

    // Get the effective rules (user + project + session + env)
    const projectResult = loadProjectConfig(ctx.cwd);
    const projectRules = projectResult?.config.rules ?? {};
    if (projectResult?.warning && ctx.hasUI) {
      ctx.ui.notify(`[pi-guard] ${projectResult.warning}`, "warning");
    }

    const envRules = process.env.PI_GUARD ? JSON.parse(process.env.PI_GUARD) : undefined;
    const effectiveRules = buildEffectiveRules(
      config.rules,
      projectRules,
      sessionRules,
      envRules,
    );

    // Check for global rule (single action for all tools)
    if (typeof effectiveRules === "string") {
      const action = effectiveRules;
      if (action === "allow") return;
      if (action === "deny") {
        return {
          block: true,
          reason: `[Blocked by pi-guard: Security policy]`,
        };
      }
      // "ask" - fall through to interactive handling
    }

    // Get tool-specific rules
    const toolRules = typeof effectiveRules === "object" ? effectiveRules[tool] : undefined;

    if (!toolRules) {
      // No rules for this tool - use default action ("ask")
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: `[Blocked by pi-guard: No interactive session available]`,
        };
      }
      // Interactive mode - prompt for approval
      return handleInteractiveApproval(pi, tool, input, ctx, sessionRules);
    }

    // Handle whole-tool action (no pattern matching needed)
    if (typeof toolRules === "string") {
      const action = toolRules;
      if (action === "allow") return;
      if (action === "deny") {
        return {
          block: true,
          reason: `[Blocked by pi-guard: Security policy]`,
        };
      }
      // "ask" - prompt for approval
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: `[Blocked by pi-guard: No interactive session available]`,
        };
      }
      return handleInteractiveApproval(pi, tool, input, ctx, sessionRules);
    }

    // Get matcher for this tool
    const matchers = config.matchers ?? {};
    const matcher = matchers[tool];

    // If no matcher, use whole-tool logic (already handled above if action is allow/deny)
    if (!matcher) {
      // For tools without matchers, check for catch-all "*"
      const defaultAction = toolRules["*"];
      if (defaultAction === "allow") return;
      if (defaultAction === "deny") {
        return {
          block: true,
          reason: `[Blocked by pi-guard: Security policy]`,
        };
      }
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: `[Blocked by pi-guard: No interactive session available]`,
        };
      }
      return handleInteractiveApproval(pi, tool, input, ctx, sessionRules);
    }

    // Extract input based on matcher param
    const value = input[matcher.param];
    if (typeof value !== "string" || value.trim() === "") return;

    // Handle bash tool specially (needs AST parsing)
    if (matcher.type === "bash") {
      return handleBashTool(pi, tool, value, toolRules, ctx, sessionRules);
    }

    // Handle glob-based tools (read, edit, write)
    if (matcher.type === "glob") {
      return handleGlobTool(pi, tool, value, toolRules, ctx, sessionRules);
    }

    // Handle exact-match tools
    if (matcher.type === "exact") {
      return handleExactTool(pi, tool, value, toolRules, ctx, sessionRules);
    }
  });
}

async function handleInteractiveApproval(
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

async function handleBashTool(
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

function findMatchingRule(name: string, args: string[], rules: Record<string, Action>, targetAction: Action): string {
  for (const [pattern, action] of Object.entries(rules)) {
    if (action !== targetAction) continue;
    if (pattern === "*") return pattern;
    if (pattern === name) return pattern;
    const tokens = pattern.split(" ");
    if (tokens[0] === name && tokens.length <= args.length + 1) {
      // Check subsequence match
      let ti = 1;
      for (const arg of args) {
        if (ti < tokens.length && arg === tokens[ti]) ti++;
      }
      if (ti === tokens.length) return pattern;
    }
  }
  return name;
}

async function handleGlobTool(
  pi: ExtensionAPI,
  tool: string,
  path: string,
  toolRules: Record<string, Action>,
  ctx: ExtensionContext,
  sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | void> {
  // Merge session rules with config rules
  const mergedRules: Record<string, Action> = { ...toolRules };
  if (sessionRules[tool]) {
    Object.assign(mergedRules, sessionRules[tool]);
  }

  const action = resolveGlobAction(path, mergedRules);

  if (action === "allow") return;

  if (action === "deny") {
    return {
      block: true,
      reason: `[Blocked by pi-guard: Security policy]`,
    };
  }

  if (!ctx.hasUI) {
    return {
      block: true,
      reason: `[Blocked by pi-guard: No interactive session available]`,
    };
  }

  // Interactive: prompt user
  const prompt = buildFileApprovalPrompt(tool, path);
  const alwaysLabel = `Always allow ${tool} (this session)`;

  pi.events.emit("nudge", { body: `${tool} needs approval` });
  const choice = await ctx.ui.select(prompt, ["Allow", alwaysLabel, "Reject"]);

  if (choice === alwaysLabel) {
    sessionRules[tool] = { ...sessionRules[tool], "*": "allow" };
    return;
  }

  if (choice !== "Allow") {
    return { block: true, reason: `[Blocked by pi-guard: User rejected this invocation]` };
  }
}

function findGlobMatchingRule(path: string, rules: Record<string, Action>, targetAction: Action): string {
  for (const [pattern, action] of Object.entries(rules)) {
    if (action !== targetAction) continue;
    if (pattern === "*") return pattern;
    if (globMatch(pattern, path)) return pattern;
  }
  return path;
}

async function handleExactTool(
  pi: ExtensionAPI,
  tool: string,
  value: string,
  toolRules: Record<string, Action>,
  ctx: ExtensionContext,
  sessionRules: Record<string, Record<string, Action>>,
): Promise<{ block: true; reason: string } | void> {
  // Merge session rules with config rules
  const mergedRules: Record<string, Action> = { ...toolRules };
  if (sessionRules[tool]) {
    Object.assign(mergedRules, sessionRules[tool]);
  }

  const action = resolveExactAction(value, mergedRules);

  if (action === "allow") return;

  if (action === "deny") {
    return {
      block: true,
      reason: `[Blocked by pi-guard: Security policy]`,
    };
  }

  if (!ctx.hasUI) {
    return {
      block: true,
      reason: `[Blocked by pi-guard: No interactive session available]`,
    };
  }

  // Interactive: prompt user
  const prompt = buildCustomApprovalPrompt(tool, value);
  const alwaysLabel = `Always allow ${tool} (this session)`;

  pi.events.emit("nudge", { body: `${tool} needs approval` });
  const choice = await ctx.ui.select(prompt, ["Allow", alwaysLabel, "Reject"]);

  if (choice === alwaysLabel) {
    sessionRules[tool] = { ...sessionRules[tool], "*": "allow" };
    return;
  }

  if (choice !== "Allow") {
    return { block: true, reason: `[Blocked by pi-guard: User rejected this invocation]` };
  }
}