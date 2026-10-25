import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import PhaseBanner from "./components/PhaseBanner";
import VoterView from "./components/VoterView";
import ValidatorView from "./components/ValidatorView";
import ResultsView from "./components/ResultsView";
import AuditView from "./components/AuditView";
import PerformanceView from "./components/PerformanceView";

import initialDeployment from "./contracts/deployed-contracts.json";

export default function App() {
  const [account, setAccount] = useState(null);
  const [provider, setProvider] = useState(null);
  const [votingContract, setVotingContract] = useState(null);
  const [deployment, setDeployment] = useState(initialDeployment);
  const [activeTab, setActiveTab] = useState("voter");
  const [currentPhaseNum, setCurrentPhaseNum] = useState(1);
  const [electionConfig, setElectionConfig] = useState(
    initialDeployment
      ? {
          title: initialDeployment.electionTitle,
          candidates: initialDeployment.candidates,
          validators: initialDeployment.validators || [],
          threshold: initialDeployment.approvalThreshold || 2,
          regStart: initialDeployment.regStart,
          regEnd: initialDeployment.regEnd,
          voteStart: initialDeployment.voteStart,
          voteEnd: initialDeployment.voteEnd,
          phase: 1,
          totalRegistered: 0,
          totalVotes: 0,
        }
      : null
  );
  const [networkError, setNetworkError] = useState(null);

  // Initialize Provider & Contract
  useEffect(() => {
    async function init() {
      try {
        let web3Provider = null;
        if (window.ethereum) {
          web3Provider = new ethers.providers.Web3Provider(window.ethereum);
          try {
            const accounts = await web3Provider.listAccounts();
            if (accounts.length > 0) {
              setAccount(accounts[0]);
            }
          } catch (e) {}

          window.ethereum.on("accountsChanged", (accs) => {
            setAccount(accs[0] || null);
          });
        } else {
          // Read-only fallback provider
          web3Provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8545");
        }
        setProvider(web3Provider);

        // Load deployment JSON from root if not loaded statically
        let dep = deployment;
        if (!dep) {
          try {
            const res = await fetch("/src/contracts/deployed-contracts.json");
            if (res.ok) {
              dep = await res.json();
              setDeployment(dep);
            }
          } catch (e) {}
        }

        if (dep && dep.votingSystemAddress && dep.abi) {
          // Use provider for read-only contract queries so it never throws on unapproved signers
          const contract = new ethers.Contract(
            dep.votingSystemAddress,
            dep.abi,
            web3Provider
          );
          setVotingContract(contract);

          // Fetch Config
          try {
            const configResult = await contract.getElectionConfig();
            setElectionConfig({
              title: configResult[0],
              candidates: configResult[1],
              validators: configResult[2],
              threshold: configResult[3].toNumber(),
              regStart: configResult[4].toNumber(),
              regEnd: configResult[5].toNumber(),
              voteStart: configResult[6].toNumber(),
              voteEnd: configResult[7].toNumber(),
              phase: configResult[8],
              totalRegistered: configResult[9].toNumber(),
              totalVotes: configResult[10].toNumber(),
            });
            setCurrentPhaseNum(configResult[8]);
          } catch (err) {
            console.warn("Could not query election config:", err.message);
          }
        }
      } catch (err) {
        console.error("Init provider error:", err);
        setNetworkError("Cannot connect to Ethereum provider. Ensure Hardhat node is running.");
      }
    }
    init();
  }, []);

  // Poll phase updates
  useEffect(() => {
    if (!votingContract) return;
    const interval = setInterval(async () => {
      try {
        const phase = await votingContract.getCurrentPhase();
        setCurrentPhaseNum(phase);
      } catch (e) {}
    }, 4000);
    return () => clearInterval(interval);
  }, [votingContract]);

  const connectWallet = async () => {
    if (window.ethereum) {
      try {
        const accounts = await window.ethereum.request({
          method: "eth_requestAccounts",
        });
        setAccount(accounts[0]);
      } catch (err) {
        console.error("User rejected wallet connection:", err);
      }
    } else {
      alert("MetaMask not found. Please install MetaMask to interact as a validator or voter.");
    }
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="brand-section">
          <div className="brand-icon">🗳️</div>
          <div>
            <h1 className="brand-title">
              {electionConfig?.title || "Anonymous Voting System"}
            </h1>
            <div className="brand-subtitle">
              Zero-Knowledge EVM Governance • 2-of-3 Validator Multi-Sig • No Admin Backdoors
            </div>
          </div>
        </div>

        <div className="header-actions">
          {account ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 14px",
                background: "rgba(255,255,255,0.06)",
                borderRadius: "10px",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <span className="pulse-dot" style={{ color: "var(--accent-emerald)" }}></span>
              <span className="mono" style={{ fontSize: "13px" }}>
                {account.substring(0, 6)}...{account.substring(account.length - 4)}
              </span>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={connectWallet}>
              🦊 Connect MetaMask
            </button>
          )}
        </div>
      </header>

      {/* Network or deployment warning */}
      {networkError && <div className="alert alert-error">⚠️ {networkError}</div>}
      {!deployment && (
        <div className="alert alert-warning">
          ℹ️ Deployed contract configuration not found yet. Please run <code>npm run deploy</code> in
          your terminal to deploy the election contract to your local Hardhat node.
        </div>
      )}

      {/* Phase Banner with Automatic Deadlines */}
      <PhaseBanner
        electionConfig={electionConfig}
        currentPhaseNum={currentPhaseNum}
      />

      {/* Role-Based Navigation Tabs (Notice: No Admin View!) */}
      <nav className="nav-tabs">
        <button
          className={`nav-tab ${activeTab === "voter" ? "active" : ""}`}
          onClick={() => setActiveTab("voter")}
        >
          🗳️ Voter View
        </button>
        <button
          className={`nav-tab ${activeTab === "validator" ? "active" : ""}`}
          onClick={() => setActiveTab("validator")}
        >
          🛡️ Validator View
        </button>
        <button
          className={`nav-tab ${activeTab === "results" ? "active" : ""}`}
          onClick={() => setActiveTab("results")}
        >
          📊 Results & Winner
        </button>
        <button
          className={`nav-tab ${activeTab === "audit" ? "active" : ""}`}
          onClick={() => setActiveTab("audit")}
        >
          🔍 Public Audit
        </button>
        <button
          className={`nav-tab ${activeTab === "performance" ? "active" : ""}`}
          onClick={() => setActiveTab("performance")}
        >
          ⚡ Performance & Benchmarks (Sancus)
        </button>
      </nav>

      {/* Main Tab Views */}
      <main>
        {activeTab === "voter" && (
          <VoterView
            votingContract={votingContract}
            account={account}
            currentPhaseNum={currentPhaseNum}
            electionConfig={electionConfig}
          />
        )}
        {activeTab === "validator" && (
          <ValidatorView
            votingContract={votingContract}
            account={account}
            provider={provider}
            electionConfig={electionConfig}
          />
        )}
        {activeTab === "results" && (
          <ResultsView
            votingContract={votingContract}
            currentPhaseNum={currentPhaseNum}
          />
        )}
        {activeTab === "audit" && (
          <AuditView
            votingContract={votingContract}
            electionConfig={electionConfig}
          />
        )}
        {activeTab === "performance" && <PerformanceView />}
      </main>
    </div>
  );
}
