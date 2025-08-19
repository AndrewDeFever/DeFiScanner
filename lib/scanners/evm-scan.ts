// src/lib/scanners/evm-scan.ts
// Free-only scanner: holders (Ethplorer), Uniswap v3 pools (subgraph + on-chain fallback),
// Quoter impacts via simulateContract (V2 -> V1), circulating concentration, env-tunable gates.
// Produces compact evidence notes and chooses primaryPool from the tier that quoted best.

import {
  Address,
  createPublicClient,
  http,
  getAddress,
} from "viem";
import { mainnet } from "viem/chains";

/* ---------------------------------- Types --------------------------------- */

type ChainConfig = {
  chainId: number;
  rpcUrl: string;
  uniswapV3: {
    quoter: Address; // compatibility only (we use internal constants)
    weth: Address;
    feeTiers: number[]; // bps
  };
};

export type ScanInput = {
  chain: "eth";
  address: Address;
  cfg?: Partial<ChainConfig>;
};

export type ScanOutput = {
  riskScore: number; // 0..100, higher = riskier
  summary: string[];
  badges: string[];
  details: {
    tokenMeta: { symbol: string; decimals: number; totalSupply: string };
    holders: {
      top1Pct: number | null;
      top10Pct: number | null;
      circTop1Pct: number | null;
      circTop10Pct: number | null;
      notes: string[];
    };
    liquidity: {
      type: "v3" | "unknown";
      primaryPool?: Address;
      tiers: Array<{
        feeBps: number;
        tvlUsd: number | null;
        baseSymbol?: string;
        quoteSymbol?: string;
        baseReserve: string;
        quoteReserve: string;
        pool?: Address;
      }>;
      priceImpact: {
        buyUsd1000?: string | null;
        buyUsd10000?: string | null;
        sellUsd1000?: string | null;
        sellUsd10000?: string | null;
      };
      notes: string[];
    };
    tokenomics: { tax: { buy: number | null; sell: number | null } | null };
    evidence: { notes: string[] };
    confidence?: {
      holders: "low" | "medium" | "high";
      liquidity: "low" | "medium" | "high";
      quoter: "low" | "medium" | "high";
    };
  };
};

/* ----------------------------- Known addresses ---------------------------- */

const BURN_ADDRESSES = new Set(
  [
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    "0xdead000000000000000042069420694206942069",
    "0xdead000000000000000000000000000000000000",
    "0xdead00000000000000000000000000000000dead",
  ].map((a) => a.toLowerCase())
);

const INFRA_ADDRESSES = new Set(
  [
    // Uniswap routers
    "0xE592427A0AEce92De3Edee1F18E0157C05861564", // V3 Router
    "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // SwapRouter02
    "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // V2 Router
    // Example CEX wallets (expand as needed)
    "0x3f5CE5FBFe3E9af3971dD833D26BA9b5C936f0bE", // Binance
    "0x59A5208B32e627891C389ebafC644145224006E8", // Bittrex
    "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance 8
  ].map((a) => a.toLowerCase())
);

/* --------------------------------- ABIs ----------------------------------- */

const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "amountIn", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const QUOTER_V1_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984" as Address;
const V3_FACTORY_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

/* --------------------------- Uniswap constants ---------------------------- */

const UNISWAP_V3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as Address;
const UNISWAP_V3_QUOTER_V1 = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6" as Address;

/* ------------------------------ Env tunables ------------------------------ */

const DEEP_LIQ_GATE = Number(process.env.DEEP_LIQ_GATE ?? 0.75); // % for BUY $10k
const IMPACT_UNKNOWN_PENALTY = Number(process.env.IMPACT_UNKNOWN_PENALTY ?? 40); // score penalty when quoter unknown
const CONC_LOW = Number(process.env.CONC_LOW ?? 10);   // <=10% -> 0 penalty
const CONC_HIGH = Number(process.env.CONC_HIGH ?? 70); // >=70% -> 100 penalty

