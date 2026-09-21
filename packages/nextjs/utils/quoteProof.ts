import {
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  TransactionReceiptNotFoundError,
  bytesToHex,
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  parseEventLogs,
  sha256,
  stringToBytes,
} from "viem";
import { hederaTestnet } from "viem/chains";
import {
  HEDERA_TESTNET_CHAIN_ID,
  MAX_FUTURE_SKEW_SECONDS,
  MAX_ORACLE_AGE_SECONDS,
  MAX_ORACLE_DECIMALS,
  SUPRA_HBAR_USD_ADDRESS,
  SUPRA_HBAR_USD_PAIR_ID,
  quoteProofAbi,
  supraAbi,
} from "~~/contracts/quoteProof";

export type QuotePayload = {
  quoteId: string;
  revision: number;
  previousRevisionHash: Hex;
  issuer: Address;
  usdCents: string;
  validUntil: number;
};

export type EvidenceFile = {
  schema: "quoteproof-evidence-v1";
  chainId: 296;
  canonicalPayload: string;
  salt: Hex;
  commitment: Hex;
  quoteIdHash: Hex;
};

export type OracleSnapshot = {
  pairId: 432;
  round: bigint;
  decimals: bigint;
  rawTime: bigint;
  timestampSeconds: bigint;
  price: bigint;
  ageSeconds: bigint;
  futureSkewSeconds: bigint;
};

export type VerificationResult =
  { status: "externally_verified"; recordHash: Hex } | { status: "failed"; reason: string };

type ReceiptLike = {
  status: "success" | "reverted";
  logs: Log[];
};

export const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

export function normalizeQuotePayload(input: QuotePayload): QuotePayload {
  const quoteId = input.quoteId.trim();
  if (!quoteId || quoteId.length > 80) throw new Error("Quote ID must contain 1 to 80 characters");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1)
    throw new Error("Revision must be a positive integer");
  if (!isHex(input.previousRevisionHash, { strict: true }) || input.previousRevisionHash.length !== 66) {
    throw new Error("Previous revision hash must be 32 bytes");
  }
  if (!isAddress(input.issuer)) throw new Error("Issuer must be a valid EVM address");
  if (!/^\d+$/.test(input.usdCents) || BigInt(input.usdCents) <= 0n) throw new Error("USD cents must be positive");
  if (!Number.isSafeInteger(input.validUntil) || input.validUntil <= 0) throw new Error("Expiry must be Unix seconds");

  return {
    quoteId,
    revision: input.revision,
    previousRevisionHash: input.previousRevisionHash.toLowerCase() as Hex,
    issuer: getAddress(input.issuer),
    usdCents: BigInt(input.usdCents).toString(),
    validUntil: input.validUntil,
  };
}

export function canonicalizeQuote(input: QuotePayload): string {
  const value = normalizeQuotePayload(input);
  return JSON.stringify({
    schema: "quoteproof-quote-v1",
    chainId: HEDERA_TESTNET_CHAIN_ID,
    quoteId: value.quoteId,
    revision: value.revision,
    previousRevisionHash: value.previousRevisionHash,
    issuer: value.issuer.toLowerCase(),
    usdCents: value.usdCents,
    validUntil: value.validUntil,
  });
}

export function createEvidence(input: QuotePayload, salt?: Hex): EvidenceFile {
  const canonicalPayload = canonicalizeQuote(input);
  const nextSalt = salt ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  if (!isHex(nextSalt, { strict: true }) || nextSalt.length !== 66) throw new Error("Salt must be 32 bytes");

  return {
    schema: "quoteproof-evidence-v1",
    chainId: HEDERA_TESTNET_CHAIN_ID,
    canonicalPayload,
    salt: nextSalt.toLowerCase() as Hex,
    commitment: sha256(stringToBytes(`${canonicalPayload}\n${nextSalt.toLowerCase()}`)),
    quoteIdHash: keccak256(stringToBytes(normalizeQuotePayload(input).quoteId)),
  };
}

