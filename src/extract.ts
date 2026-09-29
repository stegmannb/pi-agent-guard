import "./loaded-code.ts";
import type {
	ArithmeticExpression,
	AssignmentPrefix,
	Command,
	CommandExpansionPart,
	Node,
	ParameterExpansionPart,
	ProcessSubstitutionPart,
	Redirect,
	Script,
	TestExpression,
	Word,
	WordPart,
} from "unbash";
import { parse as parseBash } from "unbash";
import type { CommandContext, CommandRef } from "./types.ts";

export type { CommandRef };

/** Mutable context for tracking group IDs during extraction. */
export interface ExtractCtx {
	nextGroupId: number;
	nextScopeId: number;
	context: CommandContext[];
	currentCommand?: CommandRef;
}

/** Create a new extraction context starting at groupId 0. */
export function createExtractCtx(): ExtractCtx {
	return { nextGroupId: 0, nextScopeId: 0, context: [] };
}

function withinContext(
	ctx: ExtractCtx,
	entry: CommandContext,
	visit: () => void,
) {
	ctx.context.push(entry);
	try {
		visit();
	} finally {
		ctx.context.pop();
	}
}

/** Allocate the next group ID from the context. */
function allocGroupId(ctx: ExtractCtx): number {
	return ctx.nextGroupId++;
}

/** Find the last CommandRef in commands that has the given group,
 *  searching from startIdx onward. Returns undefined if none found.
 *  This is used to assign joiners to the correct command when recursive
 *  extraction (e.g. subshells) has added commands from different groups. */
function findLastInGroup(
	commands: CommandRef[],
	groupId: number,
	startIdx: number,
): CommandRef | undefined {
	for (let i = commands.length - 1; i >= startIdx; i--) {
		if (commands[i]?.group === groupId) {
			return commands[i];
		}
	}
	return undefined;
}

export function extractAllCommandsFromAST(
	node: Script | Node,
	source: string,
	ctx?: ExtractCtx,
): CommandRef[] {
	const ownCtx = ctx ?? createExtractCtx();
	const topGroup = allocGroupId(ownCtx);
	const commands: CommandRef[] = [];
	collectNode(node, source, commands, topGroup, ownCtx);
	return commands;
}

function collectNode(
	node: Script | Node | undefined,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (!node) return;
	const t = node.type;
	if (
		t === "Script" ||
		t === "CompoundList" ||
		t === "Pipeline" ||
		t === "AndOr"
	) {
		collectCompoundOrChain(node, source, commands, groupId, ctx);
		return;
	}
	if (
		t === "If" ||
		t === "While" ||
		t === "For" ||
		t === "Select" ||
		t === "Case"
	) {
		collectControlFlow(node, source, commands, groupId, ctx);
		return;
	}
	collectRemaining(node, source, commands, groupId, ctx);
}

/** Handle Script, CompoundList, Pipeline, and AndOr node types. */
function collectCompoundOrChain(
	node: Script | Node,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	switch (node.type) {
		case "Script":
		case "CompoundList":
			collectSequential(node.commands, source, commands, groupId, ctx);
			return;
		case "Pipeline":
		case "AndOr":
			collectChained(
				node.commands,
				node.operators,
				source,
				commands,
				groupId,
				ctx,
			);
			return;
	}
}

function collectSequential(
	children: Node[],
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	for (const [index, child] of children.entries()) {
		const startIdx = commands.length;
		collectNode(child, source, commands, groupId, ctx);
		const joinerTarget = findLastInGroup(commands, groupId, startIdx);
		if (!joinerTarget) continue;
		if (child.type === "Statement" && child.background)
			joinerTarget.joiner = "&";
		else if (index < children.length - 1) joinerTarget.joiner = ";";
	}
}

function collectChained(
	children: Node[],
	operators: string[],
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	for (const [index, child] of children.entries()) {
		const startIdx = commands.length;
		collectNode(child, source, commands, groupId, ctx);
		const joinerTarget = findLastInGroup(commands, groupId, startIdx);
		const op = operators[index];
		if (op !== undefined && joinerTarget) {
			joinerTarget.joiner = op as "|" | "|&" | "&&" | "||";
		}
	}
}

