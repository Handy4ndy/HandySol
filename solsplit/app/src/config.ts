// SplitPay demo configuration. Edit this one file to change the demo.

/** Public devnet RPC. It allows browser CORS and needs no API key. */
export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";

/**
 * Extra airdrop RPCs tried after the public one, e.g. a provider devnet URL.
 * Anything placed here ships to every visitor, so only use keys you are happy to make public.
 * Can also be set at build time with VITE_AIRDROP_RPCS (comma separated).
 */
export const EXTRA_AIRDROP_RPCS: string[] = (import.meta.env.VITE_AIRDROP_RPCS ?? "")
  .split(",").map((s: string) => s.trim()).filter(Boolean);

/**
 * Optional faucet relay (for example a small serverless function holding a demo treasury key).
 * It receives POST {"address": "<base58>"} and returns {"signature": "<sig>"}. Leave empty to skip.
 */
export const FAUCET_RELAY_URL: string = import.meta.env.VITE_FAUCET_RELAY_URL ?? "";

/** Airdrop sizes tried in order (SOL). The demo needs about 0.03 SOL. */
export const AIRDROP_AMOUNTS = [1, 0.5, 0.1];

/** Minimum wallet balance (SOL) needed to run the demo. */
export const MIN_DEMO_SOL = 0.03;

/** SOL deposited into the vault and split each run. */
export const DEMO_DEPOSIT_SOL = 0.02;

/**
 * Demo recipients. No real addresses ship with the repo: set your own devnet wallets with
 * VITE_RECIPIENT_1..4 at build time (or edit the placeholders below). The demo refuses to run
 * while any placeholder is left. Shares are basis points and must sum to 10000. Each share of the
 * deposit should be at least 0.00089 SOL so a brand new recipient account is rent exempt.
 */
export const RECIPIENT_PLACEHOLDER_PREFIX = "REPLACE_WITH_";
export const DEMO_RECIPIENTS = [
  { label: "Recipient 1", address: import.meta.env.VITE_RECIPIENT_1 ?? "REPLACE_WITH_RECIPIENT_1_PUBKEY", shareBps: 4000 },
  { label: "Recipient 2", address: import.meta.env.VITE_RECIPIENT_2 ?? "REPLACE_WITH_RECIPIENT_2_PUBKEY", shareBps: 3000 },
  { label: "Recipient 3", address: import.meta.env.VITE_RECIPIENT_3 ?? "REPLACE_WITH_RECIPIENT_3_PUBKEY", shareBps: 2000 },
  { label: "Recipient 4", address: import.meta.env.VITE_RECIPIENT_4 ?? "REPLACE_WITH_RECIPIENT_4_PUBKEY", shareBps: 1000 },
];

/** Throws a clear error if any recipient is still a placeholder. */
export function assertRecipientsConfigured(): void {
  const missing = DEMO_RECIPIENTS.filter((r) => !r.address || r.address.startsWith(RECIPIENT_PLACEHOLDER_PREFIX));
  if (missing.length) {
    throw new Error(`Demo recipients are not configured (${missing.map((r) => r.label).join(", ")}). Set VITE_RECIPIENT_1..4 to your own devnet addresses or edit src/config.ts.`);
  }
}

/** Manual faucets shown when automatic funding fails. */
export const MANUAL_FAUCETS = [
  { name: "faucet.solana.com", url: "https://faucet.solana.com" },
  { name: "QuickNode faucet", url: "https://faucet.quicknode.com/solana/devnet" },
  { name: "devnetfaucet.org", url: "https://devnetfaucet.org" },
];
