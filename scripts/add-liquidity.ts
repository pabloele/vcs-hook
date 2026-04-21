/**
 * add-liquidity — Mint a position (add liquidity) to a VCAccessHook pool
 *
 * Uses PositionManager.modifyLiquidities with MINT_POSITION + SETTLE_PAIR actions.
 * Requires ERC-20 approvals to Permit2, and Permit2 allowances to PositionManager.
 *
 * Usage:
 *   npx hardhat run scripts/add-liquidity.ts --network baseSepolia
 *
 * Known addresses (Base Sepolia):
 *   PositionManager: 0x7C5f5A4bBd8fD63184577525326123B519429bDc
 *   Permit2:         0x000000000022D473030F116dDEE9F6B43aC78BA3
 */

import * as readline from "readline";
import { network } from "hardhat";

const { ethers } = await network.connect();

const POSITION_MANAGER = "0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Actions from @uniswap/v4-periphery/src/libraries/Actions.sol
const Actions = {
  MINT_POSITION: 0x02,
  SETTLE_PAIR: 0x0d,
};

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("\n=== Add Liquidity to VCAccessHook Pool ===\n");
console.log(`PositionManager: ${POSITION_MANAGER}`);
console.log(`Permit2:         ${PERMIT2}\n`);

const currency0 = (await prompt(rl, "currency0 address (lower address): ")).trim();
const currency1 = (await prompt(rl, "currency1 address (higher address): ")).trim();
const hookAddress = (await prompt(rl, "VCAccessHook address: ")).trim();
const feeInput = (await prompt(rl, "Fee tier used at pool creation [default 3000]: ")).trim();
const tickLowerInput = (await prompt(rl, "Tick lower [default -887220]: ")).trim();
const tickUpperInput = (await prompt(rl, "Tick upper [default 887220]: ")).trim();
const amount0Input = (await prompt(rl, "Max amount of token0 to deposit (in token units, e.g. 1): ")).trim();
const amount1Input = (await prompt(rl, "Max amount of token1 to deposit (in token units, e.g. 1): ")).trim();

rl.close();

const fee = feeInput ? parseInt(feeInput) : 3000;
const tickSpacing = fee === 500 ? 10 : fee === 3000 ? 60 : 200;
const tickLower = tickLowerInput ? parseInt(tickLowerInput) : -887220;
const tickUpper = tickUpperInput ? parseInt(tickUpperInput) : 887220;

const [signer] = await ethers.getSigners();
console.log(`\nSigner: ${signer.address}`);

const erc20Abi = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const permit2Abi = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];

// Get token decimals and compute amounts
const token0 = await ethers.getContractAt(erc20Abi, currency0);
const token1 = await ethers.getContractAt(erc20Abi, currency1);
const decimals0 = await token0.decimals();
const decimals1 = await token1.decimals();

const amount0Max = ethers.parseUnits(amount0Input || "1", decimals0);
const amount1Max = ethers.parseUnits(amount1Input || "1", decimals1);

// Approximate liquidity from amounts (use the smaller side)
// For a full-range position, liquidity ≈ sqrt(amount0 * amount1)
const liquidity = BigInt(Math.floor(Math.sqrt(Number(amount0Max) * Number(amount1Max))));

console.log(`\nAmount0 max: ${ethers.formatUnits(amount0Max, decimals0)} (${amount0Max} raw)`);
console.log(`Amount1 max: ${ethers.formatUnits(amount1Max, decimals1)} (${amount1Max} raw)`);
console.log(`Liquidity:   ${liquidity}`);

// Step 1: Approve tokens to Permit2
const permit2 = await ethers.getContractAt(permit2Abi, PERMIT2);
const MAX_UINT256 = ethers.MaxUint256;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

console.log("\nApproving token0 → Permit2...");
const approveTx0 = await token0.approve(PERMIT2, MAX_UINT256, { gasLimit: 100_000n });
await approveTx0.wait();

console.log("Approving token1 → Permit2...");
const approveTx1 = await token1.approve(PERMIT2, MAX_UINT256, { gasLimit: 100_000n });
await approveTx1.wait();

console.log("Setting Permit2 allowance for token0 → PositionManager...");
const permit2Tx0 = await permit2.approve(currency0, POSITION_MANAGER, MAX_UINT160, MAX_UINT48, { gasLimit: 100_000n });
await permit2Tx0.wait();

console.log("Setting Permit2 allowance for token1 → PositionManager...");
const permit2Tx1 = await permit2.approve(currency1, POSITION_MANAGER, MAX_UINT160, MAX_UINT48, { gasLimit: 100_000n });
await permit2Tx1.wait();

// Step 2: Encode MINT_POSITION + SETTLE_PAIR actions
const poolKey = [currency0, currency1, fee, tickSpacing, hookAddress];

// actions: packed bytes of action ids
const actions = ethers.solidityPacked(
  ["uint8", "uint8"],
  [Actions.MINT_POSITION, Actions.SETTLE_PAIR]
);

// MINT_POSITION params: (PoolKey poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity,
//                        uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData)
const mintParams = ethers.AbiCoder.defaultAbiCoder().encode(
  ["(address,address,uint24,int24,address)", "int24", "int24", "uint256", "uint128", "uint128", "address", "bytes"],
  [poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, signer.address, "0x"]
);

// SETTLE_PAIR params: (Currency currency0, Currency currency1)
const settleParams = ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "address"],
  [currency0, currency1]
);

const unlockData = ethers.AbiCoder.defaultAbiCoder().encode(
  ["bytes", "bytes[]"],
  [actions, [mintParams, settleParams]]
);

const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

const positionManager = await ethers.getContractAt(
  ["function modifyLiquidities(bytes calldata unlockData, uint256 deadline) payable"],
  POSITION_MANAGER
);

console.log("\nMinting position...");
const tx = await positionManager.modifyLiquidities(unlockData, deadline, { gasLimit: 2_000_000n });
console.log(`Tx sent: ${tx.hash}`);
await tx.wait();
console.log("Liquidity added. Position minted.");
