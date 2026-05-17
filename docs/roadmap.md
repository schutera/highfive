# Roadmap

Active and planned work is tracked via GitHub Issues and Milestones on
[schutera/highfive](https://github.com/schutera/highfive/issues).

## In-flight multi-PR series

A 3-PR series to clear cofade's open issues. Auto-close keywords
(`closes`, `fixes`, `resolves`) are intentionally avoided in this file —
GitHub matches them anywhere in a merging PR's body, which would
prematurely close the future-PR tickets when _any_ PR in the series
merges. Update the bullets as PRs land; delete this section when all
three are merged.

- **PR 1 — Dashboard side-list rework** (addresses #103, #102, #101):
  on `claude/analyze-github-issues-wiqYS` (the bullet's own closeout
  ships in PR 1's final commit)
- **PR 2 — Windows host parity** (addresses #100, #99): not started
- **PR 3 — `module_configs.updated_at` semantic split** (addresses
  #97): not started

Out of repo: #80 (nginx HSTS on production — server config, not a code
change here).
