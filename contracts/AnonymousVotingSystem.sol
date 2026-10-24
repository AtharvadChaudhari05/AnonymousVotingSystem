// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./MerkleTreeWithHistory.sol";

interface IVerifier {
    function verifyProof(
        uint[2] memory a,
        uint[2][2] memory b,
        uint[2] memory c,
        uint[2] memory input
    ) external pure returns (bool r);
}

/**
 * @title AnonymousVotingSystem
 * @dev Decentralized, Zero-Knowledge, Multi-Validator, NO-ADMIN Electronic Voting System.
 *
 * GOVERNANCE & ACCESS CONTROL MODEL:
 * - NO owner, NO admin, and NO privileged roles exist.
 * - Constructor configures all parameters (title, candidates, validators, threshold, timestamps).
 * - After deployment, parameters are immutable.
 * - Deployer has ZERO special rights.
 * - Phases transition strictly and automatically based on `block.timestamp`.
 */
contract AnonymousVotingSystem is MerkleTreeWithHistory {
    // --- Election Phases ---
    enum ElectionPhase {
        NotStarted,
        Registration,
        RegistrationEnded,
        Voting,
        Ended
    }

    // --- Immutable Election Configuration ---
    string public electionTitle;
    string[] public candidateList;
    uint256 public immutable approvalThreshold;

    uint256 public immutable registrationStart;
    uint256 public immutable registrationEnd;
    uint256 public immutable votingStart;
    uint256 public immutable votingEnd;

    IVerifier public immutable verifier;

    // --- Validators Configuration ---
    address[3] public registeredValidators;
    mapping(address => bool) public isValidator;

    // --- State Mappings ---
    mapping(bytes32 => bool) public commitments;
    mapping(bytes32 => bool) public usedIdentityHashes;
    mapping(bytes32 => bool) public nullifiers;

    mapping(uint256 => uint256) public candidateVotes; // 1-indexed (candidateId: 1..candidateList.length)
    uint256 public totalVotesCast;

    // --- EIP-712 Typed Data Constants ---
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant VOTER_APPROVAL_TYPEHASH =
        keccak256("VoterApproval(bytes32 commitment,bytes32 identityHash)");

    // --- Events ---
    event Commit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp);
    event VoterRegistered(
        bytes32 indexed commitment,
        bytes32 indexed identityHash,
        uint32 leafIndex,
        uint256 timestamp
    );
    event VoteCast(uint256 indexed candidateId, bytes32 indexed nullifier, uint256 timestamp);

    /**
     * @param _levels Merkle tree depth (typically 20)
     * @param _hasher MiMC Sponge hasher contract address
     * @param _verifier Groth16 zk-SNARK verifier contract address
     * @param _electionTitle Human-readable election title
     * @param _candidateNames Array of candidate names
     * @param _validators Exactly 3 validator wallet addresses
     * @param _approvalThreshold M-of-N threshold required (e.g., 2)
     * @param _registrationStart Start timestamp for voter registration
     * @param _registrationEnd End timestamp for voter registration
     * @param _votingStart Start timestamp for vote casting
     * @param _votingEnd End timestamp for vote casting
     */
    constructor(
        uint32 _levels,
        IHasher _hasher,
        IVerifier _verifier,
        string memory _electionTitle,
        string[] memory _candidateNames,
        address[3] memory _validators,
        uint256 _approvalThreshold,
        uint256 _registrationStart,
        uint256 _registrationEnd,
        uint256 _votingStart,
        uint256 _votingEnd
    ) MerkleTreeWithHistory(_levels, _hasher) {
        require(_candidateNames.length >= 2, "Must have at least 2 candidates");
        require(_approvalThreshold == 2, "Threshold must be 2 of 3 validators");
        require(
            _validators[0] != address(0) &&
            _validators[1] != address(0) &&
            _validators[2] != address(0),
            "Validators cannot be zero address"
        );
        require(
            _validators[0] != _validators[1] &&
            _validators[1] != _validators[2] &&
            _validators[0] != _validators[2],
            "Validators must be distinct"
        );
        require(_registrationStart < _registrationEnd, "Invalid registration period");
        require(_registrationEnd <= _votingStart, "Voting cannot start before registration ends");
        require(_votingStart < _votingEnd, "Invalid voting period");

        verifier = _verifier;
        electionTitle = _electionTitle;
        candidateList = _candidateNames;
        approvalThreshold = _approvalThreshold;

        registeredValidators = _validators;
        isValidator[_validators[0]] = true;
        isValidator[_validators[1]] = true;
        isValidator[_validators[2]] = true;

        registrationStart = _registrationStart;
        registrationEnd = _registrationEnd;
        votingStart = _votingStart;
        votingEnd = _votingEnd;
    }

    // ==========================================
    //            PHASE MANAGEMENT
    // ==========================================

    /**
     * @notice Get current election phase automatically calculated from block.timestamp
     */
    function getCurrentPhase() public view returns (ElectionPhase) {
        uint256 nowTs = block.timestamp;
        if (nowTs < registrationStart) {
            return ElectionPhase.NotStarted;
        } else if (nowTs <= registrationEnd) {
            return ElectionPhase.Registration;
        } else if (nowTs < votingStart) {
            return ElectionPhase.RegistrationEnded;
        } else if (nowTs <= votingEnd) {
            return ElectionPhase.Voting;
        } else {
            return ElectionPhase.Ended;
        }
    }

    // ==========================================
    //            EIP-712 DOMAIN & HASHING
    // ==========================================

    function getDomainSeparator() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    DOMAIN_TYPEHASH,
                    keccak256(bytes("AnonymousVotingSystem")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(this)
                )
            );
    }

    function getDigest(bytes32 _commitment, bytes32 _identityHash) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(VOTER_APPROVAL_TYPEHASH, _commitment, _identityHash)
        );
        return keccak256(abi.encodePacked("\x19\x01", getDomainSeparator(), structHash));
    }

    function recoverSigner(bytes32 _digest, bytes memory _sig) public pure returns (address) {
        require(_sig.length == 65, "Invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(_sig, 32))
            s := mload(add(_sig, 64))
            v := byte(0, mload(add(_sig, 96)))
        }
        if (v < 27) {
            v += 27;
        }
        require(v == 27 || v == 28, "Invalid signature 'v' value");
        address signer = ecrecover(_digest, v, r, s);
        require(signer != address(0), "ECDSA recovery failed");
        return signer;
    }

    // ==========================================
    //            VOTER REGISTRATION
    // ==========================================

    /**
     * @notice Register a voter's commitment into the Merkle tree with 2-of-3 validator approvals.
     * @param _commitment The voter's MiMC commitment = Hash(nullifier, secret)
     * @param _identityHash Salted hash of the voter's real-world identity (prevents duplicate registration)
     * @param _signatures Exactly 2 validator EIP-712 signatures
     * @param _validatorAddresses The 2 distinct validator addresses corresponding to the signatures
     */
    function registerVoter(
        bytes32 _commitment,
        bytes32 _identityHash,
        bytes[2] calldata _signatures,
        address[2] calldata _validatorAddresses
    ) external returns (uint32 leafIndex) {
        // 1. Verify Phase
        require(getCurrentPhase() == ElectionPhase.Registration, "Registration is not active");

        // 2. Prevent duplicate real-world voter identity registration
        require(!usedIdentityHashes[_identityHash], "Identity already registered");

        // 3. Prevent duplicate commitment insertion
        require(!commitments[_commitment], "Commitment already registered");

        // 4. Verify 2 distinct registered validators
        require(
            _validatorAddresses[0] != _validatorAddresses[1],
            "Validators in approval must be distinct"
        );
        require(isValidator[_validatorAddresses[0]], "First signer is not a registered validator");
        require(isValidator[_validatorAddresses[1]], "Second signer is not a registered validator");

        // 5. Verify EIP-712 signatures
        bytes32 digest = getDigest(_commitment, _identityHash);
        address signer0 = recoverSigner(digest, _signatures[0]);
        address signer1 = recoverSigner(digest, _signatures[1]);

        require(signer0 == _validatorAddresses[0], "Invalid signature from first validator");
        require(signer1 == _validatorAddresses[1], "Invalid signature from second validator");

        // 6. Record state
        usedIdentityHashes[_identityHash] = true;
        commitments[_commitment] = true;

        // 7. Insert commitment into Merkle tree
        leafIndex = _insert(_commitment);

        // 8. Emit events
        emit Commit(_commitment, leafIndex, block.timestamp);
        emit VoterRegistered(_commitment, _identityHash, leafIndex, block.timestamp);

        return leafIndex;
    }

    // ==========================================
    //            ANONYMOUS VOTING
    // ==========================================

    /**
     * @notice Submit an anonymous vote verified via zk-SNARK Groth16 proof.
     * @param _candidateId 1-indexed candidate ID (1 to candidateList.length)
     * @param _nullifier Hash(nullifier) used as the double-spend identifier
     * @param _root Known historical Merkle tree root that the proof references
     * @param _proof_a Groth16 proof element A
     * @param _proof_b Groth16 proof element B
     * @param _proof_c Groth16 proof element C
     */
    function vote(
        uint256 _candidateId,
        bytes32 _nullifier,
        bytes32 _root,
        uint[2] memory _proof_a,
        uint[2][2] memory _proof_b,
        uint[2] memory _proof_c
    ) external {
        // 1. Verify Phase
        require(getCurrentPhase() == ElectionPhase.Voting, "Voting is not active");

        // 2. Validate Candidate ID
        require(
            _candidateId >= 1 && _candidateId <= candidateList.length,
            "Invalid candidate ID"
        );

        // 3. Prevent Double Voting via Nullifier
        require(!nullifiers[_nullifier], "Nullifier already used - double voting prohibited");

        // 4. Verify Merkle Root is known in historical roots buffer
        require(isKnownRoot(_root), "Merkle root is invalid or expired");

        // 5. Verify Zero-Knowledge Proof
        require(
            verifier.verifyProof(
                _proof_a,
                _proof_b,
                _proof_c,
                [uint256(_nullifier), uint256(_root)]
            ),
            "Invalid zk-SNARK proof"
        );

        // 6. Record vote and nullifier
        nullifiers[_nullifier] = true;
        candidateVotes[_candidateId] += 1;
        totalVotesCast += 1;

        emit VoteCast(_candidateId, _nullifier, block.timestamp);
    }

    // ==========================================
    //            GETTERS & AUDITING
    // ==========================================

    function getCandidateCount() external view returns (uint256) {
        return candidateList.length;
    }

    function getCandidates() external view returns (string[] memory) {
        return candidateList;
    }

    function getResults()
        external
        view
        returns (
            string[] memory names,
            uint256[] memory voteCounts,
            uint256 winnerCandidateId,
            bool isTie
        )
    {
        uint256 count = candidateList.length;
        names = candidateList;
        voteCounts = new uint256[](count);

        uint256 maxVotes = 0;
        winnerCandidateId = 0;
        isTie = false;

        for (uint256 i = 1; i <= count; i++) {
            uint256 votes = candidateVotes[i];
            voteCounts[i - 1] = votes;
            if (votes > maxVotes) {
                maxVotes = votes;
                winnerCandidateId = i;
                isTie = false;
            } else if (votes == maxVotes && maxVotes > 0) {
                isTie = true;
            }
        }
    }

    function getElectionConfig()
        external
        view
        returns (
            string memory title,
            string[] memory candidates,
            address[3] memory validators,
            uint256 threshold,
            uint256 regStart,
            uint256 regEnd,
            uint256 vStart,
            uint256 vEnd,
            ElectionPhase phase,
            uint256 totalRegistered,
            uint256 totalVotes
        )
    {
        return (
            electionTitle,
            candidateList,
            registeredValidators,
            approvalThreshold,
            registrationStart,
            registrationEnd,
            votingStart,
            votingEnd,
            getCurrentPhase(),
            nextIndex,
            totalVotesCast
        );
    }
}
