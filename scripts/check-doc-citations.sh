#!/usr/bin/env bash
# Scan docs/ and CLAUDE.md for `path:line` citations to source files,
# then read each cited path at the cited line and print a 3-column
# report. Exits non-zero if any cited file is missing or any cited
# line is past the file's current length / blank.
#
# This is the gate the chapter-11 "Drift sweep is not a substitute for
# a CI check" lesson promises. Wired via `make check-citations` and the
# husky pre-push hook.
#
# Caveats:
#   * Heuristic only — it can flag missing/EOF/blank lines but not
#     "shifted but still in valid territory" cases. A line that drifted
#     from a function call to a closing brace will still match here.
#     Humans inspect the report alongside.
#   * Source extensions covered: cpp h ts tsx js jsx py ino. Add more
#     here as needed.

set -uo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

# Match `path/to/file.ext:NNN`. Use git grep so .gitignore is honoured.
# `|| true` because git grep returns 1 on no matches, which set -e would treat as fatal.
matches=$(git grep -nIE \
    '[A-Za-z0-9_./-]+\.(cpp|h|ts|tsx|js|jsx|py|ino):[0-9]+' \
    -- 'docs/' 'CLAUDE.md' 2>/dev/null || true)

if [[ -z "$matches" ]]; then
  echo "check-doc-citations: no path:line citations found in docs/ or CLAUDE.md."
  exit 0
fi

fail=0
ok_count=0
problem_count=0

while IFS= read -r line; do
  # `line` is of the form: docs/foo.md:42:  ... `client.cpp:283` ...
  doc_path="${line%%:*}"
  rest="${line#*:}"
  doc_line="${rest%%:*}"
  body="${rest#*:}"

  # Pull every path:line citation out of the body — there can be more than one.
  while IFS= read -r cited; do
    [[ -z "$cited" ]] && continue
    cited_path="${cited%:*}"
    cited_line_num="${cited##*:}"

    # Re-anchor relative paths to the repo root if possible.
    if [[ ! -f "$cited_path" ]]; then
      # Try to find a unique match by basename. Bail on collisions —
      # silently picking the first hit would resolve to the wrong file
      # and report misleading content. Force the citation to be
      # repo-relative when this triggers.
      basename_only="${cited_path##*/}"
      candidates=$(git ls-files "**/$basename_only" 2>/dev/null || true)
      candidate_count=$(echo "$candidates" | grep -c . || true)
      if [[ "$candidate_count" == "1" ]]; then
        cited_path="$candidates"
      elif [[ "$candidate_count" -gt 1 ]]; then
        printf '  %-46s -> %-40s AMBIGUOUS (basename matches %d files; cite repo-relative path)\n' \
          "$doc_path:$doc_line" "$cited" "$candidate_count"
        problem_count=$((problem_count + 1))
        fail=1
        continue
      fi
    fi

    if [[ ! -f "$cited_path" ]]; then
      printf '  %-46s -> %-40s MISSING (file not found)\n' \
        "$doc_path:$doc_line" "$cited"
      problem_count=$((problem_count + 1))
      fail=1
      continue
    fi

    total=$(wc -l <"$cited_path" | tr -d ' ')
    if (( cited_line_num < 1 || cited_line_num > total )); then
      printf '  %-46s -> %-40s PAST_EOF (file has %d lines)\n' \
        "$doc_path:$doc_line" "$cited" "$total"
      problem_count=$((problem_count + 1))
      fail=1
      continue
    fi

    content=$(sed -n "${cited_line_num}p" "$cited_path")
    trimmed="${content//[$' \t']/}"
    if [[ -z "$trimmed" ]]; then
      # Warning, not a failure — the chapter-11 lessons-learned narrative
      # legitimately quotes old citations as examples of past drift, and
      # those will sometimes land on blank lines after the source moves on.
      printf '  %-46s -> %-40s BLANK_LINE (warn)\n' \
        "$doc_path:$doc_line" "$cited"
      problem_count=$((problem_count + 1))
      continue
    fi

    # Ok — print a brief preview of the cited content so a human can spot
    # obvious "drifted but valid" cases (closing braces, blank-ish lines).
    preview=$(echo "$content" | head -c 70)
    printf '  %-46s -> %-40s OK :: %s\n' \
      "$doc_path:$doc_line" "$cited" "$preview"
    ok_count=$((ok_count + 1))
  done < <(echo "$body" | grep -oE '[A-Za-z0-9_./-]+\.(cpp|h|ts|tsx|js|jsx|py|ino):[0-9]+' || true)
done <<< "$matches"

echo
echo "check-doc-citations: $ok_count OK, $problem_count problem(s)."
echo "  • Visually scan the OK rows for citations that drifted to a"
echo "    closing brace, comment, or unrelated line."
echo "  • Prefer 'path's <symbol>' over 'path:line' for named symbols."
exit $fail
