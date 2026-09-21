"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import type { NextPage } from "next";
import { type Address, type Hex, formatUnits, getAddress } from "viem";
import { useAccount, useChainId, usePublicClient, useWriteContract } from "wagmi";
import { ArrowDownTrayIcon, CheckCircleIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { HEDERA_TESTNET_CHAIN_ID, quoteProofAbi } from "~~/contracts/quoteProof";
import {
  type EvidenceFile,
  type OracleSnapshot,
  ZERO_HASH,
  convertUsdCentsToTinybar,
  createEvidence,
  fetchSupraSnapshot,
  getQuoteProofAddress,
  usdStringToCents,
  validateEvidence,
  verifyPublicReceipt,
} from "~~/utils/quoteProof";

type FlowStatus = "ready" | "pending" | "confirmed" | "externally_verified" | "failed";

const statusLabel: Record<FlowStatus, string> = {
  ready: "Ready",
  pending: "Pending wallet confirmation",
  confirmed: "Confirmed, checking public receipt",
  externally_verified: "Externally verified",
  failed: "Failed",
};

const verifyStatusLabel: Record<FlowStatus, string> = { ...statusLabel, pending: "Checking public receipt" };

const formatPrice = (snapshot: OracleSnapshot) => formatUnits(snapshot.price, Number(snapshot.decimals));
const formatHbar = (tinybar: bigint) => formatUnits(tinybar, 8);

const Home: NextPage = () => {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient({ chainId: HEDERA_TESTNET_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const configuredContract = useMemo(() => getQuoteProofAddress(), []);

  const [quoteId, setQuoteId] = useState("SYNTHETIC-Q-001");
  const [revision, setRevision] = useState("1");
  const [previousHash, setPreviousHash] = useState<Hex>(ZERO_HASH);
  const [issuer, setIssuer] = useState("");
  const [usdAmount, setUsdAmount] = useState("1250.00");
  const [validUntil, setValidUntil] = useState(() =>
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
  );
  const [evidence, setEvidence] = useState<EvidenceFile | null>(null);
  const [snapshot, setSnapshot] = useState<OracleSnapshot | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [status, setStatus] = useState<FlowStatus>("ready");
  const [flowMessage, setFlowMessage] = useState("No testnet write has been sent.");
  const [transactionHash, setTransactionHash] = useState<Hex | "">("");

  const [verifyEvidence, setVerifyEvidence] = useState<EvidenceFile | null>(null);
  const [verifyTx, setVerifyTx] = useState("");
  const [verifyContract, setVerifyContract] = useState(configuredContract ?? "");
  const [verifyStatus, setVerifyStatus] = useState<FlowStatus>("ready");
  const [verifyMessage, setVerifyMessage] = useState(
    "Choose a local evidence file and provide a public transaction hash.",
  );

  useEffect(() => {
    if (address) setIssuer(address);
  }, [address]);

  const refreshPreview = async () => {
    setPreviewError("");
    try {
      setSnapshot(await fetchSupraSnapshot());
    } catch (error) {
      setSnapshot(null);
      setPreviewError(error instanceof Error ? error.message : "Supra preview failed");
    }
  };

  useEffect(() => {
    void refreshPreview();
  }, []);

  const previewTinybar = useMemo(() => {
    try {
      return snapshot ? convertUsdCentsToTinybar(usdStringToCents(usdAmount), snapshot) : null;
    } catch {
      return null;
    }
  }, [snapshot, usdAmount]);

  const buildEvidence = () => {
    try {
      const expiry = Math.floor(new Date(validUntil).getTime() / 1000);
      const nextEvidence = createEvidence({
        quoteId,
        revision: Number(revision),
        previousRevisionHash: previousHash,
        issuer: getAddress(issuer),
        usdCents: usdStringToCents(usdAmount).toString(),
        validUntil: expiry,
      });
      if (expiry <= Math.floor(Date.now() / 1000)) throw new Error("Expiry must be in the future");
      setEvidence(nextEvidence);
      setStatus("ready");
      setFlowMessage("Evidence is local. Download it before sending a transaction.");
    } catch (error) {
      setEvidence(null);
      setStatus("failed");
      setFlowMessage(error instanceof Error ? error.message : "Could not create evidence");
    }
  };

  const downloadEvidence = () => {
    if (!evidence) return;
    const blob = new Blob([JSON.stringify(evidence, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${quoteId.replace(/[^a-z0-9_-]/gi, "-")}-evidence.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const anchorRevision = async () => {
    if (!evidence || !configuredContract || !address || !publicClient) return;
    if (chainId !== HEDERA_TESTNET_CHAIN_ID) {
      setStatus("failed");
      setFlowMessage(`Wrong wallet network: ${chainId}. Switch to Hedera Testnet 296.`);
      return;
    }
    const parsed = JSON.parse(evidence.canonicalPayload) as {
      issuer: Address;
      revision: number;
      previousRevisionHash: Hex;
      usdCents: string;
      validUntil: number;
    };
    if (getAddress(parsed.issuer) !== getAddress(address)) {
      setStatus("failed");
      setFlowMessage("Connected wallet does not match the issuer in this evidence file.");
      return;
    }

    try {
      setStatus("pending");
      setFlowMessage("Approve the Hedera Testnet contract call in your wallet.");
      const hash = await writeContractAsync({
        address: configuredContract,
        abi: quoteProofAbi,
        functionName: "recordRevision",
        args: [
          evidence.quoteIdHash,
          BigInt(parsed.revision),
          parsed.previousRevisionHash,
          evidence.commitment,
          BigInt(parsed.usdCents),
          BigInt(parsed.validUntil),
        ],
        chainId: HEDERA_TESTNET_CHAIN_ID,
      });
      setTransactionHash(hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted");
      setStatus("confirmed");
      setFlowMessage("Wallet receipt confirmed. Re-reading it from the public testnet RPC.");
      const result = await verifyPublicReceipt(hash, evidence, configuredContract);
      setStatus(result.status);
      setFlowMessage(
        result.status === "externally_verified" ? `Public event matched record ${result.recordHash}` : result.reason,
      );
    } catch (error) {
      setStatus("failed");
      setFlowMessage(error instanceof Error ? error.message : "Testnet write failed");
    }
  };

  const loadEvidence = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = validateEvidence(JSON.parse(await file.text()));
      setVerifyEvidence(parsed);
      setVerifyStatus("ready");
      setVerifyMessage("Local canonical payload and commitment match. Public receipt not checked yet.");
    } catch (error) {
      setVerifyEvidence(null);
      setVerifyStatus("failed");
      setVerifyMessage(error instanceof Error ? error.message : "Evidence file is invalid");
    }
  };

  const verifyReceipt = async () => {
    if (!verifyEvidence) return;
    try {
      setVerifyStatus("pending");
      setVerifyMessage("Reading the receipt from Hedera Testnet RPC.");
      const result = await verifyPublicReceipt(verifyTx as Hex, verifyEvidence, verifyContract);
      setVerifyStatus(result.status);
      setVerifyMessage(
        result.status === "externally_verified" ? `Public event matched record ${result.recordHash}` : result.reason,
      );
    } catch (error) {
      setVerifyStatus("failed");
      setVerifyMessage(error instanceof Error ? error.message : "Receipt verification failed");
    }
  };

  return (
    <div className="grow bg-base-200/50">
      <section className="hedera-gradient px-5 py-14 text-white">
        <div className="mx-auto max-w-6xl">
          <span className="badge badge-outline border-white/50 text-white">Hedera Testnet</span>
          <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-tight md:text-6xl">A quote anyone can check.</h1>
          <p className="mt-5 max-w-2xl text-lg text-white/80">
            QuoteProof commits a synthetic USD quote and anchors the exact Supra HBAR/USD reading used for its
            illustrative conversion.
          </p>
        </div>
      </section>

      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-10 lg:grid-cols-[1.4fr_0.8fr]">
        <section id="create" className="card border border-base-300 bg-base-100 shadow-xl">
          <div className="card-body">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold uppercase tracking-widest text-primary">Create</p>
                <h2 className="card-title text-2xl">Prepare one quote revision</h2>
              </div>
              <span
                className={`badge ${
                  status === "failed"
                    ? "badge-error"
                    : status === "externally_verified"
                      ? "badge-success"
                      : "badge-neutral"
                }`}
              >
                {statusLabel[status]}
              </span>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="form-control md:col-span-2">
                <span className="label-text mb-1">Synthetic quote ID</span>
                <input
                  className="input input-bordered"
                  value={quoteId}
                  onChange={event => setQuoteId(event.target.value)}
                />
              </label>
              <label className="form-control">
                <span className="label-text mb-1">Revision</span>
                <input
                  className="input input-bordered"
                  min="1"
                  type="number"
                  value={revision}
                  onChange={event => setRevision(event.target.value)}
                />
              </label>
              <label className="form-control">
                <span className="label-text mb-1">USD amount</span>
                <input
                  className="input input-bordered"
                  inputMode="decimal"
                  value={usdAmount}
                  onChange={event => setUsdAmount(event.target.value)}
                />
              </label>
              <label className="form-control md:col-span-2">
                <span className="label-text mb-1">Issuer EVM address</span>
                <input
                  className="input input-bordered font-mono text-sm"
                  value={issuer}
                  onChange={event => setIssuer(event.target.value)}
                  placeholder="0x..."
                />
              </label>
              <label className="form-control md:col-span-2">
                <span className="label-text mb-1">Previous revision record hash</span>
                <input
                  className="input input-bordered font-mono text-xs"
                  value={previousHash}
                  onChange={event => setPreviousHash(event.target.value as Hex)}
                />
              </label>
              <label className="form-control md:col-span-2">
                <span className="label-text mb-1">Valid until</span>
                <input
                  className="input input-bordered"
                  type="datetime-local"
                  value={validUntil}
                  onChange={event => setValidUntil(event.target.value)}
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-3">
              <button className="btn btn-primary" onClick={buildEvidence}>
                Create local evidence
              </button>
              <button className="btn btn-outline" disabled={!evidence} onClick={downloadEvidence}>
                <ArrowDownTrayIcon className="h-5 w-5" /> Download evidence
              </button>
            </div>

            {evidence && (
              <div className="rounded-box bg-base-200 p-4 text-sm">
                <p className="m-0 font-semibold">Commitment</p>
                <p className="mt-1 break-all font-mono text-xs">{evidence.commitment}</p>
                <p className="mb-0 text-base-content/70">
                  The canonical payload and random salt stay only in the downloaded local file.
                </p>
              </div>
            )}

            {!configuredContract ? (
              <div className="alert alert-warning">
                <ExclamationTriangleIcon className="h-6 w-6" />
                <span>
                  No valid QuoteProof testnet address is configured. Preview and local evidence work, but no write can
                  be sent.
                </span>
              </div>
            ) : (
              <button
                className="btn btn-secondary"
                disabled={!evidence || !isConnected || status === "pending" || status === "confirmed"}
                onClick={anchorRevision}
              >
                Anchor revision on Hedera Testnet
              </button>
            )}

            <div
              className={`alert ${
                status === "failed" ? "alert-error" : status === "externally_verified" ? "alert-success" : "alert-info"
              }`}
            >
              {status === "externally_verified" ? (
                <CheckCircleIcon className="h-6 w-6" />
              ) : (
                <span className="loading loading-ring loading-sm" />
              )}
              <div>
                <div className="font-semibold">{statusLabel[status]}</div>
                <div className="text-sm">{flowMessage}</div>
                {transactionHash && <div className="mt-1 break-all font-mono text-xs">{transactionHash}</div>}
              </div>
            </div>
          </div>
        </section>

        <aside className="card h-fit border border-base-300 bg-base-100 shadow-xl">
          <div className="card-body">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold uppercase tracking-widest text-secondary">Live oracle</p>
                <h2 className="card-title">Supra HBAR/USD</h2>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={refreshPreview}>
                Refresh
              </button>
            </div>
            {snapshot ? (
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div className="stat rounded-box bg-base-200 p-3">
                  <dt className="stat-title text-xs">Price</dt>
                  <dd className="stat-value text-lg">${formatPrice(snapshot)}</dd>
                </div>
                <div className="stat rounded-box bg-base-200 p-3">
                  <dt className="stat-title text-xs">{snapshot.futureSkewSeconds > 0n ? "Future skew" : "Age"}</dt>
                  <dd className="stat-value text-lg">
                    {snapshot.futureSkewSeconds > 0n
                      ? `+${snapshot.futureSkewSeconds.toString()}s`
                      : `${snapshot.ageSeconds.toString()}s`}
                  </dd>
                </div>
                <div>
                  <dt className="text-base-content/60">Pair</dt>
                  <dd className="font-mono">432</dd>
                </div>
                <div>
                  <dt className="text-base-content/60">Decimals</dt>
                  <dd className="font-mono">{snapshot.decimals.toString()}</dd>
                </div>
                <div>
                  <dt className="text-base-content/60">Round</dt>
                  <dd className="break-all font-mono text-xs">{snapshot.round.toString()}</dd>
                </div>
                <div>
                  <dt className="text-base-content/60">Raw time</dt>
                  <dd className="break-all font-mono text-xs">{snapshot.rawTime.toString()}</dd>
                </div>
              </dl>
            ) : (
              <div className="alert alert-error">
                <ExclamationTriangleIcon className="h-6 w-6" />
                <span>{previewError || "Loading unsigned testnet data..."}</span>
              </div>
            )}
            <div className="divider">Illustrative conversion</div>
            <p className="m-0 text-xs text-base-content/60">
              Oracle timestamps up to 30 seconds ahead are accepted as this template&apos;s clock-skew policy.
            </p>
            <div className="text-center">
              <p className="m-0 text-sm text-base-content/60">{usdAmount || "0"} USD</p>
              <p className="my-2 text-3xl font-bold">
                {previewTinybar === null ? "Unavailable" : `${formatHbar(previewTinybar)} HBAR`}
              </p>
              <p className="m-0 text-xs text-base-content/60">
                Rounded up to one tinybar. Not a settlement or price guarantee.
              </p>
            </div>
          </div>
        </aside>
      </div>

      <section id="verify" className="border-t border-base-300 bg-base-100 px-5 py-12">
        <div className="mx-auto max-w-6xl">
          <p className="text-sm font-semibold uppercase tracking-widest text-primary">Independent verification</p>
          <div className="grid gap-8 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-bold">Recompute locally, then query the public receipt.</h2>
              <p className="text-base-content/70">
                A matching local hash alone is not verification. QuoteProof also requires chain 296, a successful
                receipt, the configured contract address, and a matching event.
              </p>
              <input
                className="file-input file-input-bordered w-full"
                type="file"
                accept="application/json"
                onChange={loadEvidence}
              />
            </div>
            <div className="card border border-base-300 bg-base-200">
              <div className="card-body">
                <label className="form-control">
                  <span className="label-text mb-1">QuoteProof contract</span>
                  <input
                    className="input input-bordered font-mono text-xs"
                    value={verifyContract}
                    onChange={event => setVerifyContract(event.target.value)}
                    placeholder="0x..."
                  />
                </label>
                <label className="form-control">
                  <span className="label-text mb-1">Transaction hash</span>
                  <input
                    className="input input-bordered font-mono text-xs"
                    value={verifyTx}
                    onChange={event => setVerifyTx(event.target.value)}
                    placeholder="0x..."
                  />
                </label>
                <button
                  className="btn btn-primary"
                  disabled={!verifyEvidence || verifyStatus === "pending"}
                  onClick={verifyReceipt}
                >
                  Verify public evidence
                </button>
                <div
                  className={`alert ${
                    verifyStatus === "failed"
                      ? "alert-error"
                      : verifyStatus === "externally_verified"
                        ? "alert-success"
                        : "alert-info"
                  }`}
                >
                  <span>
                    {verifyStatusLabel[verifyStatus]}: {verifyMessage}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Home;
