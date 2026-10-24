import React, { useState, useEffect } from "react";

const PHASES = [
  { id: 0, name: "Not Started", key: "not_started", pillClass: "registration" },
  { id: 1, name: "Voter Registration", key: "registration", pillClass: "registration" },
  { id: 2, name: "Registration Ended", key: "pause", pillClass: "voting" },
  { id: 3, name: "Voting Active", key: "voting", pillClass: "voting" },
  { id: 4, name: "Election Ended", key: "ended", pillClass: "ended" },
];

export default function PhaseBanner({ electionConfig, currentPhaseNum }) {
  const [timeLeft, setTimeLeft] = useState("");

  const currentPhase = PHASES[currentPhaseNum] || PHASES[0];

  useEffect(() => {
    if (!electionConfig) return;

    const interval = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      let targetTs = null;
      let label = "";

      if (currentPhaseNum === 0) {
        targetTs = electionConfig.regStart;
        label = "Registration begins in";
      } else if (currentPhaseNum === 1) {
        targetTs = electionConfig.regEnd;
        label = "Registration closes in";
      } else if (currentPhaseNum === 2) {
        targetTs = electionConfig.voteStart;
        label = "Voting begins in";
      } else if (currentPhaseNum === 3) {
        targetTs = electionConfig.voteEnd;
        label = "Voting closes in";
      } else {
        setTimeLeft("Election Closed");
        return;
      }

      if (targetTs) {
        const diff = targetTs - now;
        if (diff <= 0) {
          setTimeLeft("Phase transition imminent...");
        } else {
          const m = Math.floor(diff / 60);
          const s = diff % 60;
          setTimeLeft(`${label}: ${m}m ${s < 10 ? "0" + s : s}s`);
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [electionConfig, currentPhaseNum]);

  return (
    <div className="phase-banner">
      <div className="phase-info">
        <div className={`phase-pill ${currentPhase.pillClass}`}>
          <span className="pulse-dot"></span>
          {currentPhase.name}
        </div>
        <div>
          <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
            Autonomous State Machine: Driven strictly by block.timestamp (No Admin Control)
          </span>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <div className="countdown-box">
          ⏱️ {timeLeft || "Calculating countdown..."}
        </div>
        <button
          className="btn btn-secondary btn-sm"
          style={{ fontSize: "12px", padding: "6px 12px", background: "rgba(99, 102, 241, 0.2)", borderColor: "var(--accent-primary)" }}
          title="Advances local EVM blockchain time to next election phase for live demonstration"
          onClick={async () => {
            try {
              const res = await fetch("http://localhost:3001/api/advance-phase", { method: "POST" });
              const data = await res.json();
              if (data.success) {
                window.location.reload();
              }
            } catch (e) {
              alert("Failed to advance phase: " + e.message);
            }
          }}
        >
          ⏩ Next Phase (Demo)
        </button>
      </div>
    </div>
  );
}
