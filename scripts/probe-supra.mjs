const rpcUrl = process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api";
const oracle = "0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917";
const pairId = 432;
const calldata = "0x89b94ea2" + pairId.toString(16).padStart(64, "0");

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error)
    throw new Error(`RPC ${body.error.code}: ${body.error.message}`);
  return body.result;
}

const chainHex = await rpc("eth_chainId", []);
const result = await rpc("eth_call", [
  { to: oracle, data: calldata },
  "latest",
]);
if (Number(BigInt(chainHex)) !== 296)
  throw new Error(`Expected chain 296, received ${chainHex}`);
if (typeof result !== "string" || result.length !== 2 + 64 * 4)
  throw new Error("Unexpected getSvalue response length");

const words = result
  .slice(2)
  .match(/.{64}/g)
  .map((word) => BigInt(`0x${word}`));
const [round, decimals, rawTime, price] = words;
const timestampSeconds =
  rawTime >= 100_000_000_000n ? rawTime / 1000n : rawTime;
const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
const ageSeconds = nowSeconds > timestampSeconds ? nowSeconds - timestampSeconds : 0n;
const futureSkewSeconds = timestampSeconds > nowSeconds ? timestampSeconds - nowSeconds : 0n;
if (price === 0n) throw new Error("Oracle price is zero");
if (decimals > 36n) throw new Error(`Unsupported decimals ${decimals}`);
if (timestampSeconds > nowSeconds + 30n)
  throw new Error("Oracle timestamp is in the future");
if (ageSeconds > 7200n)
  throw new Error(`Oracle price is stale by ${ageSeconds} seconds`);

console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      rpcUrl,
      chainId: 296,
      signedTransaction: false,
      oracle,
      pairId,
      round: round.toString(),
      decimals: decimals.toString(),
      rawTime: rawTime.toString(),
      timestampUnit: rawTime >= 100_000_000_000n ? "milliseconds" : "seconds",
      timestamp: new Date(Number(timestampSeconds) * 1000).toISOString(),
      ageSeconds: ageSeconds.toString(),
      futureSkewSeconds: futureSkewSeconds.toString(),
      price: price.toString(),
      displayPriceUsdPerHbar: `${price / 10n ** decimals}.${
        (price % 10n ** decimals)
          .toString()
          .padStart(Number(decimals), "0")
          .replace(/0+$/, "") || "0"
      }`,
      status: "PASS",
    },
    null,
    2,
  ),
);
