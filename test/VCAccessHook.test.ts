import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

// Signers resolved at module level (true top-level await, outside any callback)
const [, attester, poolManagerSigner, swapper, stranger] =
  await ethers.getSigners();

// Schema UID configured at deploy time (matches the VCS EAS schema)
const SCHEMA_UID =
  "0xd7471474fdba6e0f59a1e83cb88256ce75e975c3c9e644cf18bf00330351db7f";

// Minimal PoolKey / SwapParams required by the hook signature (values are
// ignored by the access-control logic, so we use zero / placeholder values).
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

// ── Helpers ──────────────────────────────────────────────────────────────────

async function deploy() {
  const mockEAS = await ethers.deployContract("MockEAS") as any;
  const hook = await ethers.deployContract("TestVCAccessHook", [
    poolManagerSigner.address, // treated as the PoolManager
    await mockEAS.getAddress(),
    SCHEMA_UID,
    attester.address,
  ]) as any;
  return { mockEAS, hook };
}

function validAttestation(holderAddr: string, uid: string) {
  return {
    uid,
    schema: SCHEMA_UID,
    time: 1n,
    expirationTime: 0n, // no expiry
    revocationTime: 0n, // not revoked
    refUID: ethers.ZeroHash,
    recipient: holderAddr,
    attester: attester.address,
    revocable: true,
    data: "0x",
  };
}

async function callBeforeSwap(hook: any, senderAddr: string) {
  return hook
    .connect(poolManagerSigner)
    .beforeSwap(senderAddr, ZERO_POOL_KEY, ZERO_SWAP_PARAMS, "0x");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("VCAccessHook", () => {
  it("1. permite el swap cuando el holder tiene attestation válida", async () => {
    const { mockEAS, hook } = await deploy();
    const uid = ethers.hexlify(ethers.randomBytes(32));

    await hook.connect(attester).setAttestationUID(swapper.address, uid);
    await mockEAS.setAttestation(uid, validAttestation(swapper.address, uid));

    await expect(callBeforeSwap(hook, swapper.address)).to.not.revert(ethers);
  });

  it("2. revierte cuando no hay attestation registrada para el swapper", async () => {
    const { hook } = await deploy();
    // No setAttestationUID call — mapping returns bytes32(0)

    await expect(callBeforeSwap(hook, swapper.address))
      .to.be.revertedWithCustomError(hook, "NotAuthorized")
      .withArgs(swapper.address);
  });

  it("3. revierte cuando la attestation fue revocada", async () => {
    const { mockEAS, hook } = await deploy();
    const uid = ethers.hexlify(ethers.randomBytes(32));

    await hook.connect(attester).setAttestationUID(swapper.address, uid);
    await mockEAS.setAttestation(uid, {
      ...validAttestation(swapper.address, uid),
      revocationTime: 1n, // any non-zero value means revoked
    });

    await expect(callBeforeSwap(hook, swapper.address))
      .to.be.revertedWithCustomError(hook, "NotAuthorized")
      .withArgs(swapper.address);
  });

  it("4. revierte cuando la attestation ha expirado", async () => {
    const { mockEAS, hook } = await deploy();
    const uid = ethers.hexlify(ethers.randomBytes(32));

    await hook.connect(attester).setAttestationUID(swapper.address, uid);
    await mockEAS.setAttestation(uid, {
      ...validAttestation(swapper.address, uid),
      expirationTime: 1n, // timestamp 1 is always in the past
    });

    await expect(callBeforeSwap(hook, swapper.address))
      .to.be.revertedWithCustomError(hook, "NotAuthorized")
      .withArgs(swapper.address);
  });

  it("5. solo el attester puede llamar setAttestationUID", async () => {
    const { hook } = await deploy();
    const uid = ethers.hexlify(ethers.randomBytes(32));

    // Stranger cannot register UIDs
    await expect(
      hook.connect(stranger).setAttestationUID(swapper.address, uid)
    ).to.be.revertedWithCustomError(hook, "OnlyAttester");

    // Attester can register UIDs
    await expect(
      hook.connect(attester).setAttestationUID(swapper.address, uid)
    ).to.not.revert(ethers);
  });
});
