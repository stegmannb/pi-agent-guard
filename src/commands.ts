import {
  saveConfig,
  loadProjectConfig,
  buildEffectiveRules,
} from "./config.ts";
import type { Action, GuardConfig } from "./types.ts";

export function parseGuardArgs(args: string): { action: string; target: string } {
  const trimmed = args.trim();
  if (!trimmed) return { action: "", target: "" };

  const [action = "", ...targetParts] = trimmed.split(/\s+/);
  const target = targetParts.join(" ").trim();

  return { action, target };
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

export type GuardCommandResult =
  | { type: "profile"; activeProfile: string | undefined; message: string; messageType: "info" | "warning" }
  | { type: "toggle"; config: GuardConfig; message: string }
  | { type: "list"; output: string }
  | { type: "usage"; message: string };

export function handleGuardCommand(
  action: string,
  target: string | undefined,
  config: GuardConfig,
  activeProfile: string | undefined,
  sessionRules: Record<string, Record<string, Action>>,
  cwd: string,
): GuardCommandResult {
  if (action === "toggle") {
    const result = handleToggleCommand(config);
    return { type: "toggle", config: result.config, message: result.message };
  }

  if (action === "profile") {
    const result = handleProfileCommand(config, activeProfile, target);
    return { type: "profile", activeProfile: result.activeProfile, message: result.message, messageType: result.type };
  }

  if (action === "list") {
    const output = buildListOutput(config, activeProfile, sessionRules, cwd);
    return { type: "list", output };
  }

  return { type: "usage", message: "Usage: /guard <toggle|profile|list>" };
}