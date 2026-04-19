import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { GuardConfig, Matchers, Action, ToolRules, Rules } from "./types.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");

const SAFE_FALLBACK_CONFIG: GuardConfig = {
  enabled: true,
  ...(DEFAULT_CONFIG.matchers ? { matchers: DEFAULT_CONFIG.matchers } : {}),
  rules: {},
};

interface LoadedConfigResult {
  config: GuardConfig;
  warning?: string;
}

export function buildEffectiveRules(
  userRules: Rules,
  projectRules: Rules,
  envRules: Rules | undefined,
  profileRules: Rules | undefined,
  sessionRules: Rules,
): Rules {
  // Handle the case where rules is a single action (applies to all tools)
  // Last match wins: session > profile > env > project > user
  if (typeof userRules === "string" || typeof projectRules === "string" || typeof sessionRules === "string" || typeof envRules === "string" || typeof profileRules === "string") {
    if (typeof sessionRules === "string") return sessionRules;
    if (typeof profileRules === "string") return profileRules;
    if (typeof envRules === "string") return envRules;
    if (typeof projectRules === "string") return projectRules;
    if (typeof userRules === "string") return userRules;
  }

  // Merge object-based rules
  const defaultRules = typeof DEFAULT_CONFIG.rules === "string" ? {} : DEFAULT_CONFIG.rules;
  const merged: Record<string, ToolRules> = { ...defaultRules };

  // Layer order: default → user → project → env → profile → session
  for (const layer of [userRules, projectRules, envRules, profileRules, sessionRules]) {
    if (!layer || typeof layer === "string") continue;
    for (const [tool, rules] of Object.entries(layer)) {
      if (typeof rules === "string") {
        merged[tool] = rules;
      } else {
        merged[tool] = { ...merged[tool] as Record<string, Action>, ...rules };
      }
    }
  }

  return merged;
}

/** Load project-level guard config from .pi/settings.json in the given directory. */
function loadProjectConfig(cwd: string): LoadedConfigResult | null {
  const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
  if (!fs.existsSync(projectSettingsPath)) {
    return null;
  }
  try {
    const data = fs.readFileSync(projectSettingsPath, "utf-8");
    const parsed = JSON.parse(data);
    const result = getGuardConfigFromSettings(parsed);
    return result;
  } catch {
    return {
      config: { ...SAFE_FALLBACK_CONFIG },
      warning: "Failed to parse project .pi/settings.json; using safe fallback.",
    };
  }
}

export function validateToolRules(input: unknown): { rules: Record<string, Action>; warnings: string[] } {
  const warnings: string[] = [];
  const rules: Record<string, Action> = {};

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { rules, warnings: ['rules must be an object mapping patterns to "allow", "ask", or "deny"'] };
  }

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof key === "string" && key.trim().length > 0 && (value === "allow" || value === "ask" || value === "deny")) {
      rules[key] = value;
    } else {
      warnings.push(`Invalid rule: "${key}" -> "${value}"`);
    }
  }

  return { rules, warnings };
}

