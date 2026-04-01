import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  loadConfig,
  loadProjectConfig,
  buildEffectiveRules,
} from "./config.ts";
import type { GuardContext } from "./commands.ts";
import {
  parseGuardArgs,
  handleGuardCommand,
} from "./commands.ts";
import {
  handleInteractiveApproval,
  handleBashTool,
  handleGlobTool,
  handleExactTool,
} from "./handlers.ts";
import type { Action, ToolCallInput } from "./types.ts";

export { parseGuardArgs };

export default function (pi: ExtensionAPI) {
  const loaded = loadConfig();
  const context: GuardContext = {
    config: loaded.config,
    activeProfile: undefined,
    sessionRules: {},
  };
  let configWarning = loaded.warning;

  if (configWarning) {
    console.warn(`[pi-guard] ${configWarning}`);
  }

  // Register shortcut commands
  const shortcuts = context.config.shortcuts ?? {};
  for (const [shortcut, subcommand] of Object.entries(shortcuts)) {
    if (!subcommand) continue;
    pi.registerCommand(shortcut, {
      description: `pi-guard shortcut: ${subcommand}`,
      handler: async (_args, ctx) => {
        const { action, target } = parseGuardArgs(subcommand);
        const result = handleGuardCommand(action, target, context, ctx.cwd);
        ctx.ui.notify(result.message, result.type);
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
      const result = handleGuardCommand(action, target, context, ctx.cwd);
      ctx.ui.notify(result.message, result.type);
    },
  });

  // The core interception hook
  pi.on("tool_call", async (event, ctx) => {
    if (configWarning && ctx.hasUI) {
      ctx.ui.notify(`[pi-guard] ${configWarning}`, "warning");
      configWarning = undefined;
    }

    if (!context.config.enabled) return;

    const tool = event.toolName;
    const input = event.input as ToolCallInput;

    // Get the effective rules (user + project + profile + session + env)
    const projectResult = loadProjectConfig(ctx.cwd);
    const projectRules = projectResult?.config.rules ?? {};
    if (projectResult?.warning && ctx.hasUI) {
      ctx.ui.notify(`[pi-guard] ${projectResult.warning}`, "warning");
    }

    const envRules = process.env.PI_GUARD ? JSON.parse(process.env.PI_GUARD) : undefined;
    const profiles = context.config.profiles ?? {};
    const profileRules = context.activeProfile ? profiles[context.activeProfile] : undefined;
    const effectiveRules = buildEffectiveRules(
      context.config.rules,
      projectRules,
      context.sessionRules,
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
      return handleInteractiveApproval(pi, tool, input, ctx, context.sessionRules);
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
      return handleInteractiveApproval(pi, tool, input, ctx, context.sessionRules);
    }

    // Get matcher for this tool
    const matchers = context.config.matchers ?? {};
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
      return handleInteractiveApproval(pi, tool, input, ctx, context.sessionRules);
    }

    // Extract input based on matcher param
    const value = input[matcher.param];
    if (typeof value !== "string" || value.trim() === "") return;

    // Handle bash tool specially (needs AST parsing)
    if (matcher.type === "bash") {
      return handleBashTool(pi, tool, value, toolRules, ctx, context.sessionRules);
    }

    // Handle glob-based tools (read, edit, write)
    if (matcher.type === "glob") {
      return handleGlobTool(pi, tool, value, toolRules, ctx, context.sessionRules);
    }

    // Handle exact-match tools
    if (matcher.type === "exact") {
      return handleExactTool(pi, tool, value, toolRules, ctx, context.sessionRules);
    }
  });
}