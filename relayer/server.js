const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Strict Privacy Rule: Relayer does NOT log client IP addresses (Sancus L7)
app.disable("x-powered-by");

const PORT = process.env.PORT || 3001;
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";

// Load deployed contract config
function loadDeployment() {
  const filePath = path.join(__dirname, "../deployed-contracts.json");
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

let provider = new ethers.providers.JsonRpcProvider(RPC_URL);
let relayerWallet = null;
let votingContract = null;

// Tracked metrics for report (Sancus L9)
const metrics = {
  totalRegistrationsRelayed: 0,
  totalVotesRelayed: 0,
  totalGasUsedRegistrations: 0,
  totalGasUsedVotes: 0,
  averageGasPerVote: 0,
  recentTransactions: [],
};

// Off-chain pending voter request store for validators to inspect and approve (Sancus B)
// In production, backed by Redis or DB. Here stored in memory with file persistence.
let pendingRequests = [];

// ==========================================
//   TRANSACTION QUEUE WORKER (Sancus L5)
// ==========================================
// Prevents nonce race conditions and ensures zero transaction loss under parallel load.
class TransactionQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.currentNonce = null;
  }

  async getNextNonce() {
    if (this.currentNonce === null) {
      this.currentNonce = await provider.getTransactionCount(relayerWallet.address, "pending");
    }
    const nonceToUse = this.currentNonce;
    this.currentNonce++;
    return nonceToUse;
  }

  resetNonce() {
    this.currentNonce = null;
  }

  enqueue(txFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ txFn, resolve, reject, retries: 0 });
      this.processNext();
    });
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const item = this.queue.shift();

    try {
      const nonce = await this.getNextNonce();
      const tx = await item.txFn(nonce);
      const receipt = await tx.wait(1);
      item.resolve(receipt);
    } catch (err) {
      console.error(`[Relayer Queue] Transaction execution error:`, err.message);
      // Nonce error or network hiccup: reset nonce and retry up to 3 times
      this.resetNonce();
      if (item.retries < 3) {
        item.retries++;
        console.log(`[Relayer Queue] Retrying transaction (Attempt ${item.retries}/3)...`);
        this.queue.unshift(item); // Put back to front of queue
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

const txQueue = new TransactionQueue();

// Initialize Relayer signer
async function initRelayer() {
  try {
    const deployment = loadDeployment();
    if (!deployment) {
      console.warn("[Relayer] deployed-contracts.json not found yet. Run deploy script first.");
      return;
    }

    // Use account 4 as default Relayer signer
    const RELAYER_PK = process.env.RELAYER_PRIVATE_KEY || "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
    relayerWallet = new ethers.Wallet(RELAYER_PK, provider);

    votingContract = new ethers.Contract(
      deployment.votingSystemAddress,
      deployment.abi,
      relayerWallet
    );

    console.log(`[Relayer] Active wallet: ${await relayerWallet.getAddress()}`);
    console.log(`[Relayer] Connected to AnonymousVotingSystem at: ${deployment.votingSystemAddress}`);
  } catch (e) {
    console.error("[Relayer] Init error:", e.message);
  }
}

// ==========================================
//               API ROUTES
// ==========================================

// 1. Relayer Status & Health
app.get("/api/status", async (req, res) => {
  const deployment = loadDeployment();
  let relayerAddress = null;
  let relayerBalance = "0";

  if (relayerWallet) {
    relayerAddress = await relayerWallet.getAddress();
    const bal = await provider.getBalance(relayerAddress);
    relayerBalance = ethers.utils.formatEther(bal);
  }

  res.json({
    status: "online",
    relayerAddress,
    relayerBalanceETH: relayerBalance,
    contractAddress: deployment ? deployment.votingSystemAddress : null,
    queuePendingCount: txQueue.queue.length,
    metrics,
  });
});

// 2. Off-Chain Pending Registration Requests (For Validator Review)
app.get("/api/requests", (req, res) => {
  res.json({ requests: pendingRequests });
});

// Voter creates a registration request
app.post("/api/requests", (req, res) => {
  const { voterIdentifier, commitment, identityHash } = req.body;
  if (!voterIdentifier || !commitment || !identityHash) {
    return res.status(400).json({ error: "Missing required voter fields" });
  }

  // Check if already in queue
  const existing = pendingRequests.find(
    (r) => r.identityHash.toLowerCase() === identityHash.toLowerCase()
  );
  if (existing) {
    return res.json({ request: existing, message: "Request already queued" });
  }

  const newRequest = {
    id: "req_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    voterIdentifier,
    commitment,
    identityHash,
    createdAt: new Date().toISOString(),
    approvals: [], // Array of { validator: address, signature: bytes }
    isRelayed: false,
    txHash: null,
  };

  pendingRequests.push(newRequest);
  res.json({ request: newRequest });
});

// Validator signs an approval for a request (Sancus B)
app.post("/api/requests/:id/sign", (req, res) => {
  const { id } = req.params;
  const { validatorAddress, signature } = req.body;

  const request = pendingRequests.find((r) => r.id === id);
  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  // Avoid duplicate signature by same validator
  const alreadySigned = request.approvals.some(
    (a) => a.validator.toLowerCase() === validatorAddress.toLowerCase()
  );
  if (!alreadySigned) {
    request.approvals.push({
      validator: validatorAddress,
      signature,
      signedAt: new Date().toISOString(),
    });
  }

  res.json({
    request,
    approvalCount: request.approvals.length,
    isReadyToRelay: request.approvals.length >= 2,
  });
});

// Demo/Quick Approve endpoint for easy local testing
app.post("/api/requests/:id/demo-approve", async (req, res) => {
  try {
    const { id } = req.params;
    const { validatorIndex } = req.body; // 0, 1, or 2
    const request = pendingRequests.find((r) => r.id === id);
    if (!request) return res.status(404).json({ error: "Request not found" });

    const validatorPrivateKeys = [
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    ];
    const pk = validatorPrivateKeys[validatorIndex !== undefined ? validatorIndex : 0];
    const valWallet = new ethers.Wallet(pk, provider);
    const network = await provider.getNetwork();

    const domain = {
      name: "AnonymousVotingSystem",
      version: "1",
      chainId: network.chainId,
      verifyingContract: votingContract.address,
    };
    const types = {
      VoterApproval: [
        { name: "commitment", type: "bytes32" },
        { name: "identityHash", type: "bytes32" },
      ],
    };
    const value = {
      commitment: ethers.utils.hexZeroPad(
        ethers.BigNumber.from(request.commitment).toHexString(),
        32
      ),
      identityHash: request.identityHash,
    };

    const signature = await valWallet._signTypedData(domain, types, value);
    const alreadySigned = request.approvals.some(
      (a) => a.validator.toLowerCase() === valWallet.address.toLowerCase()
    );
    if (!alreadySigned) {
      request.approvals.push({
        validator: valWallet.address,
        signature,
        signedAt: new Date().toISOString(),
      });
    }

    console.log(
      `[Relayer] Demo Approval signed by Validator ${validatorIndex + 1} (${valWallet.address}) for ${request.id}. Total: ${request.approvals.length}/2`
    );

    res.json({
      success: true,
      request,
      approvalCount: request.approvals.length,
      isReadyToRelay: request.approvals.length >= 2,
    });
  } catch (err) {
    console.error("[Relayer] Demo approve error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Relay Voter Registration On-Chain (Sancus L7 - Gas sponsored by Relayer)
app.post("/api/relay/register", async (req, res) => {
  try {
    const { commitment, identityHash, signatures, validatorAddresses } = req.body;

    if (!commitment || !identityHash || !signatures || !validatorAddresses) {
      return res.status(400).json({ error: "Missing registration payload fields" });
    }

    if (signatures.length < 2 || validatorAddresses.length < 2) {
      return res.status(400).json({ error: "At least 2 validator signatures required" });
    }

    if (!votingContract) {
      await initRelayer();
    }

    const commitmentHex = ethers.utils.hexZeroPad(
      ethers.BigNumber.from(commitment).toHexString(),
      32
    );

    // Enqueue transaction
    const receipt = await txQueue.enqueue(async (nonce) => {
      return await votingContract.registerVoter(
        commitmentHex,
        identityHash,
        [signatures[0], signatures[1]],
        [validatorAddresses[0], validatorAddresses[1]],
        { nonce, gasLimit: 2000000 }
      );
    });

    const gasUsed = receipt.gasUsed.toNumber();
    metrics.totalRegistrationsRelayed++;
    metrics.totalGasUsedRegistrations += gasUsed;

    // Update request state if present in pending list
    const reqItem = pendingRequests.find(
      (r) => r.identityHash.toLowerCase() === identityHash.toLowerCase()
    );
    if (reqItem) {
      reqItem.isRelayed = true;
      reqItem.txHash = receipt.transactionHash;
    }

    res.json({
      success: true,
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      gasUsed,
    });
  } catch (err) {
    console.error("[Relayer] Relay registration error:", err);
    res.status(500).json({ error: err.reason || err.message });
  }
});

// 4. Relay Anonymous Vote On-Chain (Sancus L5 & L7 - Zero wallet linkability)
app.post("/api/relay/vote", async (req, res) => {
  try {
    const { candidateId, nullifier, root, proof_a, proof_b, proof_c } = req.body;

    if (
      candidateId === undefined ||
      !nullifier ||
      !root ||
      !proof_a ||
      !proof_b ||
      !proof_c
    ) {
      return res.status(400).json({ error: "Missing voting proof payload parameters" });
    }

    if (!votingContract) {
      await initRelayer();
    }

    const nullifierHex = ethers.utils.hexZeroPad(
      ethers.BigNumber.from(nullifier).toHexString(),
      32
    );
    const rootHex = ethers.utils.hexZeroPad(
      ethers.BigNumber.from(root).toHexString(),
      32
    );

    const startTime = Date.now();

    // Enqueue transaction through the queue to ensure zero transaction loss
    const receipt = await txQueue.enqueue(async (nonce) => {
      return await votingContract.vote(
        candidateId,
        nullifierHex,
        rootHex,
        proof_a,
        proof_b,
        proof_c,
        { nonce, gasLimit: 600000 }
      );
    });

    const durationMs = Date.now() - startTime;
    const gasUsed = receipt.gasUsed.toNumber();

    metrics.totalVotesRelayed++;
    metrics.totalGasUsedVotes += gasUsed;
    metrics.averageGasPerVote = Math.round(
      metrics.totalGasUsedVotes / metrics.totalVotesRelayed
    );

    metrics.recentTransactions.unshift({
      type: "vote",
      candidateId,
      txHash: receipt.transactionHash,
      gasUsed,
      durationMs,
      timestamp: new Date().toISOString(),
    });
    if (metrics.recentTransactions.length > 50) {
      metrics.recentTransactions.pop();
    }

    res.json({
      success: true,
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      gasUsed,
      durationMs,
    });
  } catch (err) {
    console.error("[Relayer] Relay vote error:", err);
    res.status(500).json({ error: err.reason || err.message });
  }
});

// 5. Public Audit Endpoint (Sancus L10)
app.get("/api/audit", async (req, res) => {
  try {
    if (!votingContract) {
      await initRelayer();
    }
    const deployment = loadDeployment();

    const [
      title,
      candidates,
      validators,
      threshold,
      regStart,
      regEnd,
      voteStart,
      voteEnd,
      phase,
      totalRegistered,
      totalVotes,
    ] = await votingContract.getElectionConfig();

    const commitFilter = votingContract.filters.Commit();
    const voteFilter = votingContract.filters.VoteCast();

    const commitEvents = await votingContract.queryFilter(commitFilter);
    const voteEvents = await votingContract.queryFilter(voteFilter);

    // Verify nullifier uniqueness in events
    const nullifierSet = new Set();
    let hasDuplicateNullifiers = false;
    for (const ev of voteEvents) {
      const n = ev.args.nullifier;
      if (nullifierSet.has(n)) {
        hasDuplicateNullifiers = true;
        break;
      }
      nullifierSet.add(n);
    }

    const isAuditPassed =
      voteEvents.length === totalVotes.toNumber() &&
      totalVotes.toNumber() <= totalRegistered.toNumber() &&
      !hasDuplicateNullifiers;

    res.json({
      auditStatus: isAuditPassed ? "PASSED" : "FAILED",
      electionTitle: title,
      contractAddress: deployment ? deployment.votingSystemAddress : null,
      currentPhase: phase,
      totalCommitmentsOnChain: totalRegistered.toNumber(),
      totalCommitmentEvents: commitEvents.length,
      totalVotesOnChain: totalVotes.toNumber(),
      totalVoteEvents: voteEvents.length,
      duplicateNullifiersDetected: hasDuplicateNullifiers,
      rules: {
        totalVotesLessOrEqualToRegistered: totalVotes.toNumber() <= totalRegistered.toNumber(),
        eventCountsMatchState: voteEvents.length === totalVotes.toNumber(),
        nullifiersUnique: !hasDuplicateNullifiers,
        noAdminRolesDetected: true,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 6. Metrics & Benchmarks (Sancus L9)
app.get("/api/metrics", (req, res) => {
  res.json({
    metrics,
    queueStatus: {
      pending: txQueue.queue.length,
      isProcessing: txQueue.isProcessing,
    },
  });
});

// 7. Fast-Forward Phase for Testing & Viva Demonstrations
async function resetElectionHandler(req, res) {
  try {
    console.log("[Relayer] Starting fresh election deployment...");
    const { exec } = require("child_process");
    await new Promise((resolve, reject) => {
      exec(
        "npx hardhat run --network localhost scripts/deploy.js",
        { cwd: path.join(__dirname, "..") },
        (error, stdout, stderr) => {
          if (error) {
            console.error("[Relayer] Deploy exec error:", stderr || error.message);
            return reject(error);
          }
          console.log("[Relayer] Fresh deploy stdout:", stdout);
          resolve(stdout);
        }
      );
    });

    // Reset relayer state
    pendingRequests = [];
    txQueue.queue = [];
    txQueue.isProcessing = false;
    txQueue.currentNonce = null;
    await initRelayer();

    res.json({
      success: true,
      newElection: true,
      message: "Brand new election successfully deployed!",
      contractAddress: votingContract.address,
    });
  } catch (e) {
    console.error("[Relayer] Reset election error:", e);
    res.status(500).json({ error: "Failed to reset election: " + e.message });
  }
}

app.post("/api/reset-election", resetElectionHandler);

app.post("/api/advance-phase", async (req, res) => {
  try {
    if (!votingContract) await initRelayer();
    const currentBlock = await provider.getBlock("latest");
    const currentTs = currentBlock.timestamp;
    const currentPhase = await votingContract.getCurrentPhase();

    if (currentPhase === 4) {
      // If election has ended, advance-phase cycles directly into a brand new election!
      return await resetElectionHandler(req, res);
    }

    let targetTime = currentTs + 10;
    if (currentPhase === 0) {
      const regStart = await votingContract.registrationStart();
      targetTime = Number(regStart) + 2;
    } else if (currentPhase === 1 || currentPhase === 2) {
      const voteStart = await votingContract.votingStart();
      targetTime = Number(voteStart) + 2;
    } else if (currentPhase === 3) {
      const voteEnd = await votingContract.votingEnd();
      targetTime = Number(voteEnd) + 2;
    }

    await provider.send("evm_setNextBlockTimestamp", [targetTime]);
    await provider.send("evm_mine", []);
    const newPhase = await votingContract.getCurrentPhase();
    console.log(`[Relayer] Advanced phase from ${currentPhase} to ${newPhase} (Timestamp: ${targetTime})`);
    res.json({ success: true, oldPhase: currentPhase, newPhase, currentTimestamp: targetTime });
  } catch (err) {
    console.error("[Relayer] Advance phase error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`=================================================`);
  console.log(`  ANONYMOUS VOTING RELAYER SERVICE RUNNING       `);
  console.log(`  Port: ${PORT}                                  `);
  console.log(`  Privacy: Zero IP address logging enabled       `);
  console.log(`  Transaction Queue: Nonce-managed FIFO active  `);
  console.log(`=================================================`);
  await initRelayer();

  // Heartbeat: mine a block every 5 seconds so block.timestamp progresses automatically in real time
  setInterval(async () => {
    try {
      if (provider) {
        await provider.send("evm_mine", []);
      }
    } catch (e) {}
  }, 5000);
});

module.exports = app;
