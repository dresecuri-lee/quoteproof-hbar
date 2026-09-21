import type { Abi, Address } from "viem";

export const HEDERA_TESTNET_CHAIN_ID = 296;
export const SUPRA_HBAR_USD_ADDRESS: Address = "0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917";
export const SUPRA_HBAR_USD_PAIR_ID = 432n;
export const MAX_ORACLE_AGE_SECONDS = 2n * 60n * 60n;
export const MAX_FUTURE_SKEW_SECONDS = 30n;
export const MAX_ORACLE_DECIMALS = 36n;

export const supraAbi = [
  {
    type: "function",
    name: "getSvalue",
    stateMutability: "view",
    inputs: [{ name: "pairIndex", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "round", type: "uint256" },
          { name: "decimals", type: "uint256" },
          { name: "time", type: "uint256" },
          { name: "price", type: "uint256" },
        ],
      },
    ],
  },
] as const satisfies Abi;

export const quoteProofAbi = [
  {
    type: "function",
    name: "oracle",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "recordRevision",
    stateMutability: "nonpayable",
    inputs: [
      { name: "quoteId", type: "bytes32" },
      { name: "revision", type: "uint64" },
      { name: "previousRevisionHash", type: "bytes32" },
      { name: "commitment", type: "bytes32" },
      { name: "usdCents", type: "uint256" },
      { name: "validUntil", type: "uint64" },
    ],
    outputs: [{ name: "recordHash", type: "bytes32" }],
  },
  {
    type: "event",
    name: "RevisionRecorded",
    inputs: [
      { name: "quoteId", type: "bytes32", indexed: true },
      { name: "revision", type: "uint64", indexed: true },
      { name: "issuer", type: "address", indexed: true },
      { name: "previousRevisionHash", type: "bytes32", indexed: false },
      { name: "commitment", type: "bytes32", indexed: false },
      { name: "usdCents", type: "uint256", indexed: false },
      { name: "validUntil", type: "uint64", indexed: false },
      { name: "recordHash", type: "bytes32", indexed: false },
    ],
  },
] as const satisfies Abi;
