#!/bin/bash
# dfa1e3df probe -- the F1 red is a WALL-CLOCK MARGIN failure, and this measures
# the margin as a dose-response rather than asserting it.
#
# The drain loop pays one injected-prompt latency per pass out of ONE shared
# budget, so `budget / latency` is the number of passes the budget affords. The
# test's non-vacuity assertion (`injections > 1`) needs at least two. A red
# therefore means the FIRST pass alone consumed the whole budget.
#
# Sweep A reproduces the ORIGINAL 200 ms budget: it walks the ratio down and
# shows where the assertion turns over.
# Sweep B holds the SHIPPED 1000 ms budget and raises the latency instead --
# i.e. it asks how far a nominal 20 ms prompt must stretch under load before the
# shipped test reds.
cd /workspace/projects/acpx/hp-r4-l4-drain || exit 1
[ "$HOME" = /home/node ] || { echo "unexpected HOME $HOME -- refusing"; exit 3; }
echo "grep identity: $(grep --version | head -1)"

run_row() {
  budget=$1
  latency=$2
  out=$(ACPX_PROBE_F1_BUDGET_MS="$budget" ACPX_PROBE_F1_LATENCY_MS="$latency" \
    node --test --test-name-pattern "F1: the drain backstop deadline is shared" \
    dist-test/test/mid-turn-injection.test.js 2>&1)
  rc=$?
  # -a: the runner's TAP output can carry NUL bytes. -F: literal, no anchors.
  green=$(printf '%s' "$out" | grep -a -c -F "# fail 0")
  detail=$(printf '%s' "$out" | grep -a -oE "more than one injection \(got [0-9]+\)" | head -1)
  printf '  budget=%-5s latency=%-5s ratio=%-4s rc=%-3s green=%s  %s\n' \
    "$budget" "$latency" "$((budget / latency))" "$rc" "$green" "$detail"
}

echo "A) original 200 ms budget, shrinking the ratio:"
for pair in "200 20" "60 20" "40 20" "20 20" "5 20"; do run_row $pair; done

echo "B) SHIPPED 1000 ms budget, stretching the prompt latency (= load):"
for pair in "1000 20" "1000 200" "1000 500" "1000 1000"; do run_row $pair; done
