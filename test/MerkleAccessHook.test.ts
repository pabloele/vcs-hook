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

function buildTree(holders: string[]): StandardMerkleTree<[string, string]> {
  const entries: [string, string][] = holders.flatMap((addr) =>
    REQUIRED_TYPES.map((t) => [addr, t] as [string, string])
  );
  return StandardMerkleTree.of(entries, ["address", "string"]);
}

function getProof(tree: StandardMerkleTree<[string, string]>, addr: string) {
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

function encodeHookData(proof: { proof: string[]; proofFlags: boolean[] }) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32[]", "bool[]"],
    [proof.proof, proof.proofFlags]
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
    const hookData = encodeHookData(proof);

    await expect(
      hook
        .connect(swapper)
        .callBeforeSwap(swapper.address, ZERO_POOL_KEY, ZERO_SWAP_PARAMS, hookData)
    ).to.not.revert(ethers);
  });

  it("2. revierte cuando el holder no está en el árbol", async () => {
    const { hook } = await deploy([swapper.address]);
    const hookData = encodeHookData({ proof: [], proofFlags: [] });

    await expect(
      hook
        .connect(stranger)
        .callBeforeSwap(stranger.address, ZERO_POOL_KEY, ZERO_SWAP_PARAMS, hookData)
    )
      .to.be.revertedWithCustomError(hook, "NotAuthorized")
      .withArgs(stranger.address);
  });

  it("3. revierte cuando hookData está vacío", async () => {
    const { hook } = await deploy([swapper.address]);

    await expect(
      hook
        .connect(swapper)
        .callBeforeSwap(swapper.address, ZERO_POOL_KEY, ZERO_SWAP_PARAMS, "0x")
    ).to.be.revertedWithCustomError(hook, "InvalidHookData");
  });

  it("4. revierte cuando la proof corresponde a un root viejo (post-revocación)", async () => {
    const { hook, tree } = await deploy([swapper.address]);
    const oldProof = getProof(tree, swapper.address);

    const newTree = buildTree([stranger.address]);
    await hook.connect(attester).setMerkleRoot(newTree.root);

    const hookData = encodeHookData(oldProof);
    await expect(
      hook
        .connect(swapper)
        .callBeforeSwap(swapper.address, ZERO_POOL_KEY, ZERO_SWAP_PARAMS, hookData)
    )
      .to.be.revertedWithCustomError(hook, "NotAuthorized")
      .withArgs(swapper.address);
  });

  it("5. un atacante no puede usar la proof de otro holder", async () => {
    const { hook, tree } = await deploy([swapper.address]);
    // stranger obtiene la proof de swapper pero la presenta desde su propia wallet
    const swapperProof = getProof(tree, swapper.address);
    const hookData = encodeHookData(swapperProof);

    await expect(
      hook
        .connect(stranger)
        .callBeforeSwap(stranger.address, ZERO_POOL_KEY, ZERO_SWAP_PARAMS, hookData)
    )
      .to.be.revertedWithCustomError(hook, "NotAuthorized")
      .withArgs(stranger.address);
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

    for (const [signer, addr] of [[swapper, swapper.address], [stranger, stranger.address]] as const) {
      const proof = getProof(tree, addr);
      const hookData = encodeHookData(proof);

      await expect(
        hook
          .connect(signer)
          .callBeforeSwap(addr, ZERO_POOL_KEY, ZERO_SWAP_PARAMS, hookData)
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
