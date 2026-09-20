import { createHash } from "node:crypto";
import { DEFAULT_CONFIG } from "./defaults.ts";
import type {
	Action,
	GuardContext,
	PolicyLayer,
	PolicyLayerName,
	PolicySnapshot,
	RuleOrigin,
	RuleOverride,
	Rules,
	ToolRules,
	WinningRule,
} from "./types.ts";

const MATCHER_SEMANTICS = {
	bash: "Rules are checked in insertion order. The last matching command/pattern wins. Rule arguments are an ordered subsequence; * and ? inside tokens are globs.",
	glob: "Rules are checked in insertion order. The last matching path glob wins.",
	exact: "Rules are checked in insertion order. The last equal value wins.",
	precedence:
		"default -> user -> project -> environment -> profile -> session; later layers override earlier layers using the configured merge semantics.",
} as const;

interface ToolStateAction {
	kind: "action";
	action: Action;
	origin: RuleOrigin;
}

interface PatternState {
	action: Action;
	origin: RuleOrigin;
}

interface ToolStatePatterns {
	kind: "patterns";
	patterns: Map<string, PatternState>;
}

type ToolState = ToolStateAction | ToolStatePatterns;

function actionOrigin(
	layer: PolicyLayerName,
	action: Action,
	tool?: string,
	pattern?: string,
): RuleOrigin {
	return {
		layer,
		action,
		...(tool === undefined ? {} : { tool }),
		...(pattern === undefined ? {} : { pattern }),
	};
}

function rulesForProfile(context: GuardContext): Rules | undefined {
	if (!context.activeProfile) return undefined;
	return context.config.profiles?.[context.activeProfile];
}

function buildLayers(context: GuardContext): PolicyLayer[] {
	const profileRules = rulesForProfile(context);
	const sessionActive = Object.keys(context.sessionRules).length > 0;
	return [
		{ name: "default", active: true, rules: DEFAULT_CONFIG.rules },
		{ name: "user", active: true, rules: context.staticPolicy.userRules },
		{
			name: "project",
			active: context.staticPolicy.projectConfigPresent,
			...(context.staticPolicy.projectConfigPresent
				? { rules: context.staticPolicy.projectRules }
				: {}),
		},
		{
			name: "environment",
			active: context.staticPolicy.envRules !== undefined,
			...(context.staticPolicy.envRules === undefined
				? {}
				: { rules: context.staticPolicy.envRules }),
		},
		{
			name: "profile",
			active: profileRules !== undefined,
			...(profileRules === undefined ? {} : { rules: profileRules }),
		},
		{
			name: "session",
			active: sessionActive,
			...(sessionActive
				? { rules: context.sessionRules as unknown as Rules }
				: {}),
		},
	];
}

function recordToolReplacement(
	overrides: RuleOverride[],
	tool: string,
	previous: ToolState,
	replacement: RuleOrigin,
): void {
	if (previous.kind === "action") {
		overrides.push({
			scope: `tool:${tool}`,
			replaced: previous.origin,
			replacement,
		});
		return;
	}
	for (const [pattern, state] of previous.patterns) {
		overrides.push({
			scope: `tool:${tool}:pattern:${pattern}`,
			replaced: state.origin,
			replacement,
		});
	}
}

function mergeActionTool(
	state: Map<string, ToolState>,
	overrides: RuleOverride[],
	layer: PolicyLayer,
	tool: string,
	action: Action,
): void {
	const previous = state.get(tool);
	const origin = actionOrigin(layer.name, action, tool);
	if (previous) recordToolReplacement(overrides, tool, previous, origin);
	state.set(tool, { kind: "action", action, origin });
}

function initialPatternState(
	previous: ToolState | undefined,
	overrides: RuleOverride[],
	layer: PolicyLayer,
	tool: string,
	toolRules: Record<string, Action>,
): Map<string, PatternState> {
	if (previous?.kind === "patterns") return previous.patterns;
	const patterns = new Map<string, PatternState>();
	const firstEntry = Object.entries(toolRules)[0];
	if (!previous || !firstEntry) return patterns;

	const [pattern, action] = firstEntry;
	recordToolReplacement(
		overrides,
		tool,
		previous,
		actionOrigin(layer.name, action, tool, pattern),
	);
	return patterns;
}

