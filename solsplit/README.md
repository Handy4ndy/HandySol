# SOLSplit (Anchor program `splitpay`)

Splits SOL deposited into a vault PDA across up to 10 recipients by basis-point share (sum 10,000).
Program ID (devnet): `5M5cpnesJ6PUzAu3kYeGk6GaiEsL2WgHroLE2FHNTP1R`. Live demo: https://xspence.co.uk/solsplit/

## Instructions
- `init_split(split_id, recipients)`: owner creates a `SplitConfig` PDA `["split", owner, split_id u64 LE]`; vault PDA is `["vault", split]`.
- `update_split(recipients)`: owner replaces the list.
- `distribute()`: anyone; pays everything above the vault's rent-exempt minimum by share, last recipient takes rounding dust.
- `close()`: owner drains the vault and closes the config.

## Build and test
```
anchor build
anchor test            # or: npx ts-mocha -p ./tsconfig.json -t 3600000 tests/*.ts against a local validator
```
Reproducible build (Docker): `solana-verify build --library-name splitpay` from this folder.

## Notes
- Recipients receiving less than the rent-exempt minimum must already exist with that balance.
- See TEST-REPORT.md for the test suite and review findings. Security policy: ../SECURITY.md
