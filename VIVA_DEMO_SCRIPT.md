# Viva & Project Demonstration Script (VIVA_DEMO_SCRIPT.md)

This step-by-step presentation script is designed for your college mini-project examination/evaluation. It covers the exact sequence of commands, UI interactions, and theoretical explanations examiners look for.

---

## 1. Project Overview & Opening Statement (30 seconds)
> *"Respected examiners, our project is a Decentralized, Anonymous Voting System built on Ethereum with Solidity, Circom, Groth16 zero-knowledge proofs, and a 20-level MiMC Merkle tree. Our primary research objective was to overcome the critical architectural, cryptographic, and performance limitations of the IEEE BCCA 2022 research baseline 'Sancus'. Our implementation operates under a strict **No-Admin Governance Model**, ensuring that after deployment, no single party—including the deployer or validators—can manipulate voter registration, alter results, or link a voter's real-world identity to their cast ballot."*

---

## 2. Live Terminal Demonstration Steps

### Step 1: Start the Local Ethereum Blockchain
In Terminal 1:
```bash
npx hardhat node
```
*Point out to examiners*: Notice the 20 pre-funded test accounts on Chain ID `31337`. Accounts 1, 2, and 3 will serve as our three validators, Account 4 serves as the Relayer, and Account 0 is the one-time contract deployer.

### Step 2: Deploy the Immutable Election Smart Contract
In Terminal 2:
```bash
npm run deploy
```
*Point out to examiners*:
- Deployment script reads `election.config.json`.
- Deploys `MiMCSponge` hasher contract and `Verifier` Groth16 contract.
- Deploys `AnonymousVotingSystem` with fixed candidate list, 2-of-3 validator threshold, and immutable phase timestamps.
- Highlight: The deployer has **zero admin power** after deployment (no `owner` variable, no administrative pause/modify functions).

### Step 3: Start the Anonymous Relayer Service
In Terminal 3:
```bash
npm run relayer
```
*Point out to examiners*:
- Relayer initializes on port `3001` with zero IP address logging (Privacy preservation - Sancus L7).
- Relayer connects its transaction queue worker to manage nonces sequentially and eliminate transaction collisions under parallel load (Sancus L5).

### Step 4: Launch the Modern React Frontend
In Terminal 4:
```bash
npm run frontend
```
Open `http://localhost:5173` in your browser.

---

## 3. End-to-End Walkthrough in the Web Application

### A. Phase Indicator & No-Admin Governance
- Show examiners the **Phase Banner** at the top of the page.
- Explain: *"Notice the phase is currently **Registration**. There is no admin button to start or stop phases. The contract transitions between Registration, Voting, and Results automatically based on Ethereum block timestamps (`block.timestamp`)."*

### B. Voter Registration (3-Step Wizard)
1. In the **Voter View**, enter Student ID: `2023-CS-101`.
2. Click **"Generate Secret Note & Request Approval"**:
   - Explain to examiners: *"The browser uses cryptographic entropy to generate two 256-bit scalars: `nullifier` and `secret`. It computes the MiMC hash $\text{commitment} = \text{Hash}(\text{nullifier}, \text{secret})$. Only the commitment leaves the device. The private secrets are downloaded in a confidential JSON note file."*
3. Show the downloaded `voting_secret_note_2023-CS-101.json` file.

### C. Validator 2-of-3 Multi-Signature Desk
1. Switch to the **Validator View** tab.
2. In MetaMask, connect as **Validator 1** (`0x70997970C51812dc3A010C7d01b50e0d17dc79C8`).
3. Click **"Approve & Sign"** on Student `2023-CS-101`:
   - MetaMask prompts for an **EIP-712 typed-data signature** (explain that the validator signs `VoterApproval(bytes32 commitment, bytes32 identityHash)`).
4. Switch MetaMask to **Validator 2** (`0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`).
5. Click **"Approve & Sign"**:
   - Approvals reach `2/2`!
6. Explain: *"Now that the 2-of-3 threshold is met, the Relayer automatically bundles the two validator signatures, verifies them on-chain, and inserts the commitment into the 20-level on-chain Merkle tree. The voter's personal wallet address was never used, preventing on-chain address linkage."*