export function validateEvidence(input: unknown): EvidenceFile {
  if (!input || typeof input !== "object") throw new Error("Evidence file must be a JSON object");
  const value = input as Partial<EvidenceFile>;
  if (value.schema !== "quoteproof-evidence-v1" || value.chainId !== HEDERA_TESTNET_CHAIN_ID) {
    throw new Error("Evidence schema or network is not supported");
  }
  if (typeof value.canonicalPayload !== "string" || !value.canonicalPayload)
    throw new Error("Canonical payload is missing");
  if (!value.salt || !isHex(value.salt, { strict: true }) || value.salt.length !== 66)
    throw new Error("Salt is invalid");
  if (!value.commitment || !isHex(value.commitment, { strict: true }) || value.commitment.length !== 66) {
    throw new Error("Commitment is invalid");
  }
  if (!value.quoteIdHash || !isHex(value.quoteIdHash, { strict: true }) || value.quoteIdHash.length !== 66) {
    throw new Error("Quote ID hash is invalid");
  }

  const parsed = JSON.parse(value.canonicalPayload) as Record<string, unknown>;
  const recomputed = createEvidence(
    {
      quoteId: String(parsed.quoteId ?? ""),
      revision: Number(parsed.revision),
      previousRevisionHash: String(parsed.previousRevisionHash) as Hex,
      issuer: String(parsed.issuer) as Address,
      usdCents: String(parsed.usdCents ?? ""),
      validUntil: Number(parsed.validUntil),
    },
    value.salt,
  );
  if (recomputed.canonicalPayload !== value.canonicalPayload)
    throw new Error("Canonical payload was altered or is non-canonical");
  if (recomputed.commitment !== value.commitment.toLowerCase())
    throw new Error("Commitment does not match payload and salt");
  if (recomputed.quoteIdHash !== value.quoteIdHash.toLowerCase())
    throw new Error("Quote ID hash does not match payload");
  return recomputed;
}

export function usdStringToCents(value: string): bigint {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error("USD amount must have at most two decimal places");
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  if (cents <= 0n) throw new Error("USD amount must be positive");
  return cents;
}

export function normalizeOracleTime(rawTime: bigint): bigint {
  if (rawTime <= 0n) throw new Error("Oracle time is zero");
  return rawTime >= 100_000_000_000n ? rawTime / 1000n : rawTime;
}

export function validateOracleSnapshot(
  value: { round: bigint; decimals: bigint; time: bigint; price: bigint },
  nowSeconds: bigint,
): OracleSnapshot {
  if (value.price <= 0n) throw new Error("Oracle price is zero");
  if (value.decimals < 0n || value.decimals > MAX_ORACLE_DECIMALS) throw new Error("Oracle decimals are unsupported");
  const timestampSeconds = normalizeOracleTime(value.time);
  if (timestampSeconds > nowSeconds + MAX_FUTURE_SKEW_SECONDS) throw new Error("Oracle timestamp is in the future");
  const ageSeconds = nowSeconds > timestampSeconds ? nowSeconds - timestampSeconds : 0n;
  const futureSkewSeconds = timestampSeconds > nowSeconds ? timestampSeconds - nowSeconds : 0n;
  if (ageSeconds > MAX_ORACLE_AGE_SECONDS) throw new Error("Oracle price is older than two hours");
  return {
    pairId: 432,
    round: value.round,
    decimals: value.decimals,
    rawTime: value.time,
    timestampSeconds,
    price: value.price,
    ageSeconds,
    futureSkewSeconds,
  };
}

export function convertUsdCentsToTinybar(usdCents: bigint, snapshot: OracleSnapshot): bigint {
  if (usdCents <= 0n) throw new Error("USD cents must be positive");
  const numerator = usdCents * 10n ** snapshot.decimals * 100_000_000n;
  const denominator = snapshot.price * 100n;
  return (numerator + denominator - 1n) / denominator;
}

export function getQuoteProofAddress(raw = process.env.NEXT_PUBLIC_QUOTEPROOF_ADDRESS): Address | null {
  return raw && isAddress(raw) ? getAddress(raw) : null;
}

function getVerificationBoundary(
  evidence: unknown,
  requestedContractAddress: unknown,
): { evidence: EvidenceFile; contractAddress: Address } | { reason: string } {
  let validatedEvidence: EvidenceFile;
  try {
    validatedEvidence = validateEvidence(evidence);
  } catch {
    return { reason: "Evidence is invalid or non-canonical" };
  }

  const configuredValue = process.env.NEXT_PUBLIC_QUOTEPROOF_ADDRESS;
  if (!configuredValue) return { reason: "QuoteProof deployment address is not configured" };
  if (!isAddress(configuredValue)) return { reason: "Configured QuoteProof deployment address is invalid" };
  if (typeof requestedContractAddress !== "string" || !isAddress(requestedContractAddress)) {
    return { reason: "Requested QuoteProof contract address is invalid" };
  }

  const contractAddress = getAddress(configuredValue);
  if (getAddress(requestedContractAddress) !== contractAddress) {
    return { reason: "Requested contract does not match the configured QuoteProof deployment" };
  }
  return { evidence: validatedEvidence, contractAddress };
}

export function makeHederaTestnetClient(): PublicClient {
  const rpcUrl = process.env.NEXT_PUBLIC_HEDERA_TESTNET_RPC_URL || "https://testnet.hashio.io/api";
  return createPublicClient({ chain: hederaTestnet, transport: http(rpcUrl) });
}

