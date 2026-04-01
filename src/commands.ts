import {
  saveConfig,
  loadProjectConfig,
  buildEffectiveRules,
} from "./config.ts";
import type { Action, GuardConfig } from "./types.ts";

export interface GuardContext {
  config: GuardConfig;
  activeProfile: string | undefined;
  sessionRules: Record<string, Record<string, Action>>;
}

export function parseGuardArgs(args: string): { action: string; target: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "", target: "" };

  const [action = "", ...targetParts] = trimmed.split(/\s+/);
  const target = targetParts.join(" ").trim();

  return { action, target };
}

function handleProfileCommand(
  context: GuardContext,
  target: string | undefined,
): { message: string; type: "info" | "warning" } {
  const profiles = context.config.profiles ?? {};
  const profileNames = Object.keys(profiles);

  if (!target) {
    if (context.activeProfile) {
      return {
        message: `Active profile: ${context.activeProfile}\n\nAvailable profiles: ${profileNames.join(", ") || "(none)"}\n\nUse /guard profile <name> to activate\nUse /guard profile off to deactivate`,
        type: "info" as const,
      };
    } else {
      return {
        message: `No profile active\n\nAvailable profiles: ${profileNames.join(", ") || "(none)"}\n\nUse /guard profile <name> to activate`,
        type: "info" as const,
      };
    }
  }

  if (target === "off") {
    context.activeProfile = undefined;
    return { message: "Profile deactivated", type: "info" as const };
  }

  if (!(target in profiles)) {
    return {
      message: `Unknown profile: ${target}\n\nAvailable profiles: ${profileNames.join(", ") || "(none)"}`,
      type: "warning" as const,
    };
  }

  context.activeProfile = target;
  return { message: `Profile activated: ${target}`, type: "info" as const };
}

function handleToggleCommand(context: GuardContext): string {
  context.config.enabled = !context.config.enabled;
  saveConfig(context.config);
  return `pi-guard is now ${context.config.enabled ? "ENABLED" : "DISABLED"}`;
}

function buildListOutput(context: GuardContext, cwd: string): string {
  const enabled = context.config.enabled ? "ENABLED" : "DISABLED";
  const profiles = context.config.profiles ?? {};

  const projectResult = loadProjectConfig(cwd);
  const projectRules = projectResult?.config.rules ?? {};
  const envRules = process.env.PI_GUARD ? JSON.parse(process.env.PI_GUARD) : undefined;
  const profileRules = context.activeProfile ? profiles[context.activeProfile] : undefined;
  const effectiveRules = buildEffectiveRules(
    context.config.rules,
    projectRules,
    envRules,
    profileRules,
    context.sessionRules,
  );

  let output = `pi-guard: ${enabled}\n`;
  if (context.activeProfile) {
    output += `Profile: ${context.activeProfile}\n`;
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

export function handleGuardCommand(
  action: string,
  target: string | undefined,
  context: GuardContext,
  cwd: string,
): { message: string; type: "info" | "warning" } {
  if (action === "toggle") {
    return { message: handleToggleCommand(context), type: "info" };
  }

  if (action === "profile") {
    return handleProfileCommand(context, target);
  }

  if (action === "list") {
    return { message: buildListOutput(context, cwd), type: "info" };
  }

  return { message: "Usage: /guard <toggle|profile|list>", type: "warning" };
}