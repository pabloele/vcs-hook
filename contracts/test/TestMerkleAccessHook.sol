// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleAccessHook} from "../MerkleAccessHook.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";

/// @notice Test wrapper that skips hook address validation so the contract can be
///         deployed to any address during unit tests (no CREATE2 mining required).
contract TestMerkleAccessHook is MerkleAccessHook {
    constructor(
        IPoolManager _poolManager,
        address _attester,
        bytes32 _merkleRoot,
        string[] memory _requiredTypes
    ) MerkleAccessHook(_poolManager, _attester, _merkleRoot, _requiredTypes) {}

    function validateHookAddress(BaseHook) internal pure override {
        // skip address-bit validation in tests
    }
}
