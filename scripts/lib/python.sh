# shellcheck shell=bash
# scripts/lib/python.sh — one Python-interpreter probe for the whole repo.
#
# Source, do not execute:
#
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/python.sh"
#   if resolve_python; then "${PYTHON[@]}" -c 'import sys'; fi
#
# WHY THIS EXISTS (#273). Three scripts hand-rolled three probes with three
# different candidate lists and two validation techniques, so a Windows
# contributor's toolchain could satisfy two of them and fail the third with
# nothing shared to fix. The single-place-to-decide property is the point:
# whether `py -3` belongs at the head of the list is a judgement call, and it
# should be made once rather than three times.
#
# TWO RULES, both learned the hard way:
#
# 1. Probe by EXECUTING, never by `command -v` (#270). A default Windows
#    install ships %LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe, an App
#    Execution Alias stub whose only job is to open the Microsoft Store. It is
#    on PATH, so `command -v python3` succeeds on it, and a probe that stops
#    there picks the stub over a working `python` later in the list. Invoked,
#    it prints "Python was not found..." and exits non-zero.
#
# 2. `py -3` goes first. It is two words, which is why PYTHON is an ARRAY:
#    a string would need `# shellcheck disable=SC2086` at every call site to
#    stay splittable, and the repo runs shellcheck with `-S info`. The launcher
#    is the one interpreter a real python.org install on Windows always
#    provides, and it is never an alias stub — so it is the safest first try
#    on the platform where this goes wrong.
#
# On Linux and macOS `python3` is present and the first candidate simply fails,
# costing one failed exec.

# PYTHON is the resolved interpreter, as an array. Empty until resolve_python
# succeeds. Callers must expand it as "${PYTHON[@]}".
# shellcheck disable=SC2034  # read by the scripts that source this file
PYTHON=()

# The candidate list, in preference order. One list, one place to change it.
PYTHON_CANDIDATES=("py -3" "python3" "python" "py")

# Resolve an interpreter that actually runs. Returns 0 and sets PYTHON, or
# returns 1 and leaves PYTHON empty. Never exits: callers differ on whether a
# missing interpreter is fatal (ESP32-CAM/build.sh) or a skip
# (scripts/check-duckdb-bind-claims.sh), and that is their decision to make.
resolve_python() {
  local cand
  local -a try
  for cand in "${PYTHON_CANDIDATES[@]}"; do
    read -ra try <<<"$cand"
    if "${try[@]}" -c 'import sys' >/dev/null 2>&1; then
      PYTHON=("${try[@]}")
      return 0
    fi
  done
  return 1
}

# A human-readable rendering of the candidate list, for error messages.
python_candidates_tried() {
  local IFS=", "
  echo "${PYTHON_CANDIDATES[*]}"
}