/** Handle If, While, For, Select, and Case node types. */
function collectControlFlow(
	node: Script | Node,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	switch (node.type) {
		case "If":
			collectNode(node.clause, source, commands, groupId, ctx);
			collectNode(node.then, source, commands, groupId, ctx);
			if (node.else) collectNode(node.else, source, commands, groupId, ctx);
			return;

		case "While":
			collectNode(node.clause, source, commands, groupId, ctx);
			collectNode(node.body, source, commands, groupId, ctx);
			return;

		case "For":
			collectWord(node.name, source, commands, groupId, ctx);
			for (const word of node.wordlist) {
				collectWord(word, source, commands, groupId, ctx);
			}
			collectNode(node.body, source, commands, groupId, ctx);
			return;

		case "Select":
			collectWord(node.name, source, commands, groupId, ctx);
			for (const word of node.wordlist) {
				collectWord(word, source, commands, groupId, ctx);
			}
			collectNode(node.body, source, commands, groupId, ctx);
			return;

		case "Case":
			collectWord(node.word, source, commands, groupId, ctx);
			for (const item of node.items) {
				collectCaseItem(item, source, commands, groupId, ctx);
			}
			return;
	}
}

/** Handle remaining node types: Statement, Command, Subshell, BraceGroup,
 *  Function, Coproc, TestCommand, ArithmeticFor, ArithmeticCommand. */
function collectRemaining(
	node: Script | Node,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	switch (node.type) {
		case "Statement":
			collectNode(node.command, source, commands, groupId, ctx);
			for (const redirect of node.redirects) {
				collectRedirect(redirect, source, commands, groupId, ctx);
			}
			return;

		case "Command":
			collectCommand(node, source, commands, groupId, ctx);
			return;

		case "Subshell":
		case "BraceGroup":
			withinContext(
				ctx,
				{
					kind: node.type === "Subshell" ? "subshell" : "brace-group",
					scopeId: ctx.nextScopeId++,
				},
				() => collectNode(node.body, source, commands, groupId, ctx),
			);
			return;

		case "Function":
			collectWord(node.name, source, commands, groupId, ctx);
			collectNode(node.body, source, commands, groupId, ctx);
			for (const redirect of node.redirects) {
				collectRedirect(redirect, source, commands, groupId, ctx);
			}
			return;

		case "Coproc":
			if (node.name) collectWord(node.name, source, commands, groupId, ctx);
			collectNode(node.body, source, commands, groupId, ctx);
			for (const redirect of node.redirects) {
				collectRedirect(redirect, source, commands, groupId, ctx);
			}
			return;

		case "TestCommand":
			collectTestExpression(node.expression, source, commands, groupId, ctx);
			return;

		case "ArithmeticFor":
			collectArithmeticExpression(
				node.initialize,
				source,
				commands,
				groupId,
				ctx,
			);
			collectArithmeticExpression(node.test, source, commands, groupId, ctx);
			collectArithmeticExpression(node.update, source, commands, groupId, ctx);
			collectNode(node.body, source, commands, groupId, ctx);
			return;

		case "ArithmeticCommand":
			collectArithmeticExpression(
				node.expression,
				source,
				commands,
				groupId,
				ctx,
			);
			return;
	}
}

function collectCommand(
	node: Command,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	const previousCommand = ctx.currentCommand;
	if (node.name || node.prefix.length > 0) {
		const command: CommandRef = {
			node,
			source,
			group: groupId,
			...(ctx.context.length > 0 ? { context: [...ctx.context] } : {}),
		};
		commands.push(command);
		ctx.currentCommand = command;
	}

	for (const prefix of node.prefix) {
		collectAssignment(prefix, source, commands, groupId, ctx);
	}

	for (const word of node.suffix) {
		collectWord(word, source, commands, groupId, ctx);
	}

	for (const redirect of node.redirects) {
		collectRedirect(redirect, source, commands, groupId, ctx);
	}
	if (previousCommand) ctx.currentCommand = previousCommand;
	else delete ctx.currentCommand;
}

function collectAssignment(
	assignment: AssignmentPrefix,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (assignment.value) {
		collectWord(assignment.value, source, commands, groupId, ctx);
	}

	if (assignment.array) {
		for (const word of assignment.array) {
			collectWord(word, source, commands, groupId, ctx);
		}
	}
}

function collectRedirect(
	redirect: Redirect,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (redirect.target) {
		collectWord(redirect.target, source, commands, groupId, ctx);
	}

	if (redirect.body?.parts) {
		collectWord(redirect.body, source, commands, groupId, ctx);
	}
}

function collectWord(
	word: Word | undefined,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (!word?.parts) return;
	for (const part of word.parts) {
		collectWordPart(part, source, commands, groupId, ctx);
	}
}

