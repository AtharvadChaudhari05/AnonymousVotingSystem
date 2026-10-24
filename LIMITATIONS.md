# System Limitations & Security Boundary Analysis (LIMITATIONS.md)

This document provides a rigorous, transparent breakdown of the security assumptions, design trade-offs, and unsolved challenges in our Anonymous Voting System. While the architecture successfully overcomes the ten key limitations of the IEEE BCCA 2022 Sancus paper, certain boundaries and theoretical constraints remain inherent to decentralized zero-knowledge electronic voting.

---

## 1. Off-Chain Validator Eligibility & Collusion Risk
- **Mechanism**: Voter eligibility is verified off-chain by three validators against an institutional roll list (e.g., student roster CSV), and approved via EIP-712 typed-data multi-signatures.
- **Limitation**: The smart contract cannot independently verify real-world student identity; it delegates this trust to the $M$-of-$N$ validator threshold ($2$-of-$3$).
- **Attack Vector**: If any 2 of the 3 validators collude or are compromised by an adversary, they can forge approvals for fictitious or ineligible voter commitments, successfully inserting unauthorized leaves into the Merkle tree and stuffing the ballot box.
- **Mitigation & Boundary**: While 2-of-3 threshold is superior to Sancus's single government service (GS), it does not eliminate Sybil attacks if the quorum colludes.

---

## 2. Validator Linkability at Registration Time
- **Mechanism**: During the registration phase, the voter must present both their salted identity hash and their public commitment to validators to obtain signatures.
- **Limitation**: The validators observe the pair $(\text{identityHash}, \text{commitment})$.
- **Privacy Boundary**: Although validators **cannot** link a commitment to a subsequent vote (because voting only reveals the $\text{nullifierHash}$ and a zero-knowledge proof of tree membership), validators know that a specific student registered a specific commitment leaf. If a voter is coerced or voluntarily reveals their secret note later, their vote can be traced.

---

## 3. Relayer Network Metadata & Censorship
- **Mechanism**: The Relayer acts as an anonymity buffer that submits transactions and pays gas fees on behalf of voters, preventing the voter's Ethereum wallet address from being recorded on-chain.
- **Limitation**:
  1. **IP & Network Metadata**: The Relayer sees the incoming HTTP request. While the Relayer application does not log IP addresses, network-level inspection (ISPs, network taps, router logs) could correlate transaction timing with voter IP traffic.
  2. **Relayer Censorship**: A malicious or compromised Relayer could selectively drop or delay votes for certain candidates.
- **Mitigation & Boundary**: A direct-submission fallback exists (voters can submit directly via MetaMask if the relayer is offline or censoring), but direct submission exposes the voter's wallet address on-chain as the transaction sender, creating a trade-off between censorship resistance and network privacy.

---

## 4. Absence of Coercion Resistance & Receipt-Freeness
- **Limitation**: The system achieves **anonymity** and **double-voting prevention**, but does **not** provide coercion resistance or receipt-freeness.
- **Coercion Scenario**: A corrupt authority or briber can demand that the voter provide their secret note (`nullifier` and `secret`) before voting, compute the $\text{nullifierHash} = \text{MiMCSponge}(\text{nullifier})$, and monitor the public blockchain event log `VoteCast(candidateId, nullifier, timestamp)` to verify whether the voter obeyed instructions.
- **Why It Remains Unsolved**: Achieving true coercion resistance on public blockchains typically requires complex cryptographic primitives such as Minimal Anti-Collusion Infrastructure (MACI) with rerandomizable keys or time-lock re-encryption, which are beyond the scope of a lightweight undergraduate mini project.

---

## 5. Groth16 Trusted Setup Requirement
- **Mechanism**: The system uses Groth16 zk-SNARKs over the AltBn128 elliptic curve for verification efficiency (~298k gas on EVM).
- **Limitation**: Groth16 requires a circuit-specific **trusted setup ceremony** (Powers of Tau Phase 1 + Phase 2 circuit contribution).
- **Toxic Waste Risk**: If the randomness (toxic waste) used during the ceremony is compromised, an attacker could generate mathematically valid proofs for false statements (e.g., proving membership for leaves that never existed in the tree).
- **Future Work**: Migrating to universal, transparent argument systems like PLONK (KZG) or STARKs removes per-circuit trusted setup assumptions at the cost of higher on-chain gas verification overhead.

---

## 6. Immutable Configuration & Lack of Error Recovery
- **Mechanism**: The contract has strictly NO owner, NO admin, and NO administrative functions. Timestamps, candidate arrays, and validator addresses are immutable.
- **Limitation**: If an incorrect candidate name, misspelled address, or flawed timestamp schedule is entered into `election.config.json` at deployment time, the contract **cannot be patched, paused, or upgraded**. The entire contract must be abandoned, and a new contract must be deployed.

---

## 7. Consensus & 51% Attack Assumption
- **Limitation**: Finality and immutability depend entirely on the security of the underlying EVM network consensus. If deployed on a low-hashrate Proof-of-Work chain or a centralized testnet where a majority cartel can reorganize blocks, past `VoteCast` transactions could be reversed or rewritten.

---

## 8. Local Testbed vs. Public Mainnet Scalability
- **Limitation**: Benchmarks (10, 50, 100, 250 voters) were evaluated on an EVM development node running Hardhat with interval mining.
- **Discrepancy**: While this demonstrates algorithmic efficiency and transaction queue integrity (0 loss under 105 concurrent votes), public mainnets like Ethereum Layer 1 have dynamic EIP-1559 base fees, mempool reorderings by MEV searchers, and block gas limits (30M gas per block = ~100 Groth16 verification transactions max per block). Real-world global-scale voting would require deployment on Layer 2 rollups (Arbitrum, Optimism, or Polygon zkEVM).
