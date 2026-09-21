import { SUPRA_HBAR_USD_ADDRESS, quoteProofAbi } from "../contracts/quoteProof";
import {
  ZERO_HASH,
  canonicalizeQuote,
  convertUsdCentsToTinybar,
  createEvidence,
  normalizeOracleTime,
  usdStringToCents,
  validateEvidence,
  validateOracleSnapshot,
  verifyPublicReceipt,
  verifyReceiptEvidence,
} from "../utils/quoteProof";
import assert from "node:assert/strict";
import test from "node:test";
import {
  type Address,
  type Hex,
  type PublicClient,
  TransactionReceiptNotFoundError,
  encodeAbiParameters,
  encodeEventTopics,
} from "viem";

const issuer = "0x00000000000000000000000000000000000000a1" as Address;
const otherIssuer = "0x00000000000000000000000000000000000000a2" as Address;
const contract = "0x00000000000000000000000000000000000000b2" as Address;
const otherContract = "0x00000000000000000000000000000000000000b3" as Address;
const salt = `0x${"11".repeat(32)}` as Hex;
const recordHash = `0x${"22".repeat(32)}` as Hex;
const transactionHash = `0x${"33".repeat(32)}` as Hex;
const payload = {
  quoteId: "SYNTHETIC-Q-001",
  revision: 1,
  previousRevisionHash: ZERO_HASH,
  issuer,
  usdCents: "125000",
  validUntil: 1_900_000_000,
};

process.env.NEXT_PUBLIC_QUOTEPROOF_ADDRESS = contract;

function makeReceipt(overrides: Record<string, unknown> = {}) {
  const evidence = createEvidence(payload, salt);
  const values = {
    quoteId: evidence.quoteIdHash,
    revision: 1n,
    issuer,
    previousRevisionHash: ZERO_HASH,
    commitment: evidence.commitment,
    usdCents: 125_000n,
    validUntil: 1_900_000_000n,
    recordHash,
    ...overrides,
  };
  const topics = encodeEventTopics({
    abi: quoteProofAbi,
    eventName: "RevisionRecorded",
    args: { quoteId: values.quoteId as Hex, revision: values.revision as bigint, issuer: values.issuer as Address },
  });
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" }, { type: "bytes32" }],
    [
      values.previousRevisionHash as Hex,
      values.commitment as Hex,
      values.usdCents as bigint,
      values.validUntil as bigint,
      values.recordHash as Hex,
    ],
  );
  return { status: "success" as const, logs: [{ address: contract, topics, data } as never] };
}

function makeClient(overrides: Record<string, unknown> = {}): PublicClient {
  return {
    getChainId: async () => 296,
    getBytecode: async () => "0x6000",
    readContract: async () => SUPRA_HBAR_USD_ADDRESS,
    getTransactionReceipt: async () => makeReceipt(),
    ...overrides,
  } as unknown as PublicClient;
}

test("canonicalization is deterministic and tampering is rejected", () => {
  const first = createEvidence(payload, salt);
  const second = createEvidence({ ...payload, usdCents: "00125000" }, salt);
  assert.deepEqual(first, second);
  assert.deepEqual(validateEvidence(first), first);
  assert.throws(
    () => validateEvidence({ ...first, canonicalPayload: first.canonicalPayload.replace("125000", "125001") }),
    /altered|match/,
  );
});

test("canonical payload rejects invalid addresses and revisions", () => {
  assert.throws(() => canonicalizeQuote({ ...payload, issuer: "0x123" as Address }), /valid EVM/);
  assert.throws(() => canonicalizeQuote({ ...payload, revision: 0 }), /positive integer/);
});

test("USD and HBAR unit conversions use integer cents and tinybar ceiling", () => {
  assert.equal(usdStringToCents("1250.05"), 125005n);
  assert.throws(() => usdStringToCents("1.005"), /two decimal/);
  const snapshot = validateOracleSnapshot({ round: 1n, decimals: 0n, time: 1_800_000_000n, price: 3n }, 1_800_000_001n);
  assert.equal(convertUsdCentsToTinybar(100n, snapshot), 33_333_334n);
});

test("oracle policy accepts 30 seconds of future skew and rejects 31 seconds", () => {
  assert.equal(normalizeOracleTime(1_800_000_000_999n), 1_800_000_000n);
  assert.equal(normalizeOracleTime(1_800_000_000n), 1_800_000_000n);
  assert.throws(() => validateOracleSnapshot({ round: 1n, decimals: 18n, time: 1n, price: 1n }, 7202n), /older/);
  const future = validateOracleSnapshot({ round: 1n, decimals: 18n, time: 1_800_000_030n, price: 1n }, 1_800_000_000n);
  assert.equal(future.ageSeconds, 0n);
  assert.equal(future.futureSkewSeconds, 30n);
  assert.throws(
    () => validateOracleSnapshot({ round: 1n, decimals: 18n, time: 1_800_000_031n, price: 1n }, 1_800_000_000n),
    /future/,
  );
  assert.throws(
    () => validateOracleSnapshot({ round: 1n, decimals: 18n, time: 1_800_000_000n, price: 0n }, 1_800_000_000n),
    /zero/,
  );
  assert.throws(
    () => validateOracleSnapshot({ round: 1n, decimals: 37n, time: 1_800_000_000n, price: 1n }, 1_800_000_000n),
    /decimals/,
  );
});

