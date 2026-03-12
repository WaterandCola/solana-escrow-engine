# Solana Escrow Engine

A traditional Web2 escrow payment system rebuilt as a Solana on-chain program using Anchor.

## Web2 → Solana: Architecture Comparison

### How This Works in Web2

In a traditional escrow system:
1. A **centralized server** (e.g., Escrow.com, PayPal) holds funds in a database
2. **Buyer** deposits money into the escrow service's bank account
3. **Seller** delivers goods/services
4. **Escrow service** verifies delivery and releases funds
5. Trust relies on the **company's reputation** and legal framework

```
Buyer → [Bank API] → Escrow DB (balance++) → [Verify] → Seller Bank Account
```

Key characteristics:
- Single point of failure (the escrow company)
- Opaque state — users trust the company's database
- Reversible transactions (chargebacks)
- Business hours, geographic restrictions
- Fees: typically 1-5%

### How This Works on Solana

On-chain escrow eliminates the trusted third party:
1. **Maker** creates an escrow by depositing SPL tokens into a PDA-controlled vault
2. The **program** (immutable code) IS the escrow — no company, no human operator
3. **Taker** accepts by depositing their side; the swap is atomic
4. Either party can cancel (maker only while open)
5. Optional expiry timestamps for time-limited offers

```
Maker → [create_escrow IX] → Vault PDA (tokens locked)
Taker → [accept_escrow IX] → Atomic swap: vault→taker, taker→maker
```

Key characteristics:
- No trusted third party — code is law
- Fully transparent state — anyone can read the escrow account
- Irreversible, atomic transactions
- 24/7, global, permissionless
- Fees: only Solana tx fees (~$0.001)

### Tradeoffs & Constraints

| Aspect | Web2 Escrow | Solana Escrow |
|--------|-------------|---------------|
| Trust model | Company reputation | Verifiable code |
| Dispute resolution | Human arbitration | None (code-only) |
| Asset types | Fiat, any currency | SPL tokens only |
| Reversibility | Chargebacks possible | Irreversible |
| Privacy | Company sees all | Public blockchain |
| Uptime | Business hours / SLA | 24/7 (network permitting) |
| Cost | 1-5% fees | ~$0.001 per tx |
| Account model | SQL rows | PDAs + Token Accounts |
| State management | CRUD operations | Account init/close lifecycle |

## Program Architecture

### Account Model

```
Escrow (PDA)
├── maker: Pubkey          — who created the escrow
├── mint_a: Pubkey         — token the maker deposits
├── mint_b: Pubkey         — token the maker wants
├── deposit_amount: u64    — how much token_a is locked
├── request_amount: u64    — how much token_b is requested
├── escrow_id: u64         — unique ID per maker
├── created_at: i64        — creation timestamp
├── expiry_ts: i64         — optional expiry (0 = no expiry)
├── status: enum           — Open | Completed | Cancelled
├── bump: u8               — PDA bump
└── vault_bump: u8         — vault PDA bump

Vault (PDA Token Account)
└── Holds maker's deposited token_a, authority = vault PDA itself
```

### Instructions

1. **create_escrow** — Maker deposits token_a, specifies desired token_b amount
2. **accept_escrow** — Taker deposits token_b, receives token_a (atomic swap)
3. **cancel_escrow** — Maker reclaims token_a (only while Open)

### PDA Seeds

- Escrow: `["escrow", maker_pubkey, escrow_id_bytes]`
- Vault: `["vault", escrow_pubkey]`

## Build & Test

### Prerequisites

- Rust 1.70+
- Solana CLI v1.18+
- Anchor CLI v0.32.1
- Node.js 18+

### Build

```bash
anchor build
```

### Test

```bash
anchor test
```

### Deploy to Devnet

```bash
solana config set --url devnet
anchor deploy --provider.cluster devnet
```

## Devnet Deployment

- Program ID: `3toetXrMDWD2KkkvzmtBdytqAeuJ9DKoCwDTPzPjjMh2`
- Devnet transaction links: _(to be added after deployment)_

## CLI Client

A minimal CLI client is provided in `cli/` for interacting with the deployed program:

```bash
# Create an escrow
node cli/escrow-cli.mjs create --amount 100 --request 50 --mint-a <MINT_A> --mint-b <MINT_B>

# Accept an escrow
node cli/escrow-cli.mjs accept --escrow <ESCROW_PDA>

# Cancel an escrow
node cli/escrow-cli.mjs cancel --escrow <ESCROW_PDA>

# List open escrows
node cli/escrow-cli.mjs list
```

## License

MIT
