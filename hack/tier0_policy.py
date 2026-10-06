#!/usr/bin/env python3
"""Fail-closed Forgejo Tier-0/no-release policy for pi-agent-guard."""

from __future__ import annotations

import argparse
import json
import re
import stat
import subprocess
from datetime import datetime
import sys
from pathlib import Path
from typing import Any

import yaml

EXPECTED_CHECKS = [
    "ci / policy (pull_request)",
    "ci / typecheck (pull_request)",
    "ci / lint (pull_request)",
    "ci / format (pull_request)",
    "ci / test (pull_request)",
]
CHECKOUT_ACTION = (
    "https://data.forgejo.org/actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803"
)
RUNNER_IMAGE = (
    "git.forest-arowana.ts.net/bastian/forgejo-runner-k8s@"
    "sha256:f038e4345561f4b0bb82bc31c9f6779394db574287779a437f261b7ec409e826"
)
EXPECTED_DECLARATION = {
    "schema": 1,
    "tier": 0,
    "releaseProfile": "none",
    "securityBoundary": "command-policy-and-bypass-guard",
    "role": "canonical command-permission safety boundary for agent tool execution",
    "owner": "Bastian",
    "defaultBranch": "main",
    "policy": "docs/forgejo-tier-0.md",
    "requiredChecks": EXPECTED_CHECKS,
    "forgejoRelease": {
        "enabled": False,
        "declarations": "forbidden",
        "tags": "forbidden",
        "forgejoReleases": "forbidden",
        "packages": "forbidden",
        "publishCredentials": "forbidden",
    },
    "externalReleaseBoundary": {
        "platform": "GitHub",
        "workflow": ".github/workflows/publish.yml",
        "registry": "npm",
        "forgejoExecution": "forbidden",
        "taskScope": "unchanged",
    },
    "protectionAudit": {
        "method": "forgejo-owner-api-and-ui",
        "verifiedAt": None,
        "verifiedBy": None,
        "evidence": (
            "pending Owner-Apply and readback for main, merge, review, checks, "
            "tags, releases, and packages"
        ),
        "reviewDate": "2026-09-30",
        "triggers": ["forgejo-upgrade", "protection-setting-change"],
    },
    "ownerApplyTask": "HL-0081",
}
EXPECTED_CODEOWNERS = """* @Bastian/Reviewers

/.forgejo/ @Bastian/Reviewers
/.github/actionlint.yaml @Bastian/Reviewers
/.github/workflows/publish.yml @Bastian/Reviewers
/CODEOWNERS @Bastian/Reviewers
/AGENTS.md @Bastian/Reviewers
/docs/forgejo-tier-0.md @Bastian/Reviewers
/flake.nix @Bastian/Reviewers
/flake.lock @Bastian/Reviewers
/.npmrc @Bastian/Reviewers
/package.json @Bastian/Reviewers
/package-lock.json @Bastian/Reviewers
/pnpm-lock.yaml @Bastian/Reviewers
/tsconfig.json @Bastian/Reviewers
/biome.json @Bastian/Reviewers
/index.ts @Bastian/Reviewers
/src/ @Bastian/Reviewers
/test/ @Bastian/Reviewers
/nix/ @Bastian/Reviewers
/scripts/ @Bastian/Reviewers
/hack/ @Bastian/Reviewers
/RELEASING.md @Bastian/Reviewers
"""
CI_GATE_SPECS = {
    "policy": (
        "Validate Tier-0 and Forgejo no-release policy",
        "policy-tools",
        'bash .forgejo/ci/policy.sh "$GITHUB_EVENT_PATH"',
    ),
    "typecheck": (
        "Type-check command guard",
        "node-tools",
        "bash .forgejo/ci/typecheck.sh",
    ),
    "lint": ("Lint command guard", "node-tools", "bash .forgejo/ci/lint.sh"),
    "format": (
        "Check command guard formatting",
        "node-tools",
        "bash .forgejo/ci/format.sh",
    ),
    "test": (
        "Run complete command-guard verification",
        "node-tools",
        "bash .forgejo/ci/test.sh",
    ),
}
DEPENDENCY_INSTALL = "pnpm install --frozen-lockfile --ignore-scripts"
NPM_SCRIPT_SHELL = (
    'npm_config_script_shell="$(command -v bash)"\nexport npm_config_script_shell'
)
EXPECTED_GATE_COMMANDS = {
    "typecheck": "npm run --ignore-scripts typecheck",
    "lint": "npm run --ignore-scripts lint",
    "format": "npm run --ignore-scripts format:check",
    "test": "npm run --ignore-scripts verify",
}
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
SECRET_CONTEXT_EXPRESSION = re.compile(r"\${{.*?\bsecrets\b.*?}}", re.DOTALL)
FORBIDDEN_FORGEJO_TEXT = re.compile(
    r"(?im)(packages:\s*write|contents:\s*write|\bnpm\s+publish\b|"
    r"\bgit\s+tag\b|\bfj\s+(?:release|package)\b|\brelease-retries/)"
)


