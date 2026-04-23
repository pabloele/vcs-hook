// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleAccessHook} from "../MerkleAccessHook.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta} from "@uniswap/v4-periphery/lib/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";

/// @notice Test wrapper that skips hook address validation so the contract can be
///         deployed to any address during unit tests (no CREATE2 mining required).
contract TestMerkleAccessHook is MerkleAccessHook {
    constructor(
        IPoolManager _poolManager,
        address _attester,
        bytes32 _merkleRoot,
        string[] memory _requiredTypes
    ) MerkleAccessHook(_poolManager, _attester, _merkleRoot, _requiredTypes) {}

    function validateHookAddress(BaseHook) internal pure override {}

    /// @notice Calls _beforeSwap directly, bypassing the onlyByPoolManager check.
    ///         tx.origin in tests is the signer — use hook.connect(account).callBeforeSwap(...)
    ///         to simulate that account as the swapper.
    function callBeforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4, BeforeSwapDelta, uint24) {
        return _beforeSwap(sender, key, params, hookData);
    }
}