function collectWordPart(
	part: WordPart | CommandExpansionPart | ProcessSubstitutionPart,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	switch (part.type) {
		case "DoubleQuoted":
		case "LocaleString":
			for (const child of part.parts) {
				collectWordPart(child, source, commands, groupId, ctx);
			}
			return;

		case "CommandExpansion":
		case "ProcessSubstitution": {
			// Commands inside expansions get their own group
			const expansionGroup = allocGroupId(ctx);
			if (part.script) {
				withinContext(
					ctx,
					{
						kind:
							part.type === "CommandExpansion"
								? "command-substitution"
								: "process-substitution",
						...(ctx.currentCommand ? { parent: ctx.currentCommand } : {}),
					},
					() =>
						collectNode(
							part.script,
							expansionSource(part, source),
							commands,
							expansionGroup,
							ctx,
						),
				);
			}
			return;
		}

		case "ParameterExpansion":
			collectParameterExpansion(part, source, commands, groupId, ctx);
			return;

		case "ArithmeticExpansion":
			collectArithmeticExpression(
				part.expression,
				source,
				commands,
				groupId,
				ctx,
			);
			return;

		default:
			return;
	}
}

function collectParameterExpansion(
	part: ParameterExpansionPart,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (part.operand) {
		collectWord(part.operand, source, commands, groupId, ctx);
	}

	if (part.slice) {
		collectWord(part.slice.offset, source, commands, groupId, ctx);
		if (part.slice.length) {
			collectWord(part.slice.length, source, commands, groupId, ctx);
		}
	}

	if (part.replace) {
		collectWord(part.replace.pattern, source, commands, groupId, ctx);
		collectWord(part.replace.replacement, source, commands, groupId, ctx);
	}
}

function expansionSource(
	part: CommandExpansionPart | ProcessSubstitutionPart,
	fallbackSource: string,
): string {
	if (part.inner != null) return part.inner;

	const text = part.text;
	if (text.startsWith("$(") && text.endsWith(")")) {
		return text.slice(2, -1);
	}
	if ((text.startsWith("<(") || text.startsWith(">(")) && text.endsWith(")")) {
		return text.slice(2, -1);
	}
	if (text.startsWith("`") && text.endsWith("`")) {
		return text.slice(1, -1);
	}

	return fallbackSource;
}

function collectCaseItem(
	item: { pattern: Word[]; body: Node },
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	for (const pattern of item.pattern) {
		collectWord(pattern, source, commands, groupId, ctx);
	}
	collectNode(item.body, source, commands, groupId, ctx);
}

function collectTestExpression(
	expr: TestExpression,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	switch (expr.type) {
		case "TestUnary":
			collectWord(expr.operand, source, commands, groupId, ctx);
			return;
		case "TestBinary":
			collectWord(expr.left, source, commands, groupId, ctx);
			collectWord(expr.right, source, commands, groupId, ctx);
			return;
		case "TestLogical":
			collectTestExpression(expr.left, source, commands, groupId, ctx);
			collectTestExpression(expr.right, source, commands, groupId, ctx);
			return;
		case "TestNot":
			collectTestExpression(expr.operand, source, commands, groupId, ctx);
			return;
		case "TestGroup":
			collectTestExpression(expr.expression, source, commands, groupId, ctx);
			return;
	}
}

function collectArithmeticExpression(
	expr: ArithmeticExpression | undefined,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (!expr) return;

	switch (expr.type) {
		case "ArithmeticBinary":
			collectArithmeticExpression(expr.left, source, commands, groupId, ctx);
			collectArithmeticExpression(expr.right, source, commands, groupId, ctx);
			return;
		case "ArithmeticUnary":
			collectArithmeticExpression(expr.operand, source, commands, groupId, ctx);
			return;
		case "ArithmeticTernary":
			collectArithmeticExpression(expr.test, source, commands, groupId, ctx);
			collectArithmeticExpression(
				expr.consequent,
				source,
				commands,
				groupId,
				ctx,
			);
			collectArithmeticExpression(
				expr.alternate,
				source,
				commands,
				groupId,
				ctx,
			);
			return;
		case "ArithmeticGroup":
			collectArithmeticExpression(
				expr.expression,
				source,
				commands,
				groupId,
				ctx,
			);
			return;
		case "ArithmeticCommandExpansion":
			collectArithmeticCommandExpansion(expr, commands, ctx);
			return;
		case "ArithmeticWord":
			return;
	}
}

function collectArithmeticCommandExpansion(
	expr: Extract<ArithmeticExpression, { type: "ArithmeticCommandExpansion" }>,
	commands: CommandRef[],
	ctx: ExtractCtx,
) {
	const expansionGroup = allocGroupId(ctx);
	const source =
		expr.text.startsWith("$(") && expr.text.endsWith(")")
			? expr.text.slice(2, -1)
			: expr.text;
	const script =
		expr.script ?? (expr.inner ? parseBash(expr.inner) : undefined);
	if (!script) return;
	withinContext(
		ctx,
		{
			kind: "arithmetic-command-substitution",
			...(ctx.currentCommand ? { parent: ctx.currentCommand } : {}),
		},
		() =>
			collectNode(
				script,
				expr.script ? source : (expr.inner ?? ""),
				commands,
				expansionGroup,
				ctx,
			),
	);
}
