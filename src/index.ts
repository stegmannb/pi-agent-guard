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
import type { Action, Rules, ToolCallInput } from "./types.ts";

const block = (reason: string): { block: true; reason: string } =>
  ({ block: true, reason: `[Blocked by pi-guard: ${reason}]` });

export { parseGuardArgs };

export default function (pi: ExtensionAPI) {
  // Load all static config once at startup
  const loaded = loadConfig();
  const projectResult = loadProjectConfig(process.cwd());

  const userRules: Rules = loaded.config.rules;
  const projectRules: Rules = projectResult?.config.rules ?? {};
  const envRules: Rules | undefined = loaded.envRules;

  // Accumulate any warnings to show once
  const warnings: string[] = [];
  if (loaded.warning) warnings.push(loaded.warning);
  if (projectResult?.warning) warnings.push(projectResult.warning);
  if (warnings.length > 0) {
    console.warn(`[pi-guard] ${warnings.join("; ")}`);
  }

  const context: GuardContext = {
    config: loaded.config,
    activeProfile: undefined,
    sessionRules: {},
  };

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
      const { action, target } = parseGuardArgs(args);
      const result = handleGuardCommand(action, target, context, ctx.cwd);
      ctx.ui.notify(result.message, result.type);
    },
  });

  // The core interception hook
  pi.on("tool_call", async (event, ctx) => {
    if (!context.config.enabled) return;

    const tool = event.toolName;
    const input = event.input as ToolCallInput;

    const profiles = context.config.profiles ?? {};
    const profileRules = context.activeProfile ? profiles[context.activeProfile] : undefined;
    const effectiveRules = buildEffectiveRules(
      userRules,
      projectRules,
      envRules,
      profileRules,
      context.sessionRules,
    );

    // Collapse global action and per-tool action into one value:
    // - string effectiveRules → that action applies to all tools
    // - object effectiveRules → look up tool, undefined means "ask"
    const toolRules = typeof effectiveRules === "object" ? effectiveRules[tool] : effectiveRules;

    let action: Action = "ask";
    if (typeof toolRules !== "object") {
      action = toolRules ?? "ask";
    } else {
      const matcher = (context.config.matchers ?? {})[tool];
      if (matcher) {
        const value = input[matcher.param];
        if (typeof value !== "string" || value.trim() === "") return;
        if (matcher.type === "bash") return handleBashTool(pi, tool, value, toolRules, ctx, context.sessionRules);
        if (matcher.type === "glob") return handleGlobTool(pi, tool, value, toolRules, ctx, context.sessionRules);
        if (matcher.type === "exact") return handleExactTool(pi, tool, value, toolRules, ctx, context.sessionRules);
      } else {
        action = toolRules["*"] ?? "ask";
      }
    }

    if (action === "allow") return;
    if (action === "deny") return block("Security policy");
    if (!ctx.hasUI) return block("No interactive session available");
    return handleInteractiveApproval(pi, tool, input, ctx, context.sessionRules);
  });
}