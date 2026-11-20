// Token Radar's scoring model, release radar-2-comps.
//
// One sealed snapshot goes in; one ranked board comes out. The board always
// starts from the snapshot's watchlist — every watched slug is a row, and the
// watchlist is a floor, not a ceiling — then the early radar appends the
// strongest pre-token protocols sitting below the watchlist's TVL floor, so
// the rows this radar exists to surface are on the board at all.
//
// A protocol counts as pre-token when its snapshot record carries no token
// at all: no market cap, no CoinGecko id, no symbol. Protocols that already
// trade are never ranked; they are listed apart, at the market's own values.
//
// Nothing about a protocol's name steers its score. The whole model is
// arithmetic on the snapshot's own figures, recomputed on every run:
//
//   peers      trading protocols in the same category, each contributing its
//              market-cap / TVL ratio.
//   multiple   the category's median ratio; a thin category (fewer than five
//              peers) is pulled toward the global median with a prior weight
//              of five, so a single wild peer cannot set the price; the
//              result is clamped into [0.02, 1.50]. A category with no peer
//              at all borrows the global median.
//   value      tvl_usd x multiple, then three adjustments:
//              growth   — the 7-day change, clamped to [-60, 120], at half
//                         weight: 1 + growth/100 x 0.5
//              maturity — 0.6 + min(age, 1095)/1095 x 0.4, where age is the
//                         days since first listing, i.e. how long the
//                         protocol has run with no token on record; an
//                         unknown listing date counts as 365 days
//              reach    — 1 + 0.05 x min(chains - 1, 4): each extra chain is
//                         a little more distribution for a future token
//   implied    max(1, round(value))
//
// The dashboard prints this formula and recomputes every row from the same
// figures, so the page and the board can be checked against each other.

/** One protocol as the sealed snapshot records it: ten fields, no more. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document as a whole. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Every tunable number in the model, in one place, so the dashboard can state them. */
export interface ModelConstants {
  shrink_prior: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_max_extra: number;
}

export const MODEL: ModelConstants = {
  shrink_prior: 5,
  multiple_floor: 0.02,
  multiple_cap: 1.5,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.05,
  chain_max_extra: 4,
};

/** The model release the dashboard names and the rules quote. */
export const MODEL_VERSION = 'radar-2-comps';

/** Early rows: pre-token protocols below the watchlist floor, taken by TVL. */
export const EARLY_ROWS = 160;

/** Live rows: trading protocols shown apart, taken by market cap. */
export const LIVE_ROWS = 24;

/** One step of a farm plan: what to do, what it costs, how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    category_peers: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The compact row the dashboard reads, with its farm plan built in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

/** A protocol that already trades: the board shows the market's value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One category's comparables: the multiple and the peer count behind it. */
export interface CategoryComp {
  multiple: number;
  peers: number;
}

/** Everything the dashboard renders: board, live set, comps table, model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  global_multiple: number;
  comps: Record<string, CategoryComp>;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Thrown when the snapshot is not in the shape this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const MS_PER_DAY = 86_400_000;

/** `value` when it is a finite number, `fallback` otherwise. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The middle value of an ascending array; NaN when it is empty. */
function middleValue(ascending: number[]): number {
  const count = ascending.length;
  if (count === 0) return NaN;
  const half = Math.floor(count / 2);
  return count % 2 === 1 ? ascending[half]! : (ascending[half - 1]! + ascending[half]!) / 2;
}

/**
 * Whole days from `listedAt` to `asOf`, never below zero; null when either
 * date is missing or unparseable.
 */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / MS_PER_DAY));
}

/**
 * The comparables table, rebuilt from the snapshot on every run. For each
 * category it takes the median market-cap / TVL of the protocols in that
 * category that already trade, shrinks thin categories toward the global
 * median, and clamps the result into the model's band. A category with no
 * trading peer at all is left out here and borrows the global median later.
 */
export function categoryMultiples(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { comps: Map<string, CategoryComp>; global: number } {
  const ratiosByCategory = new Map<string, number[]>();
  const everyRatio: number[] = [];
  for (const protocol of snapshot.protocols) {
    if (protocol.mcap_usd === null || protocol.tvl_usd <= 0) continue;
    const ratio = protocol.mcap_usd / protocol.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    everyRatio.push(ratio);
    const key = protocol.category ?? 'Other';
    const bucket = ratiosByCategory.get(key);
    if (bucket === undefined) ratiosByCategory.set(key, [ratio]);
    else bucket.push(ratio);
  }
  everyRatio.sort((a, b) => a - b);
  const global = everyRatio.length > 0 ? middleValue(everyRatio) : 0.25;
  const comps = new Map<string, CategoryComp>();
  for (const [key, ratios] of ratiosByCategory) {
    ratios.sort((a, b) => a - b);
    const n = ratios.length;
    const med = middleValue(ratios);
    const shrunk = n >= model.shrink_prior ? med : (n * med + model.shrink_prior * global) / (n + model.shrink_prior);
    const multiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, shrunk));
    comps.set(key, { multiple, peers: n });
  }
  return { comps, global };
}

/** The comps entry a protocol's category carries, or the global median with no peers. */
export function multipleFor(
  protocol: SnapshotProtocol,
  comps: Map<string, CategoryComp>,
  global: number,
): CategoryComp {
  return comps.get(protocol.category ?? 'Other') ?? { multiple: global, peers: 0 };
}

/**
 * One protocol's score under the comps model: the implied value plus every
 * input that produced it, so the board and the dashboard can show the work.
 */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  comps: Map<string, CategoryComp>,
  global: number,
  model: ModelConstants = MODEL,
): {
  implied: number;
  multiple: number;
  peers: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const { multiple, peers } = multipleFor(protocol, comps, global);
  const rawGrowth = numOr(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), model.chain_max_extra);
  const chainMult = 1 + model.chain_step * extraChains;
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * chainMult));
  return { implied, multiple, peers, growthPct, growthMult, maturityMult, chainMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** True when a protocol's record carries no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** True when a protocol may be ranked: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocols keyed by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

/**
 * The ranked board: every watchlist slug first, then the early radar's
 * pre-token protocols below the watchlist floor, by TVL, capped at
 * EARLY_ROWS. A chosen protocol stays chosen — an early row never replaces
 * a watchlist row. Rows are scored, sorted by implied value with the slug
 * as the tie-break, and numbered 1..n.
 */
export function buildBoard(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { board: BoardRow[]; comps: Map<string, CategoryComp>; global: number } {
  const { comps, global } = categoryMultiples(snapshot, model);
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but the
  // board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) chosen.set(slug, found);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a replacement
  // for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, comps, global, model);
    return { p, v };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    model: {
      category_multiple: s.v.multiple,
      category_peers: s.v.peers,
      growth_pct: s.v.growthPct,
      growth_multiplier: roundTo4(s.v.growthMult),
      maturity_multiplier: roundTo4(s.v.maturityMult),
      chain_multiplier: roundTo4(s.v.chainMult),
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
  return { board, comps, global };
}

/** A number rounded to four decimals, for the board's model breakdown. */
const roundTo4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** One step as a single string: its action, then its cost and time, inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The category's one action, as a lookup table tried in order: the first
 * entry whose keyword appears in the category wins. The wording of each
 * action is the plan itself, so it never changes here — only the lookup does.
 */
const ACTION_TABLE: Array<{
  keywords: string[];
  write: (capital: number, name: string, chain: string) => string;
}> = [
  {
    keywords: ['lend', 'cdp', 'collateral'],
    write: (capital, name, chain) => `Supply $${capital} of USDC to ${name} on ${chain} and borrow a small amount against it to show both sides of the book.`,
  },
  {
    keywords: ['dex', 'leveraged farm', 'farm'],
    write: (capital, name, chain) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`,
  },
  {
    keywords: ['yield aggregator', 'yield'],
    write: (capital, name, chain) => `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and keep the shares.`,
  },
  {
    keywords: ['bridge', 'cross chain'],
    write: (capital, name, chain) => `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`,
  },
  {
    keywords: ['staking', 'restak'],
    write: (capital, name, chain) => `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`,
  },
  {
    keywords: ['perpetual', 'derivative', 'options'],
    write: (capital, name, chain) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedged trade.`,
  },
  {
    keywords: ['prediction'],
    write: (capital, name) => `Fund $${capital} and place one small market position on ${name}.`,
  },
  {
    keywords: ['curator', 'allocator', 'risk'],
    write: (capital, name, chain) => `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`,
  },
  {
    keywords: ['stable'],
    write: (capital, name, chain) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`,
  },
  {
    keywords: ['rwa'],
    write: (capital, name, chain) => `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it.`,
  },
  {
    keywords: ['insurance'],
    write: (capital, name, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`,
  },
  {
    keywords: ['payment'],
    write: (capital, name, chain) => `Route $${capital} of payments through ${name} on ${chain} over the farming window.`,
  },
  {
    keywords: ['launchpad'],
    write: (capital, name, chain) => `Commit $${capital} to the next ${name} launch on ${chain} and complete its tasks.`,
  },
];

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  for (const entry of ACTION_TABLE) {
    if (entry.keywords.some((k) => c.includes(k))) return entry.write(capital, p.name, chain);
  }
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains,
 * TVL, age), never from a hand-written list of names. Nothing here promises
 * a token or an airdrop: the protocol records no token, and farming is only
 * activity on the protocol itself.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const secondChain = p.chains.length > 1 ? ` Repeat the deposit on ${p.chains[1]} once, so more than one chain shows activity.` : '';
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.${secondChain}`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { board: BoardRow[]; radar: RadarData } {
  const { board, comps, global } = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const compsRecord: Record<string, CategoryComp> = {};
  for (const [key, value] of [...comps.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    compsRecord[key] = value;
  }
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    global_multiple: Math.round(global * 1e4) / 1e4,
    comps: compsRecord,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/**
 * Why a board is not one the gate will take, or null: coverage, ranks,
 * order, one shared implied value, and farm steps.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
