import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("QuoteProof", function () {
  const quoteId = ethers.id("SYNTHETIC-Q-001");
  const commitment = ethers.sha256(ethers.toUtf8Bytes("canonical payload|salt"));

  async function deployFixture() {
    const [issuer, other] = await ethers.getSigners();
    const oracle = await ethers.deployContract("MockSupraSValueFeed");
    const quoteProof = await ethers.deployContract("QuoteProof", [await oracle.getAddress()]);
    const now = await time.latest();
    await oracle.setValue(77, 18, BigInt(now) * 1000n, 81_018_000_000_000_000n);
    return { issuer, other, oracle, quoteProof, now };
  }

  async function recordFirst(overrides: Record<string, unknown> = {}) {
    const fixture = await deployFixture();
    const args = {
      quoteId,
      revision: 1,
      previousRevisionHash: ethers.ZeroHash,
      commitment,
      usdCents: 125_000n,
      validUntil: fixture.now + 3600,
      ...overrides,
    };
    const tx = await fixture.quoteProof.recordRevision(
      args.quoteId,
      args.revision,
      args.previousRevisionHash,
      args.commitment,
      args.usdCents,
      args.validUntil,
    );
    return { ...fixture, args, tx };
  }

  it("records raw oracle evidence, issuer, units and the first revision", async function () {
    const { issuer, quoteProof, tx } = await recordFirst();
    await expect(tx).to.emit(quoteProof, "RevisionRecorded");

    const record = await quoteProof.getRevision(quoteId, 1);
    expect(record.issuer).to.equal(issuer.address);
    expect(record.oracleRound).to.equal(77);
    expect(record.oracleDecimals).to.equal(18);
    expect(record.oraclePrice).to.equal(81_018_000_000_000_000n);
    expect(record.tinybarEstimate).to.be.greaterThan(0);
    expect(record.hbarWeiEstimate).to.equal(record.tinybarEstimate * 10_000_000_000n);
    expect(await quoteProof.latestRevisionHash(quoteId)).to.equal(record.recordHash);
  });

  it("rounds USD cents up to a whole tinybar and derives EVM wei from it", async function () {
    const { oracle, quoteProof, now } = await deployFixture();
    await oracle.setValue(1, 0, now, 3);
    const [, tinybar, hbarWei] = await quoteProof.preview(100);
    expect(tinybar).to.equal(33_333_334n);
    expect(hbarWei).to.equal(333_333_340_000_000_000n);
  });

  it("accepts observed millisecond and documented adapter second timestamps", async function () {
    const { oracle, quoteProof, now } = await deployFixture();
    await oracle.setValue(1, 18, now, 1n * 10n ** 18n);
    expect((await quoteProof.preview(100))[0].timestampSeconds).to.equal(now);
    await oracle.setValue(2, 18, BigInt(now) * 1000n + 999n, 1n * 10n ** 18n);
    expect((await quoteProof.preview(100))[0].timestampSeconds).to.equal(now);
  });

  it("enforces issuer ownership, sequential revisions and the previous record hash", async function () {
    const { other, quoteProof, now } = await recordFirst();
    const previous = await quoteProof.latestRevisionHash(quoteId);

    await expect(
      quoteProof.connect(other).recordRevision(quoteId, 2, previous, commitment, 100, now + 7200),
    ).to.be.revertedWithCustomError(quoteProof, "UnauthorizedIssuer");
    await expect(
      quoteProof.recordRevision(quoteId, 3, previous, commitment, 100, now + 7200),
    ).to.be.revertedWithCustomError(quoteProof, "InvalidRevision");
    await expect(
      quoteProof.recordRevision(quoteId, 2, ethers.ZeroHash, commitment, 100, now + 7200),
    ).to.be.revertedWithCustomError(quoteProof, "InvalidPreviousRevisionHash");

    await quoteProof.recordRevision(quoteId, 2, previous, commitment, 100, now + 7200);
    expect(await quoteProof.latestRevision(quoteId)).to.equal(2);
  });

  it("rejects duplicate and expired records", async function () {
    const { quoteProof, now } = await recordFirst();
    await expect(
      quoteProof.recordRevision(quoteId, 1, ethers.ZeroHash, commitment, 100, now + 3600),
    ).to.be.revertedWithCustomError(quoteProof, "DuplicateRevision");

    const secondQuote = ethers.id("SYNTHETIC-Q-EXPIRED");
    await expect(
      quoteProof.recordRevision(secondQuote, 1, ethers.ZeroHash, commitment, 100, now),
    ).to.be.revertedWithCustomError(quoteProof, "QuoteExpired");
  });

  it("rejects stale, future, zero, excessive-decimal and reverting oracle values", async function () {
    const { oracle, quoteProof, now } = await deployFixture();
    expect(await quoteProof.MAX_FUTURE_SKEW()).to.equal(30);

    await oracle.setValue(1, 18, (BigInt(now) - 7201n) * 1000n, 1n);
    await expect(quoteProof.preview(100)).to.be.revertedWithCustomError(quoteProof, "StaleOraclePrice");

    const beforeAcceptedFutureValue = await time.latest();
    await oracle.setValue(1, 18, (BigInt(beforeAcceptedFutureValue) + 31n) * 1000n, 1n);
    expect((await quoteProof.preview(100))[0].timestampSeconds).to.equal(BigInt(beforeAcceptedFutureValue) + 31n);

    const beforeRejectedFutureValue = await time.latest();
    // The setValue transaction advances the local block timestamp by one second, leaving a 31-second offset.
    await oracle.setValue(1, 18, (BigInt(beforeRejectedFutureValue) + 32n) * 1000n, 1n);
    await expect(quoteProof.preview(100)).to.be.revertedWithCustomError(quoteProof, "OracleTimeInFuture");

    await oracle.setValue(1, 18, now, 0);
    await expect(quoteProof.preview(100)).to.be.revertedWithCustomError(quoteProof, "OraclePriceIsZero");

    await oracle.setValue(1, 37, now, 1);
    await expect(quoteProof.preview(100)).to.be.revertedWithCustomError(quoteProof, "UnsupportedOracleDecimals");

    await oracle.setShouldRevert(true);
    await expect(quoteProof.preview(100)).to.be.revertedWith("oracle unavailable");
  });

  it("reverts instead of overflowing at unsupported price and amount boundaries", async function () {
    const { oracle, quoteProof, now } = await deployFixture();
    await oracle.setValue(1, 18, now, ethers.MaxUint256);
    await expect(quoteProof.preview(100)).to.be.revertedWithCustomError(quoteProof, "OraclePriceTooLarge");

    await oracle.setValue(1, 36, now, 1);
    await expect(quoteProof.preview(ethers.MaxUint256)).to.be.reverted;
  });
});
