# vcs-hook — Uniswap v4 Hook with Verifiable Credential Access Control

A Uniswap v4 hook that restricts access to a liquidity pool to wallets that hold verifiable credentials issued by a trusted authority. The access list is maintained as an off-chain Merkle tree whose root is anchored on-chain; swappers present a Merkle proof in every swap transaction.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [How Each Piece Works](#how-each-piece-works)
   - [MerkleAccessHook (Solidity)](#merkleaccesshook-solidity)
   - [Merkle Tree Service (Node.js)](#merkle-tree-service-nodejs)
   - [VCS / vc-rest (Go)](#vcs--vc-rest-go)
3. [End-to-End Flow](#end-to-end-flow)
4. [Step-by-Step: Deploy and Test](#step-by-step-deploy-and-test)
   - [Prerequisites](#prerequisites)
   - [1 — Clone and install](#1--clone-and-install)
   - [2 — Deploy the hook](#2--deploy-the-hook)
   - [3 — Configure and start the merkle service](#3--configure-and-start-the-merkle-service)
   - [4 — Deploy test tokens](#4--deploy-test-tokens)
   - [5 — Create the pool](#5--create-the-pool)
   - [6 — Add liquidity](#6--add-liquidity)
   - [7 — Issue a verifiable credential](#7--issue-a-verifiable-credential)
   - [8 — Swap (authorized)](#8--swap-authorized)
   - [9 — Revoke the credential and verify the swap fails](#9--revoke-the-credential-and-verify-the-swap-fails)
5. [Auditing the System](#auditing-the-system)
6. [Known Addresses (Base Sepolia)](#known-addresses-base-sepolia)
7. [Scripts Reference](#scripts-reference)
8. [Service API Reference](#service-api-reference)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Off-chain                                    │
│                                                                      │
│   VCS / vc-rest ──► admin-service ──► merkle-tree-service            │
│   (credential issuer)  (orchestrator)  (tree builder + attester)     │
│                                              │                       │
│                                              │ setMerkleRoot(root)   │
└──────────────────────────────────────────────┼───────────────────────┘
                                               │
                               ┌───────────────▼──────────────────┐
                               │           On-chain                │
                               │                                   │
                               │   MerkleAccessHook.merkleRoot     │
                               │          (bytes32)                │
                               │               │                   │
                               │        beforeSwap()               │
                               │    verifies multiProof            │
                               │               │                   │
                               │    Uniswap v4 PoolManager         │
                               └───────────────────────────────────┘
                                               ▲
                               ┌───────────────┴──────────────────┐
                               │           Swapper                 │
                               │                                   │
                               │  1. GET /proof?address=0x...      │
                               │  2. UniversalRouter.execute(      │
                               │       hookData=abi.encode(        │
                               │         user, proof, flags))      │
                               └───────────────────────────────────┘
```

**Data flow summary:**

1. An authority (VCS) issues a verifiable credential to a wallet address.
2. A webhook or admin call notifies the merkle-tree-service, which stores the `(address, credentialType)` pair in MongoDB and schedules a tree rebuild.
3. The service rebuilds the OpenZeppelin `StandardMerkleTree`, computes the new root, and calls `setMerkleRoot(root)` on the hook contract.
4. Before swapping, the swapper fetches their Merkle proof from the service's REST API.
5. The swapper encodes `(user, proof, proofFlags)` as `hookData` and submits the swap through UniversalRouter.
6. The `MerkleAccessHook.beforeSwap` callback verifies the multi-proof against the on-chain root. If it fails, the transaction reverts with `NotAuthorized`.

---

## How Each Piece Works

### MerkleAccessHook (Solidity)

**File:** `contracts/MerkleAccessHook.sol`

The hook extends Uniswap v4's `BaseHook` and registers only the `beforeSwap` permission. On every swap attempt it:

1. Decodes `hookData` as `(address user, bytes32[] proof, bool[] proofFlags)`.
2. Builds the leaf set from `requiredTypes`: for each type, the leaf is:
   ```
   keccak256(bytes.concat(keccak256(abi.encode(user, credentialType))))
   ```
   This is the OpenZeppelin `StandardMerkleTree` double-hash convention, required for compatibility with the off-chain tree builder.
3. Sorts the leaves ascending before passing them to `MerkleProof.multiProofVerify`. OpenZeppelin's multi-proof algorithm requires leaves in sorted-hash order, matching the order returned by `tree.getMultiProof()` on the JS side.
4. Validates the proof structure (`proofFlags.length == proof.length + n - 1`) and calls `MerkleProof.multiProofVerify`. Any failure reverts with `NotAuthorized(user)`.

**Key state variables:**

| Variable | Type | Description |
|---|---|---|
| `attester` | `address` | Only this address can call `setMerkleRoot` |
| `merkleRoot` | `bytes32` | Current root of the authorized-addresses tree |
| `requiredTypes` | `string[]` | Credential types a swapper must hold (set at deploy, immutable) |

**Hook flag:** `0x80` (bit 7 of the lower 14 address bits) = `BEFORE_SWAP_FLAG`. The deploy script mines a CREATE2 salt until the resulting address has this bit set, satisfying Uniswap v4's address-bit validation.

**Revocation:** When the merkle-tree-service removes a holder and calls `setMerkleRoot` with the new root (or `bytes32(0)` if no holders remain), any previously issued proof becomes invalid — the on-chain verification fails even if the swapper presents the old proof.

---

### Merkle Tree Service (Node.js)

**Directory:** `service/`

A small Express.js service that:

- Stores `(hookAddress, address, credentialType, credentialId)` records in MongoDB.
- On add/remove, schedules a debounced tree rebuild (default: 60 s window to batch multiple changes).
- Rebuilds an OpenZeppelin `StandardMerkleTree` over `[address, credentialType]` leaves.
- Calls `setMerkleRoot(root)` on the hook contract via the attester wallet.
- Serves Merkle proofs on demand via REST API.

**Startup sequence (`index.ts`):**
1. `connectDb()` — connect to MongoDB, ensure indexes.
2. `initChain()` — connect to RPC, load each hook contract, call `getRequiredTypes()` to know what leaf fields to index.
3. `restoreTree()` — reload existing holders from MongoDB and rebuild the in-memory tree (so the service can serve proofs without waiting for the first add).
4. Start Express on `PORT`.

**Batching (`batch.ts`):**
Each `add` or `remove` call triggers `scheduleDefault(hook)`, which sets a timer for `DEFAULT_WINDOW_MS` (default 60 s). If another change arrives within the window, the existing timer is reused (debounce). When the timer fires, `rebuildAndUpdate(hook)` runs: it reads all holders from MongoDB, builds the tree, and sends the `setMerkleRoot` transaction.

Call `POST /:hook/flush` to force an immediate rebuild without waiting for the window.

**Empty tree:** If the last holder is removed, `rebuildAndUpdate` calls `setMerkleRoot(bytes32(0))`, invalidating all proofs. No valid multi-proof can be constructed against a zero root.

---

### VCS / vc-rest (Go)

**Repository:** separate `VCS` repo (TrustBloc vc-rest fork)

Handles the full W3C Verifiable Credential lifecycle:

- DID resolution (did:ethr on Base Sepolia)
- Credential issuance via OIDC4VCI
- Credential status management (StatusList2021 revocation)

The VCS server does **not** communicate directly with the merkle service. That bridge is handled by a webhook or admin call that posts to `POST /:hook/holders/add` or `POST /:hook/holders/remove` on the merkle service.

**In this deployment:** the admin-service (Go, in the `VCS` repo) is the orchestrator that calls the merkle service when credentials are issued or revoked.

---

## End-to-End Flow

### Happy path (authorized swap)

```
User               VCS/Admin          Merkle Service        Hook (on-chain)
 │                    │                     │                     │
 │── request VC ─────►│                     │                     │
 │◄── credential ─────│                     │                     │
 │                    │─── POST /add ───────►│                     │
 │                    │                     │── setMerkleRoot ────►│
 │                    │                     │   (new root)         │
 │── GET /proof ───────────────────────────►│                     │
 │◄── {proof,[]} ──────────────────────────│                     │
 │── UniversalRouter.execute(hookData) ────────────────────────►  │
 │                                                        beforeSwap()
 │                                                     verifies proof ✓
 │◄── swap succeeds ───────────────────────────────────────────────│
```

### Revocation path (swap blocked)

```
Admin              Merkle Service        Hook (on-chain)
 │                     │                     │
 │── POST /remove ─────►│                     │
 │                     │── setMerkleRoot(0) ─►│
 │                     │                     │
User                   │                     │
 │── GET /proof ───────►│                     │
 │◄── 404 ─────────────│                     │
 │   (swap aborted client-side)              │
 │                                           │
 │   (if proof constructed manually)         │
 │── UniversalRouter.execute(hookData) ─────►│
 │                                   beforeSwap()
 │                               multiProofVerify fails ✗
 │◄── revert NotAuthorized ──────────────────│
```

---

## Step-by-Step: Deploy and Test

### Prerequisites

- Node.js 22 LTS (Hardhat requires even-numbered LTS)
- MongoDB running locally or accessible
- A funded wallet on Base Sepolia ([faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet))
- An Infura or Alchemy Base Sepolia RPC URL

### 1 — Clone and install

```bash
git clone https://github.com/pabloele/vcs-hook.git
cd vcs-hook
npm install
cd service && npm install && cd ..
```

Copy and fill environment files:

```bash
# Hardhat scripts (root .env)
cp .env.example .env
# BASE_SEPOLIA_PRIVATE_KEY=0x<deployer-key>
# BASE_SEPOLIA_RPC_URL=https://...

# Merkle service (service/.env)
cp service/.env.example service/.env
# RPC_URL=https://sepolia.base.org
# HOOK_ADDRESSES=0x<hook-address>          # fill after step 2
# ATTESTER_PRIVATE_KEY=0x<deployer-key>    # same wallet used to deploy
# MONGO_URI=mongodb://localhost:27017
# MONGO_DB=vcsvcs_db
# DEFAULT_WINDOW_MS=60000
```

### 2 — Deploy the hook

The hook address must have bit 7 set in its lower 14 bits (Uniswap v4's `BEFORE_SWAP_FLAG`). The deploy script mines a valid CREATE2 salt automatically — this takes a few seconds.

```bash
ATTESTER_ADDRESS=<deployer-address> \
REQUIRED_TYPES="AlephDoorAccess" \
npx hardhat run scripts/deploy-merkle.ts --network baseSepolia
```

`REQUIRED_TYPES` is a comma-separated list of credential type strings that a swapper must hold. Use exactly the same strings that the credential issuer puts in the `credentialType` field.

**Output:**
```
Hook address:    0x0a0d9c8e9f1f938d7f3fba98ed4de85d65670080
Address bits:    0x80 == 0x80 ✓
Deployed in tx:  0x86a2...
```

Copy the hook address into `service/.env` → `HOOK_ADDRESSES`.

### 3 — Configure and start the merkle service

```bash
cd service
npm run dev       # development (tsx watch)
# or
npm run build && npm start   # production
```

On startup it connects to MongoDB and RPC, reads `getRequiredTypes()` from the hook, and restores any existing tree from the database.

**Verify it's running:**
```bash
curl http://localhost:3100/hooks
# {"hooks":["0x0a0d9c8e..."]}
```

### 4 — Deploy test tokens

If you don't have ERC-20 tokens on Base Sepolia, deploy two:

```bash
npx hardhat run scripts/deploy-tokens.ts --network baseSepolia
```

Save both addresses — `currency0` must be the lexicographically lower address.

### 5 — Create the pool

```bash
npx hardhat run scripts/create-pool.ts --network baseSepolia
```

When prompted:
- `Token A` / `Token B` — your two token addresses (order doesn't matter, script sorts them)
- `VCAccessHook address` — the hook address from step 2
- `Fee tier` — `3000` (0.3%, most common)
- `Initial price` — `1` for a 1:1 starting price

**What happens on-chain:** `PositionManager.initializePool(poolKey, sqrtPriceX96)` — creates the pool in the PoolManager with sqrtPriceX96 = 2^96 (price = 1).

### 6 — Add liquidity

The swapper needs tokens in the pool to swap against. The liquidity provider can be any wallet.

```bash
npx hardhat run scripts/add-liquidity.ts --network baseSepolia
```

When prompted:
- `currency0` / `currency1` — from step 5 output (sorted order)
- `VCAccessHook address` — hook address
- `fee` — `3000`
- `tick lower` / `tick upper` — press Enter for full range (`-887220` / `887220`)
- `amount0` / `amount1` — e.g. `1000` each

The script handles: ERC-20 approve → Permit2 → PositionManager.modifyLiquidities with `MINT_POSITION + SETTLE_PAIR` actions.

### 7 — Issue a verifiable credential

This step is handled by your VCS deployment. The issuer creates a credential with `credentialType = "AlephDoorAccess"` (or whatever you configured in `REQUIRED_TYPES`) for the swapper's wallet address, and then notifies the merkle service:

```bash
curl -X POST http://localhost:3100/<hook-address>/holders/add \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0x<swapper-wallet>",
    "credentialType": "AlephDoorAccess",
    "credentialId": "urn:uuid:<credential-uuid>"
  }'
```

The service schedules a tree rebuild. After `DEFAULT_WINDOW_MS` (or force it with `POST /:hook/flush`), it calls `setMerkleRoot(newRoot)` on-chain.

**Verify the proof is available:**
```bash
curl "http://localhost:3100/<hook-address>/proof?address=0x<swapper>"
# {"proof":[],"proofFlags":[]}   ← single-leaf tree: empty proof is correct
```

An empty `proof` with empty `proofFlags` is valid for a single-leaf tree — the leaf itself is the root.

### 8 — Swap (authorized)

The swapper must have some `currency0` tokens. Transfer some from the deployer if needed.

**Interactive script:**
```bash
# Set the swapper's private key
BASE_SEPOLIA_PRIVATE_KEY=0x<swapper-key> \
npx hardhat run scripts/swap.ts --network baseSepolia
```

**Non-interactive script (all params via env):**
```bash
BASE_SEPOLIA_PRIVATE_KEY=0x<swapper-key> \
CURRENCY0=0x<token0> \
CURRENCY1=0x<token1> \
HOOK=0x<hook> \
AMOUNT_IN=1 \
MERKLE_SERVICE_URL=http://localhost:3100 \
npx hardhat run scripts/swap-env.ts --network baseSepolia
```

**Expected output:**
```
Fetching merkle proof from http://localhost:3100...
Proof: []
Flags: []
Executing swap...
Tx sent: 0xab16ba...
Status: SUCCESS ✓
Gas used: 179249
Received: 0.9969... VCT1
```

The swap fee (0.3%) is captured by the liquidity provider. The hook does not charge a fee.

### 9 — Revoke the credential and verify the swap fails

**Remove the holder from the merkle tree:**
```bash
# By credentialId (preferred — matches one specific credential):
curl -X POST "http://localhost:3100/<hook-address>/holders/remove" \
  -H "Content-Type: application/json" \
  -d '{"credentialId": "urn:uuid:<uuid>"}'

# Or by wallet address (removes all credentials for that address):
curl -X POST "http://localhost:3100/<hook-address>/holders/remove-by-address" \
  -H "Content-Type: application/json" \
  -d '{"address": "0x<swapper>"}'
```

Wait for the batch window (or `POST /:hook/flush`). The service calls `setMerkleRoot(bytes32(0))` on-chain.

**Verify the proof is gone:**
```bash
curl "http://localhost:3100/<hook-address>/proof?address=0x<swapper>"
# HTTP 404: {"error":"no proof available for this address"}
```

**Attempt the swap — it must fail:**
```bash
BASE_SEPOLIA_PRIVATE_KEY=0x<swapper-key> \
CURRENCY0=0x<token0> \
CURRENCY1=0x<token1> \
HOOK=0x<hook> \
AMOUNT_IN=1 \
npx hardhat run scripts/swap-env.ts --network baseSepolia
```

**Expected output:**
```
Fetching merkle proof from http://localhost:3100...
ERROR: merkle proof fetch failed (404): {"error":"no proof available for this address"}
```

The script aborts before submitting any transaction. If someone were to construct a proof manually using the old tree and submit it on-chain, the `beforeSwap` hook would reject it because `merkleRoot` is now `bytes32(0)` and `multiProofVerify` returns `false` — the transaction reverts with `NotAuthorized`.

---

## Auditing the System

### Verify the hook address is legitimate

A valid `MerkleAccessHook` address must have bit 7 set in the lower 14 bits:

```bash
node -e "console.log((BigInt('0x<hook-address>') & 0x3fffn).toString(16))"
# Must be 0x80 (or any value with bit 7 set, e.g. 0x80, 0x81, ..., 0xff)
```

### Read the required credential types on-chain

```solidity
MerkleAccessHook hook = MerkleAccessHook(0x<hook>);
string[] memory types = hook.getRequiredTypes();
// e.g. ["AlephDoorAccess"]
```

Or via cast:
```bash
cast call 0x<hook> "getRequiredTypes()(string[])" --rpc-url https://sepolia.base.org
```

### Read the current Merkle root

```bash
cast call 0x<hook> "merkleRoot()(bytes32)" --rpc-url https://sepolia.base.org
```

A value of `0x000...000` means no holders are authorized. Any non-zero value is the root of the current authorized-addresses tree.

### Track root updates

Every call to `setMerkleRoot` emits:
```solidity
event MerkleRootUpdated(bytes32 indexed oldRoot, bytes32 indexed newRoot);
```

Query the event log to see the full history:
```bash
cast logs \
  --address 0x<hook> \
  --from-block 0 \
  "MerkleRootUpdated(bytes32,bytes32)" \
  --rpc-url https://sepolia.base.org
```

Or filter on Basescan: open the contract → Events tab → filter by `MerkleRootUpdated`.

### Verify a proof independently

Given a root, an address, and a credential type you can verify the proof without trusting the service:

```js
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { MerkleProof } from "ethers";

// Reconstruct the leaf (must match the contract's double-hash)
const leaf = ethers.keccak256(
  ethers.solidityPacked(
    ["bytes32"],
    [ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "string"],
      ["0x<swapper>", "AlephDoorAccess"]
    ))]
  )
);

// Verify against the on-chain root
const valid = MerkleProof.verify(proof, onChainRoot, leaf);
```

For multi-proof verification (multiple credential types):
```js
const valid = MerkleProof.multiProofVerify(proof, proofFlags, root, sortedLeaves);
```

### Confirm who can update the root

```bash
cast call 0x<hook> "attester()(address)" --rpc-url https://sepolia.base.org
```

Only the `attester` address can call `setMerkleRoot`. Verify this is the merkle-tree-service's wallet and not an EOA under adversarial control.

### Check the current holder list

```bash
curl https://<your-service>/merkle/<hook-address>/holders
```

Returns the live MongoDB state. Cross-reference with the on-chain Merkle root by rebuilding the tree locally from the returned list and comparing roots.

### Rebuild the tree locally and compare roots

```js
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

// Fetch current holders
const { holders } = await fetch("https://<service>/merkle/<hook>/holders").then(r => r.json());

// Rebuild tree in the same format the service uses
const entries = holders.map(h => [h.address, h.credentialType]);
const tree = StandardMerkleTree.of(entries, ["address", "string"]);

console.log("Local root:    ", tree.root);

// Compare with on-chain root
const onChainRoot = await provider.call({
  to: hookAddress,
  data: "0x" + ethers.id("merkleRoot()").slice(2, 10)
});
console.log("On-chain root: ", onChainRoot);
console.log("Match:", tree.root.toLowerCase() === onChainRoot.slice(26).toLowerCase());
```

---

## Known Addresses (Base Sepolia)

| Contract | Address |
|---|---|
| PoolManager | `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408` |
| PositionManager | `0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80` |
| UniversalRouter | `0x492e6456d9528771018deb9e87ef7750ef184104` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| CREATE2 Factory | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |
| MerkleAccessHook (deployed) | `0x0a0d9c8e9f1f938d7f3fba98ed4de85d65670080` |
| USDCT (test token) | `0x277c155b8BbA4A2DaD6B5ac192B82061A9008d8F` |
| VCT1 (test token) | `0x3E3D479aaaA06E4dC3DF8a051Af5dF77cC5Fe530` |

---

## Scripts Reference

All scripts run with `npx hardhat run scripts/<name>.ts --network baseSepolia`.

| Script | Description |
|---|---|
| `deploy-merkle.ts` | Deploy `MerkleAccessHook` via CREATE2, mine salt for correct address bits |
| `deploy-tokens.ts` | Deploy two test ERC-20 tokens |
| `create-pool.ts` | Initialize a Uniswap v4 pool with the hook |
| `add-liquidity.ts` | Add full-range liquidity via PositionManager |
| `swap.ts` | Interactive swap via UniversalRouter (prompts for all params) |
| `swap-env.ts` | Non-interactive swap — all params via environment variables |
| `register-uid.ts` | (legacy EAS flow) Register an EAS attestation UID in the hook |
| `revoke-uid.ts` | (legacy EAS flow) Remove a UID from the hook |

**Environment variables for `swap-env.ts`:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `CURRENCY0` | yes | — | Lower token address |
| `CURRENCY1` | yes | — | Higher token address |
| `HOOK` | yes | — | Hook address |
| `FEE` | no | `3000` | Pool fee tier |
| `ZERO_FOR_ONE` | no | `true` | `"false"` to swap token1→token0 |
| `AMOUNT_IN` | no | `0.01` | Input amount in token units |
| `AMOUNT_OUT_MIN` | no | `0` | Minimum output amount |
| `MERKLE_SERVICE_URL` | no | `http://localhost:3100` | Base URL of the merkle service |

---

## Service API Reference

Base URL: `http://localhost:3100` (or your deployed URL)

### `GET /hooks`
Returns the list of configured hook addresses.

```json
{"hooks": ["0x0a0d9c8e..."]}
```

### `GET /:hook/holders`
Lists all authorized holders for a hook.

```json
{
  "holders": [
    {
      "hookAddress": "0x0a0d9c8e...",
      "address": "0x87495d92...",
      "credentialType": "AlephDoorAccess",
      "credentialId": "urn:uuid:ee941cf8-..."
    }
  ]
}
```

### `POST /:hook/holders/add`
Add a holder. Schedules a tree rebuild.

```json
{
  "address": "0x87495d92...",
  "credentialType": "AlephDoorAccess",
  "credentialId": "urn:uuid:ee941cf8-..."
}
```

### `POST /:hook/holders/remove`
Remove a holder by credential ID. Schedules a tree rebuild.

```json
{"credentialId": "urn:uuid:ee941cf8-..."}
```

### `POST /:hook/holders/remove-by-address`
Remove all credentials for a given address. Schedules a tree rebuild.

```json
{"address": "0x87495d92..."}
```

### `POST /:hook/flush?in=N`
Force a tree rebuild immediately (`in=0` or omit) or after `N` seconds.

### `GET /:hook/proof?address=0x...`
Returns the Merkle proof for a given address.

- **200** with `{"proof": [...], "proofFlags": [...]}` if authorized
- **404** with `{"error": "no proof available for this address"}` if not in the tree

For a single-leaf tree (one holder), `proof` and `proofFlags` are both `[]`. This is valid — an empty proof means the leaf is the root.
