# vcs-hook — Uniswap v4 Hook with EAS Access Control

A Uniswap v4 hook in Solidity that restricts access to a liquidity pool by verifying that `msg.sender` holds a valid, non-revoked EAS attestation on Base Sepolia.

The hook acts as on-chain access control: only wallets with a verifiable credential issued off-chain (VCS) and anchored on-chain (EAS) can operate on the pool.

## Stack

- Solidity ^0.8.24
- Hardhat 3 + TypeScript
- Mocha + ethers.js (tests)
- Target network: Base Sepolia

## Contracts

| Contract | Description |
|---|---|
| `contracts/VCAccessHook.sol` | Main hook — inherits `BaseHook`, implements `beforeSwap` |
| `contracts/interfaces/IEAS.sol` | Minimal EAS interface + `Attestation` struct |
| `contracts/test/MockEAS.sol` | EAS mock for unit tests |
| `contracts/test/TestVCAccessHook.sol` | Test wrapper that skips address-bit validation |

## Deployed Addresses (Base Sepolia)

| Contract | Address |
|---|---|
| EAS | `0x4200000000000000000000000000000000000021` |
| Schema Registry | `0x4200000000000000000000000000000000000020` |
| PoolManager (Uniswap v4) | `0x498581fF718922c3f8e6A244956aF099B2652b2b` |

**Schema UID (AlephDoorAccess):**
`0xd7471474fdba6e0f59a1e83cb88256ce75e975c3c9e644cf18bf00330351db7f`

Schema: `string credentialId, address ethAddress, uint64 validUntil`

## Setup

```shell
cp .env.example .env
# Fill in your RPC URL and private key
npm install
```

## Tests

```shell
npm test
# or selectively:
npx hardhat test mocha
npx hardhat test solidity
```

Tests use mocks for `IEAS` and `IPoolManager` — no network fork required.

## Deploy to Base Sepolia

The hook must be deployed at an address with the `BEFORE_SWAP_FLAG` bit (bit 7) set in the lower 14 bits. The deploy script mines a valid CREATE2 salt automatically.

```shell
npx hardhat run scripts/deploy.ts --network baseSepolia
```

Requires `BASE_SEPOLIA_RPC_URL` and `BASE_SEPOLIA_PRIVATE_KEY` in `.env`.

## Access Flow

1. The VCS backend issues an `AlephDoorAccess` credential and creates an EAS attestation on-chain.
2. The attester calls `setAttestationUID(holder, uid)` on the hook to register the wallet's credential.
3. When the wallet attempts a swap, the hook queries EAS and verifies:
   - The attestation exists (UID is registered)
   - The schema matches
   - `revocationTime == 0` (not revoked)
   - `expirationTime == 0 || expirationTime > block.timestamp`
4. If any check fails → `revert NotAuthorized(address)`.

## Hook Configuration Variables

```solidity
address public immutable eas;           // EAS contract address
bytes32 public immutable schemaUID;     // schema UID set at deploy time
address public attester;                // address allowed to register UIDs
mapping(address => bytes32) public attestationUID;
```
