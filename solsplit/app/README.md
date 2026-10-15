# SplitPay browser app

Small React and Vite front end for the `splitpay` program on devnet. It talks to the program directly from the
browser (throwaway keypair for the demo, Phantom via wallet adapter for the advanced view), so there is no backend.

- `src/config.ts`: RPC, airdrop and demo settings (also settable with `VITE_` env vars at build time).
- `src/DemoApp.tsx`: guided demo. `src/AdvancedApp.tsx`: create, update, distribute and close your own splits.
- `src/idl.json`: program IDL copied from `target/idl/splitpay.json`.

```
npm install
npm run dev      # local dev server
npm run build    # type check and production build into dist/
```
