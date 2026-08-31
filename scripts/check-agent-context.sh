#!/usr/bin/env bash
# check-agent-context.sh — keep Claude Code and Codex CLI in sync so both
# agents receive the same project context (open-garden-planner PR #300
# prior art; see CLAUDE.md "Claude/Codex context parity").
#
# Three checks, none of which mutate the repo:
#   1. CLAUDE.md and AGENTS.md are byte-identical, and AGENTS.md fits the
#      project_doc_max_bytes budget declared in .codex/config.toml.
#   2. Each .claude/agents/<name>.md has a matching .codex/agents/<name>.toml
#      with the same name/description/instructions (frontmatter vs TOML
#      keys — currently just senior-reviewer, written generically so a
#      second agent definition doesn't silently skip the check).
#   3. Every skill directory under .claude/skills/ has a byte-identical
#      mirror under .agents/skills/, and vice versa.
#
# Run from `make check-agent-context`, the husky pre-push hook, and the
# `repo-guards` CI job — same triple-wiring as check-python-twins.sh.

set -uo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root" || exit 1

fails=()

# --- 1. CLAUDE.md <-> AGENTS.md --------------------------------------------

check_root_docs() {
  local claude="CLAUDE.md" codex="AGENTS.md" config=".codex/config.toml"

  if [[ ! -f "$claude" ]]; then
    fails+=("missing $claude")
    return
  fi
  if [[ ! -f "$codex" ]]; then
    fails+=("missing $codex (Codex CLI's equivalent of CLAUDE.md — see 'Claude/Codex context parity')")
    return
  fi
  if ! diff -q "$claude" "$codex" >/dev/null 2>&1; then
    fails+=("$claude and $codex differ — they must be byte-identical:"$'\n'"$(diff -u "$claude" "$codex" | sed 's/^/    /')")
  fi

  if [[ ! -f "$config" ]]; then
    fails+=("missing $config")
    return
  fi
  local max_bytes
  # Anchor to the right of '=' and strip '_' — TOML allows digit-group
  # separators (e.g. `40_960`), and a bare [0-9]+ grep would read that as
  # just `40`.
  max_bytes="$(grep -E '^[[:space:]]*project_doc_max_bytes[[:space:]]*=' "$config" | sed -E 's/^[^=]*=[[:space:]]*([0-9_]+).*/\1/' | tr -d '_' | head -1)"
  # A non-numeric or missing value must be a hard failure, not silently
  # skipped: `[[ "$size" -gt "$max_bytes" ]]` on a non-numeric right-hand
  # side raises a bash "syntax error: operand expected" that isn't caught
  # by `set -uo pipefail` (no -e), so without this guard the budget check
  # silently no-ops and the script still reports OK.
  if [[ -z "$max_bytes" || ! "$max_bytes" =~ ^[0-9]+$ ]]; then
    fails+=("$config has no positive integer project_doc_max_bytes")
    return
  fi
  local size
  size="$(wc -c < "$codex" | tr -d '[:space:]')"
  if [[ "$size" -gt "$max_bytes" ]]; then
    fails+=("$codex is $size bytes, exceeds the Codex project_doc_max_bytes budget of $max_bytes ($config) — trim CLAUDE.md (and re-copy to AGENTS.md) or raise the budget deliberately")
  fi
}

# --- 2. .claude/agents/*.md <-> .codex/agents/*.toml ------------------------

