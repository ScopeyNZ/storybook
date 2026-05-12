# Verify Harness — Security Model (v6 single-round)

## Threat surfaces

The harness accepts three inputs:

1. **PR diff** — fetched at base-checkout via `gh pr diff`, used by
   `verify-pr-generate` to build a prompt bundle. The diff is contributor-
   authored content fed into the LLM prompt; treat it as a prompt-injection
   vector but never as executable code at author-time.
2. **LLM-authored recipe** — emitted by the SDK dispatch in `verify-pr-author`,
   written to an ephemeral path inside the PR-head workspace
   (`$RUNNER_TEMP/pr-head/.verify-recipes/pr-<#>.spec.ts`). Not committed.
3. **PR-head source tree** — checked out into `$RUNNER_TEMP/pr-head` and
   executed by `yarn install` + `yarn nx compile` + Playwright. This is the
   same untrusted-contributor-code surface that already exists in normal PR
   CI.

The previous v5 / early-v6 model leaned on **committed-spec human review** as
the load-bearing trifecta breaker. v6 single-round drops that step: the agent
authors and executes its own output in the same workflow run, with no
intermediate maintainer commit. Be honest about what fills the gap.

## Lethal-trifecta breakers (single-round)

| # | Mitigation | Where enforced |
|---|---|---|
| 1 | **Scoped API key.** `ANTHROPIC_API_KEY` is mounted **only** on the `Author recipe` step's `env:` block. The `Verify PR` step that executes the recipe has no API key, and no `GITHUB_TOKEN` either. | `.github/workflows/verify-pr.yml`. |
| 2 | **Static deny-regex pass.** Blocks blatant prompt-injection / compromised-agent output before the spec lands on disk. Patterns: `child_process`, `fs.unlink*`, `fs.rm*`, `fsp.unlink*` / `fsp.rm*`, `process.exit`, `eval(`, `import 'node:*'`, `require('node:*')`, `require('child_process')`. Pure function, runs in-process inside the trusted base checkout before the candidate is renamed to its final path. | `scripts/verify/recipe-deny.ts`, called from `scripts/verify/recipe-author-core.ts`. |
| 3 | **Scoped lint gate.** `scripts/verify/lint-invocation.ts` runs ESLint with a pinned config against the candidate spec. Failures retry the agent once with categorised errors; a second failure aborts before the spec is published to the PR-head workspace. | `scripts/verify/recipe-author-core.ts`. |
| 4 | **Listener-before-goto + finally-attach regex checks.** Enforces the recipe-authoring contract structurally — listeners must be registered before `page.goto(...)`; `testInfo.attach('pageErrors'\|'consoleErrors', ...)` must appear inside a `finally` block. Both checked on every dispatched candidate. | `scripts/verify/recipe-author-core.ts`. |
| 5 | **Controlled output path.** `bundle.outputSpecPath` is computed by the trusted `verify-pr-generate` script (resolved from the `--output` flag the workflow passes) and consumed verbatim by `recipe-author-core.ts`. The LLM cannot influence where its output lands — it only fills the `<<<SPEC_START>>>` / `<<<SPEC_END>>>` fence. The path is always inside `$RUNNER_TEMP/pr-head/.verify-recipes/`, so any write stays inside the ephemeral runner workspace. | `scripts/verify-pr-generate.ts` + `scripts/verify/recipe-author-core.ts`. |
| 6 | **Header-comment provenance.** Every authored spec carries a block comment with `generatedAt`, `agentModel`, `runId`, `prNumber`, `referenceSpecs`, `triageGlobs`. Materialised into the runner workspace + uploaded as an artifact, so any post-mortem can replay the exact authoring inputs. | `scripts/verify/recipe-author-core.ts` (`buildProvenanceHeader`). |
| 7 | **Actor-permission gate.** The workflow runs only when the labeller has `write` access on the repo. This is the human-in-the-loop in single-round mode: a maintainer trusts the PR enough to apply `ci:verify`. | `.github/workflows/verify-pr.yml` — `Check actor permission` step. |
| 8 | **Label gate + non-draft.** `ci:verify` label must be present on a non-draft PR. Stops drive-by triggers from contributor-authored label-add events. | `.github/workflows/verify-pr.yml` job-level `if:`. |
| 9 | **Trusted-script provenance.** `verify-pr-generate`, `verify-pr-author`, `recipe-author-core`, `recipe-deny`, `lint-invocation`, the authoring-guide, and the canonical-smoke reference all read from the **base checkout** (the maintainer-merged `next` branch), not the PR head. A malicious PR cannot replace the deny-regex list or the lint config to weaken the gate. | `.github/workflows/verify-pr.yml` step ordering — base is checked out first; PR head is a separate `$RUNNER_TEMP/pr-head` tree. |

