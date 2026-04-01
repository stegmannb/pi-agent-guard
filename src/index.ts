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
import { resolveBashAction, resolveGlobAction, resolveExactAction } from "./matching.ts";
import type { Action, ToolRules, CommandRef, ToolCallInput, GuardConfig } from "./types.ts";

export function parseGuardArgs(args: string): { action: string; target: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "", target: "" };

  const [action = "", ...targetParts] = trimmed.split(/\s+/);
  const target = targetParts.join(" ").trim();

  return { action, target };
}

interface GuardState {
  config: GuardConfig;
  activeProfile: string | undefined;
  sessionRules: Record<string, Record<string, Action>>;
}

export function handleProfileCommand(
  config: GuardConfig,
  activeProfile: string | undefined,
  target: string | undefined,
): { activeProfile: string | undefined; message: string; type: "info" | "warning" } {
  const profiles = config.profiles ?? {};
  const profileNames = Object.keys(profiles);

  if (!target) {
    // Show current profile and available profiles
    if (activeProfile) {
      return {
        activeProfile,
        message: `Active profile: ${activeProfile}\n\nAvailable profiles: ${profileNames.join(", ") || "(none)"}\n\nUse /guard profile <name> to activate\nUse /guard profile off to deactivate`,
        type: "info" as const,
      };
    } else {
      return {
        activeProfile: undefined,
        message: `No profile active\n\nAvailable profiles: ${profileNames.join(", ") || "(none)"}\n\nUse /guard profile <name> to activate`,
        type: "info" as const,
      };
    }
  }

  if (target === "off") {
    return {
      activeProfile: undefined,
      message: "Profile deactivated",
      type: "info" as const,
    };
  }

  if (!(target in profiles)) {
    return {
      activeProfile,
      message: `Unknown profile: ${target}\n\nAvailable profiles: ${profileNames.join(", ") || "(none)"}`,
      type: "warning" as const,
    };
  }

  return {
    activeProfile: target,
    message: `Profile activated: ${target}`,
    type: "info" as const,
  };
}

export function handleToggleCommand(config: GuardConfig): { config: GuardConfig; message: string } {
  config.enabled = !config.enabled;
  saveConfig(config);
  return {
    config,
    message: `pi-guard is now ${config.enabled ? "ENABLED" : "DISABLED"}`,
  };
}

export function buildListOutput(
  config: GuardConfig,
  activeProfile: string | undefined,
  sessionRules: Record<string, Record<string, Action>>,
  cwd: string,
): string {
  const enabled = config.enabled ? "ENABLED" : "DISABLED";
  const profiles = config.profiles ?? {};

  const projectResult = loadProjectConfig(cwd);
  const projectRules = projectResult?.config.rules ?? {};
  const envRules = process.env.PI_GUARD ? JSON.parse(process.env.PI_GUARD) : undefined;
  const profileRules = activeProfile ? profiles[activeProfile] : undefined;
  const effectiveRules = buildEffectiveRules(
    config.rules,
    projectRules,
    sessionRules,
    envRules,
    profileRules,
  );

  let output = `pi-guard: ${enabled}\n`;
  if (activeProfile) {
    output += `Profile: ${activeProfile}\n`;
  }
  output += "\n";

  if (typeof effectiveRules === "string") {
    output += `Global rule: ${effectiveRules}\n`;
  } else {
    for (const [tool, rules] of Object.entries(effectiveRules)) {
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

  return output;
}

export default function (pi: ExtensionAPI) {
  const loaded = loadConfig();
  let config = loaded.config;
  let configWarning = loaded.warning;
  // Session rules are stored per-tool
  const sessionRules: Record<string, Record<string, Action>> = {};
  // Active profile (session-only state)
  let activeProfile: string | undefined;

  if (configWarning) {
    console.warn(`[pi-guard] ${configWarning}`);
  }

  // Register shortcut commands
  const shortcuts = config.shortcuts ?? {};
  for (const [shortcut, subcommand] of Object.entries(shortcuts)) {
    if (!subcommand) continue;
    pi.registerCommand(shortcut, {
      description: `pi-guard shortcut: ${subcommand}`,
      handler: async (_args, ctx) => {
        const { action, target } = parseGuardArgs(subcommand);

        if (action === "profile") {
          const result = handleProfileCommand(config, activeProfile, target);
          activeProfile = result.activeProfile;
          ctx.ui.notify(result.message, result.type);
        } else if (action === "toggle") {
          const result = handleToggleCommand(config);
          config = result.config;
          ctx.ui.notify(result.message, "info");
        } else if (action === "list") {
          const output = buildListOutput(config, activeProfile, sessionRules, ctx.cwd);
          ctx.ui.notify(output, "info");
        } else {
          ctx.ui.notify(`Unknown shortcut subcommand: ${subcommand}`, "warning");
        }
      },
    });
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

      if (action === "toggle") {
        const result = handleToggleCommand(config);
        config = result.config;
        ctx.ui.notify(result.message, "info");
      } else if (action === "profile") {
        const result = handleProfileCommand(config, activeProfile, target);
        activeProfile = result.activeProfile;
        ctx.ui.notify(result.message, result.type);
      } else if (action === "list") {
        const output = buildListOutput(config, activeProfile, sessionRules, ctx.cwd);
        ctx.ui.notify(output, "info");
      } else {
        ctx.ui.notify("Usage: /guard <toggle|profile|list>", "warning");
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

    // Get the effective rules (user + project + profile + session + env)
    const projectResult = loadProjectConfig(ctx.cwd);
    const projectRules = projectResult?.config.rules ?? {};
    if (projectResult?.warning && ctx.hasUI) {
      ctx.ui.notify(`[pi-guard] ${projectResult.warning}`, "warning");
    }

    const envRules = process.env.PI_GUARD ? JSON.parse(process.env.PI_GUARD) : undefined;
    const profiles = config.profiles ?? {};
    const profileRules = activeProfile ? profiles[activeProfile] : undefined;
    const effectiveRules = buildEffectiveRules(
      config.rules,
      projectRules,
      sessionRules,
      envRules,
      profileRules,
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