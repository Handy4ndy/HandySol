# SOLSplit (SplitPay program) test report

Date: 2026-10-15 (Europe/London). Program `5M5cpnesJ6PUzAu3kYeGk6GaiEsL2WgHroLE2FHNTP1R`, binary `target/deploy/splitpay.so`
(the same file deployed to devnet). No program upgrade and no live site file changes were made.

## Summary

| Area | Pass | Fail | Notes |
|---|---|---|---|
| 1. Program, localnet (Anchor/mocha) | 75 | 0 | 63 new cases in `tests/splitpay-extended.ts` (incl. 500-iteration fuzz) + 12 original |
| 2. Devnet program | 14 | 0 | 10 distributions exact, 4 negative tests + 3 simulated negatives, split closed, keys swept back |
| 3. Live API | 27 | 1 | per-IP limit bypassable by rotating IPv4/IPv6 (Medium, see B1) |
| 4. Page (headless Chrome) | 11 | 1 | footer disclaimer contrast 4.29:1 (< 4.5 AA, Low) |

SOL spent in this test session: 1,565,000 lamports (0.001565 SOL):
devnet program tests 95,000 (rent fully recovered by close and sweep) and 14 live demo runs x 105,000 = 1,470,000.
Demo treasury: 28.3936214 SOL before, 28.3920564 SOL after.

## 1. Program on localnet

Run: `solana-test-validator --bpf-program <id> target/deploy/splitpay.so --faucet-sol 1000000`, then
`ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json npx ts-mocha -p ./tsconfig.json -t 3600000 tests/splitpay-extended.ts tests/splitpay.ts`
Result: 75 passing (log: `test-artifacts/localnet-mocha.txt`). `FUZZ_ITER` env var sets fuzz iterations (default 500).

Covered (case numbers from the file):
- init validation 1-17: sum 9999 and 10001 rejected, 9999+1 ok, single 10000 ok, exactly 10 ok, 11 rejected, empty, zero share,
  adjacent and non-adjacent duplicates, u16-max shares and u16-wrap attempt (65535+10001) rejected, re-init same id rejected,
  same id under another owner independent, wrong split PDA / wrong vault rejected (ConstraintSeeds), unsigned owner rejected.
- amounts and rounding 18-31: 1 bp = floor(amount/10000), 10 x 1000 with remainder, vault exactly rent min and empty vault
  (NothingToDistribute), rent min + 1 (single and 50/50: [0,1]), + 7 at 3333/3333/3334 = [2,2,3], + 9999 at 1/1/9998 = [0,0,9999],
  demo shape 100000 = 40000/30000/20000/10000, 100,000 SOL large amount, repeated distributes and total_distributed,
  double distribute fails, unfunded recipient below rent min fails atomically (nothing moves).
- account substitution 32-43: wrong order, too few, extra, attacker key, duplicate meta (A,A,C), read-only recipient,
  other split's vault, random vault, other split's config with this vault, system-owned fake config, wrong system program;
  all rejected, then the correct call still conserves.
- special recipients 44-47: owner as recipient ok; vault as recipient and config as recipient (see R1); executable program as
  recipient fails with no loss.
- update_split 48-53: owner update applies, non-owner rejected, owner key without signature rejected, invalid shares rejected,
  update while funds pending redirects them (R3), 1 to 10 recipients fits the space.
- close 54-58: vault funds and config rent returned exactly, non-owner rejected, distribute after close fails,
  close then re-init same id recovers stranded deposits, close on empty vault.
- atomicity 59-62: two distributes in one tx roll back entirely, deposit/distribute/deposit/distribute in one tx exact,
  close + distribute in one tx rolls back, recipient as fee payer and recipient.
- fuzz 63: 500 random splits (1 to 10 recipients, random bp cuts, amounts 1 lamport to ~1000 SOL), each asserting exact
  per-recipient parts, sum conservation, vault left at rent min and total_distributed delta. All 500 passed.
