/**
 * Chain registry and tunables shared by every deployment target.
 *
 * This module must stay free of platform APIs (no `node:*`, no Cloudflare
 * bindings, no Vercel imports) so it can be bundled into a Worker, a Vercel
 * Function and plain Node alike.
 */

/** V3 `PoolCreated(address,address,uint24,int24,address)` */
export const POOL_CREATED_TOPIC =
  "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

/** V4 `Initialize(bytes32,address,address,uint24,int24,address,uint160,int24,uint24)` */
export const POOL_INIT_TOPIC =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

/** ERC-20 view selectors used for enrichment. */
export const SELECTORS = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  slot0: "0x3850c7bd",
  liquidity: "0x1a686502",
  balanceOf: "0x70a08231",
};

/** `ReservesLens.getReserves(PoolKey)` */
export const RESERVES_LENS_SELECTOR = "f95138f2";

/**
 * Reserves lens used to read V4 pool state. Deployed at the same address on
 * every supported chain. If you add a chain where it lives elsewhere, move
 * this into the chain registry instead.
 */
export const RESERVES_LENS = "0x0000001b173C3bbF3984D417d8614E3eed34865B";

/** Zero address is the canonical sentinel for native ETH in pool keys. */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

/** Fee values at or above this bit indicate a dynamic-fee pool. */
export const DYNAMIC_FEE_FLAG = 0x800000;

/**
 * Per-chain contracts and RPC endpoints.
 *
 * `rpcs` is ordered failover: each helper tries every endpoint in turn and
 * moves to the next on failure, so a single rate-limited provider degrades
 * rather than breaks.
 */
export const CHAINS = {
  base: {
    name: "Base",
    explorer: "https://basescan.org",
    uniswapSlug: "base",
    rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    v3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    v4PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
  },
  robinhood: {
    name: "Robinhood",
    explorer: "https://robinhoodchain.blockscout.com",
    uniswapSlug: "robinhood",
    rpcs: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"],
    v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  },
};

export const CHAIN_IDS = Object.keys(CHAINS);

/**
 * Tunables.
 *
 * The pacing values below are deliberately conservative: public RPC
 * endpoints rate-limit aggressively, and a cron invocation that trips a rate
 * limit loses the entire run. `maxBlocksPerRun` is the serverless-specific
 * addition — it bounds how much history a single invocation will catch up on
 * so that a cold-start backfill spreads across several runs instead of
 * blowing the execution limit on the first one.
 */
export const TUNING = {
  /** Blocks to backfill on a brand-new database. */
  bootstrapDepth: 5000,
  /** Upper bound on blocks processed per invocation. */
  maxBlocksPerRun: 1500,
  /** Blocks per `eth_getLogs` request. */
  logChunkSize: 3000,
  /** Delay between log chunks (ms). */
  logChunkDelayMs: 100,

  /**
   * Upper bound on V4 pools whose state is read inline, per invocation.
   *
   * Reading V4 state means calling the Reserves lens, which is genuinely
   * expensive: a single 60-call batch measures around 10s. On a busy range
   * that would blow a serverless invocation budget.
   *
   * It is also unnecessary up front. The V4 `Initialize` event already
   * carries `sqrtPriceX96` and `tick`, so a pool can be inserted and rendered
   * immediately; only `liquidity` and reserves need the lens. Pools past this
   * limit are inserted with null state and repaired on a later pass by
   * `backfillV4State`, which is bounded and runs once per ingest.
   */
  v4EnrichLimit: 25,

  /** `eth_call` batch size + delay for token metadata. */
  tokenBatchSize: 60,
  tokenBatchDelayMs: 100,

  /** `eth_call` batch size + delay for V3 pool state. */
  v3BatchSize: 40,
  v3BatchDelayMs: 50,

  /** `eth_call` batch size + delay for V4 pool state. */
  v4BatchSize: 20,
  v4BatchDelayMs: 200,

  /** How long a pool stays in the live window. */
  retentionMs: 30 * 60 * 1000,

  /**
   * Heartbeat / change-detection interval for the SSE read path.
   * Each open stream re-reads the store on this cadence and emits a frame
   * when the snapshot changes.
   */
  streamPollMs: 3000,

  /** Hard cap on a single SSE stream before the client must reconnect. */
  streamMaxDurationMs: 240000,

  /** Maximum rows to return from `/api/pools`. */
  maxPoolsPerResponse: 1000,
};

/** D1 caps bound parameters at 100 per query; stay clear of it. */
export const SQL_PARAM_CHUNK = 90;

/** Postgres caps bind parameters per statement at 65535; chunk for safety. */
export const PG_PARAM_CHUNK = 500;