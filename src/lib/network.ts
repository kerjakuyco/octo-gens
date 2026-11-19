import type { Network } from "../api/types";

/** Both networks, in the order they are shown: real money first. */
export const NETWORKS: readonly Network[] = ["mainnet", "testnet"];

export function networkName(network: Network): string {
  return network === "mainnet" ? "Mainnet" : "Testnet";
}

/** What kind of money moves on a network. */
export function fundsNote(network: Network): string {
  return network === "mainnet" ? "Real funds" : "Test funds";
}

/** The exchange's own site for a network. The app needs it only for the page that manages API wallets. */
export function exchangeSite(network: Network): string {
  return network === "mainnet" ? "https://www.asterdex.com" : "https://www.asterdex-testnet.com";
}

/** The exchange's page for creating and revoking API wallets. */
export function apiWalletPage(network: Network): string {
  return `${exchangeSite(network)}/en/api-wallet`;
}
