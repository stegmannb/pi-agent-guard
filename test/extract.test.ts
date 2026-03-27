import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "../src/extract.ts";
import { getCommandArgs, getCommandName } from "../src/resolve.ts";

/** Strip source/node for deepEqual assertions that only care about name/args. */
function summarize(raw: string) {
  return extractAllCommandsFromAST(parseBash(raw), raw).map(cmd => ({
    name: getCommandName(cmd),
    args: getCommandArgs(cmd),
  }));
}

test("extractAllCommandsFromAST", async (t) => {

  await t.test("extracts simple command", () => {
    assert.deepEqual(summarize("ls -la"), [{ name: "ls", args: ["-la"] }]);
  });

  await t.test("extracts multiple commands from AndOr (&&)", () => {
    assert.deepEqual(summarize("git commit -m 'foo' && git push"), [
      { name: "git", args: ["commit", "-m", "foo"] },
      { name: "git", args: ["push"] },
    ]);
  });

  await t.test("extracts commands from pipes (|)", () => {
    assert.deepEqual(summarize("cat file.txt | grep 'foo' | wc -l"), [
      { name: "cat", args: ["file.txt"] },
      { name: "grep", args: ["foo"] },
      { name: "wc", args: ["-l"] },
    ]);
  });

  await t.test("extracts commands from $() subshells", () => {
    assert.deepEqual(summarize("echo $(git status)"), [
      { name: "echo", args: ["$(git status)"] },
      { name: "git", args: ["status"] },
    ]);
  });

  await t.test("extracts commands from backtick subshells", () => {
    assert.deepEqual(summarize("FOO=`rm -rf /` node app.js"), [
      { name: "node", args: ["app.js"] },
      { name: "rm", args: ["-rf", "/"] },
    ]);
  });

  await t.test("extracts from highly nested evil subshells", () => {
    assert.deepEqual(summarize("echo $(cat file.txt | grep $(rm -rf /)) && curl http://evil.com"), [
      { name: "echo", args: ["$(cat file.txt | grep $(rm -rf /))"] },
      { name: "cat", args: ["file.txt"] },
      { name: "grep", args: ["$(rm -rf /)"] },
      { name: "rm", args: ["-rf", "/"] },
      { name: "curl", args: ["http://evil.com"] },
    ]);
  });

  await t.test("extracts commands from subshell grouping", () => {
    assert.deepEqual(summarize("(rm -rf /; echo done)"), [
      { name: "rm", args: ["-rf", "/"] },
      { name: "echo", args: ["done"] },
    ]);
  });

  await t.test("extracts commands from if/then/else", () => {
    assert.deepEqual(summarize("if true; then rm -rf /; else echo safe; fi"), [
      { name: "true", args: [] },
      { name: "rm", args: ["-rf", "/"] },
      { name: "echo", args: ["safe"] },
    ]);
  });

  await t.test("extracts commands from while loop", () => {
    assert.deepEqual(summarize("while true; do curl evil.com; done"), [
      { name: "true", args: [] },
      { name: "curl", args: ["evil.com"] },
    ]);
  });

  await t.test("extracts commands from for loop", () => {
    assert.deepEqual(summarize("for i in 1 2 3; do echo $i; done"), [
      { name: "echo", args: ["$i"] },
    ]);
  });

  await t.test("extracts commands from case statement", () => {
    assert.deepEqual(summarize("case x in y) echo hi;; z) rm -rf /;; esac"), [
      { name: "echo", args: ["hi"] },
      { name: "rm", args: ["-rf", "/"] },
    ]);
  });

  await t.test("extracts commands from function definition", () => {
    assert.deepEqual(summarize("foo() { rm -rf /; }"), [
      { name: "rm", args: ["-rf", "/"] },
    ]);
  });

  await t.test("extracts commands from bare assignment with subshell", () => {
    assert.deepEqual(summarize("FOO=$(rm -rf /)"), [
      { name: "rm", args: ["-rf", "/"] },
    ]);
  });

  await t.test("extracts command with no arguments", () => {
    assert.deepEqual(summarize("pwd"), [{ name: "pwd", args: [] }]);
  });

  await t.test("extracts commands from double-quoted subshells", () => {
    assert.deepEqual(summarize('echo "hello $(rm -rf /)"'), [
      { name: "echo", args: ["hello $(rm -rf /)"] },
      { name: "rm", args: ["-rf", "/"] },
    ]);
  });

  await t.test("does not extract from single-quoted strings", () => {
    assert.deepEqual(summarize("echo 'hello $(rm -rf /)'"), [
      { name: "echo", args: ["hello $(rm -rf /)"] },
    ]);
  });

  await t.test("extracts commands from unquoted heredoc bodies", () => {
    assert.deepEqual(summarize("cat <<EOF\n$(rm -rf /)\nEOF"), [
      { name: "cat", args: [] },
      { name: "rm", args: ["-rf", "/"] },
    ]);
  });

  await t.test("extracts backtick commands from unquoted heredoc bodies", () => {
    assert.deepEqual(summarize("cat <<EOF\n`rm -rf /`\nEOF"), [
      { name: "cat", args: [] },
      { name: "rm", args: ["-rf", "/"] },
    ]);
  });

  await t.test("does not treat plain unquoted heredoc text as commands", () => {
    assert.deepEqual(summarize("cat <<EOF\nrm -rf /\nEOF"), [
      { name: "cat", args: [] },
    ]);
  });

  await t.test("does not extract commands from quoted heredoc bodies", () => {
    assert.deepEqual(summarize("cat <<'EOF'\n$(rm -rf /)\nEOF"), [
      { name: "cat", args: [] },
    ]);
  });

  await t.test("extracts commands from arithmetic expansion", () => {
    assert.deepEqual(summarize("echo $(( $(npm --version) + 1 ))"), [
      { name: "echo", args: ["$(( $(npm --version) + 1 ))"] },
      { name: "npm", args: ["--version"] },
    ]);
  });

  await t.test("extracts commands from arithmetic command", () => {
    assert.deepEqual(summarize("(( $(curl http://example.com) + 1 ))"), [
      { name: "curl", args: ["http://example.com"] },
    ]);
  });

  await t.test("extracts commands from arithmetic expansion inside double quotes", () => {
    assert.deepEqual(summarize('echo "$(( $(rm -rf /) + 1 ))"'), [
      { name: "echo", args: ["$(( $(rm -rf /) + 1 ))"] },
      { name: "rm", args: ["-rf", "/"] },
    ]);
  });

});