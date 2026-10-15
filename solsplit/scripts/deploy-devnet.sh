#!/usr/bin/env bash
# Deploy SplitPay to devnet with deployer.json and run the 3 recipient demo.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"
echo "Deployer: $(solana-keygen pubkey deployer.json)  balance: $(solana balance -ud -k deployer.json)"
solana program deploy -ud -k deployer.json target/deploy/splitpay.so --program-id target/deploy/splitpay-keypair.json
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=./deployer.json npx ts-node scripts/demo.ts
