// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEAS, Attestation} from "../interfaces/IEAS.sol";

/// @notice Mock EAS contract for testing — stores attestations set by the test
contract MockEAS is IEAS {
    mapping(bytes32 => Attestation) private _attestations;

    function setAttestation(bytes32 uid, Attestation calldata att) external {
        _attestations[uid] = att;
    }

    function getAttestation(bytes32 uid) external view override returns (Attestation memory) {
        return _attestations[uid];
    }
}
