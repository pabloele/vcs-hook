import { ethers } from "ethers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { config } from "./config.js";
import { holders } from "./db.js";

const ABI = [
  "function setMerkleRoot(bytes32 _root) external",
  "function getRequiredTypes() external view returns (string[])",
];

let _provider: ethers.JsonRpcProvider;
let _hook: ethers.Contract;
let _requiredTypes: string[];

// Last built tree — kept in memory to serve proofs without rebuilding
let _tree: StandardMerkleTree<[string, string]> | null = null;

export async function initChain(): Promise<void> {
  _provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const signer = new ethers.Wallet(config.attesterKey, _provider);
  _hook = new ethers.Contract(config.hookAddress, ABI, signer);
  _requiredTypes = await _hook.getRequiredTypes();
  console.log("Required credential types:", _requiredTypes);
}

// Rebuilds the in-memory tree from MongoDB without touching the chain.
// Called on startup so proofs are available immediately after a restart.
export async function restoreTree(): Promise<void> {
  const docs = await holders().find({}).toArray();
  if (docs.length === 0) return;
  const entries = docs.map((d) => [d.address, d.credentialType] as [string, string]);
  _tree = StandardMerkleTree.of(entries, ["address", "string"]);
  console.log(`Tree restored from DB: ${docs.length} entries, root=${_tree.root}`);
}

export async function rebuildAndUpdate(): Promise<void> {
  const docs = await holders().find({}).toArray();

  if (docs.length === 0) {
    console.log("No holders — skipping tree update");
    return;
  }

  const entries = docs.map((d) => [d.address, d.credentialType] as [string, string]);
  const tree = StandardMerkleTree.of(entries, ["address", "string"]);

  console.log(`Rebuilding tree: ${docs.length} entries, root=${tree.root}`);

  const tx = await _hook.setMerkleRoot(tree.root);
  await tx.wait();

  _tree = tree;
  console.log(`setMerkleRoot tx confirmed: ${tx.hash}`);
}

export function getProof(address: string): { proof: string[]; proofFlags: boolean[] } | null {
  if (!_tree || !_requiredTypes?.length) return null;

  const indices: number[] = [];
  for (const type of _requiredTypes) {
    for (const [i, [addr, t]] of _tree.entries()) {
      if (addr.toLowerCase() === address.toLowerCase() && t === type) {
        indices.push(i);
        break;
      }
    }
  }

  if (indices.length !== _requiredTypes.length) return null;

  const { proof, proofFlags } = _tree.getMultiProof(indices);
  return { proof, proofFlags };
}
