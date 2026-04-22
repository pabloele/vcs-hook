/**
 * swap — Execute a swap through a MerkleAccessHook pool via UniversalRouter
 *
 * Uses UniversalRouter with V4_SWAP command, encoding an exactInputSingle.
 * The swapper wallet must have a credential in the Merkle tree maintained by
 * the vcs-hook merkle-tree-service (default: http://localhost:3100).
 *
 * Usage:
 *   npx hardhat run scripts/swap.ts --network baseSepolia
 *
 * Known addresses (Base Sepolia):
 *   UniversalRouter: 0x492e6456d9528771018deb9e87ef7750ef184104
 *   Permit2:         0x000000000022D473030F116dDEE9F6B43aC78BA3
 */

import * as readline from "readline";
import { network } from "hardhat";

const { ethers } = await network.connect();

const UNIVERSAL_ROUTER = "0x492e6456d9528771018deb9e87ef7750ef184104";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// UniversalRouter command: V4_SWAP = 0x10
const V4_SWAP = 0x10;

// V4Router Actions
const Actions = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x0f,
};

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("\n=== Swap via VCAccessHook Pool ===\n");
console.log(`UniversalRouter: ${UNIVERSAL_ROUTER}`);
console.log(`Permit2:         ${PERMIT2}\n`);
console.log("Note: your wallet must have a UID registered in the hook.\n");

const currency0 = (await prompt(rl, "currency0 address (lower address): ")).trim();
const currency1 = (await prompt(rl, "currency1 address (higher address): ")).trim();
const hookAddress = (await prompt(rl, "VCAccessHook address: ")).trim();
const feeInput = (await prompt(rl, "Fee tier [default 3000]: ")).trim();
const zeroForOneInput = (await prompt(rl, "Swap direction — token0 for token1? (y/n) [default y]: ")).trim();
const amountInput = (await prompt(rl, "Amount in (in token units, e.g. 0.01): ")).trim();
const minAmountOutInput = (await prompt(rl, "Minimum amount out (in token units, e.g. 0) [default 0]: ")).trim();

rl.close();

const fee = feeInput ? parseInt(feeInput) : 3000;
const tickSpacing = fee === 500 ? 10 : fee === 3000 ? 60 : 200;
const zeroForOne = zeroForOneInput.toLowerCase() !== "n";
const tokenIn = zeroForOne ? currency0 : currency1;
const tokenOut = zeroForOne ? currency1 : currency0;

const [signer] = await ethers.getSigners();
console.log(`\nSigner: ${signer.address}`);

const erc20Abi = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

const permit2Abi = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
];

const tokenInContract = await ethers.getContractAt(erc20Abi, tokenIn);
const tokenOutContract = await ethers.getContractAt(erc20Abi, tokenOut);
const decimalsIn = await tokenInContract.decimals();
const decimalsOut = await tokenOutContract.decimals();

const amountIn = ethers.parseUnits(amountInput || "0.01", decimalsIn);
const amountOutMinimum = ethers.parseUnits(minAmountOutInput || "0", decimalsOut);

console.log(`\nToken in:  ${tokenIn} (${ethers.formatUnits(amountIn, decimalsIn)} tokens)`);
console.log(`Token out: ${tokenOut}`);
console.log(`Min out:   ${ethers.formatUnits(amountOutMinimum, decimalsOut)}`);

// Approve tokenIn → Permit2
const permit2 = await ethers.getContractAt(permit2Abi, PERMIT2);
const MAX_UINT256 = ethers.MaxUint256;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;

console.log("\nApproving tokenIn → Permit2...");
const approveTx = await tokenInContract.approve(PERMIT2, MAX_UINT256);
const approveReceipt = await approveTx.wait();
console.log(`  ERC20 approve tx: ${approveReceipt!.hash} (status: ${approveReceipt!.status})`);

console.log("Setting Permit2 allowance → UniversalRouter...");
const permit2Tx = await permit2.approve(tokenIn, UNIVERSAL_ROUTER, MAX_UINT160, MAX_UINT48);
const permit2Receipt = await permit2Tx.wait();
console.log(`  Permit2 approve tx: ${permit2Receipt!.hash} (status: ${permit2Receipt!.status})`);

