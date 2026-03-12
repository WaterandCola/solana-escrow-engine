#!/usr/bin/env node
/**
 * Escrow Engine CLI — minimal client for interacting with the on-chain program.
 * 
 * Usage:
 *   node cli/escrow-cli.mjs create --amount 1000000 --request 500000 --mint-a <PUBKEY> --mint-b <PUBKEY>
 *   node cli/escrow-cli.mjs accept --maker <PUBKEY> --escrow-id <NUM>
 *   node cli/escrow-cli.mjs cancel --escrow-id <NUM>
 *   node cli/escrow-cli.mjs list --maker <PUBKEY>
 */

import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import fs from "fs";
import path from "path";

// Load IDL
const idlPath = path.resolve(new URL(".", import.meta.url).pathname, "../target/idl/solana_escrow_engine.json");
const IDL = JSON.parse(fs.readFileSync(idlPath, "utf8"));

const PROGRAM_ID = new PublicKey("3toetXrMDWD2KkkvzmtBdytqAeuJ9DKoCwDTPzPjjMh2");

function loadKeypair() {
  const home = process.env.HOME;
  const keyPath = process.env.KEYPAIR || `${home}/.config/solana/taizi-wallet.json`;
  const raw = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function getConnection() {
  const url = process.env.RPC_URL || clusterApiUrl("devnet");
  return new Connection(url, "confirmed");
}

function getProvider() {
  const conn = getConnection();
  const kp = loadKeypair();
  const wallet = new Wallet(kp);
  return new AnchorProvider(conn, wallet, { commitment: "confirmed" });
}

function getEscrowPda(maker, escrowId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), maker.toBuffer(), new BN(escrowId).toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );
}

function getVaultPda(escrowKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), escrowKey.toBuffer()],
    PROGRAM_ID
  );
}

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      parsed[key] = args[i + 1] || true;
      i++;
    }
  }
  return parsed;
}

async function createEscrow(opts) {
  const provider = getProvider();
  const program = new Program(IDL, provider);
  const maker = provider.wallet.publicKey;

  const escrowId = parseInt(opts["escrow-id"] || Date.now() % 100000);
  const amount = parseInt(opts.amount);
  const request = parseInt(opts.request);
  const mintA = new PublicKey(opts["mint-a"]);
  const mintB = new PublicKey(opts["mint-b"]);
  const expiry = opts.expiry ? parseInt(opts.expiry) : 0;

  const [escrowPda] = getEscrowPda(maker, escrowId);
  const [vaultPda] = getVaultPda(escrowPda);
  const makerAtaA = await getAssociatedTokenAddress(mintA, maker);

  const tx = await program.methods
    .createEscrow(new BN(escrowId), new BN(amount), new BN(request), new BN(expiry))
    .accountsStrict({
      maker,
      mintA,
      mintB,
      escrow: escrowPda,
      vault: vaultPda,
      makerAtaA,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: PublicKey.default,
    })
    .rpc();

  console.log(`✅ Escrow created!`);
  console.log(`   ID: ${escrowId}`);
  console.log(`   PDA: ${escrowPda.toBase58()}`);
  console.log(`   TX: ${tx}`);
  console.log(`   Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
}

async function acceptEscrow(opts) {
  const provider = getProvider();
  const program = new Program(IDL, provider);
  const taker = provider.wallet.publicKey;

  const makerKey = new PublicKey(opts.maker);
  const escrowId = parseInt(opts["escrow-id"]);

  const [escrowPda] = getEscrowPda(makerKey, escrowId);
  const [vaultPda] = getVaultPda(escrowPda);

  const escrow = await program.account.escrow.fetch(escrowPda);
  const mintA = escrow.mintA;
  const mintB = escrow.mintB;

  const takerAtaA = await getAssociatedTokenAddress(mintA, taker);
  const takerAtaB = await getAssociatedTokenAddress(mintB, taker);
  const makerAtaB = await getAssociatedTokenAddress(mintB, makerKey);

  const tx = await program.methods
    .acceptEscrow()
    .accountsStrict({
      taker,
      maker: makerKey,
      mintA,
      mintB,
      escrow: escrowPda,
      vault: vaultPda,
      takerAtaA,
      takerAtaB,
      makerAtaB,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: PublicKey.default,
    })
    .rpc();

  console.log(`✅ Escrow accepted!`);
  console.log(`   TX: ${tx}`);
  console.log(`   Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
}

async function cancelEscrow(opts) {
  const provider = getProvider();
  const program = new Program(IDL, provider);
  const maker = provider.wallet.publicKey;

  const escrowId = parseInt(opts["escrow-id"]);
  const [escrowPda] = getEscrowPda(maker, escrowId);
  const [vaultPda] = getVaultPda(escrowPda);

  const escrow = await program.account.escrow.fetch(escrowPda);
  const mintA = escrow.mintA;
  const makerAtaA = await getAssociatedTokenAddress(mintA, maker);

  const tx = await program.methods
    .cancelEscrow()
    .accountsStrict({
      maker,
      mintA,
      escrow: escrowPda,
      vault: vaultPda,
      makerAtaA,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: PublicKey.default,
    })
    .rpc();

  console.log(`✅ Escrow cancelled!`);
  console.log(`   TX: ${tx}`);
  console.log(`   Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`);
}

async function listEscrows(opts) {
  const provider = getProvider();
  const program = new Program(IDL, provider);

  const accounts = await program.account.escrow.all();
  
  if (accounts.length === 0) {
    console.log("No escrows found.");
    return;
  }

  console.log(`Found ${accounts.length} escrow(s):\n`);
  for (const { publicKey, account } of accounts) {
    const status = account.status.open ? "🟢 Open" : account.status.completed ? "✅ Done" : "❌ Cancelled";
    console.log(`  ${status} | PDA: ${publicKey.toBase58()}`);
    console.log(`    Maker: ${account.maker.toBase58()}`);
    console.log(`    Deposit: ${account.depositAmount.toString()} token_a → Request: ${account.requestAmount.toString()} token_b`);
    console.log(`    Created: ${new Date(account.createdAt.toNumber() * 1000).toISOString()}`);
    if (account.expiryTs.toNumber() > 0) {
      console.log(`    Expires: ${new Date(account.expiryTs.toNumber() * 1000).toISOString()}`);
    }
    console.log();
  }
}

// Main
const [cmd, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);

switch (cmd) {
  case "create": await createEscrow(opts); break;
  case "accept": await acceptEscrow(opts); break;
  case "cancel": await cancelEscrow(opts); break;
  case "list":   await listEscrows(opts); break;
  default:
    console.log(`Solana Escrow Engine CLI\n`);
    console.log(`Commands:`);
    console.log(`  create  --amount <N> --request <N> --mint-a <PK> --mint-b <PK> [--escrow-id <N>] [--expiry <TS>]`);
    console.log(`  accept  --maker <PK> --escrow-id <N>`);
    console.log(`  cancel  --escrow-id <N>`);
    console.log(`  list`);
}
