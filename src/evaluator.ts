import { isDeepStrictEqual } from "node:util";
import { parse as parseBash, type Script } from "unbash";
import { extractAllCommandsFromAST } from "./extract.ts";
import { formatCommand } from "./format.ts";
import {
	resolveBashRule,
	resolveExactRule,
	resolveGlobRule,
} from "./matching.ts";
import { findRuleOrigin } from "./policy.ts";
import { getCommandArgs, getCommandName, isBareAssignment } from "./resolve.ts";
import type {
	Action,
	BashCommandEvaluation,
	CommandRef,
	ExactSessionGrant,
	GuardEvaluation,
	Matcher,
	PolicySnapshot,
	ToolCallInput,
	WinningRule,
} from "./types.ts";
import { expandWrapperCommands } from "./wrappers.ts";

interface ParserDiagnostic {
	message: string;
	pos: number;
}

type ParsedScript = Script & { errors?: ParserDiagnostic[] };

interface ParsedCommand {
	ast: ParsedScript;
	parserErrors: string[];
}

export interface EvaluatedToolCall {
	result: GuardEvaluation;
	bash?: {
		allCommands: CommandRef[];
		expandedWrappers: Set<CommandRef>;
		askCommands: CommandRef[];
	};
}

interface EvaluatedBashCommand {
	reference: CommandRef;
	result: BashCommandEvaluation;
}

function disposition(
	snapshot: PolicySnapshot,
	action: Action,
): GuardEvaluation["disposition"] {
	return snapshot.guardEnabled ? action : "bypass";
}

function directEvaluation(
	snapshot: PolicySnapshot,
	tool: string,
	input: ToolCallInput,
	action: Action,
	winningRule?: WinningRule,
): EvaluatedToolCall {
	return {
		result: {
			tool,
			input,
			guardEnabled: snapshot.guardEnabled,
			policyVersion: snapshot.policyVersion,
			patternAction: action,
			disposition: disposition(snapshot, action),
			reviewEligible: false,
			...(winningRule ? { winningRule } : {}),
		},
	};
}

function parserFailure(
	snapshot: PolicySnapshot,
	tool: string,
	input: ToolCallInput,
	message: string,
	action: Action,
): EvaluatedToolCall {
	return {
		result: {
			tool,
			input,
			guardEnabled: snapshot.guardEnabled,
			policyVersion: snapshot.policyVersion,
			patternAction: action,
			disposition: disposition(snapshot, action),
			reviewEligible: false,
			parserError: message,
		},
	};
}

function evaluateBashCommand(
	snapshot: PolicySnapshot,
	tool: string,
	command: CommandRef,
	rules: Action | Record<string, Action>,
): EvaluatedBashCommand {
	const bareAssignment = isBareAssignment(command);
	const name = getCommandName(command);
	const args = getCommandArgs(command);
	const resolution =
		bareAssignment || typeof rules === "string"
			? undefined
			: resolveBashRule(name, args, rules);
	const action: Action =
		typeof rules === "string"
			? rules
			: bareAssignment
				? "allow"
				: (resolution?.action ?? "ask");
	const winningRule =
		typeof rules === "string"
			? findRuleOrigin(snapshot, tool, action)
			: bareAssignment
				? undefined
				: resolution
					? findRuleOrigin(snapshot, tool, action, resolution.pattern)
					: undefined;
	return {
		reference: command,
		result: {
			command: formatCommand(command),
			name,
			args,
			action,
			bareAssignment,
			...(winningRule ? { winningRule } : {}),
		},
	};
}

function overallAction(commands: EvaluatedBashCommand[]): Action {
	if (commands.some(({ result }) => result.action === "deny")) return "deny";
	if (commands.some(({ result }) => result.action === "ask")) return "ask";
	return "allow";
}

function decisiveRule(
	commands: EvaluatedBashCommand[],
	action: Action,
): WinningRule | undefined {
	return commands.find(({ result }) => result.action === action)?.result
		.winningRule;
}

