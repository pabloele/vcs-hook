// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VCAccessHook} from "../VCAccessHook.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";

/// @notice Test wrapper that skips hook address validation so the contract can be
///         deployed to any address during unit tests (no CREATE2 mining required).
///         BaseHook.validateHookAddress is virtual precisely for this purpose.
contract TestVCAccessHook is VCAccessHook {
    constructor(
        IPoolManager _poolManager,
        address _eas,
        bytes32 _schemaUID,
        address _attester
    ) VCAccessHook(_poolManager, _eas, _schemaUID, _attester) {}

    function validateHookAddress(BaseHook) internal pure override {
        // skip address-bit validation in tests
    }
}