compare_agent_pair() {
  local md="$1" toml="$2" stem="$3"
  local q3="'''"

  local fm_end
  fm_end="$(awk '/^---$/{c++; if (c==2) {print NR; exit}}' "$md")"
  if [[ -z "$fm_end" ]]; then
    fails+=("agent $stem: $md has no closing frontmatter '---' line")
    return
  fi

  local md_name md_desc toml_name toml_desc
  md_name="$(sed -n "2,$((fm_end - 1))p" "$md" | grep -m1 '^name:' | sed 's/^name:[[:space:]]*//')"
  md_desc="$(sed -n "2,$((fm_end - 1))p" "$md" | grep -m1 '^description:' | sed 's/^description:[[:space:]]*//')"
  toml_name="$(grep -m1 '^name = ' "$toml" | sed -E 's/^name = "(.*)"$/\1/')"
  # Unescape the two realistic cases for a plain descriptive sentence
  # (\" and \\) — not a full TOML basic-string unescaper, but enough that a
  # literal double quote or backslash in the description doesn't produce a
  # false "description differs" against the unescaped .md frontmatter text.
  toml_desc="$(grep -m1 '^description = ' "$toml" | sed -E 's/^description = "(.*)"$/\1/' | sed -e 's/\\"/"/g' -e 's/\\\\/\\/g')"

  if [[ "$md_name" != "$toml_name" ]]; then
    fails+=("agent $stem: name differs ('$md_name' in $md vs '$toml_name' in $toml)")
  fi
  if [[ "$md_desc" != "$toml_desc" ]]; then
    fails+=("agent $stem: description differs between $md and $toml")
  fi

  local di_start di_end
  di_start="$(grep -n "^developer_instructions = ${q3}\$" "$toml" | head -1 | cut -d: -f1)"
  if [[ -z "$di_start" ]]; then
    fails+=("agent $stem: $toml has no developer_instructions = '''...''' opening line")
    return
  fi
  # Anchor to the FIRST closing ''' strictly after the opening line, not the
  # last ''' in the file — a later TOML key (e.g. a future `model = '''...'''`)
  # would otherwise get silently absorbed into the extracted body. This also
  # closes the gap where a bare `'''` line inside the instructions text would
  # make the TOML itself fail to parse while this check still reported OK:
  # anchoring here means the extracted range can never contain such a line,
  # so a body that would break TOML instead shows up as a legitimate
  # "instructions differ" diff against the .md source of truth.
  di_end="$(awk -v start="$di_start" -v pat="$q3" 'NR>start && $0==pat {print NR; exit}' "$toml")"
  if [[ -z "$di_end" ]]; then
    fails+=("agent $stem: $toml's developer_instructions = '''...''' block has no closing '''")
    return
  fi

  local md_body toml_body
  md_body="$(mktemp)"
  toml_body="$(mktemp)"
  tail -n +"$((fm_end + 1))" "$md" | sed -e '1{/^$/d}' >"$md_body"
  sed -n "$((di_start + 1)),$((di_end - 1))p" "$toml" >"$toml_body"

  # TOML literal strings can't contain ''' anywhere, not just as a whole
  # line — a MID-line occurrence (e.g. "...write ''' here.") still breaks
  # the actual .toml file even though it doesn't match the whole-line
  # `di_end` anchor above, so the line-based extraction alone can't catch
  # it. Scan the extracted body directly for the delimiter as a substring.
  if grep -qF "$q3" "$toml_body"; then
    fails+=("agent $stem: $toml's developer_instructions body contains a ''' sequence, which is not valid inside a TOML literal string — even though it doesn't sit on its own line")
    rm -f "$md_body" "$toml_body"
    return
  fi

  if ! diff -q "$md_body" "$toml_body" >/dev/null 2>&1; then
    fails+=("agent $stem: instructions differ between $md and $toml:"$'\n'"$(diff -u "$md_body" "$toml_body" | sed 's/^/    /')")
  fi
  rm -f "$md_body" "$toml_body"
}

