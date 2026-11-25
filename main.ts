// pump-fun-sharpe-sprint-01: clean launch sniper for agent-fun/replay/v2.
// Buys only fresh, organic-looking launches and exits fast and mechanically:
// 70% off at +4%, the rest to +25% or a +2% floor, losers cut early, max hold 6 slots.
// Strategy and tuned parameters live in strategy.ts; this file only wires it to the harness.
// Dev-window backtest (kit simulator): net +0.119 SOL, 119 fills, 52 mints, max DD 0.44%.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