class PolicyError(RuntimeError):
    """The repository violates its Forgejo Tier-0 declaration."""


class UniqueKeyLoader(yaml.SafeLoader):
    """Safe YAML loader that rejects duplicate mapping keys."""


def construct_unique_mapping(
    loader: UniqueKeyLoader, node: yaml.MappingNode, deep: bool = False
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise PolicyError(f"duplicate YAML key: {key!r}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_unique_mapping
)


def load_yaml(path: Path) -> dict[str, Any]:
    try:
        value = yaml.load(path.read_text(encoding="utf-8"), Loader=UniqueKeyLoader)
    except (OSError, yaml.YAMLError) as error:
        raise PolicyError(f"cannot parse {path}: {error}") from error
    if not isinstance(value, dict):
        raise PolicyError(f"{path} must contain a YAML mapping")
    return value


def load_json(path: Path) -> dict[str, Any]:
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, child in pairs:
            if key in value:
                raise PolicyError(f"duplicate JSON key in {path}: {key!r}")
            value[key] = child
        return value

    try:
        value = json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=unique_object
        )
    except (OSError, json.JSONDecodeError) as error:
        raise PolicyError(f"cannot parse {path}: {error}") from error
    if not isinstance(value, dict):
        raise PolicyError(f"{path} must contain a JSON object")
    return value


def workflow_triggers(workflow: dict[str, Any]) -> dict[str, Any]:
    triggers = workflow.get("on", workflow.get(True))
    if not isinstance(triggers, dict):
        raise PolicyError("workflow triggers must be an explicit mapping")
    return triggers


def scalar_strings(value: Any) -> list[str]:
    strings: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            strings.extend(scalar_strings(key))
            strings.extend(scalar_strings(child))
    elif isinstance(value, list):
        for child in value:
            strings.extend(scalar_strings(child))
    elif isinstance(value, str):
        strings.append(value)
    return strings


def secret_context_expressions(value: Any) -> list[str]:
    return [
        match.group(0)
        for scalar in scalar_strings(value)
        for match in SECRET_CONTEXT_EXPRESSION.finditer(scalar)
    ]


def action_references(value: Any) -> list[str]:
    references: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "uses":
                if not isinstance(child, str):
                    raise PolicyError("Action uses values must be strings")
                references.append(child)
            references.extend(action_references(child))
    elif isinstance(value, list):
        for child in value:
            references.extend(action_references(child))
    return references


def validate_action_pins(path: Path, value: dict[str, Any]) -> None:
    for reference in action_references(value):
        if reference.startswith("./"):
            continue
        if "@" not in reference:
            raise PolicyError(f"external Action has no ref in {path}: {reference}")
        revision = reference.rsplit("@", 1)[1]
        if not FULL_SHA.fullmatch(revision):
            raise PolicyError(
                f"external Action is not pinned to a full commit SHA in {path}: "
                f"{reference}"
            )


