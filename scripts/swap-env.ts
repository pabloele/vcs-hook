/**
 * swap-env — Execute a swap through a MerkleAccessHook pool via UniversalRouter
 *
 * All parameters are taken from environment variables (no interactive prompts).
 *
 * Usage:
 *   CURRENCY0=0x... CURRENCY1=0x... HOOK=0x... npx hardhat run scripts/swap-env.ts --network baseSepolia
 *
 * Required env vars:
 *   CURRENCY0       — lower token address
 *   CURRENCY1       — higher token address
 *   HOOK            — MerkleAccessHook address
 *
 * Optional env vars:
 *   FEE             — fee tier (default: 3000)
 *   ZERO_FOR_ONE    — "false" to swap token1→token0 (default: true)
 *   AMOUNT_IN       — amount in token units (default: 0.01)
 *   AMOUNT_OUT_MIN  — minimum out in token units (default: 0)
 *   MERKLE_SERVICE_URL — merkle service URL (default: http://localhost:3100)
 */

import { network } from "hardhat";

const { ethers } = await network.connect();

const UNIVERSAL_ROUTER = "0x492e6456d9528771018deb9e87ef7750ef184104";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const V4_SWAP = 0x10;
const Actions = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x0f,
};

const currency0 = process.env.CURRENCY0!;
const currency1 = process.env.CURRENCY1!;
const hookAddress = process.env.HOOK!;
if (!currency0 || !currency1 || !hookAddress) {
  console.error("ERROR: CURRENCY0, CURRENCY1, and HOOK env vars are required");
  process.exit(1);
}

const fee = parseInt(process.env.FEE ?? "3000");
const tickSpacing = fee === 500 ? 10 : fee === 3000 ? 60 : 200;
const zeroForOne = process.env.ZERO_FOR_ONE !== "false";
const tokenIn  = zeroForOne ? currency0 : currency1;
const tokenOut = zeroForOne ? currency1 : currency0;

const [signer] = await ethers.getSigners();
console.log(`\n=== Swap via MerkleAccessHook Pool ===`);
console.log(`Signer:          ${signer.address}`);
console.log(`UniversalRouter: ${UNIVERSAL_ROUTER}`);
console.log(`Pool:            ${currency0} / ${currency1} fee=${fee}`);
console.log(`Hook:            ${hookAddress}`);
console.log(`Direction:       ${zeroForOne ? "token0→token1" : "token1→token0"}\n`);

const erc20Abi = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
];
const permit2Abi = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];

const tokenInContract  = await ethers.getContractAt(erc20Abi, tokenIn);
const tokenOutContract = await ethers.getContractAt(erc20Abi, tokenOut);
const decimalsIn  = await tokenInContract.decimals();
const decimalsOut = await tokenOutContract.decimals();
const symIn  = await tokenInContract.symbol();
const symOut = await tokenOutContract.symbol();

const amountIn        = ethers.parseUnits(process.env.AMOUNT_IN ?? "0.01", decimalsIn);
const amountOutMinimum = ethers.parseUnits(process.env.AMOUNT_OUT_MIN ?? "0", decimalsOut);

console.log(`Token in:  ${symIn} (${ethers.formatUnits(amountIn, decimalsIn)})`);
console.log(`Token out: ${symOut}`);

// Approve tokenIn → Permit2
const permit2 = await ethers.getContractAt(permit2Abi, PERMIT2);
const MAX_UINT256 = ethers.MaxUint256;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48  = (1n << 48n) - 1n;

const balanceIn = await tokenInContract.balanceOf(signer.address);
console.log(`Balance of ${symIn}: ${ethers.formatUnits(balanceIn, decimalsIn)}`);
if (balanceIn < amountIn) {
  console.error(`ERROR: Insufficient balance`);
  process.exit(1);
}

console.log("\nApproving tokenIn → Permit2...");
const approveTx = await tokenInContract.approve(PERMIT2, MAX_UINT256, { gasLimit: 100_000n });
await approveTx.wait();

console.log("Setting Permit2 allowance → UniversalRouter...");
const permit2Tx = await permit2.approve(tokenIn, UNIVERSAL_ROUTER, MAX_UINT160, MAX_UINT48, { gasLimit: 100_000n });
await permit2Tx.wait();

// Fetch Merkle proof
const merkleServiceUrl = process.env.MERKLE_SERVICE_URL ?? "http://localhost:3100";
console.log(`\nFetching merkle proof from ${merkleServiceUrl}...`);
const proofRes = await fetch(`${merkleServiceUrl}/${hookAddress.toLowerCase()}/proof?address=${signer.address}`);
if (!proofRes.ok) {
  const body = await proofRes.text();
  console.error(`ERROR: merkle proof fetch failed (${proofRes.status}): ${body}`);
  process.exit(1);
}
const { proof: merkleProof, proofFlags: merkleProofFlags } = await proofRes.json() as { proof: string[]; proofFlags: boolean[] };
console.log(`Proof: ${JSON.stringify(merkleProof)}`);
console.log(`Flags: ${JSON.stringify(merkleProofFlags)}`);

// MerkleAccessHook hookData: abi.encode(bytes32[] proof, bool[] proofFlags)
// The contract identifies the swapper via tx.origin — no need to pass the address.
const hookData = ethers.AbiCoder.defaultAbiCoder().encode(
  ["bytes32[]", "bool[]"],
  [merkleProof, merkleProofFlags]
);

const poolKey = [currency0, currency1, fee, tickSpacing, hookAddress];

const swapParams = ethers.AbiCoder.defaultAbiCoder().encode(
  ["((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"],
  [[poolKey, zeroForOne, amountIn, amountOutMinimum, hookData]]
);
const settleParams = ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "uint256"],
  [tokenIn, amountIn]
);
const takeParams = ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "uint256"],
  [tokenOut, amountOutMinimum]
);

const v4Actions = ethers.solidityPacked(
  ["uint8", "uint8", "uint8"],
  [Actions.SWAP_EXACT_IN_SINGLE, Actions.SETTLE_ALL, Actions.TAKE_ALL]
);
const v4Input = ethers.AbiCoder.defaultAbiCoder().encode(
  ["bytes", "bytes[]"],
  [v4Actions, [swapParams, settleParams, takeParams]]
);

const universalRouter = await ethers.getContractAt(
  ["function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) payable"],
  UNIVERSAL_ROUTER
);

const commands = ethers.solidityPacked(["uint8"], [V4_SWAP]);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

const balanceBefore = await tokenOutContract.balanceOf(signer.address);

console.log("\nExecuting swap...");
const tx = await universalRouter.execute(commands, [v4Input], deadline, { gasLimit: 500_000n });
console.log(`Tx sent: ${tx.hash}`);
const receipt = await tx.wait();
console.log(`Status: ${receipt?.status === 1 ? "SUCCESS ✓" : "FAILED ✗"}`);
console.log(`Gas used: ${receipt?.gasUsed}`);

const balanceAfter = await tokenOutContract.balanceOf(signer.address);
const received = balanceAfter - balanceBefore;
console.log(`\nReceived: ${ethers.formatUnits(received, decimalsOut)} ${symOut}`);
