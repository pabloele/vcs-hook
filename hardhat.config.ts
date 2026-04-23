import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";
import "dotenv/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    ...(process.env.SEPOLIA_RPC_URL && process.env.SEPOLIA_PRIVATE_KEY
      ? {
          sepolia: {
            type: "http" as const,
            chainType: "l1" as const,
            url: process.env.SEPOLIA_RPC_URL,
            accounts: [process.env.SEPOLIA_PRIVATE_KEY],
          },
        }
      : {}),
    ...(process.env.BASE_SEPOLIA_RPC_URL && process.env.BASE_SEPOLIA_PRIVATE_KEY
      ? {
          baseSepolia: {
            type: "http" as const,
            chainType: "op" as const,
            url: process.env.BASE_SEPOLIA_RPC_URL,
            accounts: [process.env.BASE_SEPOLIA_PRIVATE_KEY],
          },
        }
      : {}),
  },
});
