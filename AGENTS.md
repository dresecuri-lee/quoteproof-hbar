# Agent instructions

Briefing for coding agents in this app (Cursor, Claude Code, Codex). Claude Code loads it through `CLAUDE.md`.

This is a Scaffold-HBAR dApp: Next.js App Router, wallet connect, Debug Contracts, and Hedera networks (testnet, mainnet, local fork). The CLI may have left only Hardhat or only Foundry.

## QuoteProof invariants

- `QuoteProof.sol` is the single authoritative record. Do not add an HCS duplicate or accept a frontend-supplied oracle price.
- Keep Supra pair 432, Hedera Testnet chain 296, two-hour freshness, 30-second future skew, and decimals 0 through 36 aligned between Solidity and `packages/nextjs/utils/quoteProof.ts`.
- USD values are integer cents. HBAR values round up to tinybar before conversion to the EVM 18-decimal representation.
- Never put the canonical quote payload, salt, personal data, or credentials on-chain or in committed environment files.
- Do not report verification until a public receipt has been re-read and its `RevisionRecorded` event matches the local evidence.
- Local mock tests and unsigned Supra reads are distinct from a signed Hedera Testnet record.

Use the package manager this project was created with (`packageManager` in the root `package.json`, or the lockfile). Examples use `npm`; if the app was created with npm, swap `npm <script>` for `npm run <script>`.

## Which Solidity package

- `packages/hardhat` exists → Hardhat (`hardhat-deploy`)
- `packages/foundry` exists → Foundry (Forge scripts)
- `packages/nextjs` is always the frontend (App Router, RainbowKit, Wagmi, Viem, DaisyUI)

Follow only the flavor that is present.

## Commands

Package-prefixed scripts for package-specific work. Keep only truly cross-workspace commands unprefixed.

```bash
# Local chain + deploy + frontend (separate terminals)
npm run hardhat:chain    # Hedera-forked Hardhat node on 8545
npm run hardhat:deploy --network localhost
npm run foundry:chain    # Anvil from the Foundry package
npm run foundry:deploy
npm run next:start       # http://localhost:3000

# Frontend only
npm run next:dev

# Quality / build
npm run lint
npm run format
npm run next:build
npm run hardhat:compile
npm run foundry:compile

# Live networks
npm run hardhat:deploy --network hederaTestnet   # or hederaMainnet
npm run foundry:deploy --network hedera_testnet  # or hedera_mainnet
npm run hardhat:verify:testnet
npm run foundry:verify:testnet

# Deployer account
npm run hardhat:account:generate
npm run hardhat:account:import
npm run hardhat:account
```

`npm run hardhat:deploy` without `--network localhost` targets the in-process `hardhat` network, not the long-running fork.

## Layout

### Hardhat

- Contracts: `packages/hardhat/contracts/`
- Deploy scripts: `packages/hardhat/deploy/`
- Tests: `packages/hardhat/test/`
- Config: `packages/hardhat/hardhat.config.ts`
- Tagged deploy: if `deployHederaToken.tags = ["HederaToken"]`, run `npm run hardhat:deploy --tags HederaToken`

### Foundry

- Contracts: `packages/foundry/contracts/`
- Deploy scripts: `packages/foundry/script/` (`Deploy.s.sol`, `DeployHederaToken.s.sol`, `DeployHtsTokenCreator.s.sol`)
- Tests: `packages/foundry/test/`
- Config: `packages/foundry/foundry.toml`
- One contract: `npm run foundry:deploy --file DeployHederaToken.s.sol`

### After deploy

ABIs and addresses are written to `packages/nextjs/contracts/deployedContracts.ts`. Put third-party contracts in `packages/nextjs/contracts/externalContracts.ts`.

Sample contracts on this starter: `HederaToken` (ERC-20) and `HtsTokenCreator` (HTS precompile at `0x167`).

## Frontend contract interaction

Hooks live in `packages/nextjs/hooks/scaffold-hbar`. Use the names that exist in the codebase:

- `useScaffoldReadContract` — not `useScaffoldContractRead`
- `useScaffoldWriteContract` — not `useScaffoldContractWrite`

Also: `useScaffoldWatchContractEvent`, `useScaffoldEventHistory`, `useDeployedContractInfo`, `useScaffoldContract`, `useTransactor`.

```typescript
const { data: balance } = useScaffoldReadContract({
  contractName: "HederaToken",
  functionName: "balanceOf",
  args: [connectedAddress],
});

const { writeContractAsync, isPending } = useScaffoldWriteContract({
  contractName: "HederaToken",
});

await writeContractAsync({
  functionName: "mint",
  args: [connectedAddress, parseEther("1")],
});
```

`HederaToken.mint` is `onlyOwner`. For HTS creation, `HtsTokenCreator.createToken` is payable (HTS fee via `msg.value`) and emits `TokenCreated`.

### UI

Use `@scaffold-hbar-ui/components` for web3 UI: `Address`, `AddressInput`, `Balance`, `EtherInput`, `IntegerInput`.

Use DaisyUI classes, not raw Tailwind when a DaisyUI component exists:

```tsx
<button className="btn btn-primary">Connect</button>
```

### Networks

- Hardhat: `packages/hardhat/hardhat.config.ts` (`hederaTestnet` 296, `hederaMainnet` 295)
- Foundry: `packages/foundry/foundry.toml` (`hedera_testnet`, `hedera_mainnet`)
- Next.js: `packages/nextjs/scaffold.config.ts` (target networks, polling, RPC overrides, WalletConnect)

## Style

| Style | Use |
| --- | --- |
| `UpperCamelCase` | types, components |
| `lowerCamelCase` | variables, functions |
| `CONSTANT_CASE` | constants |
| `snake_case` | Hardhat deploy files and Foundry scripts |

Next.js imports use the `~~` alias:

```tsx
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
```

App Router pages live under `packages/nextjs/app/`. Add `"use client"` when the page uses hooks.

Prefer `type` over `interface`. No `T` prefix on types. Let TypeScript infer when it can. Comments should add information.