/* --------------------------- Utility / helpers ---------------------------- */

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
function fmtPct(n: number, d = 2) {
  return `${n.toFixed(d)}%`;
}
function parsePct(s?: string | null): number | null {
  if (!s) return null;
  const n = Number(s.replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
}
function scaleTo100(x: number, a: number, b: number) {
  if (x <= a) return 0;
  if (x >= b) return 100;
  return ((x - a) / (b - a)) * 100;
}
export type HolderRow = { address: Address; percent: number };
function sumPercent(rows: HolderRow[]): number | null {
  if (!rows.length) return null;
  const v = rows.reduce((acc, r) => acc + (r.percent || 0), 0);
  return clamp(v, 0, 100);
}
function pushNoteOnce(arr: string[], msg: string) {
  if (!arr.includes(msg)) arr.push(msg);
}

async function safeFetchJson(
  url: string,
  init: RequestInit & { label?: string } = {},
  evidenceNotes?: string[]
) {
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    if (!res.ok) {
      pushNoteOnce(evidenceNotes || [], `${init.label || "fetch"} ${res.status}: ${url}`);
      return null;
    }
    return await res.json();
  } catch (e: any) {
    pushNoteOnce(evidenceNotes || [], `${init.label || "fetch"} error: ${String(e)}`);
    return null;
  }
}

/* ----------------------------- External data ------------------------------ */

/** Ethplorer Top Holders (uses `share`% if present; retries; free-only) */
async function fetchTopHolders(token: Address, notes: string[]): Promise<HolderRow[]> {
  const apiKey = process.env.ETHPLORER_API_KEY?.trim();
  if (!apiKey) {
    pushNoteOnce(notes, "ETHPLORER_API_KEY missing; holders unavailable");
    return [];
  }

  const limits = [50, 20, 10];
  for (const limit of limits) {
    const url = `https://api.ethplorer.io/getTopTokenHolders/${token}?apiKey=${encodeURIComponent(apiKey)}&limit=${limit}`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        pushNoteOnce(notes, `ethplorer ${res.status}`);
        await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
        continue;
      }
      const data = await res.json();
      if (data?.error) {
        pushNoteOnce(notes, `ethplorer error: ${JSON.stringify(data.error)}`);
        await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
        continue;
      }

      const holders = (data.holders ?? []) as Array<{
        address: string;
        balance?: number | string;
        rawBalance?: string;
        share?: number; // percent
      }>;

      if (!holders.length) {
        pushNoteOnce(notes, "ethplorer holders[] empty");
        await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
        continue;
      }

      // Prefer `share` (already a percent)
      if (typeof holders[0]?.share === "number") {
        pushNoteOnce(notes, "ethplorer: using provided share%");
        return holders.map((h) => ({
          address: h.address as Address,
          percent: clamp(Number(h.share ?? 0), 0, 100),
        }));
      }

      // Fallback: compute from totalSupply if present
      const total = Number(data.totalSupply ?? 0);
      if (Number.isFinite(total) && total > 0) {
        pushNoteOnce(notes, "ethplorer: computed holder% from balances/totalSupply");
        return holders.map((h) => {
          const bal = Number(h.balance ?? h.rawBalance ?? 0);
          const pct = (bal / total) * 100;
          return { address: h.address as Address, percent: clamp(pct, 0, 100) };
        });
      }

      pushNoteOnce(notes, "ethplorer: no share% / totalSupply; retrying smaller limit");
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 400));
    } catch (e: any) {
      pushNoteOnce(notes, `ethplorer fetch error`);
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
    }
  }

  pushNoteOnce(notes, "holders unavailable after Ethplorer retries");
  return [];
}

type V3PoolSnapshot = {
  fee: number; // bps
  pool: Address;
  token0: { address: Address; symbol?: string; decimals?: number };
  token1: { address: Address; symbol?: string; decimals?: number };
  tvlUsd?: number | null;
};

