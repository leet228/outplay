// Shared wallet addresses — used by Admin and DepositSheet
export const ADDRESSES = {
  ton:  'UQBMTQ2VRSwRbvthtGTIB7Tip37yqueFw8SnVvWB7y18F47t',
  tron: 'TVx8PrnGgqHc7hyE4fZicofS673AzqwjGA',
  btc:  'bc1qu75zk4x2sl3k8s0hhq2pt9793m8lpxyryrvyvv',
  eth:  '0xE20B131dadaf7f9e393b555d14e13aa2CD6034Db',
}

// Mapping: coin id → address key + network label
export const COIN_CONFIG = {
  ton:  { addressKey: 'ton',  network: 'TON Network', coin: 'TON' },
  usdt: { addressKey: 'tron', network: 'TRC-20',      coin: 'USDT' },
  btc:  { addressKey: 'btc',  network: 'Bitcoin',     coin: 'BTC' },
  eth:  { addressKey: 'eth',  network: 'ERC-20',      coin: 'ETH' },
}
