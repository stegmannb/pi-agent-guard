import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { DEFAULT_CONFIG } from "./defaults.ts";
import type { Action, GuardConfig } from "./types.ts";

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

// ── Validation ──

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
