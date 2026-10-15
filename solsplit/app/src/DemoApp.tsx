import { useCallback, useEffect, useMemo, useState } from "react";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import idl from "./idl.json";
import { AIRDROP_AMOUNTS, assertRecipientsConfigured, DEMO_DEPOSIT_SOL, DEMO_RECIPIENTS, EXTRA_AIRDROP_RPCS, FAUCET_RELAY_URL, MANUAL_FAUCETS, MIN_DEMO_SOL, RPC_URL } from "./config";

const PROGRAM_ID = new PublicKey((idl as any).address);
const txUrl = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const addrUrl = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`;
const short = (s: string) => `${s.slice(0, 4)}...${s.slice(-4)}`;
const sol = (l: number) => (l / LAMPORTS_PER_SOL).toFixed(6);
const KEY = "splitpay-demo-wallet";

type Status = { kind: "info" | "ok" | "err" | "warn"; text: string };
type Step = { label: string; sig: string };
type Result = { split: string; vault: string; steps: Step[]; rows: { label: string; address: string; shareBps: number; before: number; after: number }[] };

function loadKeypair(): Keypair | null {
  const raw = sessionStorage.getItem(KEY);
  return raw ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))) : null;
}

export default function DemoApp() {
  const connection = useMemo(() => new Connection(RPC_URL, "confirmed"), []);
  const [kp, setKp] = useState<Keypair | null>(() => loadKeypair());
  const [bal, setBal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [needManual, setNeedManual] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (!kp) return;
    setBal(await connection.getBalance(kp.publicKey, "confirmed"));
  }, [kp, connection]);
  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);

  // While waiting for a manual faucet top up, poll the balance.
  useEffect(() => {
    if (!needManual || !kp) return;
    const t = setInterval(async () => {
      const b = await connection.getBalance(kp.publicKey, "confirmed").catch(() => 0);
      setBal(b);
      if (b >= MIN_DEMO_SOL * LAMPORTS_PER_SOL) { setNeedManual(false); setStatus({ kind: "ok", text: "Funds arrived. You can run the demo split." }); }
    }, 5000);
    return () => clearInterval(t);
  }, [needManual, kp, connection]);

  const program = useMemo(() => {
    if (!kp) return null;
    const wallet = {
      publicKey: kp.publicKey,
      signTransaction: async <T extends Transaction | VersionedTransaction>(t: T) => {
        if (t instanceof VersionedTransaction) t.sign([kp]); else t.partialSign(kp);
        return t;
      },
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(ts: T[]) => {
        ts.forEach((t) => { if (t instanceof VersionedTransaction) t.sign([kp]); else t.partialSign(kp); });
        return ts;
      },
    };
    return new Program(idl as any, new AnchorProvider(connection, wallet, { commitment: "confirmed" }));
  }, [kp, connection]);

  const tryAirdrop = async (rpc: string, address: PublicKey, amount: number) => {
    const c = new Connection(rpc, "confirmed");
    const sig = await c.requestAirdrop(address, Math.round(amount * LAMPORTS_PER_SOL));
    const bh = await c.getLatestBlockhash("confirmed");
    await c.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    return sig;
  };

  const fund = async (target: Keypair) => {
    setNeedManual(false);
    if (FAUCET_RELAY_URL) {
      try {
        setStatus({ kind: "info", text: "Requesting devnet SOL from the demo faucet relay..." });
        const r = await fetch(FAUCET_RELAY_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: target.publicKey.toBase58() }) });
        if (r.ok) { await connection.confirmTransaction((await r.json()).signature, "confirmed"); setStatus({ kind: "ok", text: "Funded by the demo faucet relay." }); await refresh(); return; }
      } catch { /* fall through */ }
    }
    for (const rpc of [RPC_URL, ...EXTRA_AIRDROP_RPCS]) {
      for (const amount of AIRDROP_AMOUNTS) {
        setStatus({ kind: "info", text: `Requesting ${amount} devnet SOL from ${new URL(rpc).host}...` });
        try {
          await tryAirdrop(rpc, target.publicKey, amount);
          setStatus({ kind: "ok", text: `Funded with ${amount} devnet SOL.` });
          setBal(await connection.getBalance(target.publicKey, "confirmed"));
          return;
        } catch { /* try a smaller amount or the next RPC */ }
      }
    }
    setStatus({ kind: "warn", text: "The automatic devnet faucet is rate limited right now. Fund this address from one of the faucets below (about 0.05 SOL is plenty). This page checks the balance every 5 seconds." });
    setNeedManual(true);
  };

  const createWallet = async () => {
    setBusy(true); setResult(null);
    let k = kp;
    if (!k) {
      k = Keypair.generate();
      sessionStorage.setItem(KEY, JSON.stringify(Array.from(k.secretKey)));
      setKp(k);
    }
    try { await fund(k); } finally { setBusy(false); }
  };

  const resetWallet = () => { sessionStorage.removeItem(KEY); setKp(null); setBal(null); setResult(null); setStatus(null); setNeedManual(false); };

  const runDemo = async () => {
    if (!program || !kp) return;
    try { assertRecipientsConfigured(); } catch (e) { setStatus({ kind: "err", text: (e as Error).message }); return; }
    setBusy(true); setResult(null);
    const recips = DEMO_RECIPIENTS.map((r) => ({ ...r, pubkey: new PublicKey(r.address) }));
    try {
      const before = await Promise.all(recips.map((r) => connection.getBalance(r.pubkey, "confirmed")));
      const id = new BN(Date.now());
      const [split] = PublicKey.findProgramAddressSync([new TextEncoder().encode("split"), kp.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)], PROGRAM_ID);
      const [vault] = PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), split.toBuffer()], PROGRAM_ID);
      const steps: Step[] = [];

      setStatus({ kind: "info", text: "1/3 Creating split config..." });
      steps.push({ label: "Create split", sig: await program.methods.initSplit(id, recips.map((r) => ({ pubkey: r.pubkey, shareBps: r.shareBps }))).accounts({ owner: kp.publicKey }).rpc() });

      setStatus({ kind: "info", text: `2/3 Depositing ${DEMO_DEPOSIT_SOL} SOL into the vault...` });
      const rent = await connection.getMinimumBalanceForRentExemption(0);
      const vaultBal = await connection.getBalance(vault, "confirmed");
      const lamports = Math.round(DEMO_DEPOSIT_SOL * LAMPORTS_PER_SOL) + Math.max(0, rent - vaultBal);
      steps.push({ label: "Deposit", sig: await program.provider.sendAndConfirm!(new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: vault, lamports }))) });

      setStatus({ kind: "info", text: "3/3 Distributing..." });
      steps.push({ label: "Distribute", sig: await program.methods.distribute().accounts({ split })
        .remainingAccounts(recips.map((r) => ({ pubkey: r.pubkey, isWritable: true, isSigner: false }))).rpc() });

      const after = await Promise.all(recips.map((r) => connection.getBalance(r.pubkey, "confirmed")));
      setResult({ split: split.toBase58(), vault: vault.toBase58(), steps, rows: recips.map((r, i) => ({ label: r.label, address: r.address, shareBps: r.shareBps, before: before[i], after: after[i] })) });
      setStatus({ kind: "ok", text: "Demo split complete." });
      await refresh();
    } catch (e: any) {
      setStatus({ kind: "err", text: e?.error?.errorMessage ?? e?.message ?? String(e) });
    } finally { setBusy(false); }
  };

  const copy = async () => {
    if (!kp) return;
    await navigator.clipboard.writeText(kp.publicKey.toBase58()).catch(() => undefined);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  const enough = bal !== null && bal >= MIN_DEMO_SOL * LAMPORTS_PER_SOL;

  return (<>
    {status && <div className={`msg ${status.kind}`}>{status.text}</div>}

    <section className="card">
      <h2>1. Demo wallet</h2>
      <p className="sub">A throwaway devnet keypair is generated in your browser and kept in this tab only (sessionStorage). No browser wallet needed.</p>
      {kp && (<dl>
        <dt>Address</dt><dd><a href={addrUrl(kp.publicKey.toBase58())} target="_blank" rel="noreferrer">{kp.publicKey.toBase58()}</a> <button className="ghost small" onClick={copy}>{copied ? "Copied" : "Copy"}</button></dd>
        <dt>Balance</dt><dd>{bal === null ? "..." : `${sol(bal)} SOL`}</dd>
      </dl>)}
      <div className="actions">
        <button disabled={busy} onClick={createWallet}>{kp ? "Fund demo wallet" : "Create and fund demo wallet"}</button>
        {kp && <button className="ghost" disabled={busy} onClick={() => refresh()}>Refresh</button>}
        {kp && <button className="ghost" disabled={busy} onClick={resetWallet}>New wallet</button>}
      </div>
      {kp && bal !== null && !enough && !needManual && <div className="msg warn">Balance is under {MIN_DEMO_SOL} SOL. Fund the wallet before running the demo.</div>}
      {needManual && kp && (
        <div className="faucets">
          {MANUAL_FAUCETS.map((f) => <a key={f.url} href={f.url} target="_blank" rel="noreferrer">{f.name}</a>)}
          <code>{kp.publicKey.toBase58()}</code>
        </div>)}
    </section>

    <section className="card">
      <h2>2. Run demo split</h2>
      <p className="sub">Creates a split to these fixed devnet recipients, deposits {DEMO_DEPOSIT_SOL} SOL into its vault, then distributes.</p>
      <table><tbody>{DEMO_RECIPIENTS.map((r) => (
        <tr key={r.address}><td>{r.label}</td><td><a href={addrUrl(r.address)} target="_blank" rel="noreferrer">{short(r.address)}</a></td><td>{(r.shareBps / 100).toFixed(2)}%</td></tr>))}</tbody></table>
      <div className="actions"><button disabled={busy || !enough} onClick={runDemo}>Run demo split</button></div>
    </section>

    {result && (
      <section className="card">
        <h2>Results</h2>
        <dl>
          <dt>Split</dt><dd><a href={addrUrl(result.split)} target="_blank" rel="noreferrer">{result.split}</a></dd>
          <dt>Vault</dt><dd><a href={addrUrl(result.vault)} target="_blank" rel="noreferrer">{result.vault}</a></dd>
        </dl>
        <table>
          <thead><tr><th>Recipient</th><th>Share</th><th>Before</th><th>After</th><th>Received</th></tr></thead>
          <tbody>{result.rows.map((r) => (
            <tr key={r.address}><td><a href={addrUrl(r.address)} target="_blank" rel="noreferrer">{r.label}</a></td><td>{(r.shareBps / 100).toFixed(2)}%</td>
              <td>{sol(r.before)}</td><td>{sol(r.after)}</td><td className="good">+{sol(r.after - r.before)}</td></tr>))}</tbody>
        </table>
        <ul className="logs">{result.steps.map((s) => (
          <li key={s.sig}><b>{s.label}</b><a href={txUrl(s.sig)} target="_blank" rel="noreferrer">{short(s.sig)}</a></li>))}</ul>
      </section>)}
  </>);
}
