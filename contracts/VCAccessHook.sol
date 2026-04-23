// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
// Import v4-core types from the same vendored copy that BaseHook uses (via v4-periphery's
// remapping @uniswap/v4-core/ → lib/v4-core/) to avoid type-identity conflicts.
import {IHooks} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";
import {IEAS, Attestation} from "./interfaces/IEAS.sol";

/// @title VCAccessHook
/// @notice Uniswap v4 hook that restricts swap access to wallets with a valid EAS attestation
contract VCAccessHook is BaseHook {
    error NotAuthorized(address swapper);
    error OnlyAttester();

    /// @notice EAS contract address
    address public immutable eas;
    /// @notice Schema UID that attestations must match
    bytes32 public immutable schemaUID;
    /// @notice Address authorized to register attestation UIDs
    address public attester;
    /// @notice Maps a wallet address to its registered EAS attestation UID
    mapping(address => bytes32) public attestationUID;

    constructor(
        IPoolManager _poolManager,
        address _eas,
        bytes32 _schemaUID,
        address _attester
    ) BaseHook(_poolManager) {
        eas = _eas;
        schemaUID = _schemaUID;
        attester = _attester;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @notice Registers an EAS attestation UID for a holder; callable only by the attester
    function setAttestationUID(address holder, bytes32 uid) external {
        if (msg.sender != attester) revert OnlyAttester();
        attestationUID[holder] = uid;
    }

    function _beforeSwap(
        address sender,
        PoolKey calldata,
        SwapParams calldata,
        bytes calldata hookData
    ) internal override returns (bytes4, BeforeSwapDelta, uint24) {
        // If hookData contains a 20-byte address, use it as the real user (router case).
        // Otherwise fall back to sender (direct call).
        address user = hookData.length >= 20
            ? address(bytes20(hookData[:20]))
            : sender;

        bytes32 uid = attestationUID[user];
        if (uid == bytes32(0)) revert NotAuthorized(user);

        Attestation memory att = IEAS(eas).getAttestation(uid);

        if (att.schema != schemaUID) revert NotAuthorized(user);
        if (att.revocationTime != 0) revert NotAuthorized(user);
        if (att.expirationTime != 0 && att.expirationTime <= block.timestamp) revert NotAuthorized(user);

        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
}
