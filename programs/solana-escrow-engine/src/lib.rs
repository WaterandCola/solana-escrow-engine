use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint, CloseAccount};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("3toetXrMDWD2KkkvzmtBdytqAeuJ9DKoCwDTPzPjjMh2");

/// Solana Escrow Engine
/// 
/// A traditional Web2 escrow payment system rebuilt as a Solana on-chain program.
/// 
/// Web2 equivalent: A centralized escrow service (like Escrow.com) where:
/// - A buyer deposits funds into a trusted third-party account
/// - The seller delivers goods/services
/// - The escrow service releases funds upon confirmation
/// 
/// On-chain difference:
/// - No trusted third party — the program IS the escrow
/// - State is stored in PDAs (Program Derived Addresses)
/// - Token transfers are atomic and verifiable
/// - Anyone can audit the escrow state on-chain

#[program]
pub mod solana_escrow_engine {
    use super::*;

    /// Create a new escrow offer.
    /// The maker deposits `deposit_amount` of token_mint_a into the escrow vault,
    /// and specifies how much of token_mint_b they want in return.
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        escrow_id: u64,
        deposit_amount: u64,
        request_amount: u64,
        expiry_ts: i64,
    ) -> Result<()> {
        require!(deposit_amount > 0, EscrowError::InvalidAmount);
        require!(request_amount > 0, EscrowError::InvalidAmount);

        let clock = Clock::get()?;
        if expiry_ts > 0 {
            require!(expiry_ts > clock.unix_timestamp, EscrowError::InvalidExpiry);
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.maker = ctx.accounts.maker.key();
        escrow.mint_a = ctx.accounts.mint_a.key();
        escrow.mint_b = ctx.accounts.mint_b.key();
        escrow.deposit_amount = deposit_amount;
        escrow.request_amount = request_amount;
        escrow.escrow_id = escrow_id;
        escrow.created_at = clock.unix_timestamp;
        escrow.expiry_ts = expiry_ts;
        escrow.status = EscrowStatus::Open;
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;

        // Transfer maker's tokens into the vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.maker_ata_a.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.maker.to_account_info(),
                },
            ),
            deposit_amount,
        )?;

        msg!("Escrow {} created: {} token_a for {} token_b", escrow_id, deposit_amount, request_amount);
        Ok(())
    }

    /// Taker accepts the escrow by depositing the requested token_b amount.
    /// The vault releases token_a to the taker, and token_b goes to the maker.
    pub fn accept_escrow(ctx: Context<AcceptEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Open, EscrowError::NotOpen);

        // Check expiry
        if escrow.expiry_ts > 0 {
            let clock = Clock::get()?;
            require!(clock.unix_timestamp < escrow.expiry_ts, EscrowError::Expired);
        }

        // Transfer token_b from taker to maker
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.taker_ata_b.to_account_info(),
                    to: ctx.accounts.maker_ata_b.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            escrow.request_amount,
        )?;

        // Transfer token_a from vault to taker (PDA signs)
        let seeds = &[
            b"vault",
            ctx.accounts.escrow.to_account_info().key.as_ref(),
            &[escrow.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.taker_ata_a.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            escrow.deposit_amount,
        )?;

        // Close vault account, return rent to maker
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.maker.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ))?;

        // Update status
        let escrow_mut = &mut ctx.accounts.escrow;
        escrow_mut.status = EscrowStatus::Completed;

        msg!("Escrow {} completed", escrow_mut.escrow_id);
        Ok(())
    }

    /// Maker cancels the escrow and reclaims deposited tokens.
    /// Only possible while escrow is still Open.
    pub fn cancel_escrow(ctx: Context<CancelEscrow>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Open, EscrowError::NotOpen);

        let seeds = &[
            b"vault",
            ctx.accounts.escrow.to_account_info().key.as_ref(),
            &[escrow.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Return tokens from vault to maker
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.maker_ata_a.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            escrow.deposit_amount,
        )?;

        // Close vault
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.maker.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ))?;

        let escrow_mut = &mut ctx.accounts.escrow;
        escrow_mut.status = EscrowStatus::Cancelled;

        msg!("Escrow {} cancelled by maker", escrow_mut.escrow_id);
        Ok(())
    }
}

// ── Accounts ──

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    pub mint_a: Account<'info, Mint>,
    pub mint_b: Account<'info, Mint>,

    #[account(
        init,
        payer = maker,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", maker.key().as_ref(), escrow_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        init,
        payer = maker,
        token::mint = mint_a,
        token::authority = vault,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = maker,
    )]
    pub maker_ata_a: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptEscrow<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    /// CHECK: maker receives token_b and vault rent
    #[account(mut, address = escrow.maker)]
    pub maker: AccountInfo<'info>,

    pub mint_a: Account<'info, Mint>,
    pub mint_b: Account<'info, Mint>,

    #[account(
        mut,
        has_one = maker,
        has_one = mint_a,
        has_one = mint_b,
        seeds = [b"escrow", maker.key().as_ref(), escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = taker,
    )]
    pub taker_ata_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = taker,
    )]
    pub taker_ata_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = maker,
    )]
    pub maker_ata_b: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelEscrow<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    pub mint_a: Account<'info, Mint>,

    #[account(
        mut,
        has_one = maker,
        has_one = mint_a,
        seeds = [b"escrow", maker.key().as_ref(), escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = maker,
    )]
    pub maker_ata_a: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ── State ──

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub maker: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub deposit_amount: u64,
    pub request_amount: u64,
    pub escrow_id: u64,
    pub created_at: i64,
    pub expiry_ts: i64,
    pub status: EscrowStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    Open,
    Completed,
    Cancelled,
}

// ── Errors ──

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Escrow is not open")]
    NotOpen,
    #[msg("Escrow has expired")]
    Expired,
    #[msg("Invalid expiry timestamp")]
    InvalidExpiry,
}
