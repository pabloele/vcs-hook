/**
 * Deploy MerkleAccessHook to Base Sepolia via CREATE2 so the hook address has
 * the required permission bits set (BEFORE_SWAP_FLAG = bit 7 of the lower 14
 * bits of the address).
 *
 * Usage:
 *   npx hardhat run scripts/deploy-merkle.ts --network baseSepolia
 *
 * Required env vars (via hardhat config variables):
 *   BASE_SEPOLIA_RPC_URL
 *   BASE_SEPOLIA_PRIVATE_KEY
 *
 * Optional env vars:
 *   ATTESTER_ADDRESS   — defaults to deployer address
 *   REQUIRED_TYPES     — comma-separated, defaults to "Age18Plus,ArgentinaResident"
 */

import { network } from "hardhat";
import { ethers } from "ethers";

const { ethers: hre } = await network.connect();

// ── Configuration ──────────────────────────────────────────────────────────

const POOL_MANAGER_ADDRESS = "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408";

const HOOK_FLAGS = 0x80n;   // BEFORE_SWAP_FLAG
const HOOK_MASK  = 0x3fffn; // lower 14 bits

const CREATE2_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

// ── Helpers ─────────────────────────────────────────────────────────────────

function computeCreate2Address(deployer: string, salt: string, initCodeHash: string): string {
  const data = ethers.solidityPacked(
    ["bytes1", "address", "bytes32", "bytes32"],
    ["0xff", deployer, salt, initCodeHash]
  );
  return "0x" + ethers.keccak256(data).slice(26);
}

function mineSalt(
  deployerAddress: string,
  initCodeHash: string,
  targetBits: bigint,
  mask: bigint
): { salt: string; address: string } {
  for (let i = 0x1000000n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = computeCreate2Address(deployerAddress, salt, initCodeHash);
    if ((BigInt(addr) & mask) === targetBits) {
      return { salt, address: addr };
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const [deployer] = await hre.getSigners();
const deployerAddress = await deployer.getAddress();

const attesterAddress = (process.env.ATTESTER_ADDRESS ?? deployerAddress) as string;
const requiredTypes   = (process.env.REQUIRED_TYPES ?? "Age18Plus,ArgentinaResident")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

console.log("Deployer:       ", deployerAddress);
console.log("Balance:        ", ethers.formatEther(await hre.provider.getBalance(deployer)), "ETH");
console.log("Attester:       ", attesterAddress);
console.log("Required types: ", requiredTypes);

const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "address", "bytes32", "string[]"],
  [POOL_MANAGER_ADDRESS, attesterAddress, ethers.ZeroHash, requiredTypes]
);

const hookFactory = await hre.getContractFactory("MerkleAccessHook");
const initCode     = (hookFactory.bytecode as string) + constructorArgs.slice(2);
const initCodeHash = ethers.keccak256(initCode);

console.log("\nMining CREATE2 salt (target bits: 0x80 in lower 14 bits)...");
const { salt, address: hookAddress } = mineSalt(CREATE2_FACTORY, initCodeHash, HOOK_FLAGS, HOOK_MASK);
console.log("Salt found:     ", salt);
console.log("Hook address:   ", hookAddress);
console.log("Address bits:    0x" + (BigInt(hookAddress) & HOOK_MASK).toString(16), "== 0x80 ✓");

const rawCalldata = ethers.concat([salt, initCode]);
const tx = await deployer.sendTransaction({ to: CREATE2_FACTORY, data: rawCalldata, gasLimit: 5_000_000n });
const receipt = await tx.wait();

console.log("\nDeployed in tx: ", receipt!.hash);
console.log("MerkleAccessHook:", hookAddress);
console.log("\nNext steps:");
console.log("  1. Copy HOOK_ADDRESS=" + hookAddress + " to service/.env");
console.log("  2. Fund the attester wallet with Base Sepolia ETH");
console.log("  3. Start the tree-builder service: cd service && npm run dev");
console.log("  4. Initialize a Uniswap v4 pool with hooks =", hookAddress);