def validate_declaration(root: Path) -> None:
    declaration = load_yaml(root / ".forgejo/tier0.yaml")
    audit = declaration.get("protectionAudit")
    if not isinstance(audit, dict):
        raise PolicyError("protection audit must be a mapping")
    expected_audit = EXPECTED_DECLARATION["protectionAudit"]
    if set(audit) != set(expected_audit):
        raise PolicyError("protection audit fields must remain exact")
    for key in ("method", "reviewDate", "triggers"):
        if audit[key] != expected_audit[key]:
            raise PolicyError(f"protection audit {key} must remain exact")
    if audit["verifiedAt"] is None:
        if audit != expected_audit:
            raise PolicyError("pending protection audit must remain explicit")
    else:
        try:
            verified_at = datetime.fromisoformat(str(audit["verifiedAt"]))
        except ValueError as error:
            raise PolicyError("protection audit requires an ISO timestamp") from error
        if verified_at.tzinfo is None:
            raise PolicyError("protection audit timestamp requires a timezone")
        for key in ("verifiedBy", "evidence"):
            if not isinstance(audit[key], str) or not audit[key].strip():
                raise PolicyError(f"verified protection audit requires {key}")
    expected = {**EXPECTED_DECLARATION, "protectionAudit": audit}
    if declaration != expected:
        raise PolicyError("Tier-0 declaration must exactly match the approved contract")


def validate_codeowners(root: Path) -> None:
    text = (root / "CODEOWNERS").read_text(encoding="utf-8")
    if text != EXPECTED_CODEOWNERS:
        raise PolicyError(
            "CODEOWNERS must exactly match the approved fail-closed reviewer rules"
        )


def expected_stage_step() -> dict[str, str]:
    return {
        "name": "Stage exact head on ephemeral disk",
        "shell": "bash",
        "run": (
            "set -euo pipefail\n"
            'ci_workspace="$RUNNER_TEMP/pi-agent-guard"\n'
            'install -d "$ci_workspace"\n'
            'cp -a "$GITHUB_WORKSPACE/." "$ci_workspace/"\n'
            'echo "CI_WORKSPACE=$ci_workspace" >> "$GITHUB_ENV"\n'
        ),
    }


def expected_gate_step(job_name: str) -> dict[str, str]:
    gate_name, tool_package, command = CI_GATE_SPECS[job_name]
    return {
        "name": gate_name,
        "shell": "bash",
        "run": (
            "set -euo pipefail\n"
            'cd "$CI_WORKSPACE"\n'
            f'tools="$(nix build --no-link --print-out-paths .#{tool_package})"\n'
            'export PATH="$tools/bin:$PATH"\n'
            + (
                'biome_package="$(nix build --no-link --print-out-paths .#biome-ci)"\n'
                'export BIOME_BINARY="$biome_package/bin/biome"\n'
                if job_name in {"lint", "format", "test"}
                else ""
            )
            + f"{command}\n"
        ),
    }


def validate_ci_job(name: str, job: Any) -> None:
    if not isinstance(job, dict):
        raise PolicyError(f"ci job {name} must be a mapping")
    if "if" in job:
        raise PolicyError(f"required ci job {name} must not be conditional")
    if "continue-on-error" in job:
        raise PolicyError(f"required ci job {name} must fail closed")
    if set(job) != {"runs-on", "timeout-minutes", "container", "steps"}:
        raise PolicyError(f"required ci job {name} shape must be exact")
    if job.get("runs-on") != ["k8s-executor-small", "amd64"]:
        raise PolicyError(f"ci job {name} must use the approved runner")
    if job.get("timeout-minutes") != 15:
        raise PolicyError(f"ci job {name} timeout must be exact")
    if job.get("container") != {"image": RUNNER_IMAGE}:
        raise PolicyError(f"ci job {name} container must be approved and immutable")

    steps = job.get("steps")
    if not isinstance(steps, list) or len(steps) != 3:
        raise PolicyError(f"ci job {name} must contain exactly three steps")
    for step in steps:
        if not isinstance(step, dict):
            raise PolicyError(f"ci job {name} steps must be mappings")
        if "if" in step or "continue-on-error" in step:
            raise PolicyError(
                f"ci job {name} steps must be unconditional and fail closed"
            )

    checkout_inputs: dict[str, Any] = {
        "persist-credentials": False,
        "ref": "${{ github.event.pull_request.head.sha }}",
    }
    if name == "policy":
        checkout_inputs = {"fetch-depth": 0, **checkout_inputs}
    if steps[0] != {"uses": CHECKOUT_ACTION, "with": checkout_inputs}:
        raise PolicyError(f"ci job {name} checkout must be exact and credentialless")
    if steps[1] != expected_stage_step():
        raise PolicyError(f"ci job {name} must stage the exact head ephemerally")
    if steps[2] != expected_gate_step(name):
        raise PolicyError(f"ci job {name} must execute its exact required gate")


