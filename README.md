[![SOLSplit, built on Solana](docs/solsplit-banner.png)](https://xspence.co.uk/solsplit/)

# HandySol

Small, readable Solana programs you can run, read and build on.

The first one is **SOLSplit**: send SOL to one address and it gets shared out between up to 10 wallets by percentage, in a single transaction.

**Try it live on devnet:** https://xspence.co.uk/solsplit/

## What's inside

| Project | What it does | Status | Folder |
|---|---|---|---|
| SOLSplit | Splits SOL from a vault across up to 10 recipients by share | Live on devnet, release `solsplit-v0.1.0` | [`solsplit/`](solsplit/) |

More Solana projects will land here as their own folders.

## SOLSplit

### How it works

1. **Set up the split.** The owner picks up to 10 wallets and the share each one gets.
2. **Send SOL.** Anyone can send SOL to the split's vault address.
3. **Pay everyone.** Anyone can call `distribute`. The program shares out everything above the vault's rent minimum, straight to each wallet, in one transaction.

The live demo does steps 2 and 3 together in one transaction, paid from a devnet treasury, so you don't need a wallet to try it.

### What you could build with it

- **Checkout splits:** one customer payment shared between the seller, the platform and partners.
- **Tax set-aside:** a fixed percentage of every payment goes to a tax wallet.
- **Auto savings:** a slice of every payment goes straight into savings.
- **Team and creator payouts:** revenue shared with collaborators the moment it lands.

### Program details

| | |
|---|---|
| Program ID | [`5M5cpnesJ6PUzAu3kYeGk6GaiEsL2WgHroLE2FHNTP1R`](https://explorer.solana.com/address/5M5cpnesJ6PUzAu3kYeGk6GaiEsL2WgHroLE2FHNTP1R?cluster=devnet) |
| Network | Solana devnet |
| Framework | Anchor 1.2.1, Rust 1.89.0 |
| Release | tag [`solsplit-v0.1.0`](https://github.com/Handy4ndy/HandySol/tree/solsplit-v0.1.0/solsplit) |
| Instructions | `init_split(split_id, recipients)`, `update_split(recipients)`, `distribute()`, `close()` |
| Accounts | `SplitConfig` PDA at `["split", owner, split_id as u64 LE]`, vault PDA (no data, holds the SOL) at `["vault", split_config]` |
| Shares | Basis points, must add up to 10,000. Up to 10 recipients, no duplicates |
| Maths | `amount * share_bps / 10000` in checked u128 arithmetic; the last recipient gets whatever is left, so nothing is lost to rounding |
| security.txt | Embedded in the program, shown on Solana Explorer's Security tab |

Who can call what: anyone can create a split with `init_split` and becomes its owner; only that owner can `update_split` and `close` it. Anyone can call `distribute`, and the program checks every recipient account against the stored list, in order. Full details are in [`solsplit/README.md`](solsplit/README.md).

### Tests

- 75 passing on a local validator: 12 core tests plus 63 extended cases, including a 500-run random split fuzz test ([`test-results.txt`](solsplit/test-results.txt), [`test-results-extended.txt`](solsplit/test-results-extended.txt)).
- 14 of 14 checks on devnet: 10 distributions with exact payouts, plus negative tests.
- Results and review notes are in [`solsplit/TEST-REPORT.md`](solsplit/TEST-REPORT.md).

## Quick start

### Prerequisites

| Tool | Version |
|---|---|
| Rust | 1.89.0 (pinned in `solsplit/rust-toolchain.toml`) |
| Solana (Agave) CLI | 4.1.2 |
| Anchor CLI | 1.2.1 (via `avm`) |
| Node.js | 20 or later |
| solana-verify | 0.5.2, plus Docker, for reproducible builds |

```bash
rustup toolchain install 1.89.0
sh -c "$(curl -sSfL https://release.anza.xyz/v4.1.2/install)"
cargo install --git https://github.com/solana-foundation/anchor avm --force
avm install 1.2.1 && avm use 1.2.1
cargo install solana-verify --version 0.5.2
```

### Build and test

```bash
git clone https://github.com/Handy4ndy/HandySol
cd HandySol/solsplit
npm install
anchor build    # target/deploy/splitpay.so and target/idl/splitpay.json
anchor test     # starts a local validator and runs tests/*.ts
```

### Deploy your own copy to devnet

```bash
solana config set --url devnet
solana-keygen new -o ~/.config/solana/id.json   # skip if you already have a wallet
solana airdrop 2
solana-keygen new -o target/deploy/splitpay-keypair.json --force   # your own program ID
anchor keys sync   # writes the new ID into declare_id! and Anchor.toml
anchor build
anchor deploy --provider.cluster devnet
```

`scripts/demo.ts` creates a split to 3 throwaway recipients, funds the vault and runs a distribution:

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json npx ts-node scripts/demo.ts
```

## Verify the build

The deployed program was built reproducibly. From the repo root, with Docker running:

```bash
git checkout solsplit-v0.1.0
solana-verify build --library-name splitpay ./solsplit
solana-verify get-executable-hash solsplit/target/deploy/splitpay.so
solana-verify get-program-hash -u devnet 5M5cpnesJ6PUzAu3kYeGk6GaiEsL2WgHroLE2FHNTP1R
```

Both hashes should be:

```
7dde0967222e9cffb0d21c343af4b90a3c472236208e225f79581d032df29291
```

Solana Explorer's "Verified" badge only covers mainnet programs, so on devnet the program shows as unverified. Matching the hashes yourself is the check.

## Repo layout

```
HandySol/
  README.md
  SECURITY.md
  docs/                      images for this README
  solsplit/
    programs/splitpay/       Anchor program (src/lib.rs)
    tests/                   localnet tests (core and extended)
    scripts/                 demo.ts and deploy-devnet.sh
    app/                     React and Vite browser app for the program
    Anchor.toml
    Cargo.toml
    rust-toolchain.toml
    README.md                program notes
    TEST-REPORT.md           test results and review findings
```

## Security

SOLSplit is a devnet demo. It has not been audited and should not hold real value. Read the code, test it, and get an audit before using anything like it on mainnet.

Found a problem? Please follow [`SECURITY.md`](SECURITY.md) and email info@xspence.co.uk instead of opening a public issue.

## Contributing and contact

Issues and pull requests are welcome. For questions or ideas, email info@xspence.co.uk.

## License

No license has been chosen yet, so all rights are reserved for now. Get in touch if you want to use the code.
