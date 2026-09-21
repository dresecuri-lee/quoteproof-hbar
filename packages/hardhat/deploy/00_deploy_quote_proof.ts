import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import { getDeployGasPrice } from "../utils/getDeployGasPrice";

const SUPRA_HEDERA_TESTNET = "0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917";

const deployQuoteProof: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  if (hre.network.config.chainId !== 296) {
    throw new Error("QuoteProof deployment is restricted to Hedera Testnet (chain 296)");
  }

  await deploy("QuoteProof", {
    from: deployer,
    args: [SUPRA_HEDERA_TESTNET],
    log: true,
    autoMine: true,
    gasLimit: "3000000",
    gasPrice: await getDeployGasPrice(hre),
  });
};

deployQuoteProof.tags = ["QuoteProof"];
export default deployQuoteProof;
