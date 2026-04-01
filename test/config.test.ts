import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLoadedGuardConfig, getGuardConfigFromSettings, buildEffectiveRules, validateToolRules } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/defaults.ts";

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

  await t.test("accepts valid profiles", () => {
    const result = validateLoadedGuardConfig({
      profiles: {
        "read-write": {
          "edit": { "*": "allow" },
          "write": { "*": "allow" }
        }
      }
    });
    assert.deepEqual(result.config.profiles, {
      "read-write": {
        "edit": { "*": "allow" },
        "write": { "*": "allow" }
      }
    });
    assert.equal(result.warning, undefined);
  });

  await t.test("accepts profile with single action", () => {
    const result = validateLoadedGuardConfig({
      profiles: {
        "deny-all": "deny"
      }
    });
    assert.equal(result.config.profiles?.["deny-all"], "deny");
    assert.equal(result.warning, undefined);
  });

  await t.test("accepts valid shortcuts", () => {
    const result = validateLoadedGuardConfig({
      profiles: {
        "read-write": { "edit": { "*": "allow" } }
      },
      shortcuts: {
        "rw": "read-write",
        "ro": "off"
      }
    });
    assert.deepEqual(result.config.shortcuts, {
      "rw": "read-write",
      "ro": "off"
    });
    assert.equal(result.warning, undefined);
  });

  await t.test("rejects invalid profiles with invalid action", () => {
    const result = validateLoadedGuardConfig({
      profiles: {
        "bad": { "edit": { "*": "maybe" } }
      }
    });
    assert.ok(result.warning?.includes("maybe"));
  });
});

test("getGuardConfigFromSettings", async (t) => {
  await t.test("uses default config when the guard key is missing", () => {
    const result = getGuardConfigFromSettings({ other: true });
    assert.equal(result.config.enabled, true);
    assert.equal(result.warning, undefined);
  });

  await t.test("validates a falsey guard value", () => {
    const result = getGuardConfigFromSettings({ guard: null });
    assert.equal(result.config.enabled, true);
    assert.ok(result.warning);
  });
});

test("buildEffectiveRules", async (t) => {
  await t.test("defaults alone when all layers are empty", () => {
    const result = buildEffectiveRules({}, {}, undefined, undefined, {});
    assert.deepEqual(result, DEFAULT_CONFIG.rules);
  });

  await t.test("user rules are merged with defaults", () => {
    const result = buildEffectiveRules({ "mytool": "allow" }, {}, undefined, undefined, {});
    if (typeof result === "object") {
      assert.equal(result["mytool"], "allow");
      // Defaults are preserved - guaranteed to be object by defaults.ts
      assert.ok(typeof DEFAULT_CONFIG.rules === "object");
      assert.deepEqual(result["bash"], DEFAULT_CONFIG.rules.bash);
    }
  });

  await t.test("project rules override user rules", () => {
    const result = buildEffectiveRules({ "npm": "ask" }, { "npm": "allow" }, undefined, undefined, {});
    if (typeof result === "object") {
      assert.equal(result["npm"], "allow");
    }
  });

  await t.test("session rules override all other layers", () => {
    const result = buildEffectiveRules({}, { "npm": "ask" }, undefined, undefined, { "npm": "allow" });
    if (typeof result === "object") {
      assert.equal(result["npm"], "allow");
    }
  });

  await t.test("session rules override env rules", () => {
    const result = buildEffectiveRules({}, {}, { "npm": "ask" }, undefined, { "npm": "deny" });
    if (typeof result === "object") {
      assert.equal(result["npm"], "deny");
    }
  });

  await t.test("single action session rules win over all", () => {
    const result = buildEffectiveRules({ "bash": { "*": "ask" } }, {}, undefined, undefined, "deny");
    assert.equal(result, "deny");
  });

  await t.test("single action env rules override user rules", () => {
    const result = buildEffectiveRules({ "bash": { "*": "ask" } }, {}, "allow", undefined, {});
    assert.equal(result, "allow");
  });

  await t.test("profile rules are merged with other layers", () => {
    const result = buildEffectiveRules(
      { "edit": { "*": "allow" } },
      {},
      undefined,
      { "edit": { "*": "ask" } },
      {}
    );
    if (typeof result === "object") {
      assert.deepEqual(result["edit"], { "*": "ask" });
    }
  });

  await t.test("session rules override profile rules", () => {
    const result = buildEffectiveRules(
      {},
      {},
      undefined,
      { "edit": { "*": "allow" } },
      { "edit": { "*": "ask" } }
    );
    if (typeof result === "object") {
      assert.deepEqual(result["edit"], { "*": "ask" });
    }
  });

  await t.test("profile rules override env rules", () => {
    const result = buildEffectiveRules(
      {},
      {},
      { "edit": { "*": "allow" } },
      { "edit": { "*": "ask" } },
      {}
    );
    if (typeof result === "object") {
      assert.deepEqual(result["edit"], { "*": "ask" });
    }
  });
});