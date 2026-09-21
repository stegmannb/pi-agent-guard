import { buildPolicySnapshot } from "./policy.ts";
import type {
	GuardContext,
	PolicyLayer,
	PolicySnapshot,
	Rules,
} from "./types.ts";

export function parseGuardArgs(args: string): {
	action: string;
	target: string;
} {
	const trimmed = args.trim();
	if (!trimmed) return { action: "", target: "" };
	const [action = "", ...targetParts] = trimmed.split(/\s+/);
	return { action, target: targetParts.join(" ").trim() };
}

function handleProfileCommand(
	context: GuardContext,
	target: string | undefined,
): { message: string; type: "info" | "warning" } {
	const profiles = context.config.profiles ?? {};
	const profileNames = Object.keys(profiles);
	if (!target) {
		return {
			message: context.activeProfile
				? `Active profile: ${context.activeProfile}\n\nAvailable profiles: ${profileNames.join(", ") || "(none)"}\n\nUse /guard profile <name> to activate\nUse /guard profile off to deactivate`
				: `No profile active\n\nAvailable profiles: ${profileNames.join(", ") || "(none)"}\n\nUse /guard profile <name> to activate`,
			type: "info",
		};
	}
	if (target === "off") {
		context.activeProfile = undefined;
		return { message: "Profile deactivated", type: "info" };
	}
	if (!(target in profiles)) {
		return {
			message: `Unknown profile: ${target}\n\nAvailable profiles: ${profileNames.join(", ") || "(none)"}`,
			type: "warning",
		};
	}
	context.activeProfile = target;
	return { message: `Profile activated: ${target}`, type: "info" };
}

function handleToggleCommand(context: GuardContext): string {
	const current = context.sessionEnabled ?? context.config.enabled;
	context.sessionEnabled = !current;
	return `pi-guard is now ${context.sessionEnabled ? "ENABLED" : "DISABLED"} (session only)`;
}

function formatRules(rules: Rules | undefined, indent: string): string[] {
	if (rules === undefined) return [`${indent}(inactive)`];
	if (typeof rules === "string") return [`${indent}${rules}`];
	if (Object.keys(rules).length === 0) return [`${indent}(no rules)`];
	const lines: string[] = [];
	for (const [tool, toolRules] of Object.entries(rules)) {
		if (typeof toolRules === "string") {
			lines.push(`${indent}${tool}: ${toolRules}`);
			continue;
		}
		lines.push(`${indent}${tool}:`);
		for (const [pattern, action] of Object.entries(toolRules)) {
			lines.push(`${indent}  ${pattern}: ${action}`);
		}
	}
	return lines;
}

function formatLayer(layer: PolicyLayer): string[] {
	return [
		`${layer.name}${layer.active ? "" : " (inactive)"}:`,
		...formatRules(layer.rules, "  "),
		"",
	];
}

export function buildListOutput(snapshot: PolicySnapshot): string {
	const lines = [
		`pi-guard: ${snapshot.guardEnabled ? "ENABLED" : "DISABLED"}`,
		`Policy version: ${snapshot.policyVersion}`,
		...(snapshot.activeProfile ? [`Profile: ${snapshot.activeProfile}`] : []),
		"",
		"Layers (low to high precedence):",
	];
	for (const layer of snapshot.layers) lines.push(...formatLayer(layer));
	lines.push(
		"Effective policy:",
		...formatRules(snapshot.effectiveRules, "  "),
	);
	lines.push("", "Effective origins:");
	for (const origin of snapshot.effectiveOrigins) {
		const scope =
			[origin.tool, origin.pattern].filter(Boolean).join(" / ") || "*";
		lines.push(`  ${scope}: ${origin.action} [${origin.layer}]`);
	}
	if (snapshot.overrides.length > 0) {
		lines.push("", "Overrides:");
		for (const override of snapshot.overrides) {
			lines.push(
				`  ${override.scope}: ${override.replaced.layer}/${override.replaced.action} -> ${override.replacement.layer}/${override.replacement.action}`,
			);
		}
	}
	if (snapshot.exactSessionGrants.length > 0) {
		lines.push("", "Exact session grants:");
		for (const grant of snapshot.exactSessionGrants) {
			lines.push(
				`  ${grant.tool} @ ${grant.cwd}: ${JSON.stringify(grant.input)}`,
			);
		}
	}
	return lines.join("\n");
}

export function handleGuardCommand(
	action: string,
	target: string | undefined,
	context: GuardContext,
): { message: string; type: "info" | "warning" } {
	if (action === "profile") return handleProfileCommand(context, target);
	if (action === "list") {
		return {
			message: buildListOutput(buildPolicySnapshot(context)),
			type: "info",
		};
	}
	if (action === "toggle") {
		return { message: handleToggleCommand(context), type: "info" };
	}
	return {
		message: "Usage: /guard <profile|list|toggle|model>",
		type: "warning",
	};
}
