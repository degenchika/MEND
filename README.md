# MEND

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/degenchika/MEND/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/degenchika/MEND/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` reads a patch in unified diff, SEARCH/REPLACE, V4A, or JSON form and applies it to the tree of text files rooted at the working directory — creating, changing, moving, and deleting files — or writes nothing at all when any edit fails. Each edit's lines are found at the first of three matching tiers that has an occurrence: exact, then trailing whitespace stripped, then leading and trailing whitespace stripped (`--strict` forces exact matching only).

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is a patch file, or stdin when absent or `-`. Options: `--format=NAME` (`auto`, `unified`, `search-replace`, `v4a`, `json`; default `auto`, which detects V4A, then JSON, then SEARCH/REPLACE, then unified), `--check` (print what would change, write nothing), `--strict` (exact matching only). Exit 0 when every edit applied, exit 1 when any edit failed (nothing written), exit 2 for a usage error, an unreadable patch, or a malformed patch.

## Validation

The kit's `check.ts` runs the 100 public practice checks (30 unified, 20 SEARCH/REPLACE, 20 V4A, 15 JSON, 15 CLI) against `main.ts`. See the entry report for the score; the scored pool of 300 checks is sealed and includes kinds the practice set does not show, so the practice score is the only visible signal — it is not a guarantee of the final score.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cdzr1hpv&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
