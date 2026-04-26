import type { CommandRef } from "./types.ts";

export function getCommandName(cmd: CommandRef): string {
	if (cmd.node.name) return cmd.node.name.value ?? cmd.node.name.text;
	// Assignment-only command (e.g. TOKEN=$(...)): use the variable name
	if (cmd.node.prefix.length > 0 && cmd.node.prefix[0]?.name) {
		return cmd.node.prefix[0].name;
	}
	return "";
}

export function getCommandArgs(cmd: CommandRef): string[] {
	return cmd.node.suffix.map((word) => word.value ?? word.text);
}
