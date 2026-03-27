import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLoadedGuardConfig, getGuardConfigFromSettings, buildEffectiveRules, validateToolRules } from "../src/config.ts";
import { DEFAULT_RULES, DEFAULT_MATCHERS } from "../src/config.ts";

test("validateToolRules", async (t) => {
  await t.test("accepts valid rules", () => {
    const result = validateToolRules({ "git": "allow", "curl": "ask" });
    assert.deepEqual(result.rules, { "git": "allow", "curl": "ask" });
    assert.equal(result.warnings.length, 0);
  });

  await t.test("accepts deny action", () => {
    const result = validateToolRules({ "rm": "deny" });
    assert.deepEqual(result.rules, { "rm": "deny" });
    assert.equal(result.warnings.length, 0);
  });

  await t.test("rejects invalid actions", () => {
    const result = validateToolRules({ "git": "invalid" });
    assert.equal(result.rules["git"], undefined);
    assert.ok(result.warnings.length > 0);
  });

  await t.test("rejects empty pattern", () => {
    const result = validateToolRules({ "": "allow" });
    assert.equal(result.rules[""], undefined);
    assert.ok(result.warnings.length > 0);
  });

  await t.test("accepts empty rules object", () => {
    const result = validateToolRules({});
    assert.equal(result.warnings.length, 0);
  });

  await t.test("rejects non-object input", () => {
    const result = validateToolRules(null);
    assert.equal(result.warnings.length > 0, true);
  });
});

test("validateLoadedGuardConfig", async (t) => {
  await t.test("accepts valid config with rules", () => {
    const result = validateLoadedGuardConfig({ enabled: false, rules: { "git": "allow", "curl": "ask" } });
    assert.equal(result.config.enabled, false);
    assert.deepEqual(result.config.rules, { "git": "allow", "curl": "ask" });
    assert.equal(result.warning, undefined);
  });

  await t.test("accepts valid config with empty rules", () => {
    const result = validateLoadedGuardConfig({ enabled: true, rules: {} });
    assert.equal(result.config.enabled, true);
    assert.deepEqual(result.config.rules, {});
    assert.equal(result.warning, undefined);
  });

  await t.test("accepts valid config with no rules field", () => {
    const result = validateLoadedGuardConfig({ enabled: true });
    assert.equal(result.config.enabled, true);
    assert.deepEqual(result.config.rules, {});
    assert.equal(result.warning, undefined);
  });

  await t.test("accepts single action for all tools", () => {
    const result = validateLoadedGuardConfig({ rules: "allow" });
    assert.equal(result.config.rules, "allow");
    assert.equal(result.warning, undefined);
  });

  await t.test("accepts single tool action", () => {
    const result = validateLoadedGuardConfig({ rules: { "bash": "allow" } });
    assert.deepEqual(result.config.rules, { "bash": "allow" });
    assert.equal(result.warning, undefined);
  });

  await t.test("accepts pattern-based rules per tool", () => {
    const result = validateLoadedGuardConfig({
      rules: {
        "bash": { "git": "allow", "rm": "deny" },
        "read": { "*": "allow" }
      }
    });
    assert.deepEqual(result.config.rules, {
      "bash": { "git": "allow", "rm": "deny" },
      "read": { "*": "allow" }
    });
    assert.equal(result.warning, undefined);
  });

  await t.test("accepts custom matchers", () => {
    const result = validateLoadedGuardConfig({
      matchers: {
        "webfetch": { "param": "url", "type": "glob" }
      }
    });
    assert.deepEqual(result.config.matchers, {
      "webfetch": { "param": "url", "type": "glob" }
    });
    assert.equal(result.warning, undefined);
  });

  await t.test("rejects invalid matcher type", () => {
    const result = validateLoadedGuardConfig({
      matchers: {
        "webfetch": { "param": "url", "type": "invalid" as const }
      }
    });
    assert.equal(result.config.matchers?.["webfetch"], undefined);
    assert.ok(result.warning);
  });

  await t.test("uses safe fallback for invalid top-level shape", () => {
    const result = validateLoadedGuardConfig("bad");
    assert.equal(result.config.enabled, true);
    assert.deepEqual(result.config.rules, {});
    assert.ok(result.warning);
  });

  await t.test("recovers valid enabled when rules is invalid", () => {
    const result = validateLoadedGuardConfig({ enabled: false, rules: 42 });
    assert.equal(result.config.enabled, false);
    assert.deepEqual(result.config.rules, {});
    assert.ok(result.warning?.includes("rules"));
  });
});

