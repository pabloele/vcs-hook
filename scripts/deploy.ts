/**
 * Deploy VCAccessHook to Base Sepolia via CREATE2 so the hook address has
 * the required permission bits set (BEFORE_SWAP_FLAG = bit 7 of the lower 14
 * bits of the address).
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network baseSepolia
 *
 * Required env vars (via hardhat config variables):
 *   BASE_SEPOLIA_RPC_URL
 *   BASE_SEPOLIA_PRIVATE_KEY
 */

import { network } from "hardhat";
import { ContractFactory, ethers } from "ethers";

const { ethers: hre } = await network.connect();

// ── Configuration ──────────────────────────────────────────────────────────

const EAS_ADDRESS = "0x4200000000000000000000000000000000000021";
const SCHEMA_UID =
  "0xd7471474fdba6e0f59a1e83cb88256ce75e975c3c9e644cf18bf00330351db7f";
const POOL_MANAGER_ADDRESS = "0x498581fF718922c3f8e6A244956aF099B2652b2b";

// Only BEFORE_SWAP_FLAG (bit 7) must be set; all other hook bits must be 0.
// ALL_HOOK_MASK = (1 << 14) - 1 = 0x3FFF
const HOOK_FLAGS = 0x80n; // BEFORE_SWAP_FLAG
const HOOK_MASK = 0x3fffn; // lower 14 bits

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute a CREATE2 address locally without any RPC call.
 */
function computeCreate2Address(
  deployer: string,
  salt: string,
  initCodeHash: string
): string {
  const data = ethers.solidityPacked(
    ["bytes1", "address", "bytes32", "bytes32"],
    ["0xff", deployer, salt, initCodeHash]
  );
  return "0x" + ethers.keccak256(data).slice(26);
}

/**
 * Mine a salt such that CREATE2(deployer, salt, initCodeHash) has the correct
 * hook permission bits encoded in the address.
 */
function mineSalt(
  deployerAddress: string,
  initCodeHash: string,
  targetBits: bigint,
  mask: bigint
): { salt: string; address: string } {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = computeCreate2Address(deployerAddress, salt, initCodeHash);
    if ((BigInt(addr) & mask) === targetBits) {
      return { salt, address: addr };
    }
  }
}

// ── Canonical CREATE2 factory (EIP-2470, deployed on most networks) ─────────

const CREATE2_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

const CREATE2_FACTORY_ABI = [
  "function deploy(uint256 value, bytes32 salt, bytes memory code) returns (address)",
];

// ── Main ─────────────────────────────────────────────────────────────────────

const [deployer] = await hre.getSigners();
console.log("Deployer:", await deployer.getAddress());
console.log(
  "Balance:",
  ethers.formatEther(await hre.provider.getBalance(deployer))
);

// Build init code = bytecode + constructor args
const hookFactory = await hre.getContractFactory("VCAccessHook");
const attesterAddress = await deployer.getAddress(); // set to your attester address
const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
  ["address", "address", "bytes32", "address"],
  [POOL_MANAGER_ADDRESS, EAS_ADDRESS, SCHEMA_UID, attesterAddress]
);
const initCode = (hookFactory.bytecode as string) + constructorArgs.slice(2);
const initCodeHash = ethers.keccak256(initCode);

console.log("\nMining CREATE2 salt (target bits: 0x80 in lower 14 bits)...");
const { salt, address: hookAddress } = mineSalt(
  CREATE2_FACTORY,
  initCodeHash,
  HOOK_FLAGS,
  HOOK_MASK
);
console.log("Salt found:", salt);
console.log("Hook address:", hookAddress);
console.log(
  "Address bits check:",
  "0x" + (BigInt(hookAddress) & HOOK_MASK).toString(16),
  "== 0x80 ✓"
);

// Deploy via canonical CREATE2 factory
const factory = new ethers.Contract(
  CREATE2_FACTORY,
  CREATE2_FACTORY_ABI,
  deployer
);
const tx = await factory.deploy(0, salt, initCode);
const receipt = await tx.wait();
console.log("\nDeployed in tx:", receipt.hash);
console.log("VCAccessHook:", hookAddress);
console.log("\nNext steps:");
console.log(
  "  - Call setAttestationUID(holder, uid) on the hook for each authorized wallet"
);
console.log("  - Initialize a Uniswap v4 pool with hooks =", hookAddress);
