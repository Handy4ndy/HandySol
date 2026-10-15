//! SplitPay: a Solana port of the Xahau DynamicSplitPayment hook.
//!
//! On Xahau the hook is installed on an account and splits every incoming
//! payment across a list of recipients stored in hook state. On Solana the
//! split list lives in a PDA (SplitConfig) and funds accumulate in a second,
//! data-less PDA (the vault). Anyone can call `distribute` to push the vault
//! balance above the rent-exempt minimum out to the recipients by share.
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

declare_id!("5M5cpnesJ6PUzAu3kYeGk6GaiEsL2WgHroLE2FHNTP1R");

// security.txt shown by Solana Explorer (Security tab). Any change alters the binary hash,
// so finalise these values before the verified build.
#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "SOLSplit",
    project_url: "https://xspence.co.uk/solsplit/",
    contacts: "email:info@xspence.co.uk",
    policy: "https://github.com/Handy4ndy/HandySol/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/Handy4ndy/HandySol",
    source_release: "solsplit-v0.1.0",
    auditors: "None"
}

pub const MAX_RECIPIENTS: usize = 10;
pub const TOTAL_BPS: u32 = 10_000;
pub const SPLIT_SEED: &[u8] = b"split";
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod splitpay {
    use super::*;

    /// Owner creates a split config (and its vault address) with up to 10 recipients.
    pub fn init_split(ctx: Context<InitSplit>, split_id: u64, recipients: Vec<Recipient>) -> Result<()> {
        validate_recipients(&recipients)?;
        let cfg = &mut ctx.accounts.split;
        cfg.owner = ctx.accounts.owner.key();
        cfg.split_id = split_id;
        cfg.bump = ctx.bumps.split;
        cfg.vault_bump = ctx.bumps.vault;
        cfg.total_distributed = 0;
        cfg.recipients = recipients;
        emit!(SplitCreated { split: cfg.key(), owner: cfg.owner, count: cfg.recipients.len() as u8 });
        Ok(())
    }

    /// Owner replaces the recipient list.
    pub fn update_split(ctx: Context<UpdateSplit>, recipients: Vec<Recipient>) -> Result<()> {
        validate_recipients(&recipients)?;
        ctx.accounts.split.recipients = recipients;
        Ok(())
    }

    /// Permissionless: sends vault lamports above the rent-exempt minimum to the
    /// recipients (passed as writable remaining accounts, same order as config).
    pub fn distribute<'info>(ctx: Context<'info, Distribute<'info>>) -> Result<()> {
        let cfg = &ctx.accounts.split;
        let vault = &ctx.accounts.vault;
        let n = cfg.recipients.len();
        require!(ctx.remaining_accounts.len() == n, SplitError::RecipientMismatch);

        let min = Rent::get()?.minimum_balance(0);
        let amount = vault.lamports().checked_sub(min).ok_or(SplitError::NothingToDistribute)?;
        require!(amount > 0, SplitError::NothingToDistribute);

        let split_key = cfg.key();
        let seeds: &[&[u8]] = &[VAULT_SEED, split_key.as_ref(), &[cfg.vault_bump]];
        let signer = &[seeds];

        let mut sent: u64 = 0;
        for (i, r) in cfg.recipients.iter().enumerate() {
            let acc = &ctx.remaining_accounts[i];
            require_keys_eq!(acc.key(), r.pubkey, SplitError::RecipientMismatch);
            require!(acc.is_writable, SplitError::RecipientMismatch);
            let part: u64 = if i + 1 == n {
                // Last recipient takes the rounding remainder.
                amount.checked_sub(sent).ok_or(SplitError::MathOverflow)?
            } else {
                let p = (amount as u128)
                    .checked_mul(r.share_bps as u128)
                    .ok_or(SplitError::MathOverflow)?
                    .checked_div(TOTAL_BPS as u128)
                    .ok_or(SplitError::MathOverflow)?;
                u64::try_from(p).map_err(|_| SplitError::MathOverflow)?
            };
            sent = sent.checked_add(part).ok_or(SplitError::MathOverflow)?;
            if part > 0 {
                system_program::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.system_program.key(),
                        Transfer { from: vault.to_account_info(), to: acc.clone() },
                        signer,
                    ),
                    part,
                )?;
            }
        }
        let cfg = &mut ctx.accounts.split;
        cfg.total_distributed = cfg.total_distributed.checked_add(sent).ok_or(SplitError::MathOverflow)?;
        emit!(Distributed { split: split_key, amount: sent });
        Ok(())
    }

    /// Owner closes the split: vault is drained to the owner and the config is closed.
    pub fn close(ctx: Context<CloseSplit>) -> Result<()> {
        let bal = ctx.accounts.vault.lamports();
        if bal > 0 {
            let split_key = ctx.accounts.split.key();
            let seeds: &[&[u8]] = &[VAULT_SEED, split_key.as_ref(), &[ctx.accounts.split.vault_bump]];
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    Transfer { from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.owner.to_account_info() },
                    &[seeds],
                ),
                bal,
            )?;
        }
        Ok(())
    }
}