// Encode V4Router actions: SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL
const poolKey = [currency0, currency1, fee, tickSpacing, hookAddress];

// Fetch Merkle proof for the signer from the tree-service.
const merkleServiceUrl = process.env.MERKLE_SERVICE_URL ?? "http://localhost:3100";
const proofRes = await fetch(`${merkleServiceUrl}/${hookAddress.toLowerCase()}/proof?address=${signer.address}`);
if (!proofRes.ok) {
  const body = await proofRes.text();
  console.error(`ERROR: merkle proof fetch failed (${proofRes.status}): ${body}`);
  process.exit(1);
}
const { proof: merkleProof, proofFlags: merkleProofFlags } = await proofRes.json() as { proof: string[]; proofFlags: boolean[] };
console.log(`Merkle proof: ${JSON.stringify(merkleProof)}`);
console.log(`Proof flags:  ${JSON.stringify(merkleProofFlags)}`);

// MerkleAccessHook hookData: abi.encode(address user, bytes32[] proof, bool[] proofFlags)
// Pass address(0) to use msg.sender — but since we're going through the router,
// msg.sender is the router. Pass the actual signer address instead.
const hookData = ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "bytes32[]", "bool[]"],
  [signer.address, merkleProof, merkleProofFlags]
);

// SWAP_EXACT_IN_SINGLE params: (ExactInputSingleParams)
// struct ExactInputSingleParams { PoolKey poolKey; bool zeroForOne; uint128 amountIn;
//                                  uint128 amountOutMinimum; bytes hookData; }
const swapParams = ethers.AbiCoder.defaultAbiCoder().encode(
  ["((address,address,uint24,int24,address),bool,uint128,uint128,bytes)"],
  [[poolKey, zeroForOne, amountIn, amountOutMinimum, hookData]]
);

// SETTLE_ALL params: (Currency currency, uint256 maxAmount)
const settleParams = ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "uint256"],
  [tokenIn, amountIn]
);

// TAKE_ALL params: (Currency currency, uint256 minAmount)
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

// UniversalRouter.execute(bytes commands, bytes[] inputs, uint256 deadline)
const universalRouter = await ethers.getContractAt(
  ["function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) payable"],
  UNIVERSAL_ROUTER
);

const commands = ethers.solidityPacked(["uint8"], [V4_SWAP]);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

// Pre-flight checks
const balanceIn = await tokenInContract.balanceOf(signer.address);
console.log(`\nBalance of tokenIn: ${ethers.formatUnits(balanceIn, decimalsIn)}`);
if (balanceIn < amountIn) {
  console.error(`ERROR: Insufficient balance. Have ${ethers.formatUnits(balanceIn, decimalsIn)}, need ${ethers.formatUnits(amountIn, decimalsIn)}`);
  process.exit(1);
}

// Check Permit2 allowance for UniversalRouter
const permit2AllowanceAbi = [
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];
const permit2View = await ethers.getContractAt(permit2AllowanceAbi, PERMIT2);
const { amount: p2Amount, expiration: p2Expiry } = await permit2View.allowance(signer.address, tokenIn, UNIVERSAL_ROUTER);
console.log(`Permit2 allowance for router: ${p2Amount} (expiry: ${p2Expiry})`);
if (p2Amount < amountIn) {
  console.warn(`WARN: Permit2 allowance looks insufficient (${p2Amount} < ${amountIn}) — attempting swap anyway`);
}

const balanceBefore = await tokenOutContract.balanceOf(signer.address);

console.log("\nExecuting swap...");
const tx = await universalRouter.execute(commands, [v4Input], deadline);
console.log(`Tx sent: ${tx.hash}`);
await tx.wait();

const balanceAfter = await tokenOutContract.balanceOf(signer.address);
const received = balanceAfter - balanceBefore;
console.log(`Swap complete. Received: ${ethers.formatUnits(received, decimalsOut)} tokens`);
