// ═══════════════════════════════════════════════════════════
// Bot score helpers — guarantee that a bot-generated score is
// STRICTLY on the correct side of the player's score, so the
// visual outcome always matches `bot_should_win`.
//
// Why this file exists:
//   Every game has a `generateBotResult(...)` that invents a
//   fake score for the bot. The server's `finalize_duel` uses
//   `bot_should_win` as the SOURCE OF TRUTH for the winner —
//   it ignores the actual scores in bot games. If the client
//   somehow generates a bot score on the wrong side of the
//   player's (e.g. due to hard floors like `Math.max(25, ...)`
//   when the player outperformed the floor), the player sees
//   "bot had better score but I won" (or vice versa).
//
// Contract:
//   For each game type, we pick `direction`:
//     'lower'  — lower score is better (capitals, gradient,
//                hearing, race, reaction, sequence-time)
//     'higher' — higher score is better (circle, sequence-score,
//                quiz)
//
//   If shouldWin === true  → bot must strictly beat myScore.
//   If shouldWin === false → bot must strictly lose to myScore.
//
//   "Strictly" means `<` or `>` (no ties), EXCEPT when the
//   player's score is already an extreme boundary where a
//   strict side is impossible; in those cases we clamp to the
//   boundary and let the server's `bot_should_win` override
//   decide the winner (the display will show a tie, which is
//   the least-bad option).
// ═══════════════════════════════════════════════════════════

/**
 * Guarantee botScore is strictly less than myScore.
 * Falls back to 0 if myScore is already at/below the floor.
 * @param {number} myScore - player's score
 * @param {number} baseMargin - preferred margin (e.g. 100 km)
 * @param {number} randomSpread - additional random spread
 * @param {number} floor - absolute minimum (default 0)
 */
export function botLower(myScore, baseMargin = 100, randomSpread = 500, floor = 0) {
  // Largest margin that still keeps bot > floor and < myScore
  const maxMargin = Math.max(1, myScore - floor - 1)
  const wanted = baseMargin + Math.floor(Math.random() * Math.max(1, randomSpread))
  const margin = Math.min(wanted, maxMargin)
  const result = myScore - margin
  // Final safety: strictly less than myScore if possible, otherwise clamp to floor
  if (result >= myScore) return Math.max(floor, myScore - 1)
  return Math.max(floor, result)
}

/**
 * Guarantee botScore is strictly greater than myScore.
 * @param {number} myScore - player's score
 * @param {number} baseMargin - preferred margin
 * @param {number} randomSpread - additional random spread
 * @param {number} ceiling - absolute maximum (default Infinity)
 */
export function botHigher(myScore, baseMargin = 100, randomSpread = 500, ceiling = Infinity) {
  const maxMargin = Math.max(1, ceiling - myScore - 1)
  const wanted = baseMargin + Math.floor(Math.random() * Math.max(1, randomSpread))
  const margin = Math.min(wanted, maxMargin)
  const result = myScore + margin
  if (result <= myScore) return Math.min(ceiling, myScore + 1)
  return Math.min(ceiling, result)
}

/**
 * Safety net: given an already-generated bot score, enforce
 * the correct direction. Use this AFTER existing generator
 * logic as a post-validation.
 *
 * @param {number} botScore
 * @param {number} myScore
 * @param {boolean} shouldWin
 * @param {'lower'|'higher'} direction - which side is "better"
 * @param {object} opts - { floor, ceiling }
 */
export function enforceDirection(botScore, myScore, shouldWin, direction = 'lower', opts = {}) {
  const { floor = 0, ceiling = Infinity } = opts
  // Who wants lower? bot-lower is better IF (direction==='lower' AND bot wins) OR (direction==='higher' AND bot loses)
  const botWantsLower =
    (direction === 'lower' && shouldWin) ||
    (direction === 'higher' && !shouldWin)

  if (botWantsLower) {
    if (botScore >= myScore) {
      // wrong side — force strictly less
      return botLower(myScore, 1, 1, floor)
    }
    return Math.max(floor, botScore)
  }

  // bot wants higher
  if (botScore <= myScore) {
    return botHigher(myScore, 1, 1, ceiling)
  }
  return Math.min(ceiling, botScore)
}