function mergePatternTool(
	state: Map<string, ToolState>,
	overrides: RuleOverride[],
	layer: PolicyLayer,
	tool: string,
	toolRules: Record<string, Action>,
): void {
	const patterns = initialPatternState(
		state.get(tool),
		overrides,
		layer,
		tool,
		toolRules,
	);
	for (const [pattern, action] of Object.entries(toolRules)) {
		const origin = actionOrigin(layer.name, action, tool, pattern);
		const replaced = patterns.get(pattern);
		if (replaced) {
			overrides.push({
				scope: `tool:${tool}:pattern:${pattern}`,
				replaced: replaced.origin,
				replacement: origin,
			});
		}
		patterns.set(pattern, { action, origin });
	}
	state.set(tool, { kind: "patterns", patterns });
}

function mergeObjectLayer(
	state: Map<string, ToolState>,
	layer: PolicyLayer,
	overrides: RuleOverride[],
): void {
	const rules = layer.rules;
	if (!rules || typeof rules === "string") return;

	for (const [tool, toolRules] of Object.entries(rules)) {
		if (typeof toolRules === "string") {
			mergeActionTool(state, overrides, layer, tool, toolRules);
		} else {
			mergePatternTool(state, overrides, layer, tool, toolRules);
		}
	}
}

function originsFromLayer(layer: PolicyLayer): RuleOrigin[] {
	const rules = layer.rules;
	if (!layer.active || rules === undefined) return [];
	if (typeof rules === "string") return [actionOrigin(layer.name, rules)];

	const origins: RuleOrigin[] = [];
	for (const [tool, toolRules] of Object.entries(rules)) {
		if (typeof toolRules === "string") {
			origins.push(actionOrigin(layer.name, toolRules, tool));
			continue;
		}
		for (const [pattern, action] of Object.entries(toolRules)) {
			origins.push(actionOrigin(layer.name, action, tool, pattern));
		}
	}
	return origins;
}

function scopeForOrigin(origin: RuleOrigin): string {
	if (!origin.tool) return "global";
	if (!origin.pattern) return `tool:${origin.tool}`;
	return `tool:${origin.tool}:pattern:${origin.pattern}`;
}

function blanketOverrides(
	layers: PolicyLayer[],
	winnerIndex: number,
	winner: RuleOrigin,
): RuleOverride[] {
	return layers.flatMap((layer, index) =>
		index === winnerIndex
			? []
			: originsFromLayer(layer).map((replaced) => ({
					scope: scopeForOrigin(replaced),
					replaced,
					replacement: winner,
				})),
	);
}

function effectiveFromLayers(layers: PolicyLayer[]): {
	rules: Rules;
	origins: RuleOrigin[];
	overrides: RuleOverride[];
} {
	let blanket: { origin: RuleOrigin; layerIndex: number } | undefined;
	for (const [index, layer] of layers.entries()) {
		if (index === 0) continue;
		if (layer.active && typeof layer.rules === "string") {
			blanket = {
				origin: actionOrigin(layer.name, layer.rules),
				layerIndex: index,
			};
		}
	}
	if (blanket) {
		return {
			rules: blanket.origin.action,
			origins: [blanket.origin],
			overrides: blanketOverrides(layers, blanket.layerIndex, blanket.origin),
		};
	}

	const state = new Map<string, ToolState>();
	const overrides: RuleOverride[] = [];
	for (const layer of layers) {
		if (layer.active) mergeObjectLayer(state, layer, overrides);
	}

	const rules: Record<string, ToolRules> = {};
	const origins: RuleOrigin[] = [];
	for (const [tool, toolState] of state) {
		if (toolState.kind === "action") {
			rules[tool] = toolState.action;
			origins.push(toolState.origin);
			continue;
		}
		const patterns: Record<string, Action> = {};
		for (const [pattern, patternState] of toolState.patterns) {
			patterns[pattern] = patternState.action;
			origins.push(patternState.origin);
		}
		rules[tool] = patterns;
	}
	return { rules, origins, overrides };
}

function snapshotHash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(value))
		.digest("hex")
		.slice(0, 16);
}

