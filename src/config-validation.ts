import { DEFAULT_CONFIG } from "./defaults.ts";
import type {
	Action,
	GuardConfig,
	Matchers,
	Profile,
	Rules,
	ToolRules,
} from "./types.ts";

export const SAFE_FALLBACK_CONFIG: GuardConfig = {
	enabled: true,
	matchers: DEFAULT_CONFIG.matchers,
	rules: {},
};

export interface LoadedConfigResult {
	config: GuardConfig;
	warning?: string;
}

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
			warning:
				"Invalid guard config shape; using safe fallback (enabled=true, rules={}).",
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

	let matchers: Matchers = DEFAULT_CONFIG.matchers;
	if (cfg.matchers !== undefined) {
		if (
			cfg.matchers &&
			typeof cfg.matchers === "object" &&
			!Array.isArray(cfg.matchers)
		) {
			const validMatchers: Matchers = {};
			for (const [tool, matcher] of Object.entries(
				cfg.matchers as Record<string, unknown>,
			)) {
				if (
					matcher &&
					typeof matcher === "object" &&
					typeof (matcher as Record<string, unknown>).param === "string" &&
					["bash", "glob", "exact"].includes(
						(matcher as Record<string, unknown>).type as string,
					)
				) {
					validMatchers[tool] = {
						param: (matcher as Record<string, unknown>).param as string,
						type: (matcher as Record<string, unknown>).type as
							| "bash"
							| "glob"
							| "exact",
					};
				} else {
					warnings.push(`Invalid matcher for tool "${tool}"`);
				}
			}
			matchers = validMatchers;
		} else {
			warnings.push(
				"matchers must be an object mapping tool names to matcher configs",
			);
		}
	}

	let rules: Rules = {};
	if (cfg.rules !== undefined) {
		if (
			typeof cfg.rules === "string" &&
			(cfg.rules === "allow" || cfg.rules === "ask" || cfg.rules === "deny")
		) {
			rules = cfg.rules;
		} else if (
			cfg.rules &&
			typeof cfg.rules === "object" &&
			!Array.isArray(cfg.rules)
		) {
			const validRules: Record<string, ToolRules> = {};
			for (const [tool, toolRules] of Object.entries(
				cfg.rules as Record<string, unknown>,
			)) {
				if (
					typeof toolRules === "string" &&
					(toolRules === "allow" || toolRules === "ask" || toolRules === "deny")
				) {
					validRules[tool] = toolRules;
				} else if (
					toolRules &&
					typeof toolRules === "object" &&
					!Array.isArray(toolRules)
				) {
					const { rules: validated, warnings: toolWarnings } =
						validateToolRules(toolRules);
					validRules[tool] = validated;
					warnings.push(...toolWarnings.map((w) => `Tool "${tool}": ${w}`));
				} else {
					warnings.push(`Invalid rules for tool "${tool}"`);
				}
			}
			rules = validRules;
		} else {
			warnings.push(
				'rules must be a single action ("allow"/"ask"/"deny") or an object mapping tool names to rules',
			);
		}
	}

	let profiles: Record<string, Profile> | undefined;
	if (cfg.profiles !== undefined) {
		if (
			cfg.profiles &&
			typeof cfg.profiles === "object" &&
			!Array.isArray(cfg.profiles)
		) {
			const validProfiles: Record<string, Profile> = {};
			for (const [profileName, profileRules] of Object.entries(
				cfg.profiles as Record<string, unknown>,
			)) {
				if (
					typeof profileRules === "string" &&
					(profileRules === "allow" ||
						profileRules === "ask" ||
						profileRules === "deny")
				) {
					validProfiles[profileName] = profileRules;
				} else if (
					profileRules &&
					typeof profileRules === "object" &&
					!Array.isArray(profileRules)
				) {
					const validRules: Record<string, ToolRules> = {};
					for (const [tool, toolRules] of Object.entries(
						profileRules as Record<string, unknown>,
					)) {
						if (
							typeof toolRules === "string" &&
							(toolRules === "allow" ||
								toolRules === "ask" ||
								toolRules === "deny")
						) {
							validRules[tool] = toolRules;
						} else if (
							toolRules &&
							typeof toolRules === "object" &&
							!Array.isArray(toolRules)
						) {
							const { rules: validated, warnings: toolWarnings } =
								validateToolRules(toolRules);
							validRules[tool] = validated;
							warnings.push(
								...toolWarnings.map(
									(w) => `Profile "${profileName}", tool "${tool}": ${w}`,
								),
							);
						} else {
							warnings.push(
								`Profile "${profileName}": Invalid rules for tool "${tool}"`,
							);
						}
					}
					validProfiles[profileName] = validRules;
				} else {
					warnings.push(
						`Profile "${profileName}": must be a single action or an object mapping tool names to rules`,
					);
				}
			}
			profiles = validProfiles;
		} else {
			warnings.push(
				"profiles must be an object mapping profile names to rules",
			);
		}
	}

	let shortcuts: Record<string, string> | undefined;
	if (cfg.shortcuts !== undefined) {
		if (
			cfg.shortcuts &&
			typeof cfg.shortcuts === "object" &&
			!Array.isArray(cfg.shortcuts)
		) {
			const validShortcuts: Record<string, string> = {};
			for (const [shortcut, target] of Object.entries(
				cfg.shortcuts as Record<string, unknown>,
			)) {
				if (typeof target === "string") {
					validShortcuts[shortcut] = target;
				} else {
					warnings.push(`Shortcut "${shortcut}": must be a string`);
				}
			}
			shortcuts = validShortcuts;
		} else {
			warnings.push(
				"shortcuts must be an object mapping shortcut names to profile names or 'off'",
			);
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
		return { config: { ...SAFE_FALLBACK_CONFIG } };
	}

	const settings = input as Record<string, unknown>;

	if (!Object.hasOwn(settings, "guard")) {
		return { config: { ...SAFE_FALLBACK_CONFIG } };
	}

	return validateLoadedGuardConfig(settings.guard);
}
