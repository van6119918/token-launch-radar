# Token Radar — Build the best token launch radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/van6119918/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/van6119918/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token-launch radar for make.fun's `token-radar-01` bounty: it reads a sealed
DefiLlama snapshot, ranks the protocols that record no token by an implied
value, and hands in a static dashboard a reader can use — a ranked board, a
detail view for every protocol, and filters — plus a concrete farm plan for
each protocol.

## How implied value is computed (model `radar-2-comps`)

No protocol name is ever special-cased and no multiple is hardcoded. Every
number comes from the snapshot itself, recomputed on every run:

1. **Category comparables.** For each category, the multiple is the median
   market-cap / TVL of the protocols in that same category that already trade.
   A category with fewer than 5 trading peers is shrunk toward the global
   median (0.214x on this snapshot, 144 trading peers) with a pseudo-count of
   5, so one wild peer cannot set the multiple. Every multiple is clamped to
   0.02x–1.50x. A category with no trading peer takes the global median.
   Examples on this snapshot: Dexs 0.342x (11 peers), Lending 0.132x (15),
   RWA 0.275x (9), Canonical Bridge 0.746x (8), Liquid Staking 0.034x (11).
2. **Base.** `tvl_usd × category multiple`.
3. **Growth.** `1 + clamp(change_7d, -60, 120) / 100 × 0.5` — a protocol whose
   TVL grew over the last seven days is worth more than one that shrank.
4. **Maturity.** `0.6 + min(age_days, 1095) / 1095 × 0.4` — age is the time
   since the protocol was first listed, i.e. how long it has run with no token
   on record; an unlisted age uses 365 days.
5. **Reach.** `1 + 0.05 × min(chains − 1, 4)` — each extra chain the protocol
   runs on is a little more distribution for a future token.

`implied = max(1, round(base × growth × maturity × reach))`

The board covers all 40 watchlist protocols (TVL ≥ $50M, no token on record,
not a wrapped/staked/bridged product of a traded token) and adds the 160
pre-token protocols below the floor with the most TVL, for 200 rows. The
dashboard shows the 24 largest live-token protocols separately, with their
market caps — the market's own values, never mixed into the ranking.

## Farm plans

Each row carries six steps, derived from the protocol's own record (category,
chains, TVL, age): a fresh wallet, the category's action with a concrete
capital amount and gas cost, a weekly qualifying action, a hold period, how to
check the protocol's own points page, and a farm log. Nothing here promises a
token or an airdrop: the protocol records no token, and farming is only
activity on the protocol itself.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22.18+ (standard library only, no install). `main.ts` reads
`/input/snapshot.json` by default, writes `board.json`, `data.js`,
`dashboard/` and `screenshots/` to the output directory, and writes
`dossier.json` with the vendored `vendor/makefun-board.ts` library. Run it
twice and the bytes are identical.

## Files

- `main.ts` — entrypoint: snapshot in, board + dashboard + dossier out.
- `lib/model.ts` — the comps model, farm plans, board validation.
- `vendor/makefun-board.ts` — make.fun's dossier library (copied from the kit).
- `dashboard/` — the static page: `index.html`, `app.css`, `app.js`.
- `screenshots/` — the board, a protocol detail view, a filtered view.

---

<sub>Entered on [make.fun](https://make.fun/?ref=eaa6wt68&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
