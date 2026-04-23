// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {IHooks} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-periphery/lib/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-periphery/lib/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-periphery/lib/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-periphery/lib/v4-core/src/types/PoolOperation.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title MerkleAccessHook
/// @notice Uniswap v4 hook that restricts swap access using a Merkle tree of
///         authorized (address, credentialType) pairs. The attester maintains the
///         tree off-chain and updates a single root on-chain. Swappers supply a
///         multi-proof covering all required credential types in hookData.
contract MerkleAccessHook is BaseHook {
    error NotAuthorized(address swapper);
    error OnlyAttester();
    error InvalidHookData();

    address public attester;
    bytes32 public merkleRoot;

    /// @notice Credential types required to swap. Auditable on-chain.
    /// @dev Leaves are keccak256(bytes.concat(keccak256(abi.encode(address, type))))
    ///      matching the OZ StandardMerkleTree double-hash convention.
    string[] public requiredTypes;

    event MerkleRootUpdated(bytes32 indexed oldRoot, bytes32 indexed newRoot);

    constructor(
        IPoolManager _poolManager,
        address _attester,
        bytes32 _merkleRoot,
        string[] memory _requiredTypes
    ) BaseHook(_poolManager) {
        attester = _attester;
        merkleRoot = _merkleRoot;
        requiredTypes = _requiredTypes;
    }

    /// @notice Updates the Merkle root. Only callable by the attester.
    function setMerkleRoot(bytes32 _root) external {
        if (msg.sender != attester) revert OnlyAttester();
        emit MerkleRootUpdated(merkleRoot, _root);
        merkleRoot = _root;
    }

    /// @notice Returns the list of required credential types.
    function getRequiredTypes() external view returns (string[] memory) {
        return requiredTypes;
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

    /// @dev hookData must be abi.encode(bytes32[] proof, bool[] proofFlags).
    ///      The swapper identity is taken from tx.origin so it cannot be spoofed.
    function _beforeSwap(
        address,
        PoolKey calldata,
        SwapParams calldata,
        bytes calldata hookData
    ) internal override returns (bytes4, BeforeSwapDelta, uint24) {
        if (hookData.length == 0) revert InvalidHookData();

        (bytes32[] memory proof, bool[] memory proofFlags) =
            abi.decode(hookData, (bytes32[], bool[]));

        address user = tx.origin;

        uint256 n = requiredTypes.length;
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            // Double-hash: matches OZ StandardMerkleTree leaf encoding
            leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(user, requiredTypes[i]))));
        }

        // Sort leaves ascending to match OZ StandardMerkleTree's traversal order.
        // The JS getMultiProof returns leaves sorted by their position in the tree
        // (sorted-hash order), so on-chain leaves must be in the same order.
        _sortLeaves(leaves);

        // Validate proof structure before calling multiProofVerify to surface
        // NotAuthorized instead of OZ's MerkleProofInvalidMultiproof.
        if (proofFlags.length != proof.length + n - 1) revert NotAuthorized(user);

        if (!MerkleProof.multiProofVerify(proof, proofFlags, merkleRoot, leaves)) {
            revert NotAuthorized(user);
        }

        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    // Insertion sort — O(n²) but n is tiny (number of credential types, typically 2-5).
    function _sortLeaves(bytes32[] memory arr) internal pure {
        uint256 len = arr.length;
        for (uint256 i = 1; i < len; i++) {
            bytes32 key = arr[i];
            uint256 j = i;
            while (j > 0 && arr[j - 1] > key) {
                arr[j] = arr[j - 1];
                j--;
            }
            arr[j] = key;
        }
    }
}
