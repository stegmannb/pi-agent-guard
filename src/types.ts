import type { Command } from "unbash";

/** A concrete command node together with the source string its positions refer to. */
export interface CommandRef {
	node: Command;
	source: string;
	/** Group ID: commands in the same group are connected by operators
	 * and displayed together. Different groups are separated by blank lines. */
	group: number;
	/** The operator connecting this command to the next ("|", "&&", "||", or ";").
	 * Undefined for the last command in a group. */
	joiner?: "|" | "&&" | "||" | ";";
}

/** Matcher types define how to extract and match input from a tool call. */
export type MatcherType = "bash" | "glob" | "exact";

/** Defines how to extract and match input from a tool call. */
export interface Matcher {
	/** Tool parameter to extract (e.g., "command", "path", "url") */
	param: string;
	/** How to match the extracted value */
	type: MatcherType;
}

/** Permission actions. */
export type Action = "allow" | "ask" | "deny";

/** Rules for a single tool - can be a single action or pattern-based rules. */
export type ToolRules = Action | Record<string, Action>;

/** All rules organized by tool name. */
export type Rules = Action | Record<string, ToolRules>;

/** Custom matchers for additional tools. */
export type Matchers = Record<string, Matcher>;

/** Named profile with rule overrides. */
export type Profile = Rules;

/** Configuration sources captured when the extension starts. */
export interface StaticPolicySources {
	userRules: Rules;
	projectRules: Rules;
	envRules: Rules | undefined;
	projectConfigPresent: boolean;
}

/** Mutable session state layered over the startup policy sources. */
export interface GuardContext {
	config: GuardConfig;
	staticPolicy: StaticPolicySources;
	activeProfile: string | undefined;
	sessionRules: Record<string, Record<string, Action>>;
	/** Exact grants are created by approval UI in a later feature. */
	exactSessionGrants: ExactSessionGrant[];
	/** Session-only enabled override; undefined means use the startup config. */
	sessionEnabled?: boolean;
}

/** Full configuration for pi-guard. */
export interface GuardConfig {
	enabled: boolean;
	matchers?: Matchers;
	rules: Rules;
	profiles?: Record<string, Profile>;
	shortcuts?: Record<string, string | undefined>;
}

/** Result of a permission check. */
export interface PermissionResult {
	/** Whether to block the tool call */
	block: boolean;
	/** Human-readable reason for the decision */
	reason?: string;
	/** Context to inject into the tool result */
	context?: string;
}

/** Tool call event shape for type-safe matching. */
export interface ToolCallInput {
	[key: string]: unknown;
}

/** A session-only grant that preserves its exact tool, input, and directory scope. */
export interface ExactSessionGrant {
	tool: string;
	input: ToolCallInput;
	cwd: string;
}

export type PolicyLayerName =
	| "default"
	| "user"
	| "project"
	| "environment"
	| "profile"
	| "session";

export interface PolicyLayer {
	name: PolicyLayerName;
	active: boolean;
	rules?: Rules;
}

export interface RuleOrigin {
	layer: PolicyLayerName;
	tool?: string;
	pattern?: string;
	action: Action;
}

export interface RuleOverride {
	scope: string;
	replaced: RuleOrigin;
	replacement: RuleOrigin;
}

export interface MatcherSemantics {
	bash: string;
	glob: string;
	exact: string;
	precedence: string;
}

/** Complete policy state used by execution and read-only inspection. */
export interface PolicySnapshot {
	guardEnabled: boolean;
	policyVersion: string;
	activeProfile?: string;
	matchers: Matchers;
	matcherSemantics: MatcherSemantics;
	layers: PolicyLayer[];
	effectiveRules: Rules;
	effectiveOrigins: RuleOrigin[];
	overrides: RuleOverride[];
	exactSessionGrants: ExactSessionGrant[];
}

export interface WinningRule extends RuleOrigin {
	scope: "global" | "tool" | "pattern";
}

export interface BashCommandEvaluation {
	command: string;
	name: string;
	args: string[];
	action: Action;
	bareAssignment: boolean;
	winningRule?: WinningRule;
}

export type EnforcementDisposition = "allow" | "ask" | "deny" | "bypass";

/** Serializable result returned by guard_check and consumed by enforcement. */
export interface GuardEvaluation {
	tool: string;
	input: ToolCallInput;
	guardEnabled: boolean;
	policyVersion: string;
	cwd?: string;
	patternAction: Action;
	disposition: EnforcementDisposition;
	reviewEligible: boolean;
	winningRule?: WinningRule;
	exactSessionGrant?: ExactSessionGrant;
	commands?: BashCommandEvaluation[];
	parserError?: string;
	inputError?: string;
}
