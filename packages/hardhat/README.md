# QuoteProof Hardhat package

This package compiles, tests, and deploys the single `QuoteProof` contract. The production deployment script accepts only Hedera Testnet chain ID 296 and always passes the official Supra Push testnet address to the constructor. The constructor rejects another oracle on chain 296 while permitting mock injection on local test chains.

```sh
npm run hardhat:compile
npm run hardhat:check-types
npm run hardhat:test
```

Tests use `MockSupraSValueFeed` on the in-process Hardhat chain. They cover authorization, revision ordering and linkage, expiry, stale timestamps, the template's 30-second future-skew boundary, zero and bad-decimal prices, oracle reverts, and integer unit rounding. They do not count as a Hedera Testnet transaction.

For a real testnet deployment, follow the root README. Deployment credentials are loaded only at runtime by `scripts/runHardhatDeployWithPK.ts`; no fallback live-network private key is configured.