test("getGuardConfigFromSettings", async (t) => {
  await t.test("uses default config when the guard key is missing", () => {
    const result = getGuardConfigFromSettings({ other: true });
    assert.equal(result.config.enabled, true);
    assert.deepEqual(result.config.matchers, DEFAULT_MATCHERS);
    assert.equal(result.warning, undefined);
  });

  await t.test("validates a falsey guard value", () => {
    const result = getGuardConfigFromSettings({ guard: null });
    assert.equal(result.config.enabled, true);
    assert.ok(result.warning);
  });
});

test("DEFAULT_RULES", async (t) => {
  await t.test("all values are allow, ask, or deny", () => {
    for (const [tool, rules] of Object.entries(DEFAULT_RULES)) {
      if (typeof rules === "string") {
        assert.ok(["allow", "ask", "deny"].includes(rules), `DEFAULT_RULES["${tool}"] has invalid action "${rules}"`);
      } else {
        for (const [pattern, action] of Object.entries(rules)) {
          assert.ok(["allow", "ask", "deny"].includes(action), `DEFAULT_RULES["${tool}"]["${pattern}"] has invalid action "${action}"`);
        }
      }
    }
  });

  await t.test("all patterns are non-empty strings", () => {
    for (const [tool, rules] of Object.entries(DEFAULT_RULES)) {
      if (typeof rules !== "string") {
        for (const pattern of Object.keys(rules)) {
          assert.ok(pattern.trim().length > 0, `DEFAULT_RULES["${tool}"] has empty pattern`);
        }
      }
    }
  });
});

test("DEFAULT_MATCHERS", async (t) => {
  await t.test("has matchers for core tools", () => {
    assert.equal(DEFAULT_MATCHERS.bash!.param, "command");
    assert.equal(DEFAULT_MATCHERS.bash!.type, "bash");
    assert.equal(DEFAULT_MATCHERS.read!.param, "path");
    assert.equal(DEFAULT_MATCHERS.read!.type, "glob");
    assert.equal(DEFAULT_MATCHERS.edit!.param, "path");
    assert.equal(DEFAULT_MATCHERS.edit!.type, "glob");
    assert.equal(DEFAULT_MATCHERS.write!.param, "path");
    assert.equal(DEFAULT_MATCHERS.write!.type, "glob");
  });
});

test("buildEffectiveRules", async (t) => {
  await t.test("defaults alone when all layers are empty", () => {
    const result = buildEffectiveRules({}, {}, {}, undefined);
    assert.deepEqual(result, DEFAULT_RULES);
  });

  await t.test("user rules are merged with defaults", () => {
    const result = buildEffectiveRules({ "mytool": "allow" }, {}, {}, undefined);
    if (typeof result === "object") {
      assert.equal(result["mytool"], "allow");
      // Defaults are preserved
      if (typeof DEFAULT_RULES["bash"] === "object") {
        assert.deepEqual(result["bash"], DEFAULT_RULES["bash"]);
      }
    }
  });

  await t.test("project rules override user rules", () => {
    const result = buildEffectiveRules({ "npm": "ask" }, { "npm": "allow" }, {}, undefined);
    if (typeof result === "object") {
      assert.equal(result["npm"], "allow");
    }
  });

  await t.test("session rules override project rules", () => {
    const result = buildEffectiveRules({}, { "npm": "ask" }, { "npm": "allow" }, undefined);
    if (typeof result === "object") {
      assert.equal(result["npm"], "allow");
    }
  });

  await t.test("env rules override session rules", () => {
    const result = buildEffectiveRules({}, {}, { "npm": "ask" }, { "npm": "deny" });
    if (typeof result === "object") {
      assert.equal(result["npm"], "deny");
    }
  });

  await t.test("single action env rules win", () => {
    const result = buildEffectiveRules({ "bash": { "*": "ask" } }, {}, {}, "deny");
    assert.equal(result, "deny");
  });

  await t.test("single action session rules override user rules", () => {
    const result = buildEffectiveRules({ "bash": { "*": "ask" } }, {}, "allow", undefined);
    assert.equal(result, "allow");
  });
});