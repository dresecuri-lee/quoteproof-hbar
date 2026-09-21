# QuoteProof

QuoteProof is a Scaffold-HBAR template for committing synthetic quote revisions on Hedera Testnet. The contract reads Supra's `HBAR_USD` pair 432 itself, records the raw oracle tuple and an integer-only HBAR estimate, and emits one authoritative revision event. A separate verification flow recomputes the local commitment and requires a matching public testnet receipt before it reports `externally_verified`.

This is an evidence demo, not payment, settlement, accounting, exchange, or legal acceptance software. Do not put customer names, email addresses, document text, or other personal data on-chain.

## Install

Use Node.js 20.18.3 or newer and npm 10. Create the public community template in a new directory with:

```sh
npm create scaffold-hbar@0.4.0 quoteproof-demo -- \
  --template dresecuri-lee/quoteproof-hbar \
  --frontend nextjs-app --solidity-framework hardhat \
  --package-manager npm --network testnet --skip-hedera-skills
```

For a direct source checkout, install the checked-in lockfile:

```sh
npm ci --legacy-peer-deps
npm run hardhat:compile
npm run hardhat:check-types
npm run next:test
npm run hardhat:test
npm run lint
npm run next:build
npm run next:dev
```

Open [http://localhost:3000](http://localhost:3000). The unsigned Supra preview and local evidence generation need no wallet. `packages/nextjs/.env.example` lists optional frontend settings.

## One quote flow

1. Connect a Hedera Testnet wallet and enter a synthetic quote ID, positive USD amount, revision, prior revision hash, and expiry.
2. Review the unsigned Supra preview. The UI shows pair, round, raw price, decimals, raw time, age, and an illustrative HBAR estimate.
3. Create and download the local evidence JSON. It contains the canonical payload and a random 32-byte salt. Only the SHA-256 commitment and the hashed quote ID are sent to the contract.
4. Anchor the revision. `QuoteProof` reads Supra directly during the transaction, validates the oracle value, performs the integer conversion, stores the revision, and emits `RevisionRecorded`.
5. The UI distinguishes `pending`, `confirmed`, `externally_verified`, and `failed`. A wallet receipt alone is only `confirmed`. The final status requires a fresh public RPC read on chain 296 and a matching contract event.
6. Anyone can use the Verify section with the local evidence file and transaction hash. The displayed contract must match the operator-configured `NEXT_PUBLIC_QUOTEPROOF_ADDRESS`; altered evidence, another network, a reverted or missing receipt, a different contract, a deployment without code, a contract using another oracle, or a mismatched event fails explicitly.

The canonical payload has a fixed `quoteproof-quote-v1` schema and field order. Revision 1 must use the zero previous hash. Later revisions must be sequential, use the same issuer, and reference the previous on-chain `recordHash`. Expired quotes cannot be anchored.

## Oracle and unit policy

- Oracle: Supra Push on Hedera Testnet at `0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917`.
- Feed: `HBAR_USD`, pair ID `432`. Price means USD per HBAR.
- Freshness: at most 2 hours old, with at most 30 seconds of future clock skew. The 30-second allowance is this synthetic quote template's conservative policy, not a Supra guarantee. The UI displays an accepted future offset as future skew rather than normal age zero.
- Timestamp adapter: values at or above `1e11` are interpreted as Unix milliseconds and divided by 1,000. Smaller values are Unix seconds. Other units fail the freshness or future checks.
- Decimals: only 0 through 36 are accepted. Zero price, zero time, stale or future time, bad decimals, and oracle reverts all fail the transaction.
- USD: an integer count of cents. Decimal JavaScript numbers are not used.
- HBAR: the conversion is rounded up to one tinybar, where 1 HBAR is `1e8` tinybar. The EVM amount is then `tinybar * 1e10`, because Hedera JSON-RPC represents EVM values with 18 decimals.
- Supra's interface used here has no confidence field. QuoteProof does not claim confidence-interval validation or a guaranteed executable market price.

## Deploy to Hedera Testnet

No private key is checked in. Generate or import a dedicated testnet account, fund only that testnet account from the [Hedera faucet](https://portal.hedera.com/faucet), then deploy:

```sh
npm run hardhat:account:generate
npm run hardhat:account
npm run hardhat:deploy -- --network hederaTestnet --tags QuoteProof
```

The deploy script is restricted to chain 296 and injects the fixed Supra testnet address. The contract constructor also rejects any other oracle when deployed on chain 296; local Hardhat tests may still inject a mock oracle. It writes a local deployment artifact under `packages/hardhat/deployments/`. Copy the printed QuoteProof EVM address to an untracked file:

```sh
cp packages/nextjs/.env.example packages/nextjs/.env.local
# Set NEXT_PUBLIC_QUOTEPROOF_ADDRESS to the deployed address.
npm run next:dev
```

`NEXT_PUBLIC_QUOTEPROOF_ADDRESS` is the verifier's operator-controlled trust boundary. Verification is not ready when it is missing or invalid, and a user-supplied address cannot replace it. Public verification requires chain 296, deployed bytecode at that configured address, and `oracle()` equal to the official Supra address before reading the receipt. The operator remains responsible for configuring the intended QuoteProof deployment: these checks do not establish code provenance or protect against an operator deliberately trusting a different contract that imitates the same ABI and oracle response.

After one anchor transaction, keep the transaction hash and evidence JSON, and verify the public record in the app or at `https://hashscan.io/testnet/transaction/<transaction-id>`. Never commit `.env`, encrypted key files, evidence JSON containing a salt and canonical payload, or deployment credentials.

## Contract and source layout

- `packages/hardhat/contracts/QuoteProof.sol`: single authoritative revision contract and direct Supra adapter.
- `packages/hardhat/test/QuoteProof.test.ts`: local mock-oracle contract regression tests. These are not testnet proof.
- `packages/nextjs/utils/quoteProof.ts`: canonicalization, integer conversion, unsigned preview, and public receipt verification.
- `packages/nextjs/tests/quoteProof.test.ts`: tamper, network, receipt, oracle, and unit regressions.
- `template.json`: create-scaffold-hbar community-template manifest.

The source is MIT licensed. `LICENCE` preserves the original Scaffold-HBAR notices for BuidlGuidl and hedera-dev. QuoteProof is derived from [hedera-dev/scaffold-hbar](https://github.com/hedera-dev/scaffold-hbar).