test("receipt verification requires valid evidence and the trusted configured deployment", () => {
  const evidence = createEvidence(payload, salt);
  const receipt = makeReceipt();
  const malformed = verifyReceiptEvidence({ ...evidence, canonicalPayload: "{" }, contract, 296, receipt);
  const untrusted = verifyReceiptEvidence(evidence, otherContract, 296, receipt);
  if (malformed.status !== "failed" || untrusted.status !== "failed") assert.fail("failure expected");
  assert.match(malformed.reason, /invalid/);
  assert.match(untrusted.reason, /configured/);

  const configured = process.env.NEXT_PUBLIC_QUOTEPROOF_ADDRESS;
  delete process.env.NEXT_PUBLIC_QUOTEPROOF_ADDRESS;
  const missingConfig = verifyReceiptEvidence(evidence, contract, 296, receipt);
  process.env.NEXT_PUBLIC_QUOTEPROOF_ADDRESS = "invalid";
  const invalidConfig = verifyReceiptEvidence(evidence, contract, 296, receipt);
  process.env.NEXT_PUBLIC_QUOTEPROOF_ADDRESS = configured;
  if (missingConfig.status !== "failed" || invalidConfig.status !== "failed") assert.fail("failure expected");
  assert.match(missingConfig.reason, /not configured/);
  assert.match(invalidConfig.reason, /invalid/);
});

test("receipt verification rejects wrong networks and missing receipts", () => {
  const evidence = createEvidence(payload, salt);
  const wrongNetwork = verifyReceiptEvidence(evidence, contract, 295, null);
  const missingReceipt = verifyReceiptEvidence(evidence, contract, 296, null);
  if (wrongNetwork.status !== "failed" || missingReceipt.status !== "failed") assert.fail("failure expected");
  assert.match(wrongNetwork.reason, /Wrong network/);
  assert.match(missingReceipt.reason, /not found/);
});

test("receipt verification compares every canonical contract input", () => {
  const evidence = createEvidence(payload, salt);
  assert.deepEqual(verifyReceiptEvidence(evidence, contract, 296, makeReceipt()), {
    status: "externally_verified",
    recordHash,
  });

  const mismatches = [
    { quoteId: `0x${"44".repeat(32)}` },
    { revision: 2n },
    { issuer: otherIssuer },
    { previousRevisionHash: `0x${"55".repeat(32)}` },
    { commitment: `0x${"66".repeat(32)}` },
    { usdCents: 125_001n },
    { validUntil: 1_900_000_001n },
  ];
  for (const mismatch of mismatches) {
    assert.equal(verifyReceiptEvidence(evidence, contract, 296, makeReceipt(mismatch)).status, "failed");
  }
});

test("public verification reports wrong-chain and chain-RPC failures separately", async () => {
  const evidence = createEvidence(payload, salt);
  const wrongChain = await verifyPublicReceipt(
    transactionHash,
    evidence,
    contract,
    makeClient({ getChainId: async () => 295 }),
  );
  const rpcFailure = await verifyPublicReceipt(
    transactionHash,
    evidence,
    contract,
    makeClient({
      getChainId: async () => {
        throw new Error("provider unavailable");
      },
    }),
  );
  if (wrongChain.status !== "failed" || rpcFailure.status !== "failed") assert.fail("failure expected");
  assert.match(wrongChain.reason, /Wrong network/);
  assert.match(rpcFailure.reason, /chain ID/);
});

test("public verification rejects untrusted deployments, wrong oracle and missing code", async () => {
  const evidence = createEvidence(payload, salt);
  const untrusted = await verifyPublicReceipt(transactionHash, evidence, otherContract, makeClient());
  const noCode = await verifyPublicReceipt(
    transactionHash,
    evidence,
    contract,
    makeClient({ getBytecode: async () => undefined }),
  );
  const wrongOracle = await verifyPublicReceipt(
    transactionHash,
    evidence,
    contract,
    makeClient({ readContract: async () => otherContract }),
  );
  for (const [result, pattern] of [
    [untrusted, /configured/],
    [noCode, /no deployed/],
    [wrongOracle, /official Supra/],
  ] as const) {
    if (result.status !== "failed") assert.fail("failure expected");
    assert.match(result.reason, pattern);
  }
});

test("public verification distinguishes a missing receipt from an RPC failure", async () => {
  const evidence = createEvidence(payload, salt);
  const missing = await verifyPublicReceipt(
    transactionHash,
    evidence,
    contract,
    makeClient({
      getTransactionReceipt: async () => {
        throw new TransactionReceiptNotFoundError({ hash: transactionHash });
      },
    }),
  );
  const rpcFailure = await verifyPublicReceipt(
    transactionHash,
    evidence,
    contract,
    makeClient({
      getTransactionReceipt: async () => {
        throw new Error("provider unavailable with internal details");
      },
    }),
  );
  if (missing.status !== "failed" || rpcFailure.status !== "failed") assert.fail("failure expected");
  assert.match(missing.reason, /not found/);
  assert.match(rpcFailure.reason, /RPC failed/);
  assert.doesNotMatch(rpcFailure.reason, /internal details/);
});

test("public verification accepts canonical evidence from the trusted deployment", async () => {
  const result = await verifyPublicReceipt(transactionHash, createEvidence(payload, salt), contract, makeClient());
  assert.deepEqual(result, { status: "externally_verified", recordHash });
});
