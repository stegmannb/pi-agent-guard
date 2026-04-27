import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { DEFAULT_CONFIG } from "./defaults.ts";
import type { Action, GuardConfig, Rules, ToolRules } from "./types.ts";

// ── Constants ──

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");

export const SAFE_FALLBACK_CONFIG: GuardConfig = {
	enabled: true,
	matchers: DEFAULT_CONFIG.matchers,
	rules: {},
};

export interface LoadedConfigResult {
	config: GuardConfig;
	warning?: string;
}

// ── TypeBox schemas ──

const ActionSchema = Type.Enum({
	allow: "allow",
	ask: "ask",
	deny: "deny",
} as const);

const ToolRulesSchema = Type.Union([
	ActionSchema,
	Type.Record(Type.String(), ActionSchema),
] as const);

const RulesSchema = Type.Union([
	ActionSchema,
	Type.Record(Type.String(), ToolRulesSchema),
] as const);

const MatcherSchema = Type.Object({
	param: Type.String(),
	type: Type.Enum({
		bash: "bash",
		glob: "glob",
		exact: "exact",
	} as const),
});

const GuardConfigSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	matchers: Type.Optional(Type.Record(Type.String(), MatcherSchema)),
	rules: Type.Optional(RulesSchema),
	profiles: Type.Optional(Type.Record(Type.String(), RulesSchema)),
	shortcuts: Type.Optional(Type.Record(Type.String(), Type.String())),
});

// ── Config validation ──

export function validateToolRules(input: unknown): {
	rules: Record<string, Action>;
	warnings: string[];
} {
	const warnings: string[] = [];
	const rules: Record<string, Action> = {};

	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return {
			rules,
			warnings: [
				'rules must be an object mapping patterns to "allow", "ask", or "deny"',
			],
		};
	}

	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (
			typeof key === "string" &&
			key.trim().length > 0 &&
			(value === "allow" || value === "ask" || value === "deny")
		) {
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
			warning: "Invalid guard config; using safe fallback.",
		};
	}

	if (!Value.Check(GuardConfigSchema, input)) {
		return {
			config: { ...SAFE_FALLBACK_CONFIG },
			warning: "Invalid guard config; using safe fallback.",
		};
	}

	const cfg = input as Static<typeof GuardConfigSchema>;
	const config: GuardConfig = {
		enabled: cfg.enabled ?? true,
		matchers: cfg.matchers ?? DEFAULT_CONFIG.matchers,
		rules: cfg.rules ?? {},
	};
	if (cfg.profiles) config.profiles = cfg.profiles;
	if (cfg.shortcuts) config.shortcuts = cfg.shortcuts;
	return { config };
}

export function getGuardConfigFromSettings(input: unknown): LoadedConfigResult {
	if (!input || typeof input !== "object") {
		return { config: { ...SAFE_FALLBACK_CONFIG } };
	}

	const settings = input as Record<string, unknown>;

	if (!Object.hasOwn(settings, "guard")) {
		return { config: { ...SAFE_FALLBACK_CONFIG } };
	}

	return validateLoadedGuardConfig(settings.guard);
}

// ── Rule merging ──

export function buildEffectiveRules(
	userRules: Rules,
	projectRules: Rules,
	envRules: Rules | undefined,
	profileRules: Rules | undefined,
	sessionRules: Rules,
): Rules {
	const layers = [
		userRules,
		projectRules,
		envRules,
		profileRules,
		sessionRules,
	];

	// If any layer is a single-action string, last one wins
	for (let i = layers.length - 1; i >= 0; i--) {
		if (typeof layers[i] === "string") return layers[i] as Action;
	}

	// Merge object-based rules
	const defaultRules =
		typeof DEFAULT_CONFIG.rules === "string" ? {} : DEFAULT_CONFIG.rules;
	const merged: Record<string, ToolRules> = { ...defaultRules };

	// Layer order: default → user → project → env → profile → session
	for (const layer of layers) {
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

// ── Config loading ──

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
		return getGuardConfigFromSettings(parsed);
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
