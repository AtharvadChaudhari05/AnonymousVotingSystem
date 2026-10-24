import React, { useState, useEffect } from "react";

export default function ResultsView({ votingContract, currentPhaseNum }) {
  const [resultsData, setResultsData] = useState({
    candidateNames: [],
    voteCounts: [],
    winnerId: 0,
    isTie: false,
    totalVotes: 0,
  });
  const [recentEvents, setRecentEvents] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchResults = async () => {
    if (!votingContract) return;
    try {
      setIsLoading(true);
      const res = await votingContract.getResults();
      const names = res.names;
      const counts = res.voteCounts.map((c) => c.toNumber());
      const winnerId = res.winnerCandidateId.toNumber();
      const isTie = res.isTie;
      const total = counts.reduce((a, b) => a + b, 0);

      setResultsData({
        candidateNames: names,
        voteCounts: counts,
        winnerId,
        isTie,
        totalVotes: total,
      });

      // Query past 20 VoteCast events
      const filter = votingContract.filters.VoteCast();
      const events = await votingContract.queryFilter(filter);
      const formatted = events.slice(-15).reverse().map((e) => ({
        candidateId: e.args.candidateId.toNumber(),
        nullifier: e.args.nullifier,
        timestamp: e.args.timestamp.toNumber(),
        blockNumber: e.blockNumber,
        txHash: e.transactionHash,
      }));
      setRecentEvents(formatted);
    } catch (e) {
      console.error("Failed to fetch results:", e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchResults();

    // Event listener for live updates
    if (votingContract) {
      const onVoteCast = () => {
        fetchResults();
      };
      votingContract.on("VoteCast", onVoteCast);
      const interval = setInterval(fetchResults, 4000);
      return () => {
        votingContract.off("VoteCast", onVoteCast);
        clearInterval(interval);
      };
    }
  }, [votingContract]);

  const isElectionEnded = currentPhaseNum === 4;

  return (
    <div>
      {/* Winner Banner if Election Ended */}
      {isElectionEnded && resultsData.winnerId > 0 && !resultsData.isTie && (
        <div
          className="card"
          style={{
            background: "linear-gradient(135deg, rgba(16, 185, 129, 0.2), rgba(6, 182, 212, 0.2))",
            borderColor: "var(--accent-emerald)",
            textAlign: "center",
            padding: "32px",
          }}
        >
          <div style={{ fontSize: "42px", marginBottom: "8px" }}>🏆</div>
          <div style={{ fontSize: "14px", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--accent-emerald)", fontWeight: 700 }}>
            Official Election Winner Declared
          </div>
          <h2 style={{ fontSize: "28px", color: "#fff", margin: "8px 0" }}>
            {resultsData.candidateNames[resultsData.winnerId - 1]}
          </h2>
          <div style={{ fontSize: "15px", color: "var(--text-muted)" }}>
            Secured <strong>{resultsData.voteCounts[resultsData.winnerId - 1]}</strong> of {resultsData.totalVotes} total verified votes.
          </div>
        </div>
      )}

      {isElectionEnded && resultsData.isTie && (
        <div className="alert alert-warning" style={{ textAlign: "center", display: "block" }}>
          ⚖️ The election concluded in a tie between top candidates!
        </div>
      )}

      {/* Live Tally Cards */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <div>
            <div className="card-title">📊 Live Election Tallies</div>
            <div className="card-desc" style={{ marginBottom: 0 }}>
              Tallied directly from on-chain state and verified zero-knowledge proof events.
            </div>
          </div>
          <button className="btn btn-secondary" onClick={fetchResults} disabled={isLoading}>
            {isLoading ? "Refreshing..." : "🔄 Refresh"}
          </button>
        </div>

        <div style={{ marginBottom: "24px" }}>
          <strong>Total Verified Votes Cast: </strong>
          <span className="badge badge-info" style={{ fontSize: "14px" }}>
            {resultsData.totalVotes}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
          {resultsData.candidateNames.map((name, idx) => {
            const count = resultsData.voteCounts[idx] || 0;
            const pct = resultsData.totalVotes > 0
              ? Math.round((count / resultsData.totalVotes) * 100)
              : 0;
            const isWinner = isElectionEnded && resultsData.winnerId === idx + 1 && !resultsData.isTie;

            return (
              <div
                key={idx}
                style={{
                  background: "rgba(0, 0, 0, 0.25)",
                  padding: "16px 20px",
                  borderRadius: "12px",
                  border: isWinner ? "1px solid var(--accent-emerald)" : "1px solid var(--border-subtle)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", alignItems: "center" }}>
                  <div>
                    <span style={{ fontSize: "12px", color: "var(--accent-cyan)", fontFamily: "var(--font-mono)", marginRight: "8px" }}>
                      #{idx + 1}
                    </span>
                    <strong style={{ fontSize: "16px", color: "#fff" }}>{name}</strong>
                    {isWinner && (
                      <span className="badge badge-success" style={{ marginLeft: "10px" }}>
                        🏆 Winner
                      </span>
                    )}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ fontSize: "16px", fontWeight: 700, color: "#fff" }}>
                      {count} votes
                    </span>{" "}
                    <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>({pct}%)</span>
                  </div>
                </div>

                <div className="progress-bar-bg">
                  <div
                    className="progress-bar-fill"
                    style={{
                      width: `${pct}%`,
                      background: isWinner
                        ? "linear-gradient(90deg, var(--accent-emerald), #34d399)"
                        : "linear-gradient(90deg, var(--accent-cyan), var(--accent-emerald))",
                    }}
                  ></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Real-time Vote Event Log */}
      <div className="card">
        <div className="card-title">📜 Recent Verified Vote Events (On-Chain)</div>
        <div className="card-desc">
          Only the candidate ID and the cryptographic <code>nullifier</code> are emitted. No voter identity
          or wallet address is ever present in the transaction or event log.
        </div>

        {recentEvents.length === 0 ? (
          <div className="alert alert-info">No votes cast yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="custom-table">
              <thead>
                <tr>
                  <th>Block</th>
                  <th>Candidate</th>
                  <th>Nullifier (Double-Vote Shield)</th>
                  <th>Transaction Hash</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {recentEvents.map((ev, i) => (
                  <tr key={i}>
                    <td>#{ev.blockNumber}</td>
                    <td>
                      <span className="badge badge-info">
                        Option #{ev.candidateId}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: "11px" }}>
                      {ev.nullifier.substring(0, 18)}...
                    </td>
                    <td className="mono" style={{ fontSize: "11px" }}>
                      {ev.txHash.substring(0, 14)}...
                    </td>
                    <td style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      {new Date(ev.timestamp * 1000).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
