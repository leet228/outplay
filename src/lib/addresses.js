// Shared wallet address — used by Admin and DepositSheet
//   TON_ADDRESS  — public address of the Highload V3 wallet that
//                  receives ALL crypto deposits (TON native + every
//                  jetton like USDT-TON). On TON, jetton deposits
//                  land on a derived jetton-wallet sub-contract,
//                  but the address shown to the user is always the
//                  base wallet address — TON's jetton transfer
//                  protocol resolves the right jetton-wallet on
//                  the sender side.
export const TON_ADDRESS  = 'UQDsqlvskoZupLe-DFTwffYIqMIXxq6ghYSqh_PjIfOHz_bC'
// USDT deposits use the SAME wallet — only the asset differs.
// Kept as a separate export so the deposit sheet can swap the
// label/copy text without rebinding the address logic.
export const USDT_ADDRESS = TON_ADDRESS

// Deterministic USDT jetton-wallet address for TON_ADDRESS.
// Derived from TON_ADDRESS + the USDT-on-TON master via the
// Jetton standard. Resolved + verified by
// scripts/resolve-usdt-wallet.js after a 1 USDT seed deposit
// auto-deployed the wallet on chain.
//
// USE ONLY ON THE SERVER (indexer). The user-facing deposit
// flow always shows TON_ADDRESS — sending wallets resolve the
// jetton-wallet themselves through the USDT master.
export const USDT_JETTON_WALLET = 'UQD35azoUEPUPyTucTRbKj3SVOdtbB5-f3akyFyZmR7YAwyV'

// USDT master contract on TON (Tether). Indexer uses this to
// filter `/jetton/transfers` to USDT-only events.
export const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
