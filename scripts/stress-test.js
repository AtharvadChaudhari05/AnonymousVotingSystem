const hre = require("hardhat");
const { ethers } = hre;
const { mimcSpongecontract } = require("circomlibjs");
const path = require("path");
const {
  generateCommitment,
  generateIdentityHash,
  signVoterApproval,
  generateZKProof,
} = require("./zk-helper");

const SEED = "mimcsponge";
const TREE_LEVELS = 20;
const STRESS_VOTER_COUNT = 105; // 100+ concurrent votes to overcome Sancus L5

async function main() {
  console.log("==========================================================");
  console.log("  SANCUS L5 STRESS TEST: CONCURRENT VOTE FLOODING          ");
  console.log(`  Target: ${STRESS_VOTER_COUNT} SIMULTANEOUS TRANSACTIONS  `);
  console.log("==========================================================");

  const [deployer, validator1, validator2, validator3, relayerSigner] =
    await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  // 1. Deploy MiMC and Verifier
  console.log("\n[1/5] Deploying contracts...");
  const MiMCSpongeFactory = new ethers.ContractFactory(
    mimcSpongecontract.abi,
    mimcSpongecontract.createCode(SEED, 220),
    deployer
  );
  const mimcsponge = await MiMCSpongeFactory.deploy();
  await mimcsponge.deployed();

  const VerifierFactory = await ethers.getContractFactory("Verifier", deployer);
  const verifier = await VerifierFactory.deploy();
  await verifier.deployed();

  const currentBlock = await ethers.provider.getBlock("latest");
  const nowTs = currentBlock.timestamp;
  const regStart = nowTs + 2;
  const regEnd = regStart + 3600;
  const voteStart = regEnd + 5;
  const voteEnd = voteStart + 7200;

  const VotingSystemFactory = await ethers.getContractFactory("AnonymousVotingSystem", deployer);
  const votingSystem = await VotingSystemFactory.deploy(
    TREE_LEVELS,
    mimcsponge.address,
    verifier.address,
    "Stress Test Election",
    ["Option Alpha", "Option Beta", "Option Gamma"],
    [validator1.address, validator2.address, validator3.address],
    2,
    regStart,
    regEnd,
    voteStart,
    voteEnd
  );
  await votingSystem.deployed();

  // 2. Register all voters in Registration Phase
  console.log(`\n[2/5] Registering ${STRESS_VOTER_COUNT} voters...`);
  await hre.network.provider.send("evm_setNextBlockTimestamp", [regStart + 5]);
  await hre.network.provider.send("evm_mine");

  const notes = [];
  for (let i = 0; i < STRESS_VOTER_COUNT; i++) {
    const note = await generateCommitment();
    const id = generateIdentityHash(`STRESS_STU_${i}`);
    const sig1 = await signVoterApproval(validator1, votingSystem.address, chainId, note.commitment, id.identityHash);
    const sig2 = await signVoterApproval(validator2, votingSystem.address, chainId, note.commitment, id.identityHash);

    const commitmentHex = ethers.utils.hexZeroPad(ethers.BigNumber.from(note.commitment).toHexString(), 32);
    await votingSystem.connect(relayerSigner).registerVoter(
      commitmentHex,
      id.identityHash,
      [sig1, sig2],
      [validator1.address, validator2.address]
    );
    notes.push(note);
    if ((i + 1) % 25 === 0 || i === STRESS_VOTER_COUNT - 1) {
      process.stdout.write(`  Registered ${i + 1}/${STRESS_VOTER_COUNT} commitments...\r`);
    }
  }
  console.log(`\n  All ${STRESS_VOTER_COUNT} voters registered successfully.`);

  // 3. Move to voting phase and pre-generate ZK proofs
  console.log(`\n[3/5] Moving to voting phase & generating ${STRESS_VOTER_COUNT} zk-SNARK proofs...`);
  await hre.network.provider.send("evm_setNextBlockTimestamp", [voteStart + 5]);
  await hre.network.provider.send("evm_mine");

  const proofPayloads = [];
  for (let i = 0; i < STRESS_VOTER_COUNT; i++) {
    const p = await generateZKProof(
      votingSystem,
      TREE_LEVELS,
      notes[i],
      path.join(__dirname, "../circuits/verifier.zkey")
    );
    proofPayloads.push({
      candidateId: (i % 3) + 1,
      nullifier: ethers.utils.hexZeroPad(ethers.BigNumber.from(p.nullifierHash).toHexString(), 32),
      root: ethers.utils.hexZeroPad(ethers.BigNumber.from(p.root).toHexString(), 32),
      proof_a: p.proof_a,
      proof_b: p.proof_b,
      proof_c: p.proof_c,
    });
    if ((i + 1) % 25 === 0 || i === STRESS_VOTER_COUNT - 1) {
      process.stdout.write(`  Generated ${i + 1}/${STRESS_VOTER_COUNT} proofs...\r`);
    }
  }
  console.log(`\n  All proofs generated.`);

  // 4. FLOOD RELAYER CONCURRENTLY (Sancus L5 stress test)
  console.log(`\n[4/5] Flooding ${STRESS_VOTER_COUNT} simultaneous transactions into Relayer Queue...`);

  // Relayer FIFO transaction queue with sequential nonce tracking
  class TestRelayerQueue {
    constructor() {
      this.queue = [];
      this.isProcessing = false;
      this.currentNonce = null;
    }

    async getNextNonce() {
      if (this.currentNonce === null) {
        this.currentNonce = await ethers.provider.getTransactionCount(relayerSigner.address, "pending");
      }
      const n = this.currentNonce;
      this.currentNonce++;
      return n;
    }

    enqueue(txFn) {
      return new Promise((resolve, reject) => {
        this.queue.push({ txFn, resolve, reject, retries: 0 });
        this.processNext();
      });
    }

    async processNext() {
      if (this.isProcessing || this.queue.length === 0) return;
      this.isProcessing = true;
      const item = this.queue.shift();

      try {
        const nonce = await this.getNextNonce();
        const tx = await item.txFn(nonce);
        const receipt = await tx.wait(1);
        item.resolve(receipt);
      } catch (err) {
        if (item.retries < 3) {
          item.retries++;
          this.currentNonce = await ethers.provider.getTransactionCount(relayerSigner.address, "latest");
          this.queue.unshift(item);
        } else {
          item.reject(err);
        }
      } finally {
        this.isProcessing = false;
        if (this.queue.length > 0) {
          setImmediate(() => this.processNext());
        }
      }
    }
  }

  const relayerQueue = new TestRelayerQueue();
  const startFlood = Date.now();

  // All 105 votes are submitted simultaneously into the queue
  const queuePromises = proofPayloads.map((payload) => {
    return relayerQueue.enqueue((nonce) => {
      return votingSystem.connect(relayerSigner).vote(
        payload.candidateId,
        payload.nullifier,
        payload.root,
        payload.proof_a,
        payload.proof_b,
        payload.proof_c,
        { nonce, gasLimit: 500000 }
      );
    });
  });

  const receipts = await Promise.all(queuePromises);
  const floodDurationMs = Date.now() - startFlood;

  console.log(`  All ${receipts.length} transactions processed in ${floodDurationMs} ms!`);

  // 5. Verification & Audit Checks
  console.log(`\n[5/5] Auditing results for transaction loss or duplication...`);
  const totalVotesCast = (await votingSystem.totalVotesCast()).toNumber();
  const successfulReceipts = receipts.filter((r) => r.status === 1).length;

  console.log(`----------------------------------------------------------`);
  console.log(`  Total Concurrent Votes Sent:     ${STRESS_VOTER_COUNT}`);
  console.log(`  Receipts Confirmed (status = 1): ${successfulReceipts}`);
  console.log(`  On-Chain Total Votes Cast:       ${totalVotesCast}`);
  console.log(`  Transactions Lost:               ${STRESS_VOTER_COUNT - successfulReceipts}`);
  console.log(`  Throughput under stress:         ${((STRESS_VOTER_COUNT / floodDurationMs) * 1000).toFixed(2)} tx/sec`);
  console.log(`----------------------------------------------------------`);

  if (totalVotesCast === STRESS_VOTER_COUNT && successfulReceipts === STRESS_VOTER_COUNT) {
    console.log(">>> SUCCESS: Sancus L5 OVERCOME! Zero transaction loss under flood conditions. <<<");
  } else {
    throw new Error("Stress test failed: Transaction count mismatch!");
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = main;