def validate_gate_scripts(root: Path) -> None:
    base = (
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n\n"
        'repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"\n'
        'cd "$repo_root"\n\n'
    )
    expected = {
        name: base + f"{DEPENDENCY_INSTALL}\n{NPM_SCRIPT_SHELL}\n{command}\n"
        for name, command in EXPECTED_GATE_COMMANDS.items()
    }
    expected["test"] += (
        'git diff --exit-code HEAD\ntest -z "$(git ls-files --others --exclude-standard)"\n'
    )
    expected["policy"] = (
        base
        + "event_args=()\n"
        + 'if [ "$#" -gt 0 ]; then\n'
        + '  event_args=(--event "$1")\n'
        + "fi\n\n"
        + "actionlint \\\n"
        + "  -config-file .github/actionlint.yaml \\\n"
        + '  -ignore \'specifying action "https://[^" ]+@[0-9a-f]+" in invalid format\' \\\n'
        + "  .forgejo/workflows/ci.yml\n"
        + "bash -n .forgejo/ci/*.sh\n"
        + "shellcheck .forgejo/ci/*.sh\n"
        + 'python hack/tier0_policy.py "${event_args[@]}"\n'
        + "python -m unittest discover -s test -p 'test_tier0_policy.py'\n"
        + "ruff format --check hack test/test_tier0_policy.py\n"
        + "ruff check hack test/test_tier0_policy.py\n"
    )
    script_dir = root / ".forgejo/ci"
    paths = {path.stem: path for path in script_dir.glob("*.sh")}
    if set(paths) != set(expected):
        raise PolicyError("Forgejo gate script inventory must be exact")
    for name, content in expected.items():
        path = paths[name]
        if path.read_text(encoding="utf-8") != content:
            raise PolicyError(f"Forgejo gate script {name} must be exact")
        if not path.stat().st_mode & stat.S_IXUSR:
            raise PolicyError(f"Forgejo gate script {name} must be executable")


def validate_package_contract(root: Path) -> None:
    if (root / ".npmrc").read_text(encoding="utf-8") != (
        "child-concurrency=1\nnetwork-concurrency=2\n"
    ):
        raise PolicyError(".npmrc must exactly match the approved CI-safe contract")
    package = load_json(root / "package.json")
    scripts = package.get("scripts")
    if not isinstance(scripts, dict):
        raise PolicyError("package.json scripts must be a mapping")
    expected = {
        "test": "node --test test/*.test.ts",
        "typecheck": "tsc --noEmit",
        "lint": "biome check",
        "format:check": "biome check",
        "check": "node scripts/protection-manifest.ts --check && npm run typecheck && npm run lint && npm run format:check",
        "verify": "npm run check && npm test",
    }
    for name, command in expected.items():
        if scripts.get(name) != command:
            raise PolicyError(f"package.json script {name} must remain exact")
        for prefix in ("pre", "post"):
            lifecycle_name = f"{prefix}{name}"
            if lifecycle_name in scripts:
                raise PolicyError(
                    f"package.json must not define protected hook {lifecycle_name}"
                )
    if not (root / "pnpm-lock.yaml").is_file():
        raise PolicyError("the pnpm lockfile is required")