- u64 limits: not executable on chain (needs > 18e9 SOL). Analytically: `amount * share_bps` is computed in u128
  (max 1.8e19 * 1e4 < 2^128), division by 10000 keeps parts <= amount, and `sent` never exceeds `amount` because the
  last recipient gets `amount - sent` with checked_sub. No overflow path.

### Source review findings (lib.rs)

| ID | Severity | Finding | Suggested fix |
|---|---|---|---|
| R1 | Low | Recipient may be the vault itself or the split config. Vault-as-recipient leaves its share in the vault while `total_distributed` counts it (test 45, overstated by the share). Config-as-recipient parks lamports in the config (recoverable only on close). | In `validate_recipients` (pass split and vault keys) reject `r.pubkey == vault || r.pubkey == split`. |
| R2 | Low | A single bad recipient (new account receiving < rent min, executable account) makes every distribute fail, so pending funds wait until the owner updates (tests 31, 47). Demo avoids this by pre-funding. | Document; optionally require parts of 0 or >= rent min, or skip failing parts into the last recipient. |
| R3 | Info (trust) | Owner can `update_split` while funds sit in the vault and redirect them (test 52). Expected for an owner-controlled splitter, but recipients must trust the owner. | Document, or distribute before update inside `update_split`. |
| R4 | Info | After `close`, the vault address can still receive SOL that is stranded until the same id is re-initialised (test 57 shows it is recoverable). | Document. |
| R5 | Info | No events for `update_split` and `close`; indexers cannot track changes. | Emit events. |
| R6 | Info | Upgrade authority is a single hot key (the deployer key). | Before the verified build, consider a multisig or making it immutable. |

Checked and fine: PDA seeds and stored canonical bumps for split and vault, `has_one = owner` plus `Signer` on update/close,
`Account<SplitConfig>` owner and discriminator check, `remaining_accounts` key, order and writability checks, rent minimum for a
data-less vault, checked arithmetic everywhere, account space sized for 10 recipients (update from 1 to 10 works),
no reentrancy surface (only System Program CPI).

## 2. Devnet program

Separate test split id 900001 (owner = treasury; live demo split id 1 untouched), a throwaway test split,
3 throwaway recipients at 50.00/33.33/16.67 %. Script `test-artifacts/devnet-test.mjs`, result `test-artifacts/devnet-result.json`.
- 10 deposit+distribute transactions with 1, 7, 100, 9999, 10001, 100000, 123457, 333333, 1000003, 2500001 lamports:
  all 10 exact per-recipient amounts, sum conserved, vault left at rent min (650,240). PASS 10/10.
- Negatives on chain: non-owner update_split (ConstraintSeeds), wrong vault (ConstraintSeeds), distribute with nothing above
  rent min (NothingToDistribute), wrong order with empty vault (rejected). PASS 4/4. With a funded vault (split 900002,
  simulated, `neg2.mjs`): wrong order, missing recipient and substituted recipient all RecipientMismatch. PASS 3/3.
- Cleanup: both test splits closed (config and vault rent returned), recipients swept back to treasury. Net cost 95,000 lamports (fees).

## 3. Live API (https://xspence.co.uk/api/splitpay)

| Check | Result |
|---|---|
| status fields, public key only, recipients, program, explorer links | PASS |
| status consistency: runs 18, usage 0.00189 SOL = 18 x 105,000, on-chain total_distributed 0.0018 = 18 x 100,000 (no double spend), vault at rent min | PASS |
| daily cap logic: limits 500 runs / 0.1 SOL, usage tracked per UTC day | PASS |
| rate limit from a stable IP (home connection via the public URL): 20 parallel POSTs = 1 x 200, 19 x 429 | PASS |
| spoofed X-Forwarded-For / X-Real-IP / CF-Connecting-IP after a run: 429 | PASS |
| rate limit from a cloud test machine: 2nd POST returned 200 | FAIL (B1) |
| burst of 20 from the cloud machine: 5 x 200, 12 x 429, 3 x 503 (queue full), no 500 | PASS (no 500s, lock held) |
| malformed JSON 400, oversized 200 KB 413, JSON array / 50 KB body / object token handled (429 in cooldown) | PASS |
| GET /demo, POST /status, PUT, DELETE: 404, no stack traces | PASS |
| path traversal (13 variants incl. %2e%2e, ..%2f, ..%5c, %00, /.env, /server.js, /src/..., /data/...): all 404, no secret | PASS |
| secret absent from status, demo responses, page, JS, CSS, redirect page | PASS |
| security headers | WARN (B3) |
| CORS | WARN (B2) |