export async function fetchSupraSnapshot(client = makeHederaTestnetClient()): Promise<OracleSnapshot> {
  const chainId = await client.getChainId();
  if (chainId !== HEDERA_TESTNET_CHAIN_ID) throw new Error(`RPC returned chain ${chainId}, expected 296`);
  const result = await client.readContract({
    address: SUPRA_HBAR_USD_ADDRESS,
    abi: supraAbi,
    functionName: "getSvalue",
    args: [SUPRA_HBAR_USD_PAIR_ID],
  });
  const value = result as { round: bigint; decimals: bigint; time: bigint; price: bigint };
  return validateOracleSnapshot(value, BigInt(Math.floor(Date.now() / 1000)));
}

export function verifyReceiptEvidence(
  evidence: unknown,
  requestedContractAddress: unknown,
  chainId: number,
  receipt: ReceiptLike | null,
): VerificationResult {
  const boundary = getVerificationBoundary(evidence, requestedContractAddress);
  if ("reason" in boundary) return { status: "failed", reason: boundary.reason };
  if (chainId !== HEDERA_TESTNET_CHAIN_ID) return { status: "failed", reason: `Wrong network: ${chainId}` };
  if (!receipt) return { status: "failed", reason: "Public transaction receipt was not found" };
  if (receipt.status !== "success") return { status: "failed", reason: "Transaction reverted" };

  const matchingLogs = receipt.logs.filter(log => log.address.toLowerCase() === boundary.contractAddress.toLowerCase());
  let events;
  try {
    events = parseEventLogs({
      abi: quoteProofAbi,
      eventName: "RevisionRecorded",
      logs: matchingLogs,
      strict: true,
    });
  } catch {
    return { status: "failed", reason: "Receipt contains an invalid QuoteProof revision event" };
  }
  const parsed = JSON.parse(boundary.evidence.canonicalPayload) as QuotePayload;
  const event = events.find(candidate => {
    const args = candidate.args as Record<string, unknown>;
    return (
      args.quoteId === boundary.evidence.quoteIdHash &&
      args.revision === BigInt(parsed.revision) &&
      typeof args.issuer === "string" &&
      isAddress(args.issuer) &&
      getAddress(args.issuer) === getAddress(parsed.issuer) &&
      args.previousRevisionHash === parsed.previousRevisionHash &&
      args.commitment === boundary.evidence.commitment &&
      args.usdCents === BigInt(parsed.usdCents) &&
      args.validUntil === BigInt(parsed.validUntil)
    );
  });
  if (!event) return { status: "failed", reason: "Receipt has no matching QuoteProof revision event" };
  return { status: "externally_verified", recordHash: (event.args as { recordHash: Hex }).recordHash };
}

export async function verifyPublicReceipt(
  transactionHash: Hex,
  evidence: unknown,
  requestedContractAddress: unknown,
  client = makeHederaTestnetClient(),
): Promise<VerificationResult> {
  const boundary = getVerificationBoundary(evidence, requestedContractAddress);
  if ("reason" in boundary) return { status: "failed", reason: boundary.reason };
  if (!isHex(transactionHash, { strict: true }) || transactionHash.length !== 66) {
    return { status: "failed", reason: "Transaction hash must be 32 bytes" };
  }

  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch {
    return { status: "failed", reason: "Hedera Testnet RPC failed while checking the chain ID" };
  }
  if (chainId !== HEDERA_TESTNET_CHAIN_ID) return { status: "failed", reason: `Wrong network: ${chainId}` };

  try {
    const bytecode = await client.getBytecode({ address: boundary.contractAddress });
    if (!bytecode || bytecode === "0x") {
      return { status: "failed", reason: "Configured QuoteProof address has no deployed contract code" };
    }
  } catch {
    return { status: "failed", reason: "Hedera Testnet RPC failed while checking the deployed contract code" };
  }

  try {
    const oracleAddress = await client.readContract({
      address: boundary.contractAddress,
      abi: quoteProofAbi,
      functionName: "oracle",
    });
    if (getAddress(oracleAddress) !== getAddress(SUPRA_HBAR_USD_ADDRESS)) {
      return { status: "failed", reason: "Configured QuoteProof contract does not use the official Supra oracle" };
    }
  } catch {
    return { status: "failed", reason: "Could not verify the configured QuoteProof contract oracle" };
  }

  try {
    const receipt = await client.getTransactionReceipt({ hash: transactionHash });
    return verifyReceiptEvidence(boundary.evidence, boundary.contractAddress, chainId, receipt);
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) {
      return { status: "failed", reason: "Public transaction receipt was not found" };
    }
    return { status: "failed", reason: "Hedera Testnet RPC failed while reading the transaction receipt" };
  }
}
