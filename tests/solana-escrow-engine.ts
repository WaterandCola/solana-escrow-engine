import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaEscrowEngine } from "../target/types/solana_escrow_engine";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("solana-escrow-engine", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaEscrowEngine as Program<SolanaEscrowEngine>;

  let mintA: anchor.web3.PublicKey;
  let mintB: anchor.web3.PublicKey;
  let maker: anchor.web3.Keypair;
  let taker: anchor.web3.Keypair;
  let makerAtaA: anchor.web3.PublicKey;
  let makerAtaB: anchor.web3.PublicKey;
  let takerAtaA: anchor.web3.PublicKey;
  let takerAtaB: anchor.web3.PublicKey;

  const escrowId = new anchor.BN(1);
  const depositAmount = new anchor.BN(1_000_000); // 1 token (6 decimals)
  const requestAmount = new anchor.BN(500_000);   // 0.5 token

  before(async () => {
    // Create maker and taker keypairs
    maker = anchor.web3.Keypair.generate();
    taker = anchor.web3.Keypair.generate();

    // Airdrop SOL to maker and taker
    const makerAirdrop = await provider.connection.requestAirdrop(
      maker.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(makerAirdrop);

    const takerAirdrop = await provider.connection.requestAirdrop(
      taker.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(takerAirdrop);

    // Create mints
    mintA = await createMint(
      provider.connection,
      maker,
      maker.publicKey,
      null,
      6
    );

    mintB = await createMint(
      provider.connection,
      taker,
      taker.publicKey,
      null,
      6
    );

    // Create ATAs
    makerAtaA = await createAssociatedTokenAccount(
      provider.connection,
      maker,
      mintA,
      maker.publicKey
    );

    takerAtaB = await createAssociatedTokenAccount(
      provider.connection,
      taker,
      mintB,
      taker.publicKey
    );

    // Mint tokens
    await mintTo(
      provider.connection,
      maker,
      mintA,
      makerAtaA,
      maker,
      10_000_000 // 10 tokens
    );

    await mintTo(
      provider.connection,
      taker,
      mintB,
      takerAtaB,
      taker,
      10_000_000 // 10 tokens
    );
  });

  function getEscrowPda(makerKey: anchor.web3.PublicKey, id: anchor.BN) {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        makerKey.toBuffer(),
        id.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
  }

  function getVaultPda(escrowKey: anchor.web3.PublicKey) {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowKey.toBuffer()],
      program.programId
    );
  }

  it("Creates an escrow", async () => {
    const [escrowPda] = getEscrowPda(maker.publicKey, escrowId);
    const [vaultPda] = getVaultPda(escrowPda);

    const expiryTs = new anchor.BN(Math.floor(Date.now() / 1000) + 3600); // 1 hour

    await program.methods
      .createEscrow(escrowId, depositAmount, requestAmount, expiryTs)
      .accountsStrict({
        maker: maker.publicKey,
        mintA,
        mintB,
        escrow: escrowPda,
        vault: vaultPda,
        makerAtaA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    // Verify escrow state
    const escrow = await program.account.escrow.fetch(escrowPda);
    assert.ok(escrow.maker.equals(maker.publicKey));
    assert.ok(escrow.mintA.equals(mintA));
    assert.ok(escrow.mintB.equals(mintB));
    assert.equal(escrow.depositAmount.toNumber(), depositAmount.toNumber());
    assert.equal(escrow.requestAmount.toNumber(), requestAmount.toNumber());
    assert.deepEqual(escrow.status, { open: {} });

    // Verify vault has tokens
    const vaultAccount = await getAccount(provider.connection, vaultPda);
    assert.equal(Number(vaultAccount.amount), depositAmount.toNumber());

    // Verify maker's balance decreased
    const makerAccount = await getAccount(provider.connection, makerAtaA);
    assert.equal(Number(makerAccount.amount), 10_000_000 - depositAmount.toNumber());
  });

  it("Accepts an escrow (atomic swap)", async () => {
    const [escrowPda] = getEscrowPda(maker.publicKey, escrowId);
    const [vaultPda] = getVaultPda(escrowPda);

    // Create taker's ATA for mint_a and maker's ATA for mint_b before accepting
    takerAtaA = await createAssociatedTokenAccount(
      provider.connection,
      taker,
      mintA,
      taker.publicKey
    );

    makerAtaB = await createAssociatedTokenAccount(
      provider.connection,
      maker,
      mintB,
      maker.publicKey
    );

    await program.methods
      .acceptEscrow()
      .accountsStrict({
        taker: taker.publicKey,
        maker: maker.publicKey,
        mintA,
        mintB,
        escrow: escrowPda,
        vault: vaultPda,
        takerAtaA,
        takerAtaB,
        makerAtaB,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([taker])
      .rpc();

    // Verify escrow completed
    const escrow = await program.account.escrow.fetch(escrowPda);
    assert.deepEqual(escrow.status, { completed: {} });

    // Verify taker received token_a
    const takerAtaAAccount = await getAccount(provider.connection, takerAtaA);
    assert.equal(Number(takerAtaAAccount.amount), depositAmount.toNumber());

    // Verify maker received token_b
    const makerAtaBAccount = await getAccount(provider.connection, makerAtaB);
    assert.equal(Number(makerAtaBAccount.amount), requestAmount.toNumber());
  });

  it("Creates and cancels an escrow", async () => {
    const cancelId = new anchor.BN(2);
    const [escrowPda] = getEscrowPda(maker.publicKey, cancelId);
    const [vaultPda] = getVaultPda(escrowPda);

    const noExpiry = new anchor.BN(0);

    // Create
    await program.methods
      .createEscrow(cancelId, depositAmount, requestAmount, noExpiry)
      .accountsStrict({
        maker: maker.publicKey,
        mintA,
        mintB,
        escrow: escrowPda,
        vault: vaultPda,
        makerAtaA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    const makerBalBefore = await getAccount(provider.connection, makerAtaA);

    // Cancel
    await program.methods
      .cancelEscrow()
      .accountsStrict({
        maker: maker.publicKey,
        mintA,
        escrow: escrowPda,
        vault: vaultPda,
        makerAtaA,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    // Verify escrow cancelled
    const escrow = await program.account.escrow.fetch(escrowPda);
    assert.deepEqual(escrow.status, { cancelled: {} });

    // Verify maker got tokens back
    const makerBalAfter = await getAccount(provider.connection, makerAtaA);
    assert.equal(
      Number(makerBalAfter.amount),
      Number(makerBalBefore.amount) + depositAmount.toNumber()
    );
  });

  it("Rejects accepting a cancelled escrow", async () => {
    const cancelId = new anchor.BN(2);
    const [escrowPda] = getEscrowPda(maker.publicKey, cancelId);
    const [vaultPda] = getVaultPda(escrowPda);

    try {
      await program.methods
        .acceptEscrow()
        .accountsStrict({
          taker: taker.publicKey,
          maker: maker.publicKey,
          mintA,
          mintB,
          escrow: escrowPda,
          vault: vaultPda,
          takerAtaA,
          takerAtaB,
          makerAtaB,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([taker])
        .rpc();
      assert.fail("Should have thrown");
    } catch (err) {
      assert.include(err.toString(), "NotOpen");
    }
  });

  it("Rejects zero deposit amount", async () => {
    const badId = new anchor.BN(99);
    const [escrowPda] = getEscrowPda(maker.publicKey, badId);
    const [vaultPda] = getVaultPda(escrowPda);

    try {
      await program.methods
        .createEscrow(badId, new anchor.BN(0), requestAmount, new anchor.BN(0))
        .accountsStrict({
          maker: maker.publicKey,
          mintA,
          mintB,
          escrow: escrowPda,
          vault: vaultPda,
          makerAtaA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
      assert.fail("Should have thrown");
    } catch (err) {
      assert.include(err.toString(), "InvalidAmount");
    }
  });
});
