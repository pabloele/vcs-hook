import { expect } from "chai";
import { network } from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

const { ethers } = await network.connect();

const [, attester, poolManagerSigner, swapper, stranger] =
  await ethers.getSigners();

// Credential types required to swap — must match what's configured in the contract
const REQUIRED_TYPES = ["Age18Plus", "ArgentinaResident"];

const ZERO_POOL_KEY = {
  currency0: ethers.ZeroAddress,
  currency1: ethers.ZeroAddress,
  fee: 0,
  tickSpacing: 1,
  hooks: ethers.ZeroAddress,
};

const ZERO_SWAP_PARAMS = {
  zeroForOne: true,
  amountSpecified: 1n,
  sqrtPriceLimitX96: 0n,
};

// ── Merkle tree helpers ───────────────────────────────────────────────────────

// Builds a tree containing all (address, credentialType) pairs for the given holders.
// Each holder is assumed to have ALL required types.
function buildTree(holders: string[]): StandardMerkleTree<[string, string]> {
  const entries: [string, string][] = holders.flatMap((addr) =>
    REQUIRED_TYPES.map((t) => [addr, t] as [string, string])
  );
  return StandardMerkleTree.of(entries, ["address", "string"]);
}

// Returns the multi-proof for all required types of a given address.
function getProof(tree: StandardMerkleTree<[string, string]>, addr: string) {
  // Collect indices for all (addr, type) leaves in REQUIRED_TYPES order
  const indices: number[] = [];
  for (const type of REQUIRED_TYPES) {
    for (const [i, [a, t]] of tree.entries()) {
      if (a.toLowerCase() === addr.toLowerCase() && t === type) {
        indices.push(i);
        break;
      }
    }
  }
  return tree.getMultiProof(indices);
}

function encodeHookData(
  user: string,
  proof: { proof: string[]; proofFlags: boolean[] }
) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "bytes32[]", "bool[]"],
    [user, proof.proof, proof.proofFlags]
  );
}

// ── Deploy ────────────────────────────────────────────────────────────────────

async function deploy(holders: string[] = []) {
  const tree = holders.length > 0 ? buildTree(holders) : null;
  const hook = (await ethers.deployContract("TestMerkleAccessHook", [
    poolManagerSigner.address,
    attester.address,
    tree ? tree.root : ethers.ZeroHash,
    REQUIRED_TYPES,
  ])) as any;
  return { hook, tree: tree! };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MerkleAccessHook", () => {
  it("1. permite el swap cuando el holder tiene todas las credenciales requeridas", async () => {
    const { hook, tree } = await deploy([swapper.address]);
    const proof = getProof(tree, swapper.address);
    const hookData = encodeHookData(swapper.address, proof);

    await expect(
      hook
        .connect(poolManagerSigner)
        .beforeSwap(swapper.address, ZERO_POOL_KEY, ZERO_SWAP_PARAMS, hookData)
    ).to.not.revert(ethers);
  });

  it("2. revierte cuando el holder no está en el árbol", async () => {
    const { hook } = await deploy([swapper.address]);
    // stranger no está en el árbol — generamos una proof inválida vacía
    const hookData = encodeHookData(stranger.address, { proof: [], proofFlags: [] });

    await expect(
      hook
        .connect(poolManagerSigner)
        .beforeSwap(stranger.address, ZERO_POOL_KEY, ZERO_SWAP_PARAMS, hookData)
    )
      .to.be.revertedWithCustomError(hook, "NotAuthorized")
      .withArgs(stranger.address);
  });

  it("3. revierte cuando hookData está vacío", async () => {
    const { hook } = await deploy([swapper.address]);

    await expect(
      hook
        .connect(poolManagerSigner)
        .beforeSwap(swapper.address, ZERO_POOL_KEY, ZERO_SWAP_PARAMS, "0x")
    ).to.be.revertedWithCustomError(hook, "InvalidHookData");
  });

  it("4. revierte cuando la proof corresponde a un root viejo (post-revocación)", async () => {
    const { hook, tree } = await deploy([swapper.address]);
    const oldProof = getProof(tree, swapper.address);

    // Attester revoca a swapper: reconstruye árbol sin él y actualiza el root
    const newTree = buildTree([stranger.address]);
    await hook.connect(attester).setMerkleRoot(newTree.root);

    // La proof vieja ya no es válida contra el nuevo root
    const hookData = encodeHookData(swapper.address, oldProof);
    await expect(
      hook
        .connect(poolManagerSigner)
        .beforeSwap(swapper.address, ZERO_POOL_KEY, ZERO_SWAP_PARAMS, hookData)
    )
      .to.be.revertedWithCustomError(hook, "NotAuthorized")
      .withArgs(swapper.address);
  });

  it("5. permite el swap con address(0) en hookData (usa sender como user)", async () => {
    const { hook, tree } = await deploy([swapper.address]);
    const proof = getProof(tree, swapper.address);
    // Pasar address(0) como user → el hook usa sender
    const hookData = encodeHookData(ethers.ZeroAddress, proof);

    await expect(
      hook
        .connect(poolManagerSigner)
        .beforeSwap(swapper.address, ZERO_POOL_KEY, ZERO_SWAP_PARAMS, hookData)
    ).to.not.revert(ethers);
  });

  it("6. solo el attester puede llamar setMerkleRoot", async () => {
    const { hook } = await deploy();
    const newRoot = ethers.hexlify(ethers.randomBytes(32));

    await expect(
      hook.connect(stranger).setMerkleRoot(newRoot)
    ).to.be.revertedWithCustomError(hook, "OnlyAttester");

    await expect(
      hook.connect(attester).setMerkleRoot(newRoot)
    ).to.not.revert(ethers);
  });

  it("7. múltiples holders en el árbol — cada uno puede swapear con su propia proof", async () => {
    const holders = [swapper.address, stranger.address];
    const { hook, tree } = await deploy(holders);

    for (const holder of holders) {
      const proof = getProof(tree, holder);
      const hookData = encodeHookData(holder, proof);

      await expect(
        hook
          .connect(poolManagerSigner)
          .beforeSwap(holder, ZERO_POOL_KEY, ZERO_SWAP_PARAMS, hookData)
      ).to.not.revert(ethers);
    }
  });

  it("8. emite MerkleRootUpdated al actualizar el root", async () => {
    const { hook } = await deploy();
    const newRoot = ethers.hexlify(ethers.randomBytes(32));

    await expect(hook.connect(attester).setMerkleRoot(newRoot))
      .to.emit(hook, "MerkleRootUpdated")
      .withArgs(ethers.ZeroHash, newRoot);
  });
});