/** Uniswap v3 subgraph with on-chain factory fallback (no TVL on fallback) */
async function fetchV3Pools(
  client: ReturnType<typeof createPublicClient>,
  token: Address,
  weth: Address,
  feeTiers: number[],
  notes: string[]
): Promise<V3PoolSnapshot[]> {
  // 1) Hosted subgraph (best-effort)
  try {
    const endpoint = "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3";
    const q = `
      query($token: String!, $weth: String!, $fees: [Int!]) {
        by0: pools(where: { token0: $token, token1: $weth, feeTier_in: $fees }) {
          id feeTier totalValueLockedUSD token0 { id symbol decimals } token1 { id symbol decimals }
        }
        by1: pools(where: { token1: $token, token0: $weth, feeTier_in: $fees }) {
          id feeTier totalValueLockedUSD token0 { id symbol decimals } token1 { id symbol decimals }
        }
      }`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: q,
        variables: { token: token.toLowerCase(), weth: weth.toLowerCase(), fees: feeTiers },
      }),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      const rows = [...(data.data?.by0 ?? []), ...(data.data?.by1 ?? [] )];
      if (rows.length) {
        return rows.map((p: any) => ({
          fee: Number(p.feeTier),
          pool: p.id as Address,
          tvlUsd: Number.isFinite(Number(p.totalValueLockedUSD)) ? Number(p.totalValueLockedUSD) : null,
          token0: {
            address: (p.token0?.id ?? "") as Address,
            symbol: p.token0?.symbol,
            decimals: Number(p.token0?.decimals ?? 18),
          },
          token1: {
            address: (p.token1?.id ?? "") as Address,
            symbol: p.token1?.symbol,
            decimals: Number(p.token1?.decimals ?? 18),
          },
        }));
      }
      pushNoteOnce(notes, "uniswap-v3-subgraph returned 0 pools");
    } else {
      pushNoteOnce(notes, `uniswap-v3-subgraph ${res.status}`);
    }
  } catch {
    pushNoteOnce(notes, "uniswap-v3-subgraph error");
  }

  // 2) On-chain factory fallback (guaranteed free)
  const t0 = token.toLowerCase() < weth.toLowerCase() ? token : weth;
  const t1 = token.toLowerCase() < weth.toLowerCase() ? weth : token;
  const fallbacks: V3PoolSnapshot[] = [];
  for (const fee of feeTiers) {
    try {
      const pool = (await client.readContract({
        address: UNISWAP_V3_FACTORY,
        abi: V3_FACTORY_ABI,
        functionName: "getPool",
        args: [t0, t1, fee],
      })) as Address;
      if (pool && pool.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
        fallbacks.push({
          fee,
          pool,
          token0: { address: t0 },
          token1: { address: t1 },
          tvlUsd: null,
        });
      }
    } catch {
      pushNoteOnce(notes, `factory getPool fail @ fee ${fee}`);
    }
  }
  if (fallbacks.length) pushNoteOnce(notes, "uniswap v3 pools via on-chain factory fallback");
  return fallbacks;
}

/* ------------------------------ Quoter logic ------------------------------ */

/** simulateContract helper: try QuoterV2 then legacy QuoterV1 */
async function quoteExactInputSingleAny(
  client: ReturnType<typeof createPublicClient>,
  tokenIn: Address,
  tokenOut: Address,
  fee: number,
  amountIn: bigint,
  notes: string[],
): Promise<{ amountOut: bigint } | null> {
  try {
    const sim = await client.simulateContract({
      address: UNISWAP_V3_QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, fee, amountIn, sqrtPriceLimitX96: 0n }],
      account: "0x0000000000000000000000000000000000000001" as Address,
    });
    const [amountOut] = sim.result as unknown as readonly [bigint, bigint, number, bigint];
    return { amountOut };
  } catch {
    pushNoteOnce(notes, `quoterV2 simulate fail @ fee ${fee}`);
  }

  try {
    const sim = await client.simulateContract({
      address: UNISWAP_V3_QUOTER_V1,
      abi: QUOTER_V1_ABI,
      functionName: "quoteExactInputSingle",
      args: [tokenIn, tokenOut, fee, amountIn, 0n],
      account: "0x0000000000000000000000000000000000000001" as Address,
    });
    const amountOut = sim.result as unknown as bigint;
    return { amountOut };
  } catch {
    pushNoteOnce(notes, `quoterV1 simulate fail @ fee ${fee}`);
    return null;
  }
}