### D. Anonymous Zero-Knowledge Voting
1. In Terminal 2, advance time into the **Voting Phase**:
   ```bash
   npx hardhat eval "await network.provider.send('evm_increaseTime', [610]); await network.provider.send('evm_mine');"
   ```
2. In the browser, refresh: the phase banner automatically flips to **Voting Active**!
3. Go to **Step 3 (Cast Anonymous Vote)**:
   - Select candidate: `Alice Vance`.
   - Ensure the secret note is loaded.
   - Click **"Cast Anonymous Vote"**.
4. Show examiners the live progress bar:
   - *"The browser reconstructs the Merkle path from on-chain `Commit` events."*
   - *"Snarkjs executes the Groth16 zk-SNARK prover over the AltBn128 curve inside the browser in ~2.5 seconds."*
   - *"The proof $(A, B, C)$ and public signals $(\text{nullifierHash}, \text{root})$ are sent to the Relayer."*
   - *"The smart contract verifies `isKnownRoot(root)` and checks `!nullifiers[nullifierHash]` before incrementing Alice's tally."*
5. Show the green confirmation receipt with transaction hash and gas used (~298,000 gas).

### E. Double-Voting Prevention Demo (Crucial for Examiners!)
1. Without clearing the note, click **"Cast Anonymous Vote"** a second time.
2. An immediate error appears:
   ```
   ⚠️ Error: Nullifier already used - double voting prohibited
   ```
3. Explain: *"The voter proved they belong to the Merkle tree without revealing their leaf, but the reveal of the unique `nullifierHash` prevents any second vote with mathematical certainty."*

### F. Results & Automatic Winner Declaration
1. Go to the **Results & Winner** tab.
2. Show the real-time progress bar reflecting Alice's vote.
3. In Terminal 2, advance past the election deadline:
   ```bash
   npx hardhat eval "await network.provider.send('evm_increaseTime', [1250]); await network.provider.send('evm_mine');"
   ```
4. Refresh: The phase changes to **Election Ended**, and the **Official Winner Banner** automatically crowns Alice Vance!

### G. Public Cryptographic Audit Page (Sancus L10)
1. Switch to the **Public Audit** tab.
2. Click **"Re-run Full Audit"**:
   - Verifies on-chain: `Total Votes (1) <= Registered Commitments (1)`.
   - Scans all `VoteCast` events: `Zero duplicate nullifiers detected`.
   - Verifies event counts match smart contract storage variables.
   - Verifies zero admin backdoors or pause mechanisms.
3. Show the **"100% CRYPTOGRAPHICALLY SOUND"** green audit badge.

### H. Performance & Sancus Comparison
1. Switch to the **Performance & Benchmarks** tab.
2. Walk the examiners through the **Sancus vs Our System Table** (L1 through L10).
3. Conclude by demonstrating the 13 automated Hardhat test results (`npm test`).

---

## 4. Common Examiner Questions & Concise Model Answers

**Q1: How do validators prevent a student from registering twice under two different commitments?**
> *Answer*: Each validator signature covers both the commitment and a salted `identityHash` (`keccak256(studentId + salt)`). The contract stores `usedIdentityHashes[identityHash] = true` on first registration. If the student generates a second commitment, the contract rejects the transaction because the `identityHash` has already been consumed.

**Q2: Can the Relayer change my vote?**
> *Answer*: No. The vote is cryptographically bound to the zero-knowledge proof payload $(A, B, C)$ and candidate ID. If the relayer alters the candidate ID or proof arguments, the on-chain `IVerifier.verifyProof` call immediately reverts. The relayer can only choose whether to submit or delay, but cannot forge a vote.

**Q3: How does the contract verify a voter was registered without knowing who they are?**
> *Answer*: The voter proves in zero-knowledge that their commitment is a valid leaf in the 20-level on-chain Merkle tree by proving knowledge of the private inputs (`nullifier`, `secret`, and Merkle path) that hash to a known Merkle root (`isKnownRoot`). The contract only inspects the validity of the Groth16 mathematical proof without ever seeing the voter's leaf index or identity.
