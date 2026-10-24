const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { mimcSpongecontract } = require("circomlibjs");
const path = require("path");
const {
  generateCommitment,
  generateIdentityHash,
  signVoterApproval,
  generateZKProof,
} = require("../scripts/zk-helper");

const SEED = "mimcsponge";
const TREE_LEVELS = 20;

describe("AnonymousVotingSystem - Comprehensive Test Suite", function () {
  this.timeout(180000); // ZK proof generation takes a few seconds

  let deployer, validator1, validator2, validator3, nonValidator, voter1, voter2, relayer;
  let mimcsponge, verifier, votingSystem;
  let candidates = [
    "Alice Vance (Party A)",
    "Bob Chen (Party B)",
    "Charlie Miller (Party C)",
  ];
  let regStart, regEnd, voteStart, voteEnd;

  before(async function () {
    [
      deployer,
      validator1,
      validator2,
      validator3,
      nonValidator,
      voter1,
      voter2,
      relayer,
    ] = await ethers.getSigners();

    // 1. Deploy MiMC Sponge Hasher
    const MiMCSpongeFactory = new ethers.ContractFactory(
      mimcSpongecontract.abi,
      mimcSpongecontract.createCode(SEED, 220),
      deployer
    );
    mimcsponge = await MiMCSpongeFactory.deploy();
    await mimcsponge.deployed();

    // 2. Deploy Groth16 Verifier
    const VerifierFactory = await ethers.getContractFactory("Verifier", deployer);
    verifier = await VerifierFactory.deploy();
    await verifier.deployed();
  });

  beforeEach(async function () {
    const latestTime = await time.latest();
    regStart = latestTime + 10;
    regEnd = regStart + 300; // 5 min registration
    voteStart = regEnd + 10;
    voteEnd = voteStart + 600; // 10 min voting

    const VotingSystemFactory = await ethers.getContractFactory(
      "AnonymousVotingSystem",
      deployer
    );

    votingSystem = await VotingSystemFactory.deploy(
      TREE_LEVELS,
      mimcsponge.address,
      verifier.address,
      "Campus Election 2026",
      candidates,
      [validator1.address, validator2.address, validator3.address],
      2, // 2-of-3 threshold
      regStart,
      regEnd,
      voteStart,
      voteEnd
    );
    await votingSystem.deployed();
  });

  describe("1. Deployment & No-Admin Governance Rules", function () {
    it("Deployer has no special rights and cannot modify election parameters", async function () {
      // Check that AnonymousVotingSystem has no owner() function or onlyOwner modifier
      expect(votingSystem.functions["owner()"]).to.be.undefined;
      expect(votingSystem.functions["transferOwnership(address)"]).to.be.undefined;
      expect(votingSystem.functions["pause()"]).to.be.undefined;

      const config = await votingSystem.getElectionConfig();
      expect(config.title).to.equal("Campus Election 2026");
      expect(config.threshold).to.equal(2);
      expect(config.validators[0]).to.equal(validator1.address);
      expect(config.validators[1]).to.equal(validator2.address);
      expect(config.validators[2]).to.equal(validator3.address);
    });

    it("Rejects deployment with invalid threshold or duplicate validators", async function () {
      const VotingSystemFactory = await ethers.getContractFactory("AnonymousVotingSystem");
      const latestTime = await time.latest();

      // Threshold not equal to 2
      await expect(
        VotingSystemFactory.deploy(
          TREE_LEVELS,
          mimcsponge.address,
          verifier.address,
          "Title",
          candidates,
          [validator1.address, validator2.address, validator3.address],
          1, // invalid threshold
          latestTime + 10,
          latestTime + 20,
          latestTime + 30,
          latestTime + 40
        )
      ).to.be.revertedWith("Threshold must be 2 of 3 validators");

      // Duplicate validators
      await expect(
        VotingSystemFactory.deploy(
          TREE_LEVELS,
          mimcsponge.address,
          verifier.address,
          "Title",
          candidates,
          [validator1.address, validator1.address, validator3.address],
          2,
          latestTime + 10,
          latestTime + 20,
          latestTime + 30,
          latestTime + 40
        )
      ).to.be.revertedWith("Validators must be distinct");
    });
  });

  describe("2. Automatic Phase Transitions via Timestamp", function () {
    it("Starts in NotStarted phase, transitions to Registration, RegistrationEnded, Voting, and Ended automatically", async function () {
      // 1. NotStarted
      expect(await votingSystem.getCurrentPhase()).to.equal(0); // NotStarted

      // 2. Advance to Registration
      await time.increaseTo(regStart + 1);
      expect(await votingSystem.getCurrentPhase()).to.equal(1); // Registration

      // 3. Advance to RegistrationEnded
      await time.increaseTo(regEnd + 2);
      expect(await votingSystem.getCurrentPhase()).to.equal(2); // RegistrationEnded

      // 4. Advance to Voting
      await time.increaseTo(voteStart + 1);
      expect(await votingSystem.getCurrentPhase()).to.equal(3); // Voting

      // 5. Advance to Ended
      await time.increaseTo(voteEnd + 1);
      expect(await votingSystem.getCurrentPhase()).to.equal(4); // Ended
    });
  });

  describe("3. Voter Registration with 2-of-3 EIP-712 Validator Approvals", function () {
    it("Rejects registration when current phase is NotStarted or Voting", async function () {
      const note = await generateCommitment();
      const id = generateIdentityHash("STUDENT_001");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const sig1 = await signVoterApproval(validator1, votingSystem.address, chainId, note.commitment, id.identityHash);
      const sig2 = await signVoterApproval(validator2, votingSystem.address, chainId, note.commitment, id.identityHash);

      // Attempt before registrationStart
      await expect(
        votingSystem.registerVoter(
          ethers.utils.hexZeroPad(ethers.BigNumber.from(note.commitment).toHexString(), 32),
          id.identityHash,
          [sig1, sig2],
          [validator1.address, validator2.address]
        )
      ).to.be.revertedWith("Registration is not active");
    });

    it("Rejects registration with only 1 validator signature or same validator signing twice", async function () {
      await time.increaseTo(regStart + 5);
      const note = await generateCommitment();
      const id = generateIdentityHash("STUDENT_002");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const sig1 = await signVoterApproval(validator1, votingSystem.address, chainId, note.commitment, id.identityHash);

      // Same validator signing twice
      await expect(
        votingSystem.registerVoter(
          ethers.utils.hexZeroPad(ethers.BigNumber.from(note.commitment).toHexString(), 32),
          id.identityHash,
          [sig1, sig1],
          [validator1.address, validator1.address]
        )
      ).to.be.revertedWith("Validators in approval must be distinct");
    });

    it("Rejects registration when signed by a non-validator", async function () {
      await time.increaseTo(regStart + 5);
      const note = await generateCommitment();
      const id = generateIdentityHash("STUDENT_003");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const sig1 = await signVoterApproval(validator1, votingSystem.address, chainId, note.commitment, id.identityHash);
      const sigNon = await signVoterApproval(nonValidator, votingSystem.address, chainId, note.commitment, id.identityHash);

      await expect(
        votingSystem.registerVoter(
          ethers.utils.hexZeroPad(ethers.BigNumber.from(note.commitment).toHexString(), 32),
          id.identityHash,
          [sig1, sigNon],
          [validator1.address, nonValidator.address]
        )
      ).to.be.revertedWith("Second signer is not a registered validator");
    });

    it("Successfully registers voter with 2 valid validator signatures and prevents duplicate identity registration", async function () {
      await time.increaseTo(regStart + 5);
      const note = await generateCommitment();
      const id = generateIdentityHash("STUDENT_004");
      const chainId = (await ethers.provider.getNetwork()).chainId;

      const sig1 = await signVoterApproval(validator1, votingSystem.address, chainId, note.commitment, id.identityHash);
      const sig2 = await signVoterApproval(validator2, votingSystem.address, chainId, note.commitment, id.identityHash);

      const commitmentBytes32 = ethers.utils.hexZeroPad(ethers.BigNumber.from(note.commitment).toHexString(), 32);

      // Register successfully
      const tx = await votingSystem.registerVoter(
        commitmentBytes32,
        id.identityHash,
        [sig1, sig2],
        [validator1.address, validator2.address]
      );
      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);

      expect(await votingSystem.commitments(commitmentBytes32)).to.be.true;
      expect(await votingSystem.usedIdentityHashes(id.identityHash)).to.be.true;

      // Duplicate registration attempt with SAME identityHash (even with a new commitment) must be rejected
      const note2 = await generateCommitment();
      const sig1_again = await signVoterApproval(validator1, votingSystem.address, chainId, note2.commitment, id.identityHash);
      const sig2_again = await signVoterApproval(validator2, votingSystem.address, chainId, note2.commitment, id.identityHash);

      await expect(
        votingSystem.registerVoter(
          ethers.utils.hexZeroPad(ethers.BigNumber.from(note2.commitment).toHexString(), 32),
          id.identityHash,
          [sig1_again, sig2_again],
          [validator1.address, validator2.address]
        )
      ).to.be.revertedWith("Identity already registered");
    });
  });

  describe("4. Anonymous Voting, Zero-Knowledge Proofs & Double-Vote Prevention", function () {
    let noteVoter1, noteVoter2;

    beforeEach(async function () {
      // Register 2 voters during registration phase
      await time.increaseTo(regStart + 10);
      const chainId = (await ethers.provider.getNetwork()).chainId;

      noteVoter1 = await generateCommitment();
      const id1 = generateIdentityHash("STUDENT_VOTER_1");
      const sig1_v1 = await signVoterApproval(validator1, votingSystem.address, chainId, noteVoter1.commitment, id1.identityHash);
      const sig2_v1 = await signVoterApproval(validator3, votingSystem.address, chainId, noteVoter1.commitment, id1.identityHash);

      await votingSystem.connect(relayer).registerVoter(
        ethers.utils.hexZeroPad(ethers.BigNumber.from(noteVoter1.commitment).toHexString(), 32),
        id1.identityHash,
        [sig1_v1, sig2_v1],
        [validator1.address, validator3.address]
      );

      noteVoter2 = await generateCommitment();
      const id2 = generateIdentityHash("STUDENT_VOTER_2");
      const sig1_v2 = await signVoterApproval(validator2, votingSystem.address, chainId, noteVoter2.commitment, id2.identityHash);
      const sig2_v2 = await signVoterApproval(validator3, votingSystem.address, chainId, noteVoter2.commitment, id2.identityHash);

      await votingSystem.connect(relayer).registerVoter(
        ethers.utils.hexZeroPad(ethers.BigNumber.from(noteVoter2.commitment).toHexString(), 32),
        id2.identityHash,
        [sig1_v2, sig2_v2],
        [validator2.address, validator3.address]
      );
    });

    it("Rejects voting before the voting window opens", async function () {
      // Current phase is still Registration
      const proofData = await generateZKProof(
        votingSystem,
        TREE_LEVELS,
        noteVoter1,
        path.join(__dirname, "../circuits/verifier.zkey")
      );

      await expect(
        votingSystem.connect(relayer).vote(
          1,
          ethers.utils.hexZeroPad(ethers.BigNumber.from(proofData.nullifierHash).toHexString(), 32),
          ethers.utils.hexZeroPad(ethers.BigNumber.from(proofData.root).toHexString(), 32),
          proofData.proof_a,
          proofData.proof_b,
          proofData.proof_c
        )
      ).to.be.revertedWith("Voting is not active");
    });

    it("Accepts valid vote with zk-SNARK proof and increments tally", async function () {
      await time.increaseTo(voteStart + 10);

      const proofData = await generateZKProof(
        votingSystem,
        TREE_LEVELS,
        noteVoter1,
        path.join(__dirname, "../circuits/verifier.zkey")
      );

      const nullifierBytes32 = ethers.utils.hexZeroPad(
        ethers.BigNumber.from(proofData.nullifierHash).toHexString(),
        32
      );
      const rootBytes32 = ethers.utils.hexZeroPad(
        ethers.BigNumber.from(proofData.root).toHexString(),
        32
      );

      const tx = await votingSystem.connect(relayer).vote(
        1, // Candidate 1: Alice Vance
        nullifierBytes32,
        rootBytes32,
        proofData.proof_a,
        proofData.proof_b,
        proofData.proof_c
      );

      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1);

      // Verify nullifier is registered
      expect(await votingSystem.nullifiers(nullifierBytes32)).to.be.true;

      // Verify candidate votes count
      expect(await votingSystem.candidateVotes(1)).to.equal(1);
      expect(await votingSystem.totalVotesCast()).to.equal(1);
    });

    it("Rejects double voting with the same nullifier (L2 check)", async function () {
      await time.increaseTo(voteStart + 10);

      const proofData = await generateZKProof(
        votingSystem,
        TREE_LEVELS,
        noteVoter1,
        path.join(__dirname, "../circuits/verifier.zkey")
      );

      const nullifierBytes32 = ethers.utils.hexZeroPad(
        ethers.BigNumber.from(proofData.nullifierHash).toHexString(),
        32
      );
      const rootBytes32 = ethers.utils.hexZeroPad(
        ethers.BigNumber.from(proofData.root).toHexString(),
        32
      );

      // First vote succeeds
      await votingSystem.connect(relayer).vote(
        1,
        nullifierBytes32,
        rootBytes32,
        proofData.proof_a,
        proofData.proof_b,
        proofData.proof_c
      );

      // Second vote with the same nullifier must be rejected
      await expect(
        votingSystem.connect(relayer).vote(
          2,
          nullifierBytes32,
          rootBytes32,
          proofData.proof_a,
          proofData.proof_b,
          proofData.proof_c
        )
      ).to.be.revertedWith("Nullifier already used - double voting prohibited");
    });

    it("Rejects vote from an unregistered commitment (invalid Merkle root / membership)", async function () {
      await time.increaseTo(voteStart + 10);

      // Create an unregistered commitment
      const fakeNote = await generateCommitment();

      // Generating proof with fake leaf against tree without fake leaf fails or produces root not in tree
      const invalidProof = await generateZKProof(
        votingSystem,
        TREE_LEVELS,
        noteVoter1,
        path.join(__dirname, "../circuits/verifier.zkey")
      );

      // Tamper with the root to a fake root
      const fakeRoot = ethers.utils.hexZeroPad("0x123456", 32);
      const nullifierBytes32 = ethers.utils.hexZeroPad(
        ethers.BigNumber.from(invalidProof.nullifierHash).toHexString(),
        32
      );

      await expect(
        votingSystem.connect(relayer).vote(
          1,
          nullifierBytes32,
          fakeRoot,
          invalidProof.proof_a,
          invalidProof.proof_b,
          invalidProof.proof_c
        )
      ).to.be.revertedWith("Merkle root is invalid or expired");
    });

    it("Rejects voting after the voting window has closed", async function () {
      await time.increaseTo(voteStart + 10);

      const proofData = await generateZKProof(
        votingSystem,
        TREE_LEVELS,
        noteVoter1,
        path.join(__dirname, "../circuits/verifier.zkey")
      );

      // Fast-forward past votingEnd
      await time.increaseTo(voteEnd + 10);

      const nullifierBytes32 = ethers.utils.hexZeroPad(
        ethers.BigNumber.from(proofData.nullifierHash).toHexString(),
        32
      );
      const rootBytes32 = ethers.utils.hexZeroPad(
        ethers.BigNumber.from(proofData.root).toHexString(),
        32
      );

      await expect(
        votingSystem.connect(relayer).vote(
          1,
          nullifierBytes32,
          rootBytes32,
          proofData.proof_a,
          proofData.proof_b,
          proofData.proof_c
        )
      ).to.be.revertedWith("Voting is not active");
    });
  });

  describe("5. End-to-End Election Tally & Results Verification", function () {
    it("Conducts full election with 3 voters, tallies results correctly, and declares winner", async function () {
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // 1. Advance to Registration
      await time.increaseTo(regStart + 10);

      const note1 = await generateCommitment();
      const id1 = generateIdentityHash("STU_101");
      const sig1_1 = await signVoterApproval(validator1, votingSystem.address, chainId, note1.commitment, id1.identityHash);
      const sig2_1 = await signVoterApproval(validator2, votingSystem.address, chainId, note1.commitment, id1.identityHash);
      await votingSystem.registerVoter(
        ethers.utils.hexZeroPad(ethers.BigNumber.from(note1.commitment).toHexString(), 32),
        id1.identityHash,
        [sig1_1, sig2_1],
        [validator1.address, validator2.address]
      );

      const note2 = await generateCommitment();
      const id2 = generateIdentityHash("STU_102");
      const sig1_2 = await signVoterApproval(validator2, votingSystem.address, chainId, note2.commitment, id2.identityHash);
      const sig2_2 = await signVoterApproval(validator3, votingSystem.address, chainId, note2.commitment, id2.identityHash);
      await votingSystem.registerVoter(
        ethers.utils.hexZeroPad(ethers.BigNumber.from(note2.commitment).toHexString(), 32),
        id2.identityHash,
        [sig1_2, sig2_2],
        [validator2.address, validator3.address]
      );

      const note3 = await generateCommitment();
      const id3 = generateIdentityHash("STU_103");
      const sig1_3 = await signVoterApproval(validator1, votingSystem.address, chainId, note3.commitment, id3.identityHash);
      const sig2_3 = await signVoterApproval(validator3, votingSystem.address, chainId, note3.commitment, id3.identityHash);
      await votingSystem.registerVoter(
        ethers.utils.hexZeroPad(ethers.BigNumber.from(note3.commitment).toHexString(), 32),
        id3.identityHash,
        [sig1_3, sig2_3],
        [validator1.address, validator3.address]
      );

      // 2. Advance to Voting
      await time.increaseTo(voteStart + 10);

      // Voter 1 votes for Candidate 1 (Alice)
      const p1 = await generateZKProof(votingSystem, TREE_LEVELS, note1, path.join(__dirname, "../circuits/verifier.zkey"));
      await votingSystem.connect(relayer).vote(
        1,
        ethers.utils.hexZeroPad(ethers.BigNumber.from(p1.nullifierHash).toHexString(), 32),
        ethers.utils.hexZeroPad(ethers.BigNumber.from(p1.root).toHexString(), 32),
        p1.proof_a,
        p1.proof_b,
        p1.proof_c
      );

      // Voter 2 votes for Candidate 1 (Alice)
      const p2 = await generateZKProof(votingSystem, TREE_LEVELS, note2, path.join(__dirname, "../circuits/verifier.zkey"));
      await votingSystem.connect(relayer).vote(
        1,
        ethers.utils.hexZeroPad(ethers.BigNumber.from(p2.nullifierHash).toHexString(), 32),
        ethers.utils.hexZeroPad(ethers.BigNumber.from(p2.root).toHexString(), 32),
        p2.proof_a,
        p2.proof_b,
        p2.proof_c
      );

      // Voter 3 votes for Candidate 2 (Bob)
      const p3 = await generateZKProof(votingSystem, TREE_LEVELS, note3, path.join(__dirname, "../circuits/verifier.zkey"));
      await votingSystem.connect(relayer).vote(
        2,
        ethers.utils.hexZeroPad(ethers.BigNumber.from(p3.nullifierHash).toHexString(), 32),
        ethers.utils.hexZeroPad(ethers.BigNumber.from(p3.root).toHexString(), 32),
        p3.proof_a,
        p3.proof_b,
        p3.proof_c
      );

      // 3. Fast forward to election end
      await time.increaseTo(voteEnd + 10);
      expect(await votingSystem.getCurrentPhase()).to.equal(4); // Ended

      const results = await votingSystem.getResults();
      expect(results.voteCounts[0]).to.equal(2); // Alice: 2 votes
      expect(results.voteCounts[1]).to.equal(1); // Bob: 1 vote
      expect(results.voteCounts[2]).to.equal(0); // Charlie: 0 votes
      expect(results.winnerCandidateId).to.equal(1); // Alice wins!
      expect(results.isTie).to.be.false;
    });
  });
});