### Bugs and risks

| ID | Severity | Finding | Suggested fix (not applied live) |
|---|---|---|---|
| B1 | Medium, FIXED 11:29 | Per-IP limit keys on the exact client address. The cloud test machine egresses via a pool that changes IPv4/IPv6 per connection, so each POST was a new "visitor" (2nd POST and both spoof tests succeeded from that machine; from a stable IP the limit works). Any IPv6 user has a /64 to rotate through. Loss is bounded by the daily cap (0.1 SOL/day), but one actor can exhaust the cap and deny the demo to others. | Key IPv6 by prefix: `import { ipKeyGenerator } from 'express-rate-limit'` and use `ipKeyGenerator(clientIp(req), 56)` in `keyGenerator` and for `lastRunByIp`. Enable Turnstile (`TURNSTILE_SECRET`, `TURNSTILE_SITEKEY`). Optionally lower `SPLITPAY_DAILY_MAX_RUNS` and add a global per-minute limit. |
| B2 | Low, FIXED 11:29 | `app.use(cors())` gives `Access-Control-Allow-Origin: *` and allows POST from any origin, so a third-party page can make its visitors' browsers trigger demo runs (cap drain via many IPs). | In the router, reject POST /demo when `Origin` is present and not `https://xspence.co.uk`, or mount `cors({ origin: 'https://xspence.co.uk' })` on the splitpay router before the app-wide one. |
| B3 | Low, PARTLY FIXED (SOLSplit paths only) | No HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy; `X-Powered-By: Express` exposed. | `app.disable('x-powered-by')`, add `helmet` (CSP allowing fonts.googleapis.com / fonts.gstatic.com and challenges.cloudflare.com) or set headers in Apache. |
| B4 | Info, FIXED | Router-level `express.json({ limit: '4kb' })` is ineffective because the app-wide parser (100 KB) runs first; bodies up to 100 KB are accepted. | Harmless (body is ignored except the token); drop the router parser or document. |
| B5 | Info, FIXED | Default Express HTML error pages for 400/404/413 on API paths. | Optional JSON 404 handler at the end of the router. |

## 4. Page (headless Chrome, live)

Script `test-artifacts/ui.mjs`, result `test-artifacts/ui-result.json`. Screenshots: `test-artifacts/live-desktop.png`,
`test-artifacts/live-desktop-result.png` (after the UI run), `test-artifacts/live-mobile.png`.
- `/splitpay/?x=1#demo` lands on `/solsplit/?x=1#demo` (query and hash preserved). PASS
- Desktop 1440 and mobile 390 render, no horizontal overflow on mobile. PASS
- Console errors 0, page errors 0, failed requests 0. PASS
- Status loaded (treasury balance shown), button enabled. PASS
- UI demo run: result card with tx Explorer link (devnet), before/after per recipient (+40,000/+30,000/+20,000/+10,000),
  last-run column filled, button shows cooldown countdown. PASS
- Accessibility basics: `lang="en"`, title, viewport meta, landmarks header/nav/main/footer, heading order h1 > h2 > h3,
  images have alt, button has text, no unlabeled links, all new-tab links `rel=noopener`. PASS
- Contrast (WCAG AA): body 21:1, muted text 8.0 to 8.5:1, green links 14:1, button text 4.65:1 on purple end and 14:1 on green end. PASS
- Footer disclaimer #6f6f85 on black 4.29:1 (< 4.5:1 for small text). FAIL, Low. FIXED: now #8f8fa6, 6.65:1.
- Note: the treasury balance and results are announced only visually; adding `aria-live="polite"` to `#statusMsg` and
  `#resultCard` would help screen readers (Info).

## Recommendation before verified build / security.txt
1. Fix B1 (IPv6 prefix keying + Turnstile) and B2 (origin check) in the drop-in and redeploy the router (needs a restart).
2. Decide on R1 (reject vault/config as recipients) and R6 (upgrade authority) before producing the verified build,
   since R1 needs a program upgrade.
3. B3 headers and the contrast tweak are quick wins.

## Follow-up: live site fixes deployed (2026-10-15 11:29)

Approved scope: live site only (no program upgrade, no multisig). A backup of src/splitpay, public/solsplit, public/splitpay and server.js was taken before the change.

Changes deployed:
- server.js: the SOLSplit line moved from after `express.json()` to directly before `app.use(cors())`, now
  `app.use((await import('./src/splitpay/splitpay-routes.js')).createSolSplitMount());`. It handles /api/splitpay itself and
  adds headers to /solsplit/ and /splitpay/, everything else passes through untouched.
- Rate limit key `ipKeyGenerator(clientIp, 56)`: IPv4 per address, IPv6 per /56, source still last X-Forwarded-For, 1 run per 2 min.
- POST /demo origin check: Origin must be https://xspence.co.uk or https://www.xspence.co.uk (www is the Apache ServerAlias);
  if Origin is absent, Referer (when present) must match; if both are absent it is allowed (non-browser client; browsers
  always send Origin on cross-origin POST). Others get 403 before the rate limiter. CORS on /api/splitpay echoes only allowed
  origins; foreign preflights get 403. Site-wide CORS unchanged (`*` on other routes, verified).
- Headers on /api/splitpay: CSP `default-src 'none'; frame-ancestors 'none'`, nosniff, X-Frame-Options DENY,
  Referrer-Policy strict-origin-when-cross-origin, Cache-Control no-store. On /solsplit/ and /splitpay/: CSP self + Google
  Fonts + Cloudflare Turnstile + hash of the redirect script, same other headers.
- JSON bodies for 400/404/413/500 on /api/splitpay; the 4 KB body limit is now effective.
- Footer disclaimer contrast 6.65:1; aria-live on the status line and result card.
- Turnstile: unchanged and off (no keys). Enable by adding TURNSTILE_SITEKEY and TURNSTILE_SECRET to .env and restarting.

Verification
| Check | Result |
|---|---|
| Harness security checks `harness-checks.sh` | 25/25 |
| Harness rate limit: IPv6 same /56 different /64 -> 429, different /56 -> 200, IPv4 per address, daily cap 429 | PASS |
| `ipv6-grouping-unit.mjs` (ipKeyGenerator /56, IPv4, ::ffff: mapped) | 7/7 |
| Live after restart: /, /index, /devnet, /about, /hooks101, /contact, /claim, /health, css asset, /solsplit/, /splitpay/, status | all 200 |
| Live `harness-checks.sh https://xspence.co.uk` (no demo runs) | 25/25 |
| Live headless Chrome: 0 console/CSP errors, 0 page errors, 0 failed requests, Inter font loaded, redirect keeps query/hash, UI demo run OK | PASS |
| Live stable-IP test: 1 run 200, then 10 parallel 429, spoofed IPv6 XFF 429 | PASS |
| Accounting: 20 runs, usage 0.0021 SOL, on-chain total_distributed 0.002 | consistent |

Live demo runs used: 2 (UI run and stable-IP run), 210,000 lamports. Treasury now 28.3918464 SOL.

Residual risks
- /56 grouping stops ordinary IPv6 rotation, but an actor with many /56s or many IPv4 addresses (e.g. a VPN pool) can still
  run once per address; the daily cap (0.1 SOL) bounds it. Turnstile is the remaining control.
- Site-wide (not changed, recommended): `app.disable('x-powered-by')` and HSTS in the Apache SSL vhost
  (`Header always set Strict-Transport-Security "max-age=31536000"`).
