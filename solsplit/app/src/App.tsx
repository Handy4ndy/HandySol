import { useState } from "react";
import DemoApp from "./DemoApp";
import AdvancedApp from "./AdvancedApp";
import idl from "./idl.json";

export default function App() {
  const [advanced, setAdvanced] = useState(false);
  const pid = (idl as any).address as string;
  return (
    <div className="wrap">
      <header>
        <div>
          <h1>SplitPay</h1>
          <p className="sub">Trustless SOL splits on Solana devnet. A port of the Xahau DynamicSplitPayment hook.</p>
        </div>
      </header>
      <p className="note">Devnet only. Program <a href={`https://explorer.solana.com/address/${pid}?cluster=devnet`} target="_blank" rel="noreferrer">{pid.slice(0, 4)}...{pid.slice(-4)}</a>
        {" | "}<a href="#" onClick={(e) => { e.preventDefault(); setAdvanced(!advanced); }}>{advanced ? "Back to quick demo" : "Advanced: use my own wallet"}</a></p>
      {advanced ? <AdvancedApp /> : <DemoApp />}
    </div>
  );
}
