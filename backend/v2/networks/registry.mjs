const EVM_NETWORKS = [
  ["ETH", "Ethereum", 1, "ETH", "https://etherscan.io", ["Blockscout", "Etherscan"]],
  ["ARB", "Arbitrum", 42161, "ETH", "https://arbiscan.io", ["Blockscout", "Etherscan"]],
  ["AVAX", "Avalanche C-Chain", 43114, "AVAX", "https://snowtrace.io", ["Routescan"]],
  ["BASE", "Base", 8453, "ETH", "https://basescan.org", ["Blockscout", "Etherscan"]],
  ["BLAST", "Blast", 81457, "ETH", "https://blastscan.io", ["Routescan", "Etherscan"]],
  ["BNB", "BNB Chain", 56, "BNB", "https://bscscan.com", ["Binplorer"]],
  ["CELO", "Celo", 42220, "CELO", "https://celoscan.io", ["Blockscout", "Etherscan"]],
  ["HEMI", "Hemi", 43111, "ETH", "https://explorer.hemi.xyz", ["Blockscout"]],
  ["HYPEREVM", "HyperEVM", 999, "HYPE", "https://hyperevmscan.io", ["Etherscan"]],
  ["LINEA", "Linea", 59144, "ETH", "https://lineascan.build", ["Blockscout", "Etherscan"]],
  ["MANTLE", "Mantle", 5000, "MNT", "https://explorer.mantle.xyz", ["Routescan", "Etherscan"]],
  ["MEGAETH", "MegaETH", 4326, "ETH", "https://megaeth.blockscout.com", ["Blockscout", "Etherscan"]],
  ["MONAD", "Monad", 143, "MON", "https://monadscan.com", ["Etherscan"]],
  ["OPBNB", "opBNB", 204, "BNB", "https://opbnbscan.com", ["Etherscan"]],
  ["OP", "Optimism", 10, "ETH", "https://optimistic.etherscan.io", ["Blockscout", "Etherscan"]],
  ["PALM", "Palm", 11297108109, "PALM", "https://explorer.palm.io", []],
  ["POLYGON", "Polygon PoS", 137, "POL", "https://polygonscan.com", ["Blockscout", "Etherscan"]],
  ["SCROLL", "Scroll", 534352, "ETH", "https://scrollscan.com", ["Blockscout"]],
  ["SEI", "Sei", 1329, "SEI", "https://seitrace.com", ["Etherscan"]],
  ["UNICHAIN", "Unichain", 130, "ETH", "https://uniscan.xyz", ["Blockscout", "Etherscan"]],
  ["ZKSYNC", "ZKsync Era", 324, "ETH", "https://era.zksync.network", ["Blockscout"]],
].map(([key, name, chainId, symbol, explorerBaseUrl, providers]) => ({
  key,
  name,
  family: "evm",
  chainId,
  symbol,
  decimals: 18,
  explorerBaseUrl,
  providers,
}));

const NETWORKS = [
  ...EVM_NETWORKS,
  {
    key: "TRX",
    name: "TRON",
    family: "tron",
    chainId: null,
    symbol: "TRX",
    decimals: 6,
    explorerBaseUrl: "https://tronscan.org/#",
    providers: ["TRON public API"],
  },
  {
    key: "BTC",
    name: "Bitcoin",
    family: "utxo",
    chainId: null,
    symbol: "BTC",
    decimals: 8,
    explorerBaseUrl: "https://mempool.space",
    providers: ["Mempool.space", "Blockstream Esplora"],
  },
];

const NETWORK_BY_KEY = new Map(NETWORKS.map((network) => [network.key, Object.freeze(network)]));

export function listNetworks() {
  return NETWORKS.map((network) => ({ ...network, providers: [...network.providers] }));
}

export function getNetwork(networkKey) {
  return NETWORK_BY_KEY.get(String(networkKey || "").trim().toUpperCase()) || null;
}

export function isEvmAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || "").trim());
}

export function isTronAddress(address) {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(address || "").trim());
}

export function isBitcoinAddress(address) {
  const value = String(address || "").trim();
  return /^(bc1[ac-hj-np-z02-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i.test(value);
}

export function validateAddressForNetwork(address, networkKey) {
  const network = getNetwork(networkKey);
  if (!network) return false;
  if (network.family === "evm") return isEvmAddress(address);
  if (network.family === "tron") return isTronAddress(address);
  if (network.family === "utxo") return isBitcoinAddress(address);
  return false;
}

export function detectNetworksByFormat(address) {
  if (isTronAddress(address)) return [getNetwork("TRX")];
  if (isBitcoinAddress(address)) return [getNetwork("BTC")];
  if (isEvmAddress(address)) return EVM_NETWORKS.map((network) => getNetwork(network.key));
  return [];
}

export function publicNetwork(network) {
  return {
    key: network.key,
    name: network.name,
    family: network.family,
    chainId: network.chainId,
    symbol: network.symbol,
    decimals: network.decimals,
    explorerBaseUrl: network.explorerBaseUrl,
  };
}
