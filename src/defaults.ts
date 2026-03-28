import type { GuardConfig } from "./types.ts";

export const DEFAULT_CONFIG: GuardConfig = {
  enabled: true,
  matchers: {
    bash: { param: "command", type: "bash" },
    read: { param: "path", type: "glob" },
    write: { param: "path", type: "glob" },
    edit: { param: "path", type: "glob" },
    grep: { param: "path", type: "glob" },
    find: { param: "path", type: "glob" },
    ls: { param: "path", type: "glob" },
  },
  rules: {
    bash: {
      "*": "ask",
      cat: "allow",
      cd: "allow",
      echo: "allow",
      find: "allow",
      grep: "allow",
      head: "allow",
      ls: "allow",
      pwd: "allow",
      rg: "allow",
      "git blame": "allow",
      "git branch --show-current": "allow",
      "git diff": "allow",
      "git log": "allow",
      "git show": "allow",
      "git status": "allow",
    },
    read: {
      "*": "allow",
      "*.env": "deny",
      "*.pem": "deny",
    },
    write: {
      "*": "ask",
    },
    edit: {
      "*": "ask",
    },
    grep: {
      "*": "allow",
    },
    find: {
      "*": "allow",
    },
    ls: {
      "*": "allow",
    },
  },
};
