#!/bin/sh
# Prints every failure in a TAP file as a workflow error, so that a failed Windows job says which test failed and why
# to somebody who cannot read its log.
#
# The job log of a workflow run can only be downloaded by an account with admin rights on the repository: without them
# `GET /actions/jobs/{id}/logs` answers 403 «Must have admin rights to Repository», and so does the log zip of the run.
# What is readable by anybody who can see the run at all is its annotations — `GET /check-runs/{id}/annotations` — and
# an annotation is what `::error::` makes. So a step that ends in «Process completed with exit code 1», which is the
# whole of what a failing test run leaves behind today, becomes one line per failing test with the assertion in it.
#
# This only reports; it never fails. The exit code of the test run is the step's own business, and a reporter that
# could fail a green run would be worse than no reporter. GitHub shows at most ten annotations per step, so ten is
# where this stops as well — the eleventh would be dropped by the other end anyway, and the count is printed instead.
set -u

tap=${1:-}
label=${2:-tests}
[ -n "$tap" ] && [ -f "$tap" ] || exit 0

awk -v label="$label" '
  # A workflow command is one line, and `%`, CR and LF are what has to be said in escapes for it to stay one line.
  function esc(s) {
    gsub(/%/, "%25", s)
    gsub(/\r/, "%0D", s)
    gsub(/\n/, "%0A", s)
    return s
  }
  function flush() {
    if (name == "") return
    found++
    if (found <= 10) printf "::error title=%s::%s\n", esc(label), esc(detail == "" ? name : name "\n" detail)
    name = ""
    detail = ""
  }
  /^not ok / {
    flush()
    name = $0
    sub(/^not ok [0-9]+ - /, "", name)
    inside = 1
    skipping = 0
    next
  }
  # The YAML block Node writes after a failing test ends in an indented `...` of its own.
  inside && /^[ \t]*\.\.\.[ \t]*$/ {
    inside = 0
    flush()
    next
  }
  inside {
    line = $0
    sub(/^[ \t]+/, "", line)
    # The stack is the longest part of the block and says the least about what went wrong; everything from it on is
    # left out. The rest — the message, what was expected, what came instead — is the point of this.
    if (line ~ /^stack:/) skipping = 1
    if (skipping) next
    if (line == "---" || line ~ /^(duration_ms|type|location|failureType):/) next
    # Long enough for an assertion message and what it compared, short enough to stay readable where it is shown.
    if (length(detail) < 1200) detail = detail (detail == "" ? "" : "\n") line
  }
  END {
    flush()
    if (found > 10) printf "::error title=%s::%d failures in all; the first ten are above\n", esc(label), found
  }
' "$tap"
