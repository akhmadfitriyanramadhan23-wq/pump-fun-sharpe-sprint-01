// Clean launch sniper for agent-fun/replay/v2 (pump.fun bonding curves), tuned for Sharpe.
//
// Idea: the only buy point that survives the 2-slot latency is the launch itself, so the bot
// watches every CreateEvent and buys only launches whose opening tape looks organic: a modest
// creator buy, a handful of distinct non-creator buyers (not a bundled cluster), no creator
// selling, a sane reserve, and no run-up yet. Positions are small and exits are fast and
// mechanical: take 70% off at +4%, let the rest run to +25% or a +2% floor, cut losers
// early, never hold past 6 slots. Many small, similar trades => steady equity,
// shallow drawdowns, a Sharpe built on consistency rather than one moonshot.
//
// Pure function of the batches it is fed: no clock, no randomness, no I/O, no network.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to spend per coin (each buy still capped at 1% of real SOL reserve). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets dumps. */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window (0 = at create price). */
  minRunupBps: number;
  maxRunupBps: number;
  /** Recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** First take-profit: sell tp1PartBps of the position once it is worth tp1Bps over its cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** After the first take-profit, the rest stops out at this much under its cost (bps; negative = above). */
  slAfterTp1Bps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  // Tuned on the dev window with the kit's pilot simulator (part-00000, ~first 11h):
  // net +0.119 SOL, 119 fills, 52 mints, max DD 0.44%.
  // Lessons baked in: buy only launches with >=6 distinct non-creator buyers in their first
  // 3 slots (organic crowd, not a bundle); cap the creator's own buy at 1.5 SOL; do NOT cap
  // the run-up (qualifying launches have already pumped >5% by decision time, and capping
  // it kills every trade); bank 70% at +4%, let the rest ride to +25% or a +2% trailing
  // floor, never hold past 6 slots. Small, fast, similar trades => steady equity.
  maxAge: 3,
  stakeLamports: 300_000_000,
  minBuyLamports: 5_000_000,
  minRealSol: 300_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 0,
  maxDevBuy: 1_500_000_000,
  minTrades: 2,
  minBuyers: 6,
  maxBuyers: 100,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  minRunupBps: 0,
  maxRunupBps: 1_000_000,
  flowWindow: 10,
  minFlowLamports: 0,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tp1Bps: 400,
  tp1PartBps: 7_000,
  slAfterTp1Bps: -200,
  tpBps: 2_500,
  slBps: 1_200,
  trailArmBps: 1_000_000,
  trailBps: 500,
  maxHold: 6,
  exitOnDevSell: true,
  staleSlots: 30,
};

const FEE_BPS = 125n; // protocol 95 + creator 30 bps charged on curve trades.

interface TapeTick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface CoinTape {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: TapeTick[];
  boughtOnce: boolean;
  /** Never consider it again (exited, filtered out for good, or completed). */
  done: boolean;
}

interface OpenTrade {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  tookTp1: boolean;
  devSoldAtOpen: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const tapes = new Map<Pubkey, CoinTape>();
  const open = new Map<Pubkey, OpenTrade>();
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapes.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          boughtOnce: false,
          done: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = tapes.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        const isDev = e.user === c.creator;
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = tapes.get(e.mint);
        if (c !== undefined) c.done = true;
      }
    }
  }

  /** Net lamports bought minus sold, and distinct buyers, over the last flowWindow slots. */
  function flow(c: CoinTape, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  }

  function pendingSide(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Track fills: open trades on buy fills, close them on harness closes / our sells.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          open.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.side === 'buy' && f.status === 'filled' && !open.has(f.mint)) {
          const c = tapes.get(f.mint);
          open.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            tookTp1: false,
            devSoldAtOpen: c?.devSold ?? false,
          });
        }
        const h = open.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') h.txPaid += BigInt(f.tx_fee_lamports);
      }
      for (const mint of [...selling]) if (!pendingSide(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !pendingSide(state, mint, 'buy')) {
          open.delete(mint);
        }
      }

      // --- Exits first: every open position is re-priced every batch. ---
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = tapes.get(mint);
        let h = open.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, tookTp1: false, devSoldAtOpen: c?.devSold ?? false };
          open.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          // Partial take-profit: bank half early, then let the rest ride near breakeven.
          if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(P.tp1Bps))) {
            const part = (pos.token_amount * BigInt(P.tp1PartBps)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              if (c !== undefined) c.done = true;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          const sl = h.tookTp1 ? BigInt(P.slAfterTp1Bps) : BigInt(P.slBps);
          if (value * BPS <= basis * (BPS - sl)) exit = true;
          if (
            h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) &&
            value * BPS <= h.best * (BPS - BigInt(P.trailBps))
          ) {
            exit = true;
          }
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // --- Entries: one buy per qualifying launch, nothing more. ---
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let openCount = state.committedPositionCount();
      for (const c of tapes.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.boughtOnce) continue;
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (openCount >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && P.skipDevSold) {
          c.done = true;
          continue;
        }
        // Rug / bundle filter on the opening tape.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.trades < P.minTrades || c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        // Price run-up since create, in bps over the create price (0 = unchanged).
        const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0) - BPS;
        if (runup > BigInt(P.maxRunupBps) || runup < BigInt(P.minRunupBps)) continue;
        const fl = flow(c, state.slot);
        if (fl.net < BigInt(P.minFlowLamports) || fl.buyers < P.minRecentBuyers) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.boughtOnce = true;
        openCount += 1;
      }
      return orders;
    },
  };
}
