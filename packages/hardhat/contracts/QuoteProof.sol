// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

interface ISupraSValueFeed {
    struct PriceFeed {
        uint256 round;
        uint256 decimals;
        uint256 time;
        uint256 price;
    }

    function getSvalue(uint256 pairIndex) external view returns (PriceFeed memory);
}

/// @title QuoteProof
/// @notice Anchors synthetic quote revisions with the HBAR/USD value read directly from Supra.
/// @dev This is evidence of an illustrative estimate, not a payment or a legal acceptance.
contract QuoteProof {
    address public constant SUPRA_HEDERA_TESTNET = 0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917;
    uint256 public constant HBAR_USD_PAIR_ID = 432;
    uint256 public constant MAX_ORACLE_AGE = 2 hours;
    uint256 public constant MAX_FUTURE_SKEW = 30 seconds;
    uint256 public constant MAX_ORACLE_DECIMALS = 36;
    uint256 public constant TINYBAR_PER_HBAR = 1e8;
    uint256 public constant EVM_WEI_PER_TINYBAR = 1e10;

    ISupraSValueFeed public immutable oracle;

    struct RevisionRecord {
        bytes32 commitment;
        bytes32 previousRevisionHash;
        bytes32 recordHash;
        address issuer;
        uint64 revision;
        uint64 validUntil;
        uint64 recordedAt;
        uint256 usdCents;
        uint256 hbarWeiEstimate;
        uint256 tinybarEstimate;
        uint256 oracleRound;
        uint256 oracleDecimals;
        uint256 oracleTime;
        uint256 oraclePrice;
    }

    struct OracleSnapshot {
        uint256 round;
        uint256 decimals;
        uint256 rawTime;
        uint256 timestampSeconds;
        uint256 price;
    }

    mapping(bytes32 quoteId => address issuer) public quoteIssuer;
    mapping(bytes32 quoteId => uint64 revision) public latestRevision;
    mapping(bytes32 quoteId => bytes32 recordHash) public latestRevisionHash;
    mapping(bytes32 quoteId => mapping(uint64 revision => RevisionRecord record)) private records;

    event RevisionRecorded(
        bytes32 indexed quoteId,
        uint64 indexed revision,
        address indexed issuer,
        bytes32 previousRevisionHash,
        bytes32 commitment,
        uint256 usdCents,
        uint64 validUntil,
        bytes32 recordHash
    );

    error InvalidOracle();
    error InvalidQuoteId();
    error InvalidCommitment();
    error InvalidUsdAmount();
    error QuoteExpired();
    error UnauthorizedIssuer();
    error InvalidRevision(uint64 expected, uint64 received);
    error DuplicateRevision();
    error InvalidPreviousRevisionHash();
    error OraclePriceIsZero();
    error OracleTimeIsZero();
    error OracleTimeInFuture();
    error StaleOraclePrice();
    error UnsupportedOracleDecimals();
    error OraclePriceTooLarge();

    constructor(address oracleAddress) {
        if (oracleAddress == address(0)) revert InvalidOracle();
        if (block.chainid == 296 && oracleAddress != SUPRA_HEDERA_TESTNET) revert InvalidOracle();
        oracle = ISupraSValueFeed(oracleAddress);
    }

    function recordRevision(
        bytes32 quoteId,
        uint64 revision,
        bytes32 previousRevisionHash,
        bytes32 commitment,
        uint256 usdCents,
        uint64 validUntil
    ) external returns (bytes32 recordHash) {
        _validateRevision(quoteId, revision, previousRevisionHash, commitment, usdCents, validUntil);

        OracleSnapshot memory snapshot = _readOracle();
        (uint256 tinybarEstimate, uint256 hbarWeiEstimate) = _convertUsdCents(usdCents, snapshot);

        bytes32 quoteDataHash = keccak256(
            abi.encode(quoteId, revision, previousRevisionHash, commitment, msg.sender, validUntil, usdCents)
        );
        bytes32 valuationHash = keccak256(
            abi.encode(
                hbarWeiEstimate,
                tinybarEstimate,
                snapshot.round,
                snapshot.decimals,
                snapshot.rawTime,
                snapshot.price
            )
        );
        recordHash = keccak256(abi.encode(block.chainid, address(this), quoteDataHash, valuationHash));

        records[quoteId][revision] = RevisionRecord({
            commitment: commitment,
            previousRevisionHash: previousRevisionHash,
            recordHash: recordHash,
            issuer: msg.sender,
            revision: revision,
            validUntil: validUntil,
            recordedAt: uint64(block.timestamp),
            usdCents: usdCents,
            hbarWeiEstimate: hbarWeiEstimate,
            tinybarEstimate: tinybarEstimate,
            oracleRound: snapshot.round,
            oracleDecimals: snapshot.decimals,
            oracleTime: snapshot.rawTime,
            oraclePrice: snapshot.price
        });

        if (quoteIssuer[quoteId] == address(0)) quoteIssuer[quoteId] = msg.sender;
        latestRevision[quoteId] = revision;
        latestRevisionHash[quoteId] = recordHash;

        emit RevisionRecorded(
            quoteId,
            revision,
            msg.sender,
            previousRevisionHash,
            commitment,
            usdCents,
            validUntil,
            recordHash
        );
    }

    function preview(
        uint256 usdCents
    ) external view returns (OracleSnapshot memory snapshot, uint256 tinybar, uint256 hbarWei) {
        if (usdCents == 0) revert InvalidUsdAmount();
        snapshot = _readOracle();
        (tinybar, hbarWei) = _convertUsdCents(usdCents, snapshot);
    }

    function getRevision(bytes32 quoteId, uint64 revision) external view returns (RevisionRecord memory) {
        return records[quoteId][revision];
    }

    function normalizeOracleTime(uint256 rawTime) public pure returns (uint256) {
        if (rawTime == 0) revert OracleTimeIsZero();
        // Supra Hedera has been observed returning Unix milliseconds. Values below
        // 1e11 are treated as Unix seconds so the adapter rejects other units as stale/future.
        return rawTime >= 1e11 ? rawTime / 1000 : rawTime;
    }

    function _validateRevision(
        bytes32 quoteId,
        uint64 revision,
        bytes32 previousRevisionHash,
        bytes32 commitment,
        uint256 usdCents,
        uint64 validUntil
    ) private view {
        if (quoteId == bytes32(0)) revert InvalidQuoteId();
        if (commitment == bytes32(0)) revert InvalidCommitment();
        if (usdCents == 0) revert InvalidUsdAmount();
        if (validUntil <= block.timestamp) revert QuoteExpired();
        if (records[quoteId][revision].recordHash != bytes32(0)) revert DuplicateRevision();

        address issuer = quoteIssuer[quoteId];
        uint64 expectedRevision = latestRevision[quoteId] + 1;
        if (issuer != address(0) && issuer != msg.sender) revert UnauthorizedIssuer();
        if (revision != expectedRevision) revert InvalidRevision(expectedRevision, revision);

        bytes32 expectedPreviousHash = latestRevisionHash[quoteId];
        if (previousRevisionHash != expectedPreviousHash) revert InvalidPreviousRevisionHash();
    }

    function _readOracle() private view returns (OracleSnapshot memory snapshot) {
        ISupraSValueFeed.PriceFeed memory value = oracle.getSvalue(HBAR_USD_PAIR_ID);
        if (value.price == 0) revert OraclePriceIsZero();
        if (value.decimals > MAX_ORACLE_DECIMALS) revert UnsupportedOracleDecimals();

        uint256 timestampSeconds = normalizeOracleTime(value.time);
        if (timestampSeconds > block.timestamp + MAX_FUTURE_SKEW) revert OracleTimeInFuture();
        if (timestampSeconds + MAX_ORACLE_AGE < block.timestamp) revert StaleOraclePrice();
        if (value.price > type(uint256).max / 100) revert OraclePriceTooLarge();

        snapshot = OracleSnapshot({
            round: value.round,
            decimals: value.decimals,
            rawTime: value.time,
            timestampSeconds: timestampSeconds,
            price: value.price
        });
    }

    function _convertUsdCents(
        uint256 usdCents,
        OracleSnapshot memory snapshot
    ) private pure returns (uint256 tinybarEstimate, uint256 hbarWeiEstimate) {
        uint256 priceScale = 10 ** snapshot.decimals;
        uint256 numeratorScale = priceScale * TINYBAR_PER_HBAR;
        uint256 denominator = snapshot.price * 100;
        tinybarEstimate = Math.mulDiv(usdCents, numeratorScale, denominator, Math.Rounding.Ceil);
        hbarWeiEstimate = tinybarEstimate * EVM_WEI_PER_TINYBAR;
    }
}
