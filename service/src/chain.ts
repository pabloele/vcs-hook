import { ethers } from "ethers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { config } from "./config.js";
import { holders } from "./db.js";

const ABI = [
  "function setMerkleRoot(bytes32 _root) external",
  "function getRequiredTypes() external view returns (string[])",
];

interface HookState {
  contract:      ethers.Contract;
  requiredTypes: string[];
  tree:          StandardMerkleTree<[string, string]> | null;
}

const _hooks = new Map<string, HookState>();

export async function initChain(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const signer   = new ethers.Wallet(config.attesterKey, provider);

  for (const addr of config.hookAddresses) {
    const contract      = new ethers.Contract(addr, ABI, signer);
    const requiredTypes = await contract.getRequiredTypes() as string[];
    _hooks.set(addr.toLowerCase(), { contract, requiredTypes, tree: null });
    console.log(`Hook ${addr} — required types: ${requiredTypes.join(", ")}`);
  }
}

export async function restoreTree(hookAddress: string): Promise<void> {
  const hook = _getHook(hookAddress);
  const docs = await holders().find({ hookAddress: hookAddress.toLowerCase() }).toArray();
  if (docs.length === 0) return;
  const entries = docs.map((d) => [d.address, d.credentialType] as [string, string]);
  hook.tree = StandardMerkleTree.of(entries, ["address", "string"]);
  console.log(`Hook ${hookAddress}: tree restored (${docs.length} entries, root=${hook.tree.root})`);
}

export async function rebuildAndUpdate(hookAddress: string): Promise<void> {
  const hook = _getHook(hookAddress);
  const docs = await holders().find({ hookAddress: hookAddress.toLowerCase() }).toArray();

  if (docs.length === 0) {
    console.log(`Hook ${hookAddress}: no holders — clearing tree and zeroing root`);
    const tx = await hook.contract.setMerkleRoot(ethers.ZeroHash, { gasLimit: 100_000n });
    await tx.wait();
    hook.tree = null;
    console.log(`Hook ${hookAddress}: root zeroed (${tx.hash})`);
    return;
  }

  const entries = docs.map((d) => [d.address, d.credentialType] as [string, string]);
  const tree    = StandardMerkleTree.of(entries, ["address", "string"]);

  console.log(`Hook ${hookAddress}: rebuilding tree (${docs.length} entries, root=${tree.root})`);

  const tx = await hook.contract.setMerkleRoot(tree.root, { gasLimit: 100_000n });
  await tx.wait();
  hook.tree = tree;

  console.log(`Hook ${hookAddress}: setMerkleRoot confirmed (${tx.hash})`);
}

export function getProof(
  hookAddress: string,
  address: string
): { proof: string[]; proofFlags: boolean[] } | null {
  const hook = _getHook(hookAddress);
  if (!hook.tree) return null;

  const indices: number[] = [];
  for (const type of hook.requiredTypes) {
    for (const [i, [addr, t]] of hook.tree.entries()) {
      if (addr.toLowerCase() === address.toLowerCase() && t === type) {
        indices.push(i);
        break;
      }
    }
  }

  if (indices.length !== hook.requiredTypes.length) return null;

  const { proof, proofFlags } = hook.tree.getMultiProof(indices);
  return { proof, proofFlags };
}

export function knownHooks(): string[] {
  return [..._hooks.keys()];
}

function _getHook(hookAddress: string): HookState {
  const hook = _hooks.get(hookAddress.toLowerCase());
  if (!hook) throw new Error(`Unknown hook: ${hookAddress}`);
  return hook;
}
