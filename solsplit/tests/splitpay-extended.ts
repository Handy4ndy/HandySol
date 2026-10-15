// Extended SplitPay suite: boundaries, account substitution, rounding, lifecycle, atomicity, fuzz.
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { Splitpay } from "../target/types/splitpay";

type R = { pubkey: PublicKey; shareBps: number };

describe("splitpay extended", function () {
  this.timeout(3_600_000);
  const envProv = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    new anchor.web3.Connection(envProv.connection.rpcEndpoint, "confirmed"), envProv.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program<Splitpay>(require("../target/idl/splitpay.json"), provider);
  const conn = provider.connection;
  const owner = provider.wallet.publicKey;
  const payerKp: Keypair = (provider.wallet as any).payer;
  let nextId = 1_000_000 + Math.floor(Math.random() * 1e9);
  let rentMin = 0;

  const pdas = (id: number | BN, o: PublicKey = owner) => {
    const [split] = PublicKey.findProgramAddressSync(
      [Buffer.from("split"), o.toBuffer(), new BN(id).toArrayLike(Buffer, "le", 8)], program.programId);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), split.toBuffer()], program.programId);
    return { split, vault };
  };
  const bal = (k: PublicKey) => conn.getBalance(k, "confirmed");
  const send = (ixs: TransactionInstruction[], signers: Keypair[] = [payerKp]) =>
    sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed", preflightCommitment: "confirmed" });
  const xfer = (to: PublicKey, lamports: number | bigint, from: PublicKey = owner) =>
    SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: BigInt(lamports) as any });
  const fund = (to: PublicKey, lamports: number) => send([xfer(to, lamports)]);

  /** n fresh keys funded to the rent-exempt minimum so tiny payouts are accepted. */
  const fresh = async (n: number): Promise<PublicKey[]> => {
    const ks = Array.from({ length: n }, () => Keypair.generate().publicKey);
    for (let i = 0; i < ks.length; i += 10) await send(ks.slice(i, i + 10).map((k) => xfer(k, rentMin)));
    return ks;
  };
  const recips = async (shares: number[]): Promise<R[]> => {
    const ks = await fresh(shares.length);
    return shares.map((s, i) => ({ pubkey: ks[i], shareBps: s }));
  };
  const unfunded = (shares: number[]): R[] => shares.map((s) => ({ pubkey: Keypair.generate().publicKey, shareBps: s }));

  const initIx = (id: number, rs: R[], o = owner) => program.methods.initSplit(new BN(id), rs).accounts({ owner: o }).instruction();
  const init = async (rs: R[]) => {
    const id = nextId++;
    await program.methods.initSplit(new BN(id), rs).accounts({ owner }).rpc();
    return { id, ...pdas(id), rs };
  };
  const metas = (keys: PublicKey[], writable = true) => keys.map((pubkey) => ({ pubkey, isWritable: writable, isSigner: false }));
  const distIx = (split: PublicKey, keys: PublicKey[], vault?: PublicKey, extra: any = {}) =>
    program.methods.distribute().accountsPartial({ split, ...(vault ? { vault } : {}), ...extra }).remainingAccounts(metas(keys)).instruction();
  const distribute = async (s: { split: PublicKey; rs: R[] }, keys?: PublicKey[]) =>
    send([await distIx(s.split, keys ?? s.rs.map((r) => r.pubkey))]);
  const cfg = (split: PublicKey) => program.account.splitConfig.fetch(split);

  const errText = async (e: any) => {
    let logs: string[] = [];
    try { logs = (typeof e?.getLogs === "function" ? await e.getLogs(conn) : null) ?? e?.logs ?? e?.transactionLogs ?? []; } catch { logs = e?.logs ?? []; }
    return [e?.error?.errorCode?.code, e?.message, ...(logs || [])].join(" | ");
  };
  const expectFail = async (f: () => Promise<unknown>, re: RegExp) => {
    let ok = false;
    try { await f(); ok = true; } catch (e: any) { assert.match(await errText(e), re); }
    if (ok) assert.fail(`expected failure ${re}`);
  };
  const expectedParts = (amount: bigint, rs: R[]) => {
    let sent = 0n;
    return rs.map((r, i) => {
      const p = i === rs.length - 1 ? amount - sent : (amount * BigInt(r.shareBps)) / 10000n;
      sent += p; return p;
    });
  };
  /** deposit amount, distribute, assert exact per-recipient parts, conservation and vault left at rent min. */
  const depositAndCheck = async (s: { split: PublicKey; vault: PublicKey; rs: R[] }, amount: bigint) => {
    const vb = BigInt(await bal(s.vault));
    const need = vb < BigInt(rentMin) ? BigInt(rentMin) - vb : 0n;
    const before = await Promise.all(s.rs.map((r) => bal(r.pubkey)));
    const tdBefore = BigInt((await cfg(s.split)).totalDistributed.toString());
    await send([xfer(s.vault, amount + need), await distIx(s.split, s.rs.map((r) => r.pubkey))]);
    const after = await Promise.all(s.rs.map((r) => bal(r.pubkey)));
    const deltas = after.map((a, i) => BigInt(a) - BigInt(before[i]));
    const total = vb + need - BigInt(rentMin) + amount;
    assert.deepEqual(deltas.map(String), expectedParts(total, s.rs).map(String));
    assert.equal(deltas.reduce((a, b) => a + b, 0n).toString(), total.toString(), "conservation");
    assert.equal(await bal(s.vault), rentMin, "vault keeps rent min");
    const td = BigInt((await cfg(s.split)).totalDistributed.toString());
    assert.equal((td - tdBefore).toString(), total.toString(), "total_distributed");
    return deltas;
  };

  before(async () => {
    rentMin = await conn.getMinimumBalanceForRentExemption(0);
    if ((await bal(owner)) < 200_000 * LAMPORTS_PER_SOL) {
      const sig = await conn.requestAirdrop(owner, 250_000 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
    }
  });

  // ---------- init_split validation
  describe("init_split validation", () => {
    it("1 rejects sum 9999", async () => expectFail(async () => init(unfunded([5000, 4999])), /InvalidShareSum/));
    it("2 rejects sum 10001", async () => expectFail(async () => init(unfunded([9999, 2])), /InvalidShareSum/));
    it("3 accepts 9999 + 1", async () => { const s = await init(unfunded([9999, 1])); assert.equal((await cfg(s.split)).recipients.length, 2); });
    it("4 accepts a single recipient at 10000", async () => { const s = await init(unfunded([10000])); assert.equal((await cfg(s.split)).recipients[0].shareBps, 10000); });
    it("5 accepts exactly 10 recipients", async () => { const s = await init(unfunded(Array(10).fill(1000))); assert.equal((await cfg(s.split)).recipients.length, 10); });
    it("6 rejects 11 recipients", async () => expectFail(async () => init(unfunded([...Array(10).fill(909), 910])), /TooManyRecipients/));
    it("7 rejects an empty list", async () => expectFail(async () => init([]), /NoRecipients/));
    it("8 rejects a zero share", async () => expectFail(async () => init(unfunded([10000, 0])), /ZeroShare/));
    it("9 rejects adjacent duplicates", async () => {
      const k = Keypair.generate().publicKey;
      await expectFail(async () => init([{ pubkey: k, shareBps: 5000 }, { pubkey: k, shareBps: 5000 }]), /DuplicateRecipient/);
    });
    it("10 rejects non-adjacent duplicates (first and last of 10)", async () => {
      const rs = unfunded(Array(10).fill(1000)); rs[9].pubkey = rs[0].pubkey;
      await expectFail(async () => init(rs), /DuplicateRecipient/);
    });
    it("11 rejects u16-max shares (no u16 wrap)", async () => expectFail(async () => init(unfunded([65535, 65535])), /InvalidShareSum/));
    it("12 rejects shares that would wrap a u16 sum to 10000 (65535 + 10001)", async () =>
      expectFail(async () => init(unfunded([65535, 10001])), /InvalidShareSum/));
    it("13 rejects re-init of the same split id", async () => {
      const id = nextId++; const rs = unfunded([10000]);
      await program.methods.initSplit(new BN(id), rs).accounts({ owner }).rpc();
      await expectFail(() => program.methods.initSplit(new BN(id), rs).accounts({ owner }).rpc(), /already in use|0x0/);
    });
    it("14 same id under a different owner is an independent split", async () => {
      const other = Keypair.generate(); await fund(other.publicKey, LAMPORTS_PER_SOL);
      const id = nextId++;
      await program.methods.initSplit(new BN(id), unfunded([10000])).accounts({ owner }).rpc();
      await program.methods.initSplit(new BN(id), unfunded([10000])).accounts({ owner: other.publicKey }).signers([other]).rpc();
      assert.notEqual(pdas(id).split.toBase58(), pdas(id, other.publicKey).split.toBase58());
      assert.equal((await cfg(pdas(id, other.publicKey).split)).owner.toBase58(), other.publicKey.toBase58());
    });
    it("15 rejects a split PDA that does not match the seeds", async () => {
      const id = nextId++; const wrong = pdas(nextId++);
      await expectFail(() => program.methods.initSplit(new BN(id), unfunded([10000]))
        .accountsPartial({ owner, split: wrong.split, vault: wrong.vault }).rpc(), /ConstraintSeeds|seeds/i);
    });
    it("16 rejects a vault that does not match the seeds", async () => {
      const id = nextId++; const p = pdas(id);
      await expectFail(() => program.methods.initSplit(new BN(id), unfunded([10000]))
        .accountsPartial({ owner, split: p.split, vault: Keypair.generate().publicKey }).rpc(), /ConstraintSeeds|seeds/i);
    });
    it("17 init requires the owner signature (unsigned owner rejected)", async () => {
      const victim = Keypair.generate().publicKey; const id = nextId++;
      const ix = await program.methods.initSplit(new BN(id), unfunded([10000])).accounts({ owner: victim }).instruction();
      await expectFail(() => send([ix]), /signature|Signature|unknown signer/i);
    });
  });

  // ---------- share boundaries and rounding
  describe("distribution amounts and rounding", () => {
    it("18 1 bp recipient gets floor(amount/10000)", async () => {
      const s = await init(await recips([1, 9999]));
      const d = await depositAndCheck(s, 123_456_789n);
      assert.equal(d[0].toString(), "12345");
    });
    it("19 single recipient at 10000 gets everything above rent min", async () => {
      const s = await init(await recips([10000])); await depositAndCheck(s, 777_777n);
    });
    it("20 ten recipients x 1000 with remainder 10001", async () => {
      const s = await init(await recips(Array(10).fill(1000)));
      const d = await depositAndCheck(s, 10_001n);
      assert.equal(d[9].toString(), "1001");
    });
    it("21 vault at exactly rent min: NothingToDistribute", async () => {
      const s = await init(await recips([10000])); await fund(s.vault, rentMin);
      await expectFail(() => distribute(s), /NothingToDistribute/);
    });
    it("22 vault empty (below rent min): NothingToDistribute", async () => {
      const s = await init(await recips([10000])); await expectFail(() => distribute(s), /NothingToDistribute/);
    });
    it("23 rent min + 1, one recipient: +1 lamport", async () => {
      const s = await init(await recips([10000])); await fund(s.vault, rentMin);
      const d = await depositAndCheck(s, 1n); assert.equal(d[0].toString(), "1");
    });
    it("24 rent min + 1, 50/50: first 0 (skipped), last 1", async () => {
      const s = await init(await recips([5000, 5000])); await fund(s.vault, rentMin);
      const d = await depositAndCheck(s, 1n); assert.deepEqual(d.map(String), ["0", "1"]);
    });
    it("25 rent min + 7 at 3333/3333/3334: [2,2,3]", async () => {
      const s = await init(await recips([3333, 3333, 3334])); await fund(s.vault, rentMin);
      const d = await depositAndCheck(s, 7n); assert.deepEqual(d.map(String), ["2", "2", "3"]);
    });
    it("26 rent min + 9999 at 1/1/9998: [0,0,9999]", async () => {
      const s = await init(await recips([1, 1, 9998])); await fund(s.vault, rentMin);
      const d = await depositAndCheck(s, 9_999n); assert.deepEqual(d.map(String), ["0", "0", "9999"]);
    });
    it("27 demo shape: 100000 at 40/30/20/10 exact", async () => {
      const s = await init(await recips([4000, 3000, 2000, 1000])); await fund(s.vault, rentMin);
      const d = await depositAndCheck(s, 100_000n); assert.deepEqual(d.map(String), ["40000", "30000", "20000", "10000"]);
    });
    it("28 large amount: 100,000 SOL at prime-ish shares, exact conservation", async () => {
      const s = await init(await recips([1237, 2851, 5912]));
      await depositAndCheck(s, 100_000n * BigInt(LAMPORTS_PER_SOL) + 12_345n);
    });
    it("29 repeated distributes accumulate total_distributed", async () => {
      const s = await init(await recips([2500, 7500]));
      for (const a of [1n, 333n, 1_000_003n]) await depositAndCheck(s, a);
      const td = (await cfg(s.split)).totalDistributed.toString();
      assert.equal(td, "1000337", "accumulates");
    });
    it("30 second distribute without new deposit fails", async () => {
      const s = await init(await recips([10000])); await depositAndCheck(s, 5_000n);
      await expectFail(() => distribute(s), /NothingToDistribute/);
    });
    it("31 fresh (unfunded) recipient below rent min makes distribute fail atomically", async () => {
      const s = await init(unfunded([10000]));
      await fund(s.vault, rentMin);
      const vb = await bal(s.vault);
      await expectFail(async () => send([xfer(s.vault, 10_000), await distIx(s.split, [s.rs[0].pubkey])]), /rent|insufficient funds/i);
      assert.equal(await bal(s.vault), vb, "nothing moved");
    });
  });

  // ---------- account substitution
  describe("account substitution and ordering", () => {
    let s: any;
    before(async () => { s = await init(await recips([5000, 3000, 2000])); await fund(s.vault, rentMin + 1_000_000); });
    const ks = () => s.rs.map((r: R) => r.pubkey);
    it("32 wrong order rejected", async () => expectFail(() => distribute(s, [ks()[1], ks()[0], ks()[2]]), /RecipientMismatch/));
    it("33 too few accounts rejected", async () => expectFail(() => distribute(s, ks().slice(0, 2)), /RecipientMismatch/));
    it("34 extra account rejected", async () => expectFail(() => distribute(s, [...ks(), Keypair.generate().publicKey]), /RecipientMismatch/));
    it("35 attacker key substituted rejected", async () => expectFail(() => distribute(s, [ks()[0], ks()[1], Keypair.generate().publicKey]), /RecipientMismatch/));
    it("36 duplicate account meta (A,A,C) rejected", async () => expectFail(() => distribute(s, [ks()[0], ks()[0], ks()[2]]), /RecipientMismatch/));
    it("37 read-only recipient rejected", async () => {
      const ix = await program.methods.distribute().accountsPartial({ split: s.split })
        .remainingAccounts([...metas(ks().slice(0, 2)), ...metas(ks().slice(2), false)]).instruction();
      await expectFail(() => send([ix]), /RecipientMismatch/);
    });
    it("38 vault of another split rejected", async () => {
      const t = await init(unfunded([10000])); await fund(t.vault, rentMin + 5);
      await expectFail(async () => send([await distIx(s.split, ks(), t.vault)]), /ConstraintSeeds|seeds/i);
    });
    it("39 random keypair as vault rejected", async () =>
      expectFail(async () => send([await distIx(s.split, ks(), Keypair.generate().publicKey)]), /ConstraintSeeds|seeds/i));
    it("40 config of another split with this vault rejected", async () => {
      const t = await init(s.rs);
      await expectFail(async () => send([await distIx(t.split, ks(), s.vault)]), /ConstraintSeeds|seeds/i);
    });
    it("41 system-owned fake config rejected", async () => {
      const fake = Keypair.generate().publicKey; await fund(fake, rentMin);
      const [fv] = PublicKey.findProgramAddressSync([Buffer.from("vault"), fake.toBuffer()], program.programId);
      await expectFail(async () => send([await distIx(fake, ks(), fv)]), /AccountOwnedByWrongProgram|AccountNotInitialized|3007|3012/);
    });
    it("42 wrong system program rejected", async () =>
      expectFail(async () => send([await distIx(s.split, ks(), undefined, { systemProgram: Keypair.generate().publicKey })]), /InvalidProgramId|3008/));
    it("43 after all negatives the correct call still works and conserves", async () => { await depositAndCheck(s, 0n); });
  });

  // ---------- special recipients
  describe("special recipient keys", () => {
    it("44 recipient = owner works (isolated owner key)", async () => {
      const o = Keypair.generate(); await fund(o.publicKey, LAMPORTS_PER_SOL);
      const others = await recips([5000]); const id = nextId++; const p = pdas(id, o.publicKey);
      const rs = [{ pubkey: o.publicKey, shareBps: 5000 }, others[0]];
      await program.methods.initSplit(new BN(id), rs).accounts({ owner: o.publicKey }).signers([o]).rpc();
      await fund(p.vault, rentMin + 2_000_000);
      const ob = await bal(o.publicKey);
      await distribute({ split: p.split, rs });
      assert.equal((await bal(o.publicKey)) - ob, 1_000_000);
    });
    it("45 recipient = its own vault: lamports stay in vault but total_distributed is credited (finding)", async () => {
      const id = nextId++; const p = pdas(id); const other = await recips([5000]);
      await program.methods.initSplit(new BN(id), [{ pubkey: p.vault, shareBps: 5000 }, other[0]]).accounts({ owner }).rpc();
      await fund(p.vault, rentMin + 1_000_000);
      const ob = await bal(other[0].pubkey);
      await distribute({ split: p.split, rs: [{ pubkey: p.vault, shareBps: 5000 }, other[0]] });
      assert.equal((await bal(other[0].pubkey)) - ob, 500_000);
      assert.equal(await bal(p.vault), rentMin + 500_000, "self-payment stays in vault");
      assert.equal((await cfg(p.split)).totalDistributed.toString(), "1000000", "counter overstates by 500000");
    });
    it("46 recipient = its own split config: config account receives lamports", async () => {
      const id = nextId++; const p = pdas(id); const other = await recips([5000]);
      const rs = [{ pubkey: p.split, shareBps: 5000 }, other[0]];
      await program.methods.initSplit(new BN(id), rs).accounts({ owner }).rpc();
      await fund(p.vault, rentMin + 1_000_000);
      const cb = await bal(p.split);
      await distribute({ split: p.split, rs });
      assert.equal((await bal(p.split)) - cb, 500_000);
    });
    it("47 recipient = an executable program account fails (no lamports lost)", async () => {
      const s = await init([{ pubkey: program.programId, shareBps: 10000 }]);
      await fund(s.vault, rentMin + 1_000);
      await expectFail(() => distribute(s), /.+/);
      assert.equal(await bal(s.vault), rentMin + 1_000);
    });
  });

  // ---------- update_split
  describe("update_split", () => {
    it("48 owner update applies to the next distribute", async () => {
      const s = await init(await recips([5000, 5000]));
      const next = await recips([7000, 3000]);
      await program.methods.updateSplit(next).accounts({ split: s.split }).rpc();
      await depositAndCheck({ ...s, rs: next }, 10_000n);
    });
    it("49 non-owner update rejected", async () => {
      const s = await init(unfunded([10000])); const m = Keypair.generate(); await fund(m.publicKey, LAMPORTS_PER_SOL / 10);
      await expectFail(() => program.methods.updateSplit(unfunded([10000])).accountsPartial({ owner: m.publicKey, split: s.split }).signers([m]).rpc(),
        /Unauthorized|ConstraintSeeds|seeds/i);
    });
    it("50 owner key passed without signature rejected", async () => {
      const victimKp = Keypair.generate(); await fund(victimKp.publicKey, LAMPORTS_PER_SOL / 10);
      const id = nextId++; await program.methods.initSplit(new BN(id), unfunded([10000])).accounts({ owner: victimKp.publicKey }).signers([victimKp]).rpc();
      const ix = await program.methods.updateSplit(unfunded([10000])).accountsPartial({ owner: victimKp.publicKey, split: pdas(id, victimKp.publicKey).split }).instruction();
      ix.keys = ix.keys.map((k) => (k.pubkey.equals(victimKp.publicKey) ? { ...k, isSigner: false } : k));
      await expectFail(() => send([ix]), /AccountNotSigner|3010|signature/i);
    });
    it("51 update with invalid shares rejected", async () => {
      const s = await init(unfunded([10000]));
      await expectFail(() => program.methods.updateSplit(unfunded([5000, 4000])).accounts({ split: s.split }).rpc(), /InvalidShareSum/);
      await expectFail(() => program.methods.updateSplit(unfunded(Array(11).fill(909))).accounts({ split: s.split }).rpc(), /TooManyRecipients/);
    });
    it("52 update while funds are pending redirects them to the new set (owner trust, finding)", async () => {
      const s = await init(await recips([10000])); await fund(s.vault, rentMin + 50_000);
      const next = await recips([10000]);
      await program.methods.updateSplit(next).accounts({ split: s.split }).rpc();
      await expectFail(() => distribute(s), /RecipientMismatch/);
      const b = await bal(next[0].pubkey); await distribute({ ...s, rs: next });
      assert.equal((await bal(next[0].pubkey)) - b, 50_000);
    });
    it("53 update from 1 to 10 recipients fits the allocated space", async () => {
      const s = await init(unfunded([10000]));
      const next = await recips(Array(10).fill(1000));
      await program.methods.updateSplit(next).accounts({ split: s.split }).rpc();
      await depositAndCheck({ ...s, rs: next }, 1_000_009n);
    });
  });

  // ---------- close
  describe("close", () => {
    it("54 close returns vault funds and config rent to owner (isolated owner key)", async () => {
      const o = Keypair.generate(); await fund(o.publicKey, LAMPORTS_PER_SOL);
      const id = nextId++; const p = pdas(id, o.publicKey);
      await program.methods.initSplit(new BN(id), unfunded([10000])).accounts({ owner: o.publicKey }).signers([o]).rpc();
      await fund(p.vault, rentMin + 3_000_000);
      const cfgRent = await bal(p.split); const vb = await bal(p.vault); const ob = await bal(o.publicKey);
      await program.methods.close().accounts({ owner: o.publicKey, split: p.split } as any).signers([o]).rpc(); // fee paid by provider wallet
      assert.equal((await bal(o.publicKey)) - ob, cfgRent + vb);
      assert.equal(await bal(p.vault), 0); assert.isNull(await conn.getAccountInfo(p.split));
    });
    it("55 non-owner close rejected", async () => {
      const s = await init(unfunded([10000])); const m = Keypair.generate(); await fund(m.publicKey, LAMPORTS_PER_SOL / 10);
      await expectFail(() => program.methods.close().accountsPartial({ owner: m.publicKey, split: s.split, vault: s.vault }).signers([m]).rpc(),
        /Unauthorized|ConstraintSeeds|seeds/i);
    });
    it("56 distribute after close fails", async () => {
      const s = await init(await recips([10000])); await program.methods.close().accounts({ split: s.split }).rpc();
      await fund(s.vault, rentMin + 10);
      await expectFail(() => distribute(s), /AccountNotInitialized|3012/);
    });
    it("57 close then re-init the same id; stranded deposits become distributable", async () => {
      const s = await init(await recips([10000])); await program.methods.close().accounts({ split: s.split }).rpc();
      await fund(s.vault, rentMin + 4_242);
      await program.methods.initSplit(new BN(s.id), s.rs).accounts({ owner }).rpc();
      assert.equal((await cfg(s.split)).totalDistributed.toString(), "0");
      await depositAndCheck(s, 0n);
    });
    it("58 close on an empty vault succeeds", async () => {
      const s = await init(unfunded([10000])); await program.methods.close().accounts({ split: s.split }).rpc();
      assert.isNull(await conn.getAccountInfo(s.split));
    });
  });

  // ---------- atomicity / double calls
  describe("atomicity and double calls", () => {
    it("59 two distributes in one tx: whole tx fails, nothing moves", async () => {
      const s = await init(await recips([10000])); await fund(s.vault, rentMin + 9_000);
      const ix = await distIx(s.split, [s.rs[0].pubkey]); const b = await bal(s.rs[0].pubkey);
      await expectFail(() => send([ix, ix]), /NothingToDistribute/);
      assert.equal(await bal(s.rs[0].pubkey), b); assert.equal(await bal(s.vault), rentMin + 9_000);
    });
    it("60 deposit, distribute, deposit, distribute in one tx", async () => {
      const s = await init(await recips([6000, 4000])); await fund(s.vault, rentMin);
      const ix = await distIx(s.split, s.rs.map((r) => r.pubkey)); const b = await Promise.all(s.rs.map((r) => bal(r.pubkey)));
      await send([xfer(s.vault, 1000), ix, xfer(s.vault, 3), ix]);
      const a = await Promise.all(s.rs.map((r) => bal(r.pubkey)));
      assert.deepEqual(a.map((x, i) => x - b[i]), [600 + 1, 400 + 2]);
    });
    it("61 close then distribute in one tx fails atomically", async () => {
      const s = await init(await recips([10000])); await fund(s.vault, rentMin + 100);
      const c = await program.methods.close().accounts({ split: s.split }).instruction();
      await expectFail(async () => send([c, await distIx(s.split, [s.rs[0].pubkey])]), /.+/);
      assert.isNotNull(await conn.getAccountInfo(s.split));
    });
    it("62 recipient signing as fee payer and as recipient works (double role)", async () => {
      const r = Keypair.generate(); await fund(r.publicKey, LAMPORTS_PER_SOL / 10);
      const s = await init([{ pubkey: r.publicKey, shareBps: 10000 }]); await fund(s.vault, rentMin + 50_000);
      const tx = new Transaction().add(await distIx(s.split, [r.publicKey])); tx.feePayer = r.publicKey;
      const b = await bal(r.publicKey); const sig = await sendAndConfirmTransaction(conn, tx, [r], { commitment: "confirmed" });
      const fee = (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.fee;
      assert.equal((await bal(r.publicKey)) - b + fee, 50_000);
    });
  });

  // ---------- property / fuzz
  describe("property fuzz", () => {
    const ITER = Number(process.env.FUZZ_ITER || 500);
    it(`63 ${ITER} random splits: exact parts, conservation, no lamports lost`, async () => {
      const WORKERS = 10; let done = 0; let rng = 0x5eed1234;
      const rand = () => { rng ^= rng << 13; rng >>>= 0; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return rng / 2 ** 32; };
      const pools = await Promise.all(Array.from({ length: WORKERS }, () => fresh(10)));
      const worker = async (w: number) => {
        while (done < ITER) {
          done++;
          const n = 1 + Math.floor(rand() * 10);
          const cuts = Array.from({ length: n - 1 }, () => 1 + Math.floor(rand() * 9999)).sort((a, b) => a - b);
          let shares = [...cuts, 10000].map((c, i, arr) => c - (i ? arr[i - 1] : 0));
          if (shares.some((x) => x === 0)) shares = [...Array(n - 1).fill(1), 10000 - (n - 1)];
          const pick = [...pools[w]].sort(() => rand() - 0.5).slice(0, n);
          const rs = shares.map((s, i) => ({ pubkey: pick[i], shareBps: s }));
          const mode = rand();
          const amount = mode < 0.3 ? BigInt(1 + Math.floor(rand() * 100)) : mode < 0.8 ? BigInt(Math.floor(rand() * 1e9)) + 1n
            : BigInt(Math.floor(rand() * 1e6)) * BigInt(LAMPORTS_PER_SOL) / 1000n + BigInt(Math.floor(rand() * 9999)) + 1n;
          const s = await init(rs);
          await depositAndCheck(s, amount);
        }
      };
      await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));
      assert.isAtLeast(done, ITER);
    });
  });
});
