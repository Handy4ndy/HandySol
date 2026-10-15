import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { assert } from "chai";
import { Splitpay } from "../target/types/splitpay";

describe("splitpay", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Splitpay as Program<Splitpay>;
  const owner = provider.wallet.publicKey;
  let nextId = Date.now();

  const pdas = (id: number, o: PublicKey = owner) => {
    const [split] = PublicKey.findProgramAddressSync(
      [Buffer.from("split"), o.toBuffer(), new BN(id).toArrayLike(Buffer, "le", 8)], program.programId);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), split.toBuffer()], program.programId);
    return { split, vault };
  };
  const recips = (shares: number[]) => shares.map((s) => ({ pubkey: Keypair.generate().publicKey, shareBps: s }));
  const init = async (rs: { pubkey: PublicKey; shareBps: number }[]) => {
    const id = nextId++;
    const p = pdas(id);
    await program.methods.initSplit(new BN(id), rs).accounts({ owner }).rpc();
    return { id, ...p, rs };
  };
  const expectErr = async (f: () => Promise<unknown>, code: string) => {
    try { await f(); } catch (e: any) {
      assert.include(String(e?.error?.errorCode?.code ?? e), code); return;
    }
    assert.fail("expected error " + code);
  };
  const fund = async (to: PublicKey, lamports: number) => {
    await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: to, lamports })));
  };
  const distribute = (s: { split: PublicKey; rs: { pubkey: PublicKey }[] }) =>
    program.methods.distribute().accounts({ split: s.split })
      .remainingAccounts(s.rs.map((r) => ({ pubkey: r.pubkey, isWritable: true, isSigner: false }))).rpc();
  const bal = (k: PublicKey) => provider.connection.getBalance(k);

  it("rejects shares that do not sum to 10000", async () => {
    await expectErr(() => init(recips([5000, 4000])), "InvalidShareSum");
  });
  it("rejects shares that sum above 10000", async () => {
    await expectErr(() => init(recips([6000, 5000])), "InvalidShareSum");
  });
  it("rejects duplicate recipients", async () => {
    const k = Keypair.generate().publicKey;
    await expectErr(() => init([{ pubkey: k, shareBps: 5000 }, { pubkey: k, shareBps: 5000 }]), "DuplicateRecipient");
  });
  it("rejects a zero share", async () => {
    await expectErr(() => init(recips([10000, 0])), "ZeroShare");
  });
  it("rejects more than 10 recipients", async () => {
    await expectErr(() => init(recips([...Array(10).fill(909), 910])), "TooManyRecipients");
  });
  it("happy path: 3 recipients split 50/30/20", async () => {
    const s = await init(recips([5000, 3000, 2000]));
    const rentMin = await provider.connection.getMinimumBalanceForRentExemption(0);
    await fund(s.vault, rentMin + LAMPORTS_PER_SOL);
    await distribute(s);
    const got = await Promise.all(s.rs.map((r) => bal(r.pubkey)));
    assert.deepEqual(got, [0.5, 0.3, 0.2].map((f) => f * LAMPORTS_PER_SOL));
    assert.equal(await bal(s.vault), rentMin);
    const cfg = await program.account.splitConfig.fetch(s.split);
    assert.equal(cfg.totalDistributed.toNumber(), LAMPORTS_PER_SOL);
  });
  it("rounding remainder goes to the last recipient", async () => {
    const s = await init(recips([3333, 3333, 3334]));
    const rentMin = await provider.connection.getMinimumBalanceForRentExemption(0);
    // recipients must end rent exempt, so use amounts well above rent
    const amount = 10_000_001;
    await fund(s.vault, rentMin + amount);
    await distribute(s);
    const got = await Promise.all(s.rs.map((r) => bal(r.pubkey)));
    const a = Math.floor((amount * 3333) / 10000);
    assert.deepEqual(got, [a, a, amount - 2 * a]);
    assert.equal(got.reduce((x, y) => x + y, 0), amount);
  });
  it("fails distribute when vault is empty", async () => {
    const s = await init(recips([10000]));
    await expectErr(() => distribute(s), "NothingToDistribute");
  });
  it("fails distribute with wrong recipient accounts", async () => {
    const s = await init(recips([5000, 5000]));
    await fund(s.vault, LAMPORTS_PER_SOL);
    await expectErr(() => distribute({ ...s, rs: [s.rs[1], s.rs[0]] }), "RecipientMismatch");
  });
  it("lets anyone distribute", async () => {
    const s = await init(recips([10000]));
    await fund(s.vault, LAMPORTS_PER_SOL);
    const rando = Keypair.generate();
    await fund(rando.publicKey, LAMPORTS_PER_SOL / 10);
    const tx = await program.methods.distribute().accounts({ split: s.split })
      .remainingAccounts([{ pubkey: s.rs[0].pubkey, isWritable: true, isSigner: false }]).transaction();
    tx.feePayer = rando.publicKey;
    await sendAndConfirmTransaction(provider.connection, tx, [rando]);
    assert.isAbove(await bal(s.rs[0].pubkey), 0);
  });
  it("owner can update, others cannot", async () => {
    const s = await init(recips([5000, 5000]));
    const next = recips([7000, 3000]);
    await program.methods.updateSplit(next).accounts({ split: s.split }).rpc();
    const cfg = await program.account.splitConfig.fetch(s.split);
    assert.equal(cfg.recipients[0].shareBps, 7000);
    const mallory = Keypair.generate();
    await fund(mallory.publicKey, LAMPORTS_PER_SOL / 10);
    try {
      await program.methods.updateSplit(recips([10000]))
        .accountsPartial({ owner: mallory.publicKey, split: s.split }).signers([mallory]).rpc();
      assert.fail("unauthorised update succeeded");
    } catch (e: any) {
      assert.match(String(e?.error?.errorCode?.code ?? e), /Unauthorized|ConstraintSeeds/);
    }
  });
  it("owner can close and reclaim vault funds", async () => {
    const s = await init(recips([10000]));
    await fund(s.vault, LAMPORTS_PER_SOL);
    await program.methods.close().accounts({ split: s.split }).rpc();
    assert.isNull(await provider.connection.getAccountInfo(s.split));
    assert.equal(await bal(s.vault), 0);
  });
});
