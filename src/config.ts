import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getGuardConfigFromSettings,
	SAFE_FALLBACK_CONFIG,
	validateLoadedGuardConfig,
} from "./config-validation.ts";
import { DEFAULT_CONFIG } from "./defaults.ts";
import type { Action, GuardConfig, Rules, ToolRules } from "./types.ts";

export type { LoadedConfigResult } from "./config-validation.ts";
export {
	getGuardConfigFromSettings,
	SAFE_FALLBACK_CONFIG,
	validateLoadedGuardConfig,
	validateToolRules,
} from "./config-validation.ts";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");

export function buildEffectiveRules(
	userRules: Rules,
	projectRules: Rules,
	envRules: Rules | undefined,
	profileRules: Rules | undefined,
	sessionRules: Rules,
): Rules {
	// Handle the case where rules is a single action (applies to all tools)
	// Last match wins: session > profile > env > project > user
	if (
		typeof userRules === "string" ||
		typeof projectRules === "string" ||
		typeof sessionRules === "string" ||
		typeof envRules === "string" ||
		typeof profileRules === "string"
	) {
		if (typeof sessionRules === "string") return sessionRules;
		if (typeof profileRules === "string") return profileRules;
		if (typeof envRules === "string") return envRules;
		if (typeof projectRules === "string") return projectRules;
		if (typeof userRules === "string") return userRules;
	}

	// Merge object-based rules
	const defaultRules =
		typeof DEFAULT_CONFIG.rules === "string" ? {} : DEFAULT_CONFIG.rules;
	const merged: Record<string, ToolRules> = { ...defaultRules };

	// Layer order: default → user → project → env → profile → session
	for (const layer of [
		userRules,
		projectRules,
		envRules,
		profileRules,
		sessionRules,
	]) {
		if (!layer || typeof layer === "string") continue;
		for (const [tool, rules] of Object.entries(layer)) {
			if (typeof rules === "string") {
				merged[tool] = rules;
			} else {
				merged[tool] = {
					...(merged[tool] as Record<string, Action>),
					...rules,
				};
			}
		}
	}

	return merged;
}

/** Load project-level guard config from .pi/settings.json in the given directory. */
function loadProjectConfig(
	cwd: string,
): { config: GuardConfig; warning?: string } | null {
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
			warning:
				"Failed to parse project .pi/settings.json; using safe fallback.",
		};
	}
}

/** Load environment rules from PI_GUARD env var. */
function loadEnvRules(): Rules | undefined {
	const env = process.env.PI_GUARD;
	if (!env) return undefined;

	try {
		const parsed = JSON.parse(env);
		if (
			typeof parsed === "string" &&
			(parsed === "allow" || parsed === "ask" || parsed === "deny")
		) {
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

export function loadConfig() {
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
				warning:
					"Failed to parse settings.json; using safe fallback (enabled=true, rules={}).",
				envRules,
			};
		}
	}

	return { config: { ...SAFE_FALLBACK_CONFIG }, envRules };
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
			...(config.matchers &&
				Object.keys(config.matchers).length > 0 && {
					matchers: config.matchers,
				}),
			rules: config.rules,
			...(config.profiles &&
				Object.keys(config.profiles).length > 0 && {
					profiles: config.profiles,
				}),
			...(config.shortcuts &&
				Object.keys(config.shortcuts).length > 0 && {
					shortcuts: config.shortcuts,
				}),
		};

		fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
	} catch (e) {
		console.error("Failed to save guard config to settings.json", e);
	}
}

export { DEFAULT_CONFIG, loadProjectConfig };