check_agents() {
  local claude_root=".claude/agents" codex_root=".codex/agents"
  shopt -s nullglob
  local claude_files=("$claude_root"/*.md)
  local codex_files=("$codex_root"/*.toml)
  shopt -u nullglob

  declare -A claude_stems=()
  local f stem
  for f in "${claude_files[@]}"; do
    stem="$(basename "$f" .md)"
    claude_stems["$stem"]="$f"
  done
  declare -A codex_stems=()
  for f in "${codex_files[@]}"; do
    stem="$(basename "$f" .toml)"
    codex_stems["$stem"]="$f"
  done

  # Both sides empty must fail, not silently pass — otherwise deleting (or
  # renaming out from under) the only agent definition on both sides at
  # once leaves nothing for the loops below to compare, and the check
  # reports OK on a repo with no agent parity to certify at all.
  if [[ ${#claude_stems[@]} -eq 0 && ${#codex_stems[@]} -eq 0 ]]; then
    fails+=("no agent definitions found in $claude_root or $codex_root — nothing to check")
    return
  fi

  for stem in "${!claude_stems[@]}"; do
    if [[ -z "${codex_stems[$stem]:-}" ]]; then
      fails+=("agent missing from $codex_root: $stem.toml")
    fi
  done
  for stem in "${!codex_stems[@]}"; do
    if [[ -z "${claude_stems[$stem]:-}" ]]; then
      fails+=("agent missing from $claude_root: $stem.md")
    fi
  done
  for stem in "${!claude_stems[@]}"; do
    [[ -n "${codex_stems[$stem]:-}" ]] || continue
    compare_agent_pair "${claude_stems[$stem]}" "${codex_stems[$stem]}" "$stem"
  done
}

# --- 3. .claude/skills/<name> <-> .agents/skills/<name> --------------------

check_skills() {
  local claude_root=".claude/skills" codex_root=".agents/skills"

  # The set of project-owned skills is defined by .gitignore's allow-lists
  # (the `!.claude/skills/<name>/` and `!.agents/skills/<name>/`
  # exceptions), not by whatever happens to be materialized on disk — a
  # host-provided/plugin skill (e.g. an installed `skill-creator`) can
  # exist locally under either path without being part of this repo, and
  # must not be treated as drift. Deriving BOTH directions from .gitignore
  # (rather than one from .gitignore and the other from a directory glob)
  # matters: a glob-driven reverse check reintroduces the exact false-flag
  # this forward check exists to avoid, the moment a host/plugin skill
  # lands under .agents/skills/ instead of .claude/skills/.
  local claude_names codex_names
  claude_names="$(grep -oE '^!\.claude/skills/[^/]+/$' .gitignore | sed -E 's#^!\.claude/skills/([^/]+)/$#\1#' | sort -u)"
  codex_names="$(grep -oE '^!\.agents/skills/[^/]+/$' .gitignore | sed -E 's#^!\.agents/skills/([^/]+)/$#\1#' | sort -u)"

  if [[ -z "$claude_names" && -z "$codex_names" ]]; then
    fails+=(".gitignore has no '!.claude/skills/<name>/' or '!.agents/skills/<name>/' entries — nothing to check")
    return
  fi

  local only_claude only_codex both
  only_claude="$(comm -23 <(echo "$claude_names") <(echo "$codex_names"))"
  only_codex="$(comm -13 <(echo "$claude_names") <(echo "$codex_names"))"
  both="$(comm -12 <(echo "$claude_names") <(echo "$codex_names"))"

  local name
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    fails+=(".gitignore allow-lists .claude/skills/$name/ but not .agents/skills/$name/ — add '!.agents/skills/$name/'")
  done <<<"$only_claude"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    fails+=(".gitignore allow-lists .agents/skills/$name/ but not .claude/skills/$name/ — add '!.claude/skills/$name/'")
  done <<<"$only_codex"

  local claude_dir codex_dir diff_out
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    claude_dir="$claude_root/$name"
    codex_dir="$codex_root/$name"
    if [[ ! -d "$claude_dir" ]]; then
      fails+=("$claude_dir is in .gitignore's allow-list but does not exist")
      continue
    fi
    if [[ ! -d "$codex_dir" ]]; then
      fails+=("$codex_dir is in .gitignore's allow-list but does not exist")
      continue
    fi
    if ! diff_out=$(diff -rq "$claude_dir" "$codex_dir" 2>&1); then
      fails+=("skill content differs: $name"$'\n'"$(echo "$diff_out" | sed 's/^/    /')")
    fi
  done <<<"$both"
}

check_root_docs
check_agents
check_skills

if [[ ${#fails[@]} -gt 0 ]]; then
  echo "check-agent-context: FAIL — Claude Code and Codex CLI context has drifted:"
  echo ""
  for f in "${fails[@]}"; do
    echo "- $f"
  done
  echo ""
  echo "  CLAUDE.md and AGENTS.md must stay byte-identical, .claude/agents/*.md and"
  echo "  .codex/agents/*.toml must carry the same name/description/instructions, and"
  echo "  .claude/skills/ and .agents/skills/ must mirror each other. See CLAUDE.md"
  echo "  'Claude/Codex context parity'."
  exit 1
fi

echo "check-agent-context: OK — CLAUDE.md/AGENTS.md, agent definitions, and skill mirrors all match."
exit 0
