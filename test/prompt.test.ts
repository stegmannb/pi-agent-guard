import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseBash } from "unbash";
import { extractAllCommandsFromAST } from "../src/extract.ts";
import { buildApprovalPrompt, buildFileApprovalPrompt, buildCustomApprovalPrompt } from "../src/prompt.ts";
import { resolveBashAction } from "../src/matching.ts";
import { getCommandName, getCommandArgs } from "../src/resolve.ts";

function extract(raw: string) {
  return extractAllCommandsFromAST(parseBash(raw), raw);
}

test("buildApprovalPrompt", async (t) => {
  await t.test("shows allowed commands for context alongside unapproved ones", () => {
    const commands = extract("cd /Users/jdiamond/code/pi-nudge && npx tsc --noEmit 2>&1");
    const unauthorized = commands.filter(cmd => {
      const name = getCommandName(cmd);
      const args = getCommandArgs(cmd);
      return resolveBashAction(name, args, { "cd": "allow" }) !== "allow";
    });

    assert.equal(
      buildApprovalPrompt(commands, unauthorized, { maxLength: 40, argMaxLength: 40 }),
      [
        "⚠️ Unapproved Commands",
        "",
        "✔ cd /Users/jdiamond/code/pi-nudge",
        "✖ npx tsc --noEmit 2>&1",
      ].join("\n"),
    );
  });

  await t.test("preserves command order and does not deduplicate entries", () => {
    const commands = extract("echo ok && npm test && npm test");
    const unauthorized = commands.filter(cmd => {
      const name = getCommandName(cmd);
      const args = getCommandArgs(cmd);
      return resolveBashAction(name, args, { "echo": "allow" }) !== "allow";
    });

    assert.equal(
      buildApprovalPrompt(commands, unauthorized, { maxLength: 200, argMaxLength: 200 }),
      [
        "⚠️ Unapproved Commands",
        "",
        "✔ echo ok",
        "✖ npm test",
        "✖ npm test",
      ].join("\n"),
    );
  });
});

test("buildFileApprovalPrompt", async (t) => {
  await t.test("formats read prompts", () => {
    const prompt = buildFileApprovalPrompt("read", "/path/to/file.ts");
    assert.equal(prompt, "⚠️ Read Permission Required\n\n/path/to/file.ts");
  });

  await t.test("formats edit prompts", () => {
    const prompt = buildFileApprovalPrompt("edit", "/path/to/file.ts");
    assert.equal(prompt, "⚠️ Edit Permission Required\n\n/path/to/file.ts");
  });

  await t.test("formats write prompts", () => {
    const prompt = buildFileApprovalPrompt("write", "/path/to/file.ts");
    assert.equal(prompt, "⚠️ Write Permission Required\n\n/path/to/file.ts");
  });

  await t.test("truncates long paths", () => {
    const longPath = "/".repeat(150);
    const prompt = buildFileApprovalPrompt("read", longPath, { maxLength: 50 });
    assert.ok(prompt.includes("…"));
    assert.ok(prompt.length < 200); // Should be truncated
  });
});

test("buildCustomApprovalPrompt", async (t) => {
  await t.test("formats custom tool prompts", () => {
    const prompt = buildCustomApprovalPrompt("webfetch", "https://example.com");
    assert.equal(prompt, "⚠️ webfetch Permission Required\n\nhttps://example.com");
  });

  await t.test("capitalizes tool name", () => {
    const prompt = buildCustomApprovalPrompt("spawn", "build");
    assert.equal(prompt, "⚠️ spawn Permission Required\n\nbuild");
  });

  await t.test("truncates long input", () => {
    const longInput = "a".repeat(150);
    const prompt = buildCustomApprovalPrompt("webfetch", longInput, { maxLength: 50 });
    assert.ok(prompt.includes("…"));
    assert.ok(prompt.length < 200); // Should be truncated
  });
});