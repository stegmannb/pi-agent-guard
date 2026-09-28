import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface FileReference {
	path: string;
	sha256: string;
}

export function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = resolve(root, "protection-code.json");

// Every local runtime module imports this module before executing its body.
// Capture once, even when modules are cached before the extension is registered.
function packageRoot(names: string[]): string {
	let parent = root;
	for (const name of names) {
		let candidate = dirname(
			createRequire(resolve(parent, "package.json")).resolve(name),
		);
		while (
			!existsSync(resolve(candidate, "package.json")) ||
			JSON.parse(readFileSync(resolve(candidate, "package.json"), "utf8"))
				.name !== name
		) {
			if (dirname(candidate) === candidate)
				throw new Error("Unknown dependency");
			candidate = dirname(candidate);
		}
		parent = candidate;
	}
	return parent;
}

function manifestFile(entry: { path: string; packages?: string }): string {
	const base = entry.packages ? packageRoot(entry.packages.split(">")) : root;
	const path = realpathSync(resolve(base, entry.path));
	if (relative(realpathSync(base), path).startsWith(".."))
		throw new Error("Unknown closure");
	return path;
}

function walkPackage(directory: string, files: Set<string>): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		if (entry.isSymbolicLink()) throw new Error("Unknown dependency symlink");
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) walkPackage(path, files);
		else files.add(realpathSync(path));
	}
}

function expectedFiles(): Set<string> {
	const files = new Set(
		[
			"index.ts",
			"package.json",
			"pnpm-lock.yaml",
			...readdirSync(resolve(root, "src")).map((name) => `src/${name}`),
		].map((name) => realpathSync(resolve(root, name))),
	);
	function visitPackage(chain: string[]): void {
		if (chain.length > 10) throw new Error("Unknown dependency closure");
		const base = packageRoot(chain);
		walkPackage(base, files);
		const dependencies =
			JSON.parse(readFileSync(resolve(base, "package.json"), "utf8"))
				.dependencies ?? {};
		for (const name of Object.keys(dependencies))
			visitPackage([...chain, name]);
	}
	for (const name of ["minimatch", "unbash"]) visitPackage([name]);
	return files;
}

interface ManifestEntry {
	path: string;
	sha256: string;
	packages?: string;
}
function isManifestEntry(value: unknown): value is ManifestEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<ManifestEntry>;
	if (typeof entry.path !== "string" || typeof entry.sha256 !== "string")
		return false;
	if (entry.packages === undefined)
		return /^(index\.ts|src\/[a-z-]+\.ts|package\.json|pnpm-lock\.yaml)$/.test(
			entry.path,
		);
	if (typeof entry.packages !== "string") return false;
	const names = entry.packages.split(">");
	return (
		["minimatch", "unbash"].includes(names[0] ?? "") &&
		names.every((name) => /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(name))
	);
}

function capture(): FileReference[] | undefined {
	try {
		const contents = readFileSync(manifestPath, "utf8");
		const manifest: unknown = JSON.parse(contents);
		if (!Array.isArray(manifest) || manifest.length === 0) return;
		const files: FileReference[] = [];
		for (const entry of manifest) {
			if (!isManifestEntry(entry)) return;
			const path = manifestFile(entry);
			if (sha256(readFileSync(path)) !== entry.sha256) return;
			files.push({ path, sha256: entry.sha256 });
		}
		const expected = expectedFiles();
		if (
			files.length !== expected.size ||
			new Set(files.map((file) => file.path)).size !== expected.size ||
			files.some((file) => !expected.has(file.path))
		)
			return;
		files.push({ path: realpathSync(manifestPath), sha256: sha256(contents) });
		return files.sort((a, b) => a.path.localeCompare(b.path));
	} catch {
		return;
	}
}

const loaded = capture();

export function loadedCode(): FileReference[] | undefined {
	return loaded ? structuredClone(loaded) : undefined;
}

export function referencesUnchanged(files: FileReference[]): boolean {
	try {
		const expected = expectedFiles();
		expected.add(realpathSync(manifestPath));
		if (
			expected.size !== files.length ||
			files.some((file) => !expected.has(file.path))
		)
			return false;
		return files.every(
			(file) =>
				realpathSync(file.path) === file.path &&
				sha256(readFileSync(file.path)) === file.sha256,
		);
	} catch {
		return false;
	}
}
