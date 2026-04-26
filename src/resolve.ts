import type { CommandRef } from "./types.ts";

export function getCommandName(cmd: CommandRef): string {
	if (cmd.node.name) return cmd.node.name.value ?? cmd.node.name.text;
	// Assignment-only command (e.g. TOKEN=$(...)): use the variable name
	if (cmd.node.prefix.length > 0 && cmd.node.prefix[0]?.name) {
		return cmd.node.prefix[0].name;
	}
	return "";
}

/** Returns true if this is a bare assignment (no command name, only prefix assignments).
 *  E.g. TOKEN=$(curl ...) — not a real command, just a variable assignment. */
export function isBareAssignment(cmd: CommandRef): boolean {
	return !cmd.node.name && cmd.node.prefix.length > 0;
}

export function getCommandArgs(cmd: CommandRef): string[] {
	return cmd.node.suffix.map((word) => word.value ?? word.text);
}
