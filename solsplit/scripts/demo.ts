// Devnet demo: create a split to 3 throwaway recipients, fund the vault, distribute.
// Run: ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=./deployer.json npx ts-node scripts/demo.ts
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import idl from "../target/idl/splitpay.json";

const ex = (s: string) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;

(async () => {
  const env = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(env.connection, env.wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
  const program = new Program(idl as anchor.Idl, provider);
  const owner = provider.wallet.publicKey;
  const recipients = [5000, 3000, 2000].map((s) => ({ pubkey: Keypair.generate().publicKey, shareBps: s }));
  const id = new BN(Date.now());
  const [split] = PublicKey.findProgramAddressSync(
    [Buffer.from("split"), owner.toBuffer(), id.toArrayLike(Buffer, "le", 8)], program.programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), split.toBuffer()], program.programId);

  const initSig = await program.methods.initSplit(id, recipients).accounts({ owner }).rpc();
  const rent = await provider.connection.getMinimumBalanceForRentExemption(0);
  const fundSig = await provider.sendAndConfirm(new Transaction().add(
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: vault, lamports: rent + 0.1 * LAMPORTS_PER_SOL })));
  const distSig = await program.methods.distribute().accounts({ split })
    .remainingAccounts(recipients.map((r) => ({ pubkey: r.pubkey, isWritable: true, isSigner: false }))).rpc();
  const balances = await Promise.all(recipients.map((r) => provider.connection.getBalance(r.pubkey, "confirmed")));
  const out = {
    programId: program.programId.toBase58(), split: split.toBase58(), vault: vault.toBase58(),
    recipients: recipients.map((r, i) => ({ pubkey: r.pubkey.toBase58(), shareBps: r.shareBps, lamports: balances[i] })),
    txs: { initSplit: ex(initSig), fund: ex(fundSig), distribute: ex(distSig) },
  };
  fs.writeFileSync("demo-result.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
})();