## What single-round explicitly gives up

- **No human review of the executed spec.** A maintainer applies `ci:verify`,
  but the spec the agent writes is not reviewed before execution. The deny-
  regex + lint + structural-pattern checks are the only filters between
  agent output and `playwright test` invocation.
- **No replay-by-default in version control.** The spec is artifact-only
  (uploaded as part of `verify-output-pr-<#>-<run_id>`, 14-day retention).
  After the artifact expires, the only authoritative replay path is
  re-running the harness on the same PR sha (regenerates a fresh spec; not
  byte-identical even with a stable model, since `generatedAt` and the
  prompt contents shift).

If either of those is unacceptable for a given PR class, fall back to the
local-dev path: `yarn verify-pr-generate --pr <#>` → invoke the
`verify-recipe-author` skill under human review → commit
`.verify-recipes/pr-<#>.spec.ts` → re-fire `ci:verify`. The skill remains
the supported authoring entry point for ambiguous changes.

## v6 isolation posture

v6 runs both the authoring step and the verify step on a stock GitHub
Actions ephemeral runner — **the same isolation profile as the existing
Storybook PR CI**, which already executes untrusted contributor code as
part of normal test runs. No Docker, no Verdaccio, no sandbox-runtime.

The previous v5-0 container (`--cap-drop ALL`, `--network=none`,
`--read-only`, `--tmpfs`, `--user 1000:1000`) was dropped because:

- The supply-chain ceremony it added (digest pins, harden-build-context
  overlay, lifecycle-script stripping, Verdaccio publish pipeline) was
  asymmetric to the runtime risk. `enableScripts: false`, the
  committed lockfile, and the `.npmrc` purge already cover that
  surface.
- The container's runtime isolation flags addressed a threat
  (untrusted-PR code execution with cross-tenant blast radius) that
  doesn't apply to a per-PR ephemeral runner.
- BuildKit's layer-isolation behaviour proved fragile across 11
  firetest rounds — `code/core/dist` repeatedly disappeared between
  stages.

## When to add stronger isolation

If the threat model expands to processing third-party PRs at scale
with adversarial recipe authors, wrap the playwright test step in
`sandbox-runtime` (bubblewrap on Linux) — ~10 lines of config per
Anthropic's "Securely deploying AI agents" doc. Do **not** reintroduce
the full Docker + Verdaccio stack.

Network egress on the runner is unrestricted today (matching the rest of
upstream CI). If the deny-regex + lint gates are ever judged insufficient,
the simplest hardening is a runner-level egress allowlist (npm registry,
GitHub, Playwright browser CDN) rather than container reintroduction.

## Sensitive-path exclusion

Local `.claude/settings.json` deny rules block the Claude Code agent
from reading/writing `.env`, SSH/AWS/GCP/Azure credentials, npm/pypi
auth tokens, PEM/key files, and the git credential store. These apply to
**local-dev** runs of the `verify-recipe-author` skill. They do **not**
apply to the CI single-round path, which uses the Anthropic SDK directly
(`verify-pr-author --dispatch-mode sdk`) and never instantiates a
Claude Code agent loop.

`.dockerignore` keeps the same exclusion set even though no Docker
image is built today — the file is preserved so any future
`docker build` from the repo root (e.g. local debugging) stays safe.