def validate_ci_workflow(root: Path) -> None:
    path = root / ".forgejo/workflows/ci.yml"
    workflow = load_yaml(path)
    if set(workflow) != {"name", "on", "permissions", "env", "jobs"}:
        raise PolicyError("the required-check workflow shape must be exact")
    if workflow.get("name") != "ci":
        raise PolicyError("the required-check workflow must be named ci")
    if workflow_triggers(workflow) != {"pull_request": None}:
        raise PolicyError("ci must run unfiltered and only for pull requests")
    if workflow.get("permissions") != {"contents": "read"}:
        raise PolicyError("ci permissions must be read-only")
    if secret_context_expressions(workflow):
        raise PolicyError("pull-request CI must not receive secrets")
    if workflow.get("env") != {
        "NIX_CONFIG": (
            "accept-flake-config = true\n"
            "experimental-features = nix-command flakes\n"
            "fallback = true\n"
            "sandbox = false\n"
        )
    }:
        raise PolicyError("ci workflow environment must contain only pinned Nix config")

    jobs = workflow.get("jobs")
    if not isinstance(jobs, dict) or set(jobs) != set(CI_GATE_SPECS):
        raise PolicyError(f"ci jobs must be exactly {sorted(CI_GATE_SPECS)}")
    for name, job in jobs.items():
        validate_ci_job(name, job)


def validate_workflows(root: Path) -> None:
    workflow_dir = root / ".forgejo/workflows"
    active_paths = sorted(
        set(workflow_dir.glob("*.yml")) | set(workflow_dir.glob("*.yaml"))
    )
    if [path.name for path in active_paths] != ["ci.yml"]:
        raise PolicyError("ci.yml must be the only active Forgejo workflow")
    for path in active_paths:
        workflow = load_yaml(path)
        validate_action_pins(path, workflow)
        if "push" in workflow_triggers(workflow):
            raise PolicyError("Forgejo releaseProfile none forbids push workflows")
        if FORBIDDEN_FORGEJO_TEXT.search(path.read_text(encoding="utf-8")):
            raise PolicyError(
                f"Forgejo releaseProfile none forbids publishing in {path}"
            )
    validate_ci_workflow(root)


def validate_external_release_boundary(root: Path) -> None:
    path = root / ".github/workflows/publish.yml"
    if not path.is_file():
        raise PolicyError(
            "the external GitHub/npm release workflow must remain present"
        )
    forgejo_text = "\n".join(
        path.read_text(encoding="utf-8")
        for directory in (root / ".forgejo/workflows", root / ".forgejo/ci")
        for path in directory.rglob("*")
        if path.is_file()
    )
    if ".github/workflows/publish.yml" in forgejo_text:
        raise PolicyError(
            "Forgejo automation must not invoke the GitHub release boundary"
        )


def git(root: Path, *args: str) -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(root), *args],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except subprocess.CalledProcessError as error:
        raise PolicyError(error.stderr.strip() or "git command failed") from error


def validate_event(root: Path, event_path: Path) -> None:
    try:
        event = json.loads(event_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PolicyError(f"cannot parse event payload: {error}") from error
    pull_request = event.get("pull_request")
    if not isinstance(pull_request, dict):
        raise PolicyError("the policy workflow requires a pull_request event")
    base = pull_request.get("base")
    head = pull_request.get("head")
    if not isinstance(base, dict) or not isinstance(head, dict):
        raise PolicyError("pull_request event must contain base and head")
    base_ref = base.get("ref")
    if base_ref != "main" and not (
        isinstance(base_ref, str)
        and base_ref.startswith("release/")
        and len(base_ref) > len("release/")
    ):
        raise PolicyError("Tier-0 pull requests must target main or release/*")
    head_sha = head.get("sha")
    if not isinstance(head_sha, str) or not FULL_SHA.fullmatch(head_sha):
        raise PolicyError("pull_request head must be a full commit SHA")
    if git(root, "rev-parse", "HEAD") != head_sha:
        raise PolicyError("checked-out commit does not match the pull-request head")


def validate_repository(root: Path, event_path: Path | None = None) -> None:
    releases = root / "releases"
    if releases.exists() or releases.is_symlink():
        raise PolicyError("releaseProfile none forbids release declarations")
    validate_declaration(root)
    validate_codeowners(root)
    validate_workflows(root)
    validate_gate_scripts(root)
    validate_package_contract(root)
    validate_external_release_boundary(root)
    if event_path is not None:
        validate_event(root, event_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument("--event", type=Path)
    args = parser.parse_args()
    try:
        validate_repository(args.root.resolve(), args.event)
    except PolicyError as error:
        print(f"Tier-0 policy failed: {error}", file=sys.stderr)
        return 1
    print("Forgejo Tier-0/no-release policy passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