export function validateLoadedGuardConfig(input: unknown): LoadedConfigResult {
  if (!input || typeof input !== "object") {
    return {
      config: { ...SAFE_FALLBACK_CONFIG },
      warning: "Invalid guard config shape; using safe fallback (enabled=true, rules={}).",
    };
  }

  const cfg = input as Record<string, unknown>;
  const warnings: string[] = [];

  let enabled = SAFE_FALLBACK_CONFIG.enabled;
  if (typeof cfg.enabled === "boolean") {
    enabled = cfg.enabled;
  } else if (cfg.enabled !== undefined) {
    warnings.push("enabled must be a boolean");
  }

  let matchers: Matchers = DEFAULT_CONFIG.matchers!;
  if (cfg.matchers !== undefined) {
    if (cfg.matchers && typeof cfg.matchers === "object" && !Array.isArray(cfg.matchers)) {
      const validMatchers: Matchers = {};
      for (const [tool, matcher] of Object.entries(cfg.matchers as Record<string, unknown>)) {
        if (
          matcher &&
          typeof matcher === "object" &&
          typeof (matcher as Record<string, unknown>).param === "string" &&
          ["bash", "glob", "exact"].includes((matcher as Record<string, unknown>).type as string)
        ) {
          validMatchers[tool] = {
            param: (matcher as Record<string, unknown>).param as string,
            type: (matcher as Record<string, unknown>).type as "bash" | "glob" | "exact",
          };
        } else {
          warnings.push(`Invalid matcher for tool "${tool}"`);
        }
      }
      matchers = validMatchers;
    } else {
      warnings.push("matchers must be an object mapping tool names to matcher configs");
    }
  }

  let rules: Rules = {};
  if (cfg.rules !== undefined) {
    if (typeof cfg.rules === "string" && (cfg.rules === "allow" || cfg.rules === "ask" || cfg.rules === "deny")) {
      rules = cfg.rules;
    } else if (cfg.rules && typeof cfg.rules === "object" && !Array.isArray(cfg.rules)) {
      const validRules: Record<string, ToolRules> = {};
      for (const [tool, toolRules] of Object.entries(cfg.rules as Record<string, unknown>)) {
        if (typeof toolRules === "string" && (toolRules === "allow" || toolRules === "ask" || toolRules === "deny")) {
          validRules[tool] = toolRules;
        } else if (toolRules && typeof toolRules === "object" && !Array.isArray(toolRules)) {
          const { rules: validated, warnings: toolWarnings } = validateToolRules(toolRules);
          validRules[tool] = validated;
          warnings.push(...toolWarnings.map(w => `Tool "${tool}": ${w}`));
        } else {
          warnings.push(`Invalid rules for tool "${tool}"`);
        }
      }
      rules = validRules;
    } else {
      warnings.push('rules must be a single action ("allow"/"ask"/"deny") or an object mapping tool names to rules');
    }
  }

  let profiles: Record<string, import("./types.ts").Profile> | undefined;
  if (cfg.profiles !== undefined) {
    if (cfg.profiles && typeof cfg.profiles === "object" && !Array.isArray(cfg.profiles)) {
      const validProfiles: Record<string, import("./types.ts").Profile> = {};
      for (const [profileName, profileRules] of Object.entries(cfg.profiles as Record<string, unknown>)) {
        if (typeof profileRules === "string" && (profileRules === "allow" || profileRules === "ask" || profileRules === "deny")) {
          validProfiles[profileName] = profileRules;
        } else if (profileRules && typeof profileRules === "object" && !Array.isArray(profileRules)) {
          const validRules: Record<string, ToolRules> = {};
          for (const [tool, toolRules] of Object.entries(profileRules as Record<string, unknown>)) {
            if (typeof toolRules === "string" && (toolRules === "allow" || toolRules === "ask" || toolRules === "deny")) {
              validRules[tool] = toolRules;
            } else if (toolRules && typeof toolRules === "object" && !Array.isArray(toolRules)) {
              const { rules: validated, warnings: toolWarnings } = validateToolRules(toolRules);
              validRules[tool] = validated;
              warnings.push(...toolWarnings.map(w => `Profile "${profileName}", tool "${tool}": ${w}`));
            } else {
              warnings.push(`Profile "${profileName}": Invalid rules for tool "${tool}"`);
            }
          }
          validProfiles[profileName] = validRules;
        } else {
          warnings.push(`Profile "${profileName}": must be a single action or an object mapping tool names to rules`);
        }
      }
      profiles = validProfiles;
    } else {
      warnings.push("profiles must be an object mapping profile names to rules");
    }
  }

  let shortcuts: Record<string, string> | undefined;
  if (cfg.shortcuts !== undefined) {
    if (cfg.shortcuts && typeof cfg.shortcuts === "object" && !Array.isArray(cfg.shortcuts)) {
      const validShortcuts: Record<string, string> = {};
      for (const [shortcut, target] of Object.entries(cfg.shortcuts as Record<string, unknown>)) {
        if (typeof target === "string") {
          validShortcuts[shortcut] = target;
        } else {
          warnings.push(`Shortcut "${shortcut}": must be a string`);
        }
      }
      shortcuts = validShortcuts;
    } else {
      warnings.push("shortcuts must be an object mapping shortcut names to profile names or 'off'");
    }
  }

  if (warnings.length > 0) {
    return {
      config: {
        enabled,
        matchers,
        rules,
        ...(profiles && { profiles }),
        ...(shortcuts && { shortcuts }),
      },
      warning: `Invalid guard config fields (${warnings.join("; ")}); using safe values for invalid fields.`,
    };
  }

  return {
    config: {
      enabled,
      matchers,
      rules,
      ...(profiles && { profiles }),
      ...(shortcuts && { shortcuts }),
    },
  };
}

export function getGuardConfigFromSettings(input: unknown): LoadedConfigResult {
  if (!input || typeof input !== "object") {
    return { config: { enabled: true, ...(DEFAULT_CONFIG.matchers ? { matchers: DEFAULT_CONFIG.matchers } : {}), rules: {} } };
  }

  const settings = input as Record<string, unknown>;

  if (!Object.hasOwn(settings, "guard")) {
    return validateLoadedGuardConfig({});
  }

  return validateLoadedGuardConfig(settings.guard);
}

/** Load environment rules from PI_GUARD env var. */
function loadEnvRules(): Rules | undefined {
  const env = process.env.PI_GUARD;
  if (!env) return undefined;

  try {
    const parsed = JSON.parse(env);
    if (typeof parsed === "string" && (parsed === "allow" || parsed === "ask" || parsed === "deny")) {
      return parsed;
    }
    if (typeof parsed === "object" && parsed !== null) {
      // Validate it's a valid rules object
      const result = validateLoadedGuardConfig({ rules: parsed });
      if (result.config.rules) {
        return result.config.rules;
      }
    }
  } catch {
    // Silently ignore invalid env var
  }

  return undefined;
}

export function loadConfig(): LoadedConfigResult & { envRules: Rules | undefined } {
  const envRules = loadEnvRules();

  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const data = fs.readFileSync(SETTINGS_PATH, "utf-8");
      const parsed = JSON.parse(data);
      const result = getGuardConfigFromSettings(parsed);
      return { ...result, envRules };
    } catch {
      return {
        config: { ...SAFE_FALLBACK_CONFIG },
        warning: "Failed to parse settings.json; using safe fallback (enabled=true, rules={}).",
        envRules,
      };
    }
  }

  return {
    config: { enabled: true, ...(DEFAULT_CONFIG.matchers ? { matchers: DEFAULT_CONFIG.matchers } : {}), rules: {} },
    envRules,
  };
}

export function saveConfig(config: GuardConfig) {
  try {
    fs.mkdirSync(AGENT_DIR, { recursive: true });

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    }

    settings.guard = {
      enabled: config.enabled,
      ...(config.matchers && Object.keys(config.matchers).length > 0 && { matchers: config.matchers }),
      rules: config.rules,
      ...(config.profiles && Object.keys(config.profiles).length > 0 && { profiles: config.profiles }),
      ...(config.shortcuts && Object.keys(config.shortcuts).length > 0 && { shortcuts: config.shortcuts }),
    };

    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save guard config to settings.json", e);
  }
}

export { loadProjectConfig, DEFAULT_CONFIG };