import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./index.css";
import App from "./App";

export const RPC = "https://api.devnet.solana.com";

function Root() {
  // Phantom and Solflare register via the Wallet Standard, so no explicit adapters are needed.
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