function isReviewEligible(
	tool: string,
	commands: EvaluatedBashCommand[],
	action: Action,
): boolean {
	if (tool !== "bash" || action !== "ask") return false;
	const asks = commands.filter(({ result }) => result.action === "ask");
	return (
		asks.length > 0 &&
		asks.every(
			({ result }) =>
				result.winningRule?.scope === "pattern" &&
				result.winningRule.pattern === "*",
		)
	);
}

function parseCommand(
	snapshot: PolicySnapshot,
	tool: string,
	input: ToolCallInput,
	rawCommand: string,
	fallbackAction: Action,
): ParsedCommand | EvaluatedToolCall {
	let ast: ParsedScript;
	try {
		ast = parseBash(rawCommand) as ParsedScript;
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown parser error";
		return parserFailure(snapshot, tool, input, message, fallbackAction);
	}
	const diagnostics = ast.errors ?? [];
	return {
		ast,
		parserErrors: diagnostics.map(
			(diagnostic) => `${diagnostic.message} at ${diagnostic.pos}`,
		),
	};
}

function evaluateBash(
	snapshot: PolicySnapshot,
	tool: string,
	input: ToolCallInput,
	rawCommand: string,
	rules: Action | Record<string, Action>,
): EvaluatedToolCall {
	const fallbackAction = typeof rules === "string" ? rules : "ask";
	const parsed = parseCommand(
		snapshot,
		tool,
		input,
		rawCommand,
		fallbackAction,
	);
	if ("result" in parsed) return parsed;
	const {
		commands: allCommands,
		expandedWrappers,
		parserErrors,
	} = expandWrapperCommands(extractAllCommandsFromAST(parsed.ast, rawCommand));
	const evaluatedCommands = allCommands.map((command) =>
		evaluateBashCommand(snapshot, tool, command, rules),
	);
	const askCommands = evaluatedCommands
		.filter(({ result }) => result.action === "ask")
		.map(({ reference }) => reference);
	const parserError = [...parsed.parserErrors, ...parserErrors].join("; ");
	const knownAction = overallAction(evaluatedCommands);
	if (parserError && knownAction === "deny") {
		const winningRule = decisiveRule(evaluatedCommands, "deny");
		return {
			result: {
				tool,
				input,
				guardEnabled: snapshot.guardEnabled,
				policyVersion: snapshot.policyVersion,
				patternAction: "deny",
				disposition: disposition(snapshot, "deny"),
				reviewEligible: false,
				...(winningRule ? { winningRule } : {}),
				commands: evaluatedCommands.map(({ result }) => result),
				parserError,
			},
			bash: { allCommands, expandedWrappers, askCommands },
		};
	}
	if (parserError) {
		return parserFailure(snapshot, tool, input, parserError, fallbackAction);
	}

	if (allCommands.length === 0) {
		const emptyAction = typeof rules === "string" ? rules : "allow";
		const winningRule =
			typeof rules === "string"
				? findRuleOrigin(snapshot, tool, emptyAction)
				: undefined;
		return {
			result: {
				tool,
				input,
				guardEnabled: snapshot.guardEnabled,
				policyVersion: snapshot.policyVersion,
				patternAction: emptyAction,
				disposition: disposition(snapshot, emptyAction),
				reviewEligible: false,
				...(winningRule ? { winningRule } : {}),
				inputError: "The command did not contain an executable command node.",
			},
			bash: { allCommands, expandedWrappers, askCommands },
		};
	}

	const patternAction = overallAction(evaluatedCommands);
	const winningRule = decisiveRule(evaluatedCommands, patternAction);
	return {
		result: {
			tool,
			input,
			guardEnabled: snapshot.guardEnabled,
			policyVersion: snapshot.policyVersion,
			patternAction,
			disposition: disposition(snapshot, patternAction),
			reviewEligible: isReviewEligible(tool, evaluatedCommands, patternAction),
			...(winningRule ? { winningRule } : {}),
			commands: evaluatedCommands.map(({ result }) => result),
		},
		bash: { allCommands, expandedWrappers, askCommands },
	};
}

