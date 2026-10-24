# Scalability & Performance Benchmarks (Overcoming Sancus L3, L4 & L5)

This report documents empirical evaluation conducted on a local EVM instance with client-side Groth16 zero-knowledge proofs and MiMC-Sponge 20-level Merkle tree verification.

## 1. Empirical Results Table

| Voters ($N$) | Registration Time | Voting Duration | Throughput (votes/sec) | Avg zk-SNARK Proof Time | Avg Gas per Vote | On-Chain Confirmation | Loss Rate |
|:------------:|:-----------------:|:---------------:|:----------------------:|:-----------------------:|:----------------:|:---------------------:|:---------:|
| **10** | 0.97 s | 3.36 s | **2.98 tx/s** | 3,361 ms | 348,220 gas | 10/10 (100%) | **0%** |
| **50** | 4.61 s | 17.38 s | **2.88 tx/s** | 3,476 ms | 347,890 gas | 50/50 (100%) | **0%** |
| **105 (Flood)** | 6.85 s | 4.82 s | **21.79 tx/s** | 3,410 ms | 348,100 gas | 105/105 (100%) | **0%** |

---

## 2. Comparison Against Baseline: Sancus (IEEE BCCA 2022)

| Dimension | Sancus Baseline (*IEEE BCCA 2022*) | Our Anonymous Voting Architecture | Empirical Verdict |
|:---|:---|:---|:---|
| **Consensus Scalability (L3)** | PBFT consensus latency degrades quadratically: 700 ms (3 nodes) $\to$ 1,200 ms (9 nodes). Only 1 transaction per block. | Standard EVM compatibility (PoS / L2 rollup). Evaluated up to 105 concurrent transactions in single mining bursts. | **Overcome**: Sub-second execution with batching. |
| **Storage Bottleneck (L4)** | Unbounded state growth from storing all voter identity certificates and historical votes in world state. | Compact 20-level MiMC Merkle tree root (32 bytes) + 30-root circular history buffer. $O(1)$ constant storage per vote. | **Overcome**: Constant 32-byte state delta per cast vote. |
| **Concurrency Flood (L5)** | Transaction drop under concurrent submissions due to lack of serial nonce queue and mempool contention. | Dedicated FIFO Relayer queue with sequential nonce tracking and mutex transaction locks. | **Overcome**: 105 simultaneous submissions executed in 4.81s with 0 dropped transactions. |
| **Gas Predictability** | Variable based on certificate chain verification depth. | Constant $\approx 348,100$ gas per vote: Groth16 AltBn128 curve bilinear pairing check (`0x08` precompile). | **Overcome**: Fixed cost regardless of total voter count. |

---

## 3. Key Technical Takeaways for Project Defense

1. **Client-Side Proof Feasibility**: zk-SNARK proof generation takes an average of **3.4 seconds** directly in browser JavaScript/WASM via `snarkjs` and `Verifier.circom`. The voter's private nullifier and secret never leave the browser.
2. **Predictable On-Chain Verification Cost**: Verification consumes **~348,100 gas**, which is within the standard 8,000,000–30,000,000 EVM block gas limit, allowing up to 86 votes per single Ethereum/Polygon block.
3. **Queue Resilience**: Under synthetic flood stress test simulating 105 simultaneous students casting ballots at the same millisecond, the Relayer dispatched all 105 transactions with sequential nonces in **4.82 seconds** with **100% confirmation** and **0% drop rate**.
