# ADR-033: Claude Code ↔ Codex CLI agent-context parity, enforced by a bash gate

## Status

Accepted.

## Context

HiveHive's instructions and workspace-agent config were Claude-Code-only: `CLAUDE.md`
at the repo root, `.claude/agents/senior-reviewer.md`, and
`.claude/skills/{analyze-pr,esp32-onboarding}/`. The sibling repo
`cofade/open-garden-planner` ([PR #300](https://github.com/cofade/open-garden-planner/pull/300))
added equivalent support for OpenAI's Codex CLI — a root `AGENTS.md`,
`.codex/config.toml` + `.codex/agents/*.toml`, and a `.agents/skills/` mirror — plus a
Python parity checker (`scripts/check_agent_context.py`, using `tomllib`) wired into
CI. Bringing Codex CLI support to HiveHive means someone (human or agent) working from
Codex sees the same rules, gates, and skills as someone working from Claude Code, and
any future drift between the two is caught automatically rather than silently
producing two agents that behave differently on the same repo.

A direct port of OGP's checker doesn't fit this repo's conventions. HiveHive's Python
floor is pinned to 3.10 for a documented historical reason ([ADR-029](adr-029-python-version-matrix-floated-pins.md),
issue #180 — a 3.11-only API crashed prod once already), so a `tomllib`-only (3.11+)
script would either need to run as a host-only CI tool (fine) or risk failing on a
contributor's machine via `make`/`.husky/pre-push` if their default `python3` resolves
to 3.10 (not fine, and inconsistent with every other repo-policy check in `scripts/`,
which is bash, triple-wired into `Makefile`/`.husky/pre-push`/the `repo-guards` CI job
— e.g. `check-python-twins.sh`).

`CLAUDE.md` was also already 35,686 bytes — over the 32768-byte `project_doc_max_bytes`
budget OGP configured (Codex's project-doc budget) — before this change added
anything, so mirroring it into `AGENTS.md` verbatim would need either a larger
declared budget or a trim. Several `CLAUDE.md` sections (the "Verifying UI claims"
rules, three "Critical rules" bullets, two "Dev helper scripts" gotchas, one "Run the
tests" paragraph) restated incident narratives that already live in full in
[chapter 11](../11-risks-and-technical-debt/README.md),
[`esp-reliability.md`](../06-runtime-view/esp-reliability.md),
[`troubleshooting.md`](../troubleshooting.md), and
[`ci-gates.md`](../10-quality-requirements/ci-gates.md) — duplicating exactly the kind
of content `CLAUDE.md`'s own "Updating documentation" rule says belongs solely in the
arc42 docs.

## Decision

- Keep `AGENTS.md` **byte-identical** to `CLAUDE.md`, not a thin Codex-specific pointer
  file — both agents must operate from literally the same rules, and a byte-diff is a
  trivially cheap, unambiguous parity check. Enforced by `scripts/check-agent-context.sh`.
- Trim `CLAUDE.md`'s duplicated-incident prose down to short pointers in the same
  change that introduces this parity requirement (35,686 → ~33.5KB) — every sentence
  removed was first verified (by grep, not assumption) to already live in full at the
  doc it now points to, and where it didn't, it was written there first (two cases:
  the PR #104 auto-close-keyword incident and the Windows LAN-reachability
  network-category/Group-Policy gotcha — see [chapter 11](../11-risks-and-technical-debt/README.md)
  and [`troubleshooting.md`](../troubleshooting.md) respectively). `.codex/config.toml`'s
  `project_doc_max_bytes` is set to `36864`, deliberately still above Codex's own
  documented built-in default of `32768` — see "Negative" below for why the remaining
  ~700 bytes were judged not worth cutting further.
- `.codex/config.toml` carries no `[mcp_servers.*]` entries. OGP's config wires two
  project-specific MCP servers (an embedded in-app server, GitHub Copilot's MCP);
  HiveHive has no equivalent embedded server today, and inventing placeholder MCP
  config would be speculative. Add entries once a real Codex MCP use case exists.
- `scripts/check-agent-context.sh` is bash, not Python, matching every other
  `scripts/check-*.sh` policy gate — modeled on `check-python-twins.sh`'s pair-diff
  pattern, triple-wired into `make check-agent-context`, `.husky/pre-push`, and the
  `repo-guards` CI job. It checks: (1) `CLAUDE.md`/`AGENTS.md` are byte-identical and
  `AGENTS.md` is under budget, (2) each `.claude/agents/*.md` matches its
  `.codex/agents/*.toml` (name/description/instructions, extracted from the
  respective frontmatter/TOML formats), (3) every skill directory named in
  `.gitignore`'s `.claude/skills/` allow-list has a byte-identical mirror under
  `.agents/skills/`. Deriving the skill list from `.gitignore`'s allow-list (rather
  than walking whatever exists on disk) turned out to be necessary in practice: a
  locally-installed host/plugin skill (`skill-creator`) is materialized under
  `.claude/skills/` on a real dev machine without being part of the repo, and would
  otherwise false-positive as "missing from `.agents/skills/`".
- No `HOST_ONLY_SKILLS`-style exclusion list in the script (unlike OGP's) — the
  `.gitignore`-allow-list approach above makes one unnecessary, since only
  project-owned, committed skills are ever compared.

## Consequences

**Positive**:

- Codex CLI (or any other `AGENTS.md`-reading agent) gets the same rules,
  critical-rules list, and doc-update obligations as Claude Code, with no separate
  maintenance burden — a `CLAUDE.md` edit that forgets `AGENTS.md` fails CI and
  pre-push, not silently.
- `.claude/agents/senior-reviewer.md` and `.codex/agents/senior-reviewer.toml` are
  guaranteed to carry the same review dimensions, severity discipline, and instructions
  text regardless of which CLI runs the review — though not necessarily the same
  underlying model: `.claude/agents/senior-reviewer.md` pins `model: opus` in its
  frontmatter, `check-agent-context.sh` does not compare that field, and
  `.codex/agents/senior-reviewer.toml` sets none (inherits whatever Codex's parent
  session is using). A Codex-run review is the same instructions on a possibly
  different model.
- `CLAUDE.md` itself got measurably leaner (~2.2KB net, even after adding the new
  "Claude/Codex context parity" section) by relocating duplicated incident narrative
  to the arc42 chapters that already owned it.

**Negative**:

- Every future `CLAUDE.md` edit is now two file edits in practice (`CLAUDE.md`, then
  copy to `AGENTS.md`) unless tooling automates the copy — currently manual, gated
  only by CI catching a forgotten copy after the fact, not before.
- `.codex/agents/senior-reviewer.toml`'s `developer_instructions` block is a
  hand-maintained copy of the `.md` body; the two formats (YAML frontmatter + Markdown
  body vs. TOML keys) can't literally share one source file, so
  `check-agent-context.sh`'s text-extraction (`awk`/`sed` against frontmatter markers
  and `'''`-delimited TOML strings) is inherently a bit more fragile than a straight
  `diff` — a structural edit to either file's shape (e.g. changing the frontmatter
  delimiter) needs a matching script update.
- `.codex/config.toml` shipping without MCP servers means Codex CLI on this repo
  currently has no MCP-backed tools beyond what it ships with by default; revisit once
  a concrete need exists.
- The byte-identical `CLAUDE.md`/`AGENTS.md` already carries one piece of Claude
  Code-specific mechanics verbatim: "Mandatory end-of-implementation gate" says
  "Invoke it via the Agent tool with `subagent_type: senior-reviewer`", which names a
  Claude Code tool-call shape Codex CLI doesn't have (Codex's own subagent-invocation
  mechanism differs). This is exactly the class of drift the "Forbidden: do not let
  `AGENTS.md` diverge" rule below is meant to keep out of the shared file — it's
  grandfathered in here because it predates this ADR and rewriting it correctly for
  both tools needs its own pass, not because the rule doesn't apply to it. A capable
  agent on either side can still infer the intent (run the senior-reviewer subagent);
  the risk is precision, not function.
- `CLAUDE.md`/`AGENTS.md` (~33.5KB) stays above Codex's own documented built-in
  `project_doc_max_bytes` default of `32768` by roughly 700 bytes, even after this
  change's trimming. `.codex/config.toml` declares `36864` to cover it, but that
  declaration itself only takes effect once Codex loads project-scoped `.codex/`
  config for this checkout — if it doesn't (an untrusted/first-run checkout, or a
  future Codex version that changes that behavior), Codex falls back to its own
  32768-byte default and silently truncates the tail of the file (currently the
  **Branch model** section and the second "Dev helper scripts" bench gotcha). The
  remaining gap was judged not worth closing by cutting further: the sections left
  above 32768 are the firmware-release "shipped twice" warning and the mandatory
  doc-update gate, both already trimmed once in this same change and both judged too
  operationally load-bearing to compress further without another verification pass.
  Revisit if Codex CLI's actual truncation behavior on this repo's real checkouts
  turns out to matter in practice.

**Forbidden**:

- **Do not** let `AGENTS.md` diverge from `CLAUDE.md`. If a change is genuinely
  Codex-only or Claude-only, it does not belong in either shared file — put it in the
  tool's own native config (`.codex/config.toml`, `.claude/settings.json`) instead.
- **Do not** hand-roll a Python-3.11-only check for this repo's policy gates;
  `scripts/` is bash-only for exactly this class of script (ADR-029's Python-floor
  rationale applies here too).