fn validate_recipients(rs: &[Recipient]) -> Result<()> {
    require!(!rs.is_empty(), SplitError::NoRecipients);
    require!(rs.len() <= MAX_RECIPIENTS, SplitError::TooManyRecipients);
    let mut sum: u32 = 0;
    for (i, r) in rs.iter().enumerate() {
        require!(r.share_bps > 0, SplitError::ZeroShare);
        require!(rs[..i].iter().all(|o| o.pubkey != r.pubkey), SplitError::DuplicateRecipient);
        sum = sum.checked_add(r.share_bps as u32).ok_or(SplitError::MathOverflow)?;
    }
    require!(sum == TOTAL_BPS, SplitError::InvalidShareSum);
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, PartialEq)]
pub struct Recipient {
    pub pubkey: Pubkey,
    pub share_bps: u16,
}

#[account]
#[derive(InitSpace)]
pub struct SplitConfig {
    pub owner: Pubkey,
    pub split_id: u64,
    pub bump: u8,
    pub vault_bump: u8,
    pub total_distributed: u64,
    #[max_len(10)]
    pub recipients: Vec<Recipient>,
}

#[derive(Accounts)]
#[instruction(split_id: u64)]
pub struct InitSplit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + SplitConfig::INIT_SPACE,
        seeds = [SPLIT_SEED, owner.key().as_ref(), &split_id.to_le_bytes()], bump)]
    pub split: Account<'info, SplitConfig>,
    /// CHECK: data-less system-owned PDA that holds the SOL to split.
    #[account(seeds = [VAULT_SEED, split.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateSplit<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ SplitError::Unauthorized,
        seeds = [SPLIT_SEED, owner.key().as_ref(), &split.split_id.to_le_bytes()], bump = split.bump)]
    pub split: Account<'info, SplitConfig>,
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(mut, seeds = [SPLIT_SEED, split.owner.as_ref(), &split.split_id.to_le_bytes()], bump = split.bump)]
    pub split: Account<'info, SplitConfig>,
    /// CHECK: vault PDA, verified by seeds.
    #[account(mut, seeds = [VAULT_SEED, split.key().as_ref()], bump = split.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseSplit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, close = owner, has_one = owner @ SplitError::Unauthorized,
        seeds = [SPLIT_SEED, owner.key().as_ref(), &split.split_id.to_le_bytes()], bump = split.bump)]
    pub split: Account<'info, SplitConfig>,
    /// CHECK: vault PDA, verified by seeds.
    #[account(mut, seeds = [VAULT_SEED, split.key().as_ref()], bump = split.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct SplitCreated { pub split: Pubkey, pub owner: Pubkey, pub count: u8 }
#[event]
pub struct Distributed { pub split: Pubkey, pub amount: u64 }

#[error_code]
pub enum SplitError {
    #[msg("Shares must sum to 10000 basis points")]
    InvalidShareSum,
    #[msg("Duplicate recipient")]
    DuplicateRecipient,
    #[msg("Share must be greater than zero")]
    ZeroShare,
    #[msg("Too many recipients (max 10)")]
    TooManyRecipients,
    #[msg("At least one recipient required")]
    NoRecipients,
    #[msg("Only the owner can do this")]
    Unauthorized,
    #[msg("Recipient accounts do not match the split config")]
    RecipientMismatch,
    #[msg("Vault has nothing above the rent-exempt minimum")]
    NothingToDistribute,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