function evaluateBashInput(
	snapshot: PolicySnapshot,
	tool: string,
	input: ToolCallInput,
	param: string,
	rules: Action | Record<string, Action>,
): EvaluatedToolCall {
	const value = input[param];
	if (typeof value === "string" && value.trim() !== "") {
		return evaluateBash(snapshot, tool, input, value, rules);
	}
	const evaluated = directEvaluation(
		snapshot,
		tool,
		input,
		typeof rules === "string" ? rules : "allow",
		typeof rules === "string"
			? findRuleOrigin(snapshot, tool, rules)
			: undefined,
	);
	evaluated.result.inputError = `Expected a non-empty string in input.${param}.`;
	return evaluated;
}

function evaluateActionToolCall(
	snapshot: PolicySnapshot,
	tool: string,
	input: ToolCallInput,
	action: Action,
	matcher: Matcher | undefined,
): EvaluatedToolCall {
	if (matcher?.type === "bash") {
		return evaluateBashInput(snapshot, tool, input, matcher.param, action);
	}
	return directEvaluation(
		snapshot,
		tool,
		input,
		action,
		findRuleOrigin(snapshot, tool, action),
	);
}

function evaluatePatternToolCall(
	snapshot: PolicySnapshot,
	tool: string,
	input: ToolCallInput,
): EvaluatedToolCall {
	const effectiveRules = snapshot.effectiveRules;
	const matcher = snapshot.matchers[tool];
	if (typeof effectiveRules === "string") {
		return evaluateActionToolCall(
			snapshot,
			tool,
			input,
			effectiveRules,
			matcher,
		);
	}

	const toolRules = effectiveRules[tool];
	if (typeof toolRules === "string") {
		return evaluateActionToolCall(snapshot, tool, input, toolRules, matcher);
	}
	if (!toolRules) return directEvaluation(snapshot, tool, input, "allow");

	if (!matcher) {
		const action = toolRules["*"] ?? "allow";
		const winner = toolRules["*"]
			? findRuleOrigin(snapshot, tool, action, "*")
			: undefined;
		return directEvaluation(snapshot, tool, input, action, winner);
	}

	if (matcher.type === "bash") {
		return evaluateBashInput(snapshot, tool, input, matcher.param, toolRules);
	}
	const value = input[matcher.param];
	if (typeof value !== "string" || value.trim() === "") {
		const evaluated = directEvaluation(snapshot, tool, input, "allow");
		evaluated.result.inputError = `Expected a non-empty string in input.${matcher.param}.`;
		return evaluated;
	}
	const resolution =
		matcher.type === "glob"
			? resolveGlobRule(value, toolRules)
			: resolveExactRule(value, toolRules);
	const action = resolution?.action ?? "ask";
	const winner = resolution
		? findRuleOrigin(snapshot, tool, action, resolution.pattern)
		: undefined;
	return directEvaluation(snapshot, tool, input, action, winner);
}

function exactSessionGrant(
	snapshot: PolicySnapshot,
	tool: string,
	input: ToolCallInput,
	cwd: string | undefined,
): ExactSessionGrant | undefined {
	if (!cwd) return undefined;
	return snapshot.exactSessionGrants.find(
		(grant) =>
			grant.tool === tool &&
			grant.cwd === cwd &&
			isDeepStrictEqual(grant.input, input),
	);
}

export function evaluateToolCall(
	snapshot: PolicySnapshot,
	tool: string,
	input: ToolCallInput,
	cwd?: string,
): EvaluatedToolCall {
	const evaluated = evaluatePatternToolCall(snapshot, tool, input);
	if (cwd) evaluated.result.cwd = cwd;
	if (
		!snapshot.guardEnabled ||
		evaluated.result.disposition !== "ask" ||
		evaluated.result.parserError
	) {
		return evaluated;
	}
	const grant = exactSessionGrant(snapshot, tool, input, cwd);
	if (!grant) return evaluated;
	evaluated.result.disposition = "allow";
	evaluated.result.reviewEligible = false;
	evaluated.result.exactSessionGrant = grant;
	return evaluated;
}
