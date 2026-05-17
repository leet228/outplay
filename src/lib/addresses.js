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

// ── Treasury wallet = HD derivation index 0 ──────────────────────
// PUBLIC addresses only — the key is server-derived from
// HD_MASTER_MNEMONIC (index 0), never in the bundle/git. This is
// the SINGLE canonical hot wallet: sweep destination, gas source,
// admin-displayed balance, AND the deposit fallback shown before a
// user's own derived address is ready. One key per network, so a
// single address serves the whole chain:
//   TRON → TRX + USDT-TRC20
//   EVM  → same 0x on Ethereum AND BSC: ETH, BNB, USDT/USDC
//          ERC20+BEP20
//   BTC  → BTC      ·   LTC → LTC
// (Derived via scripts/hd-derive.js index 0 — keep in sync.)
export const TRON_DEPOSIT_ADDRESS = 'TNLov2u5DuHKiSJpQHziqb8Gcov2GQWZw4'
export const EVM_DEPOSIT_ADDRESS  = '0x71740514b90aC31d0Ba0fF772107Ab5bA8496Ac2'
export const BTC_DEPOSIT_ADDRESS  = 'bc1qprd6zdx8kv73xup6ed9rypnedxcltm89k8pfzk'
export const LTC_DEPOSIT_ADDRESS  = 'ltc1qc65xapvmpzqesmvajncddleww3gxuy7z7jku6g'

// coin-id (as used by DepositSheet.SOON_COINS / depositAddrKey)
// → its default receiving address.
export const DEPOSIT_ADDRESSES = {
  'usdt-trc20': TRON_DEPOSIT_ADDRESS,
  'trx':        TRON_DEPOSIT_ADDRESS,
  'eth':        EVM_DEPOSIT_ADDRESS,
  'bnb':        EVM_DEPOSIT_ADDRESS,
  'usdt-erc20': EVM_DEPOSIT_ADDRESS,
  'usdc-erc20': EVM_DEPOSIT_ADDRESS,
  'usdt-bep20': EVM_DEPOSIT_ADDRESS,
  'usdc-bep20': EVM_DEPOSIT_ADDRESS,
  'btc':        BTC_DEPOSIT_ADDRESS,
  'ltc':        LTC_DEPOSIT_ADDRESS,
}

// Grouped view for the admin wallet screen — one entry per real
// keypair, listing every coin/network it receives.
export const DEPOSIT_WALLET_GROUPS = [
  {
    id: 'tron', name: 'TRON', address: TRON_DEPOSIT_ADDRESS,
    accent: 'linear-gradient(135deg, #EF3A3A 0%, #FF7A7A 100%)',
    serves: 'TRX · USDT (TRC20)',
  },
  {
    id: 'evm', name: 'EVM (Ethereum + BSC)', address: EVM_DEPOSIT_ADDRESS,
    accent: 'linear-gradient(135deg, #627EEA 0%, #A9B6F7 100%)',
    serves: 'ETH · BNB · USDT/USDC (ERC20 & BEP20)',
  },
  {
    id: 'btc', name: 'Bitcoin', address: BTC_DEPOSIT_ADDRESS,
    accent: 'linear-gradient(135deg, #F7931A 0%, #FFC46B 100%)',
    serves: 'BTC',
  },
  {
    id: 'ltc', name: 'Litecoin', address: LTC_DEPOSIT_ADDRESS,
    accent: 'linear-gradient(135deg, #345D9D 0%, #6E91C9 100%)',
    serves: 'LTC',
  },
]
