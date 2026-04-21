/**
 * create-pool — Initialize a Uniswap v4 pool with VCAccessHook
 *
 * The PositionManager exposes initializePool() which wraps PoolManager.initialize.
 * Pool key requires currency0 < currency1 (sorted by address).
 *
 * Usage:
 *   npx hardhat run scripts/create-pool.ts --network baseSepolia
 *
 * Known addresses (Base Sepolia):
 *   PoolManager:     0x498581fF718922c3f8e6A244956aF099B2652b2b
 *   PositionManager: 0x7C5f5A4bBd8fD63184577525326123B519429bDc
 */

import * as readline from "readline";
import { network } from "hardhat";

const { ethers } = await network.connect();

const POOL_MANAGER = "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408";
const POSITION_MANAGER = "0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80";

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("\n=== Create Uniswap v4 Pool with VCAccessHook ===\n");
console.log(`PoolManager:     ${POOL_MANAGER}`);
console.log(`PositionManager: ${POSITION_MANAGER}\n`);

const tokenA = (await prompt(rl, "Token A address: ")).trim();
const tokenB = (await prompt(rl, "Token B address: ")).trim();
const hookAddress = (await prompt(rl, "VCAccessHook address: ")).trim();
const feeInput = (await prompt(rl, "Fee tier (500 / 3000 / 10000) [default 3000]: ")).trim();
const initialPriceInput = (
  await prompt(rl, "Initial price token0/token1 as decimal (e.g. 1 for 1:1) [default 1]: ")
).trim();

rl.close();

// Sort tokens
const [currency0, currency1] =
  tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

const fee = feeInput ? parseInt(feeInput) : 3000;
const tickSpacing = fee === 500 ? 10 : fee === 3000 ? 60 : 200;

// Compute sqrtPriceX96 from decimal price
const price = initialPriceInput ? parseFloat(initialPriceInput) : 1.0;
const sqrtPrice = Math.sqrt(price);
const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * 2 ** 96));

const poolKey = {
  currency0,
  currency1,
  fee,
  tickSpacing,
  hooks: hookAddress,
};

console.log("\nPool key:");
console.log(`  currency0:   ${currency0}`);
console.log(`  currency1:   ${currency1}`);
console.log(`  fee:         ${fee}`);
console.log(`  tickSpacing: ${tickSpacing}`);
console.log(`  hooks:       ${hookAddress}`);
console.log(`  sqrtPriceX96: ${sqrtPriceX96}`);

const [signer] = await ethers.getSigners();
console.log(`\nSigner: ${signer.address}`);

const positionManager = await ethers.getContractAt(
  ["function initializePool((address,address,uint24,int24,address) key, uint160 sqrtPriceX96) payable returns (int24)"],
  POSITION_MANAGER
);

console.log("\nInitializing pool...");
const tx = await positionManager.initializePool(
  [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
  sqrtPriceX96,
  { gasLimit: 1_000_000n }
);
console.log(`Tx sent: ${tx.hash}`);
const receipt = await tx.wait();
console.log("Pool initialized.");
console.log(`\nSave these values for the next scripts:`);
console.log(`  currency0:   ${currency0}`);
console.log(`  currency1:   ${currency1}`);
console.log(`  fee:         ${fee}`);
console.log(`  tickSpacing: ${tickSpacing}`);
console.log(`  hooks:       ${hookAddress}`);
