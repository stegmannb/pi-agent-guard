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
import type { CommandRef } from "./types.ts";

export type { CommandRef };

/** Mutable context for tracking group IDs during extraction. */
export interface ExtractCtx {
	nextGroupId: number;
}

/** Create a new extraction context starting at groupId 0. */
export function createExtractCtx(): ExtractCtx {
	return { nextGroupId: 0 };
}

/** Allocate the next group ID from the context. */
function allocGroupId(ctx: ExtractCtx): number {
	return ctx.nextGroupId++;
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

	switch (node.type) {
		case "Script":
		case "CompoundList": {
			for (const [i, child] of node.commands.entries()) {
				const startIdx = commands.length;
				collectNode(child, source, commands, groupId, ctx);
				const lastCmd = commands[commands.length - 1];
				// Set ; joiner on last command from each child except the last
				if (
					i < node.commands.length - 1 &&
					commands.length > startIdx &&
					lastCmd
				) {
					lastCmd.joiner = ";";
				}
			}
			return;
		}

		case "Pipeline":
		case "AndOr": {
			for (const [i, child] of node.commands.entries()) {
				const startIdx = commands.length;
				collectNode(child, source, commands, groupId, ctx);
				const lastCmd = commands[commands.length - 1];
				const op = node.operators[i];
				// Set operator joiner on last command from each child
				if (op !== undefined && commands.length > startIdx && lastCmd) {
					lastCmd.joiner = op as "|" | "&&" | "||";
				}
			}
			return;
		}

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
			collectNode(node.body, source, commands, groupId, ctx);
			return;

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
	if (node.name) {
		commands.push({ node, source, group: groupId });
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
				collectNode(
					part.script,
					expansionSource(part, source),
					commands,
					expansionGroup,
					ctx,
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
		case "ArithmeticCommandExpansion": {
			// Commands inside arithmetic expansions get their own group
			const expansionGroup = allocGroupId(ctx);
			if (expr.script) {
				// Extract inner source from text like "$(cmd)" -> "cmd"
				const innerSource =
					expr.text.startsWith("$(") && expr.text.endsWith(")")
						? expr.text.slice(2, -1)
						: expr.text;
				collectArithmeticCommands(
					expr.script,
					innerSource,
					commands,
					expansionGroup,
					ctx,
				);
			} else if (expr.inner) {
				// Parse the inner text and collect commands (for double-quoted context)
				const innerAst = parseBash(expr.inner);
				collectArithmeticCommands(
					innerAst,
					expr.inner,
					commands,
					expansionGroup,
					ctx,
				);
			}
			return;
		}
		case "ArithmeticWord":
			return;
	}
}

function collectArithmeticCommands(
	node: Script | Node | undefined,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (!node) return;

	switch (node.type) {
		case "Script":
		case "CompoundList": {
			for (const [i, child] of node.commands.entries()) {
				const startIdx = commands.length;
				collectArithmeticCommands(child, source, commands, groupId, ctx);
				const lastCmd = commands[commands.length - 1];
				if (
					i < node.commands.length - 1 &&
					commands.length > startIdx &&
					lastCmd
				) {
					lastCmd.joiner = ";";
				}
			}
			return;
		}

		case "AndOr":
		case "Pipeline": {
			for (const [i, child] of node.commands.entries()) {
				const startIdx = commands.length;
				collectArithmeticCommands(child, source, commands, groupId, ctx);
				const lastCmd = commands[commands.length - 1];
				const op = node.operators[i];
				if (op !== undefined && commands.length > startIdx && lastCmd) {
					lastCmd.joiner = op as "|" | "&&" | "||";
				}
			}
			return;
		}

		case "Statement":
			collectArithmeticCommands(node.command, source, commands, groupId, ctx);
			for (const redirect of node.redirects) {
				collectArithmeticRedirect(redirect, source, commands, groupId, ctx);
			}
			return;

		case "Command":
			if (node.name) {
				commands.push({ node, source, group: groupId });
			}
			for (const prefix of node.prefix) {
				collectAssignment(prefix, source, commands, groupId, ctx);
			}
			for (const word of node.suffix) {
				collectWord(word, source, commands, groupId, ctx);
			}
			for (const redirect of node.redirects) {
				collectArithmeticRedirect(redirect, source, commands, groupId, ctx);
			}
			return;

		case "Subshell":
		case "BraceGroup":
			collectArithmeticCommands(node.body, source, commands, groupId, ctx);
			return;

		case "If":
			collectArithmeticCommands(node.clause, source, commands, groupId, ctx);
			collectArithmeticCommands(node.then, source, commands, groupId, ctx);
			if (node.else)
				collectArithmeticCommands(node.else, source, commands, groupId, ctx);
			return;

		case "While":
			collectArithmeticCommands(node.clause, source, commands, groupId, ctx);
			collectArithmeticCommands(node.body, source, commands, groupId, ctx);
			return;

		case "For":
			collectWord(node.name, source, commands, groupId, ctx);
			for (const word of node.wordlist) {
				collectWord(word, source, commands, groupId, ctx);
			}
			collectArithmeticCommands(node.body, source, commands, groupId, ctx);
			return;

		case "Select":
			collectWord(node.name, source, commands, groupId, ctx);
			for (const word of node.wordlist) {
				collectWord(word, source, commands, groupId, ctx);
			}
			collectArithmeticCommands(node.body, source, commands, groupId, ctx);
			return;

		case "Case":
			collectWord(node.word, source, commands, groupId, ctx);
			for (const item of node.items) {
				collectArithmeticCaseItem(item, source, commands, groupId, ctx);
			}
			return;

		case "Function":
			collectWord(node.name, source, commands, groupId, ctx);
			collectArithmeticCommands(node.body, source, commands, groupId, ctx);
			for (const redirect of node.redirects) {
				collectArithmeticRedirect(redirect, source, commands, groupId, ctx);
			}
			return;

		case "Coproc":
			if (node.name) collectWord(node.name, source, commands, groupId, ctx);
			collectArithmeticCommands(node.body, source, commands, groupId, ctx);
			for (const redirect of node.redirects) {
				collectArithmeticRedirect(redirect, source, commands, groupId, ctx);
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
			collectArithmeticCommands(node.body, source, commands, groupId, ctx);
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

function collectArithmeticRedirect(
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

function collectArithmeticCaseItem(
	item: { pattern: Word[]; body: Node },
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	for (const pattern of item.pattern) {
		collectWord(pattern, source, commands, groupId, ctx);
	}
	collectArithmeticCommands(item.body, source, commands, groupId, ctx);
}
