[![make.fun](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/kornztt/diff-speed/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/kornztt/diff-speed/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)

# diff-speed

A faster drop-in for makefun-diff 1.0.0: for each case's `{ old, new }` it
returns exactly the patch makefun-diff returns, as one JSON string — and does
it faster.

## How it works

`solve.js` re-implements makefun-diff's rule from scratch: lines cut after
every `\n`, the common prefix kept, then the common suffix, and between them
Myers's greedy search with make.fun's tie-break (the deletion wins when a
deletion and an insertion reach the same point), no edge pruning, snakes
followed as far as they go; the patch is then built with 3 kept lines of
context and hunks merged across gaps of at most 6 kept lines.

The speed comes from the search's representation, not from a different
search: the reference builds its edit script as a linked list of freshly
allocated objects, one or two per diagonal visit, so a case with a few
thousand edits churns millions of small objects through the collector. This
file keeps the same search, step for step, but records only one integer per
diagonal per depth — the old position reached — in flat `Int32Array` rows,
and rebuilds the script by walking that record backwards, re-applying the
same tie-break at every step. Lines are also interned to small integers
once, so the snake walks compare ints instead of re-scanning strings.

`main.ts` is the program the harness runs: it reads every case from
`/input/cases.json`, answers each one alone with `run()` from `solve.js`,
and writes `/output/answers.json`.

## Local check

With the kit unpacked, from the kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

On the practice set this scores 4/4 and reproduces byte for byte.

## License

MIT — see `LICENSE`.