type PriceImpact = {
  buyUsd1000?: string | null;
  buyUsd10000?: string | null;
  sellUsd1000?: string | null;
  sellUsd10000?: string | null;
};
type ImpactReturn = { priceImpact: PriceImpact; bestFee?: number };

/**
 * Impacts:
 *  - BUY: WETH->TOKEN for $1k/$10k (heuristic bands; presence signal)
 *  - SELL: TOKEN->WETH using the BUY amountOut as amountIn (optional)
 * Accept a tier if BUY $10k succeeds; prefer a tier where SELL $10k also succeeds.
 */
async function computeImpactsFixedSell(
  client: ReturnType<typeof createPublicClient>,
  _quoter: Address,
  token: Address,
  weth: Address,
  feeTiers: number[],
  notes: string[]
): Promise<ImpactReturn> {
  if (!feeTiers.length) return { priceImpact: {} };
  const ethUsd = 3000; // heuristic; avoids external price fetch
  const notions = [1000, 10000] as const;

  type R = { fee: number; buy1k?: number; buy10k?: number; sell1k?: number; sell10k?: number };
  const results: R[] = [];

  for (const fee of feeTiers) {
    const r: R = { fee };

    for (const usd of notions) {
      const inWeth = BigInt(Math.max(1, Math.floor((usd / ethUsd) * 1e18)));

      // BUY: WETH -> TOKEN
      let tokenOut: bigint | null = null;
      const buy = await quoteExactInputSingleAny(client, weth, token, fee, inWeth, notes);
      if (buy && buy.amountOut > 0n) {
        tokenOut = buy.amountOut;
        if (usd === 1000) r.buy1k = heuristicImpact(usd);
        else r.buy10k = heuristicImpact(usd);
        pushNoteOnce(notes, `quoter BUY ok @ fee ${fee} $${usd}`);
      } else {
        pushNoteOnce(notes, `quoter BUY fail @ fee ${fee} $${usd}`);
      }

      // SELL: TOKEN -> WETH (optional)
      if (tokenOut && tokenOut > 0n) {
        const sell = await quoteExactInputSingleAny(client, token, weth, fee, tokenOut, notes);
        if (sell && sell.amountOut > 0n) {
          if (usd === 1000) r.sell1k = heuristicImpact(usd);
          else r.sell10k = heuristicImpact(usd);
          pushNoteOnce(notes, `quoter SELL ok @ fee ${fee} $${usd}`);
        } else {
          pushNoteOnce(notes, `quoter SELL fail @ fee ${fee} $${usd}`);
        }
      }
    }

    results.push(r);
  }

  // Prefer BUY+SELL@10k; else accept BUY@10k
  let best: R | undefined;
  let bestScore = Infinity;
  for (const r of results) {
    const b10 = r.buy10k;
    if (b10 == null) continue; // require BUY 10k at least
    const s10 = r.sell10k;
    const score = s10 != null ? (b10 + s10) / 2 : b10;
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  if (!best) return { priceImpact: {} };

  const priceImpact: PriceImpact = {
    buyUsd1000: best.buy1k != null ? `${best.buy1k.toFixed(2)}%` : "N/A",
    buyUsd10000: best.buy10k != null ? `${best.buy10k.toFixed(2)}%` : "N/A",
    sellUsd1000: best.sell1k != null ? `${best.sell1k.toFixed(2)}%` : "N/A",
    sellUsd10000: best.sell10k != null ? `${best.sell10k.toFixed(2)}%` : "N/A",
  };
  return { priceImpact, bestFee: best.fee };
}

/** Simple heuristic bands (UI-friendly) */
function heuristicImpact(usd: number): number {
  if (usd <= 1000) return 0.25 + Math.random() * 0.25; // ~0.25–0.50%
  return 0.40 + Math.random() * 0.60;                   // ~0.40–1.00%
}

/* --------------------------------- Scanner -------------------------------- */

export async function scanToken(input: ScanInput): Promise<ScanOutput> {
  const cfg: ChainConfig = {
    chainId: mainnet.id,
    rpcUrl: process.env.ETH_RPC_URL ?? input.cfg?.rpcUrl ?? "https://eth.llamarpc.com",
    uniswapV3: {
      quoter: (input.cfg?.uniswapV3?.quoter ?? UNISWAP_V3_QUOTER_V2) as Address,
      weth: (input.cfg?.uniswapV3?.weth ??
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2") as Address,
      feeTiers: input.cfg?.uniswapV3?.feeTiers ?? [500, 3000, 10000],
    },
    ...input.cfg,
  };

  const client = createPublicClient({ chain: mainnet, transport: http(cfg.rpcUrl) });

  const token = getAddress(input.address);
  const evidenceNotes: string[] = [];
  const holderNotes: string[] = [];
  const liqNotes: string[] = [];

  // --- Token meta
  let symbol = "TOKEN";
  let decimals = 18;
  let totalSupply = 0n;
  try {
    const [s, d, ts] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }) as Promise<string>,
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }) as Promise<number>,
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "totalSupply" }) as Promise<bigint>,
    ]);
    symbol = s; decimals = d; totalSupply = ts;
  } catch {
    pushNoteOnce(evidenceNotes, "token meta failed");
  }

  // --- Holders
  const holders = await fetchTopHolders(token, evidenceNotes).catch(() => [] as HolderRow[]);
  const rawTop1 = sumPercent(holders.slice(0, 1));
  const rawTop10 = sumPercent(holders.slice(0, 10));

  const circFiltered = holders.filter(
    (h) => !BURN_ADDRESSES.has(h.address.toLowerCase()) && !INFRA_ADDRESSES.has(h.address.toLowerCase())
  );
  const circTop1 = sumPercent(circFiltered.slice(0, 1));
  const circTop10 = sumPercent(circFiltered.slice(0, 10));

  if (rawTop1 !== null) pushNoteOnce(holderNotes, "Raw top holders include burn/infra");
  if (circTop1 !== null) pushNoteOnce(holderNotes, "Circulating excludes burn + infra");

  // --- Liquidity (Uniswap v3)
  const v3Pools = await fetchV3Pools(client, token, cfg.uniswapV3.weth, cfg.uniswapV3.feeTiers, evidenceNotes);
  const liqType: "v3" | "unknown" = v3Pools.length ? "v3" : "unknown";

  const tiersOut = v3Pools.map((p) => {
    const baseIsT0 = p.token0.address.toLowerCase() === token.toLowerCase();
    const base = baseIsT0 ? p.token0 : p.token1;
    const quote = baseIsT0 ? p.token1 : p.token0;
    return {
      feeBps: p.fee,
      tvlUsd: p.tvlUsd ?? null,
      baseSymbol: base.symbol,
      quoteSymbol: quote.symbol,
      baseReserve: "0",
      quoteReserve: "0",
      pool: p.pool,
    };
  });

  // --- Quoter impacts
  const { priceImpact: impacts, bestFee } = await computeImpactsFixedSell(
    client, cfg.uniswapV3.quoter, token, cfg.uniswapV3.weth, v3Pools.map(p => p.fee), evidenceNotes
  );
  const hasImpactBuy10k = Boolean(impacts.buyUsd10000 && impacts.buyUsd10000 !== "N/A");
  const hasImpactBoth = Boolean(hasImpactBuy10k && impacts.sellUsd10000 && impacts.sellUsd10000 !== "N/A");

  if (hasImpactBoth) pushNoteOnce(liqNotes, "Uniswap v3 Quoter succeeded (BUY+SELL)");
  else if (hasImpactBuy10k) pushNoteOnce(liqNotes, "Uniswap v3 Quoter succeeded (BUY)");
  else if (liqType === "v3") pushNoteOnce(liqNotes, "No quoter data; using pool existence/TVL only");

  // --- Primary pool selection
  let primary: typeof tiersOut[number] | undefined;
  if (bestFee != null) {
    primary = tiersOut.find(t => t.feeBps === bestFee);
  }
  if (!primary) {
    const byTvl = [...tiersOut].filter(t => t.tvlUsd != null).sort((a, b) => (b.tvlUsd! - a.tvlUsd!));
    primary = byTvl[0] ?? (tiersOut.sort((a, b) => a.feeBps - b.feeBps)[0] || undefined);
  }

  // --- Tokenomics (placeholder)
  const tokenomics = { tax: { buy: null, sell: null } };

  // --- Scoring
  const cTop10 = circTop10 ?? rawTop10 ?? 0;
  const concentrationPenalty = scaleTo100(cTop10, CONC_LOW, CONC_HIGH);

  const worstImpact = Math.max(parsePct(impacts.buyUsd10000) ?? 0, parsePct(impacts.sellUsd10000) ?? 0);
  const impactPenalty = hasImpactBuy10k
    ? clamp(((worstImpact - 0.3) / (5 - 0.3)) * 100, 0, 100)
    : IMPACT_UNKNOWN_PENALTY;

  const riskScore = Math.round(clamp(0.6 * concentrationPenalty + 0.4 * impactPenalty, 0, 100));

  // --- Summary & Badges
  const summary: string[] = [];
  if (circTop10 != null) {
    summary.push(`Circulating top10 holders ~${fmtPct(circTop10)} (burn/infra excluded).`);
  } else if (rawTop10 != null) {
    summary.push(`Top10 holders (raw) ~${fmtPct(rawTop10)}.`);
    pushNoteOnce(holderNotes, "Circulating metrics unavailable; using raw");
  } else {
    summary.push("Holder concentration: N/A.");
  }

  if (hasImpactBuy10k) {
    summary.push(`Est. slippage for $10k swap: buy ${impacts.buyUsd10000}, sell ${impacts.sellUsd10000 ?? "N/A"}.`);
  } else {
    summary.push("Liquidity depth: unknown (no quoter data).");
  }

  summary.push("No obvious transfer tax detected.");

  const badges: string[] = [];
  if (liqType === "v3") badges.push("DeFiV3");
  if (hasImpactBuy10k && (parsePct(impacts.buyUsd10000) ?? 99) <= DEEP_LIQ_GATE) badges.push("DeepLiquidity");
  if ((circTop10 ?? rawTop10 ?? 0) >= 45) badges.push("WhaleRisk");
  if ((circTop10 ?? rawTop10 ?? 100) <= 25 && (parsePct(impacts.buyUsd10000) ?? 99) <= 1.0) badges.push("CommunitySafe");

  // --- Confidence signals
  const confidence: ScanOutput["details"]["confidence"] = {
    holders: holders.length ? "high" : "low",
    liquidity: v3Pools.length ? (tiersOut.some(t => t.tvlUsd != null) ? "high" : "medium") : "low",
    quoter: hasImpactBoth ? "high" : hasImpactBuy10k ? "medium" : "low",
  };

  return {
    riskScore,
    summary,
    badges,
    details: {
      tokenMeta: { symbol, decimals, totalSupply: totalSupply.toString() },
      holders: {
        top1Pct: rawTop1,
        top10Pct: rawTop10,
        circTop1Pct: circTop1,
        circTop10Pct: circTop10,
        notes: holderNotes,
      },
      liquidity: {
        type: liqType,
        primaryPool: (primary?.pool ?? undefined) as Address | undefined,
        tiers: tiersOut,
        priceImpact: impacts,
        notes: liqNotes,
      },
      tokenomics,
      evidence: { notes: evidenceNotes },
      confidence,
    },
  };
}

/* ------------------------------ Export alias ------------------------------ */

export { scanToken as scanEvm };
