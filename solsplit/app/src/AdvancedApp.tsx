import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import idl from "./idl.json";

const PROGRAM_ID = new PublicKey((idl as any).address);
const tx = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const addr = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
const short = (s: string) => `${s.slice(0, 4)}...${s.slice(-4)}`;

type Row = { address: string; percent: string };
type Split = { pubkey: PublicKey; vault: PublicKey; id: BN; recipients: { pubkey: PublicKey; shareBps: number }[]; totalDistributed: BN };
type Log = { label: string; sig: string; time: string };

const vaultFor = (split: PublicKey) =>
  PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), split.toBuffer()], PROGRAM_ID)[0];

export default function AdvancedApp() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const wallet = useAnchorWallet();
  const program = useMemo(() => wallet ? new Program(idl as any, new AnchorProvider(connection, wallet, {})) : null, [wallet, connection]);

  const [rows, setRows] = useState<Row[]>([{ address: "", percent: "50" }, { address: "", percent: "50" }]);
  const [splits, setSplits] = useState<Split[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [deposit, setDeposit] = useState("0.1");
  const [logs, setLogs] = useState<Log[]>(() => JSON.parse(localStorage.getItem("splitpay-logs") ?? "[]"));
  const [busy, setBusy] = useState(false);
  const [walletBal, setWalletBal] = useState<number | null>(null);
  const [faucet, setFaucet] = useState<{ kind: "info" | "ok" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const addLog = (label: string, sig: string) => setLogs((l) => {
    const next = [{ label, sig, time: new Date().toLocaleTimeString() }, ...l].slice(0, 20);
    localStorage.setItem("splitpay-logs", JSON.stringify(next));
    return next;
  });

  const total = rows.reduce((s, r) => s + (parseFloat(r.percent) || 0), 0);
  const current = splits.find((s) => s.pubkey.toBase58() === selected);

  const load = useCallback(async () => {
    if (!program || !publicKey) { setWalletBal(null); return setSplits([]); }
    setWalletBal(await connection.getBalance(publicKey, "confirmed"));
    const all = await (program.account as any).splitConfig.all([{ memcmp: { offset: 8, bytes: publicKey.toBase58() } }]);
    const list: Split[] = all.map((a: any) => ({ pubkey: a.publicKey, vault: vaultFor(a.publicKey), id: a.account.splitId, recipients: a.account.recipients, totalDistributed: a.account.totalDistributed }));
    list.sort((a, b) => b.id.cmp(a.id));
    setSplits(list);
    const bals: Record<string, number> = {};
    await Promise.all(list.map(async (s) => { bals[s.vault.toBase58()] = await connection.getBalance(s.vault); }));
    setBalances(bals);
    if (list.length && !list.find((s) => s.pubkey.toBase58() === selected)) setSelected(list[0].pubkey.toBase58());
  }, [program, publicKey, connection, selected]);

  useEffect(() => { load().catch((e) => setMsg({ kind: "err", text: String(e) })); }, [load]);

  const run = async (label: string, f: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try {
      const sig = await f();
      addLog(label, sig);
      setMsg({ kind: "ok", text: `${label} confirmed` });
      await load();
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.error?.errorMessage ?? e?.message ?? String(e) });
    } finally { setBusy(false); }
  };

  const airdrop = async () => {
    if (!publicKey) return;
    setBusy(true);
    for (const sol of [1, 0.5]) {
      setFaucet({ kind: "info", text: `Requesting ${sol} devnet SOL...` });
      try {
        const sig = await connection.requestAirdrop(publicKey, sol * LAMPORTS_PER_SOL);
        const bh = await connection.getLatestBlockhash("confirmed");
        await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
        addLog(`Airdrop ${sol} SOL`, sig);
        setFaucet({ kind: "ok", text: `Received ${sol} devnet SOL.` });
        await load().catch(() => undefined);
        setBusy(false);
        return;
      } catch { /* try the smaller amount next */ }
    }
    setFaucet({ kind: "err", text: "The public devnet faucet is rate limited right now. Use the web faucet below (sign in with GitHub for higher limits), paste your address, then click Refresh." });
    setBusy(false);
  };
  const copyAddr = async () => {
    if (!publicKey) return;
    await navigator.clipboard.writeText(publicKey.toBase58()).catch(() => undefined);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  const fillDemo = () => {
    const mk = () => Keypair.generate().publicKey.toBase58();
    setRows([{ address: mk(), percent: "50" }, { address: mk(), percent: "30" }, { address: mk(), percent: "20" }]);
    setMsg({ kind: "ok", text: "Filled 3 throwaway demo recipients (50/30/20). Click Create split, then Deposit and Distribute." });
  };

  const create = () => run("Create split", async () => {
    if (!program || !publicKey) throw new Error("Connect a wallet");
    const recipients = rows.map((r) => ({ pubkey: new PublicKey(r.address.trim()), shareBps: Math.round(parseFloat(r.percent) * 100) }));
    const id = new BN(Date.now());
    return program.methods.initSplit(id, recipients).accounts({ owner: publicKey }).rpc();
  });

  const fund = () => run("Deposit", async () => {
    if (!publicKey || !current) throw new Error("Select a split");
    const lamports = Math.round(parseFloat(deposit) * LAMPORTS_PER_SOL);
    const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: current.vault, lamports }));
    const sig = await sendTransaction(t, connection);
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  });

  const distribute = () => run("Distribute", async () => {
    if (!program || !current) throw new Error("Select a split");
    return program.methods.distribute().accounts({ split: current.pubkey })
      .remainingAccounts(current.recipients.map((r) => ({ pubkey: r.pubkey, isWritable: true, isSigner: false }))).rpc();
  });

  const setRow = (i: number, k: keyof Row, v: string) => setRows(rows.map((r, j) => j === i ? { ...r, [k]: v } : r));
  const vb = current ? balances[current.vault.toBase58()] ?? 0 : 0;

  return (
    <div>
      <div className="actions"><WalletMultiButton /></div>
      {publicKey && (
        <section className="card">
          <h2>Wallet</h2>
          <div className="actions">
            <span>Balance: <b>{walletBal === null ? "..." : (walletBal / LAMPORTS_PER_SOL).toFixed(4)} SOL</b></span>
            <button disabled={busy} onClick={airdrop}>Get devnet SOL</button>
            <button className="ghost" disabled={busy} onClick={() => load()}>Refresh</button>
          </div>
          {walletBal !== null && walletBal < 0.05 * LAMPORTS_PER_SOL && !faucet && (
            <div className="msg warn">Your devnet balance is low (under 0.05 SOL). Click Get devnet SOL to top up before creating a split.</div>)}
          {faucet && <div className={`msg ${faucet.kind}`}>{faucet.text}</div>}
          {faucet?.kind === "err" && (
            <div className="actions" style={{ marginTop: 10 }}>
              <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">Open faucet.solana.com</a>
              <code>{publicKey.toBase58()}</code>
              <button className="ghost" onClick={copyAddr}>{copied ? "Copied" : "Copy address"}</button>
            </div>)}
        </section>
      )}
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}

      <section className="card">
        <div className="actions" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>1. Create a split</h2>
          <button className="ghost" onClick={fillDemo}>Try demo split</button>
        </div>
        {rows.map((r, i) => (
          <div className="row" key={i}>
            <input placeholder="Recipient address" value={r.address} onChange={(e) => setRow(i, "address", e.target.value)} />
            <input className="pct" type="number" min="0.01" step="0.01" value={r.percent} onChange={(e) => setRow(i, "percent", e.target.value)} /><span>%</span>
            <button className="ghost" disabled={rows.length <= 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <div className="actions">
          <button className="ghost" disabled={rows.length >= 10} onClick={() => setRows([...rows, { address: "", percent: "0" }])}>Add recipient</button>
          <span className={Math.abs(total - 100) < 1e-9 ? "good" : "bad"}>Total {total.toFixed(2)}%</span>
          <button disabled={busy || !publicKey || Math.abs(total - 100) > 1e-9} onClick={create}>Create split</button>
        </div>
      </section>

      <section className="card">
        <h2>2. Fund and distribute</h2>
        {!publicKey ? <p>Connect a wallet to see your splits.</p> : splits.length === 0 ? <p>No splits yet.</p> : (<>
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {splits.map((s) => <option key={s.pubkey.toBase58()} value={s.pubkey.toBase58()}>Split {s.id.toString()} ({s.recipients.length} recipients)</option>)}
          </select>
          {current && (<>
            <dl>
              <dt>Vault</dt><dd><a href={addr(current.vault.toBase58())} target="_blank">{current.vault.toBase58()}</a></dd>
              <dt>Vault balance</dt><dd>{(vb / LAMPORTS_PER_SOL).toFixed(6)} SOL</dd>
              <dt>Total distributed</dt><dd>{(current.totalDistributed.toNumber() / LAMPORTS_PER_SOL).toFixed(6)} SOL</dd>
            </dl>
            <table><tbody>{current.recipients.map((r) => (
              <tr key={r.pubkey.toBase58()}><td><a href={addr(r.pubkey.toBase58())} target="_blank">{short(r.pubkey.toBase58())}</a></td><td>{(r.shareBps / 100).toFixed(2)}%</td></tr>))}</tbody></table>
            <div className="actions">
              <input className="pct" type="number" step="0.01" value={deposit} onChange={(e) => setDeposit(e.target.value)} /><span>SOL</span>
              <button disabled={busy} onClick={fund}>Deposit</button>
              <button disabled={busy} onClick={distribute}>Distribute</button>
              <button className="ghost" disabled={busy} onClick={() => load()}>Refresh</button>
            </div>
          </>)}
        </>)}
      </section>

      <section className="card">
        <h2>Recent results</h2>
        {logs.length === 0 ? <p>No transactions yet.</p> : (
          <ul className="logs">{logs.map((l) => (
            <li key={l.sig}><span>{l.time}</span><b>{l.label}</b><a href={tx(l.sig)} target="_blank">{short(l.sig)}</a></li>))}</ul>)}
      </section>
    </div>
  );
}
