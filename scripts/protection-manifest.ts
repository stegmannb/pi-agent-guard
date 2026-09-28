import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = new Set<string>(["package.json", "pnpm-lock.yaml"]);
const packageNames = new Set([
	"@mariozechner/pi-ai",
	"@mariozechner/pi-coding-agent",
	"@mariozechner/pi-tui",
	"typebox",
	"typebox/value",
	"minimatch",
	"unbash",
]);

function visitFile(name: string): void {
	if (files.has(name)) return;
	assert.match(name, /^(index\.ts|src\/[a-z-]+\.ts)$/);
	files.add(name);
	const source = readFileSync(resolve(root, name), "utf8");
	const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
	if (name !== "src/loaded-code.ts") {
		const first = tree.statements[0];
		assert.ok(first && ts.isImportDeclaration(first));
		assert.ok(ts.isStringLiteral(first.moduleSpecifier));
		assert.equal(
			first.moduleSpecifier.text,
			name === "index.ts" ? "./src/loaded-code.ts" : "./loaded-code.ts",
		);
	}
	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node)) {
			assert.notEqual(
				node.expression.kind,
				ts.SyntaxKind.ImportKeyword,
				"Dynamic imports need a new closure contract",
			);
			assert.ok(
				!ts.isIdentifier(node.expression) ||
					!["require", "eval", "Function"].includes(node.expression.text),
			);
		}
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier
		) {
			assert.ok(ts.isStringLiteral(node.moduleSpecifier));
			const specifier = node.moduleSpecifier.text;
			if (specifier.startsWith("."))
				visitFile(relative(root, resolve(root, dirname(name), specifier)));
			else
				assert.ok(
					specifier.startsWith("node:") || packageNames.has(specifier),
					`Unknown code dependency: ${specifier}`,
				);
		}
		ts.forEachChild(node, visit);
	}
	visit(tree);
}

visitFile("index.ts");
interface ManifestEntry {
	path: string;
	sha256: string;
	packages?: string;
}
const manifest: ManifestEntry[] = [...files]
	.sort()
	.map((path) => ({ path, sha256: hash(resolve(root, path)) }));
function hash(path: string) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function visitPackage(name: string, parent: string, chain: string[]): void {
	let base = dirname(
		createRequire(resolve(parent, "package.json")).resolve(name),
	);
	while (
		!existsSync(resolve(base, "package.json")) ||
		JSON.parse(readFileSync(resolve(base, "package.json"), "utf8")).name !==
			name
	) {
		assert.notEqual(dirname(base), base);
		base = dirname(base);
	}
	const packages = [...chain, name];
	assert.ok(packages.length < 10, "Cyclic/unknown package closure");
	function walk(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
			(a, b) => a.name.localeCompare(b.name),
		)) {
			if (entry.name === "node_modules") continue;
			const path = resolve(directory, entry.name);
			assert.ok(!entry.isSymbolicLink(), "Unknown package file symlink");
			if (entry.isDirectory()) walk(path);
			else
				manifest.push({
					packages: packages.join(">"),
					path: relative(realpathSync(base), path),
					sha256: hash(path),
				});
		}
	}
	walk(base);
	const dependencies =
		JSON.parse(readFileSync(resolve(base, "package.json"), "utf8"))
			.dependencies ?? {};
	for (const dependency of Object.keys(dependencies).sort())
		visitPackage(dependency, base, packages);
}
for (const name of ["minimatch", "unbash"]) visitPackage(name, root, []);
const result = `${JSON.stringify(manifest, null, "\t")}\n`;
const target = resolve(root, "protection-code.json");
if (process.argv.includes("--check"))
	assert.equal(
		readFileSync(target, "utf8"),
		result,
		"Refresh protection-code.json with pnpm run protection:manifest",
	);
else writeFileSync(target, result);