export function buildPolicySnapshot(context: GuardContext): PolicySnapshot {
	const layers = buildLayers(context);
	const effective = effectiveFromLayers(layers);
	const guardEnabled = context.sessionEnabled ?? context.config.enabled;
	const snapshotBody = {
		guardEnabled,
		...(context.activeProfile ? { activeProfile: context.activeProfile } : {}),
		matchers: context.config.matchers ?? DEFAULT_CONFIG.matchers,
		layers,
		effectiveRules: effective.rules,
		effectiveOrigins: effective.origins,
		overrides: effective.overrides,
		exactSessionGrants: context.exactSessionGrants,
	};
	return {
		...snapshotBody,
		policyVersion: snapshotHash(snapshotBody),
		matcherSemantics: MATCHER_SEMANTICS,
	};
}

export function findRuleOrigin(
	snapshot: PolicySnapshot,
	tool: string,
	action: Action,
	pattern?: string,
): WinningRule | undefined {
	if (typeof snapshot.effectiveRules === "string") {
		const origin = snapshot.effectiveOrigins.find(
			(candidate) => candidate.tool === undefined,
		);
		return origin ? { ...origin, scope: "global" } : undefined;
	}
	const toolRules = snapshot.effectiveRules[tool];
	if (typeof toolRules === "string") {
		const origin = snapshot.effectiveOrigins.find(
			(candidate) =>
				candidate.tool === tool &&
				candidate.pattern === undefined &&
				candidate.action === action,
		);
		return origin ? { ...origin, scope: "tool" } : undefined;
	}
	if (pattern === undefined) return undefined;
	const origin = snapshot.effectiveOrigins.find(
		(candidate) =>
			candidate.tool === tool &&
			candidate.pattern === pattern &&
			candidate.action === action,
	);
	return origin ? { ...origin, scope: "pattern" } : undefined;
}

function filterRules(
	rules: Rules | undefined,
	tool: string | undefined,
	commandPrefix: string | undefined,
): Rules | undefined {
	if (!rules || typeof rules === "string") return rules;
	const filtered: Record<string, ToolRules> = {};
	for (const [toolName, toolRules] of Object.entries(rules)) {
		if (tool && toolName !== tool) continue;
		if (
			typeof toolRules === "string" ||
			!commandPrefix ||
			toolName !== "bash"
		) {
			filtered[toolName] = toolRules;
			continue;
		}
		const patterns = Object.fromEntries(
			Object.entries(toolRules).filter(([pattern]) =>
				pattern.startsWith(commandPrefix),
			),
		);
		if (Object.keys(patterns).length > 0) filtered[toolName] = patterns;
	}
	return filtered;
}

/** Filter snapshot presentation without recomputing or changing its decision. */
export function filterPolicySnapshot(
	snapshot: PolicySnapshot,
	filters: { tool?: string; commandPrefix?: string },
): PolicySnapshot {
	const { tool, commandPrefix } = filters;
	if (!tool && !commandPrefix) return snapshot;
	const layers = snapshot.layers.map((layer): PolicyLayer => {
		if (layer.rules === undefined) return { ...layer };
		const rules = filterRules(layer.rules, tool, commandPrefix);
		return rules === undefined
			? { name: layer.name, active: layer.active }
			: { ...layer, rules };
	});
	return {
		...snapshot,
		layers,
		effectiveRules:
			filterRules(snapshot.effectiveRules, tool, commandPrefix) ?? {},
		effectiveOrigins: snapshot.effectiveOrigins.filter(
			(origin) =>
				(!tool || origin.tool === undefined || origin.tool === tool) &&
				(!commandPrefix ||
					origin.pattern === undefined ||
					origin.pattern.startsWith(commandPrefix)),
		),
		overrides: snapshot.overrides.filter(
			(entry) =>
				(!tool ||
					entry.replaced.tool === tool ||
					entry.replacement.tool === tool) &&
				(!commandPrefix ||
					entry.replaced.pattern?.startsWith(commandPrefix) ||
					entry.replacement.pattern?.startsWith(commandPrefix)),
		),
		exactSessionGrants: snapshot.exactSessionGrants.filter((grant) => {
			if (tool && grant.tool !== tool) return false;
			if (!commandPrefix || grant.tool !== "bash") return true;
			const command = grant.input.command;
			return typeof command === "string" && command.startsWith(commandPrefix);
		}),
	};
}
