import React, { useState, useEffect, useRef } from "react";
import { ethers } from "ethers";
import {
  generateCommitment,
  generateIdentityHash,
  generateZKProofBrowser,
} from "../contracts/zk-browser-helper";

const RELAYER_URL = "http://localhost:3001";
const TREE_LEVELS = 20;

export default function VoterView({
  votingContract,
  account,
  currentPhaseNum,
  electionConfig,
}) {
  const [activeStep, setActiveStep] = useState(1);
  const [voterRollNumber, setVoterRollNumber] = useState("");
  const [voterSalt, setVoterSalt] = useState("");
  const [generatedNote, setGeneratedNote] = useState(null);
  const [requestStatus, setRequestStatus] = useState(null);
  const [approvalsCount, setApprovalsCount] = useState(0);

  // Voting state
  const [noteJsonInput, setNoteJsonInput] = useState("");
  const [parsedNote, setParsedNote] = useState(null);
  const [loadedFileInfo, setLoadedFileInfo] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [isGeneratingProof, setIsGeneratingProof] = useState(false);
  const [proofProgress, setProofProgress] = useState("");
  const [proofDurationSec, setProofDurationSec] = useState(null);
  const [voteReceipt, setVoteReceipt] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [useDirectFallback, setUseDirectFallback] = useState(false);

  // Auto-fill note JSON if generated in same session
  useEffect(() => {
    if (generatedNote && !parsedNote) {
      setParsedNote(generatedNote);
      setNoteJsonInput(JSON.stringify(generatedNote, null, 2));
      setLoadedFileInfo({
        name: `voting_secret_note_${generatedNote.voterRollNumber || "session"}.json (Auto-loaded from Step 1)`,
        voterRollNumber: generatedNote.voterRollNumber || "Auto-detected",
        commitmentShort: generatedNote.commitment ? generatedNote.commitment.slice(0, 16) + "..." : "",
        isAutoLoaded: true,
      });
    }
  }, [generatedNote, parsedNote]);

  // Step 1 & 2: Generate Secret Note & Request 2-of-3 Validator Approvals
  const handleGenerateAndRegister = async () => {
    try {
      setErrorMsg(null);
      if (!voterRollNumber.trim()) {
        setErrorMsg("Please enter your Student ID or Roll Number.");
        return;
      }

      // 1. Locally generate ZK commitment (nullifier + secret)
      const note = await generateCommitment();
      const idInfo = generateIdentityHash(voterRollNumber.trim(), voterSalt);

      const completeNote = {
        title: electionConfig?.title || "Anonymous Voting Secret Note",
        nullifier: note.nullifier,
        secret: note.secret,
        commitment: note.commitment,
        nullifierHash: note.nullifierHash,
        identityHash: idInfo.identityHash,
        salt: idInfo.salt,
        voterRollNumber: voterRollNumber.trim(),
        createdAt: new Date().toISOString(),
      };

      setGeneratedNote(completeNote);
      setVoterSalt(idInfo.salt);

      // 2. Submit to Relayer Off-Chain Queue for Validators to review
      const res = await fetch(`${RELAYER_URL}/api/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          voterIdentifier: voterRollNumber.trim(),
          commitment: note.commitment,
          identityHash: idInfo.identityHash,
        }),
      });
      const data = await res.json();
      setRequestStatus(data.request);

      // Auto-download secret note JSON
      const blob = new Blob([JSON.stringify(completeNote, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `voting_secret_note_${voterRollNumber.trim()}.json`;
      a.click();
      URL.revokeObjectURL(url);

      setActiveStep(2);
    } catch (err) {
      setErrorMsg(err.message || "Failed to generate commitment note.");
    }
  };

  // Check validator approvals from Relayer
  const checkApprovals = async () => {
    try {
      if (!requestStatus?.id) return;
      const res = await fetch(`${RELAYER_URL}/api/requests`);
      const data = await res.json();
      const found = data.requests.find((r) => r.id === requestStatus.id);
      if (found) {
        setRequestStatus(found);
        setApprovalsCount(found.approvals.length);

        // If 2 approvals ready and not yet relayed, relay it automatically!
        if (found.approvals.length >= 2 && !found.isRelayed) {
          await submitRegistrationThroughRelayer(found);
        }
      }
    } catch (e) {
      console.warn("Could not fetch approval updates:", e);
    }
  };

  // Submit registration with 2 signatures via Relayer
  const submitRegistrationThroughRelayer = async (reqObj) => {
    try {
      setErrorMsg(null);
      const res = await fetch(`${RELAYER_URL}/api/relay/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commitment: reqObj.commitment,
          identityHash: reqObj.identityHash,
          signatures: [reqObj.approvals[0].signature, reqObj.approvals[1].signature],
          validatorAddresses: [
            reqObj.approvals[0].validator,
            reqObj.approvals[1].validator,
          ],
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setRequestStatus((prev) => ({ ...prev, isRelayed: true, txHash: data.transactionHash }));
    } catch (err) {
      setErrorMsg("Relay registration error: " + err.message);
    }
  };

  // File upload handlers for Secret Note JSON
  const processNoteFile = (file) => {
    if (!file) return;
    setErrorMsg(null);
    if (!file.name.toLowerCase().endsWith(".json")) {
      setErrorMsg("Please upload a .json file (e.g. voting_secret_note_....json).");
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target.result;
        const parsed = JSON.parse(content);
        if (!parsed.nullifier || !parsed.secret || !parsed.commitment) {
          setErrorMsg("Selected file is missing required cryptographic keys (nullifier, secret, commitment).");
          setLoadedFileInfo(null);
          setParsedNote(null);
          return;
        }
        setParsedNote(parsed);
        setNoteJsonInput(content);
        setLoadedFileInfo({
          name: file.name,
          size: file.size,
          voterRollNumber: parsed.voterRollNumber || "Extracted from Note",
          commitmentShort: parsed.commitment ? parsed.commitment.slice(0, 16) + "..." : "",
          isAutoLoaded: false,
        });
      } catch (err) {
        setErrorMsg("Failed to read JSON: " + err.message);
        setLoadedFileInfo(null);
        setParsedNote(null);
      }
    };
    reader.readAsText(file);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processNoteFile(e.dataTransfer.files[0]);
    }
  };

  // Step 3: Cast Anonymous Vote
  const handleCastVote = async () => {
    try {
      setErrorMsg(null);
      setVoteReceipt(null);

      if (!selectedCandidate) {
        setErrorMsg("Please select a candidate to vote for.");
        return;
      }

      let noteToUse = parsedNote;
      if (!noteToUse && noteJsonInput.trim()) {
        try {
          noteToUse = JSON.parse(noteJsonInput);
        } catch (e) {}
      }

      if (!noteToUse || !noteToUse.nullifier || !noteToUse.secret || !noteToUse.commitment) {
        setErrorMsg("Please upload your Secret Note JSON file before casting your vote.");
        return;
      }

      setIsGeneratingProof(true);
      const t0 = Date.now();

      // 1. Generate Groth16 zero-knowledge proof in the browser
      const proofPayload = await generateZKProofBrowser(
        votingContract,
        TREE_LEVELS,
        noteToUse,
        (msg) => setProofProgress(msg)
      );

      const genTime = ((Date.now() - t0) / 1000).toFixed(2);
      setProofDurationSec(genTime);
      setProofProgress(`zk-SNARK proof generated in ${genTime}s! Submitting anonymously...`);

      // 2. Submit via Relayer (Standard) or Direct Fallback
      if (useDirectFallback) {
        setProofProgress("Submitting directly via connected wallet (Privacy Alert: Gas payer visible)...");
        const nullifierHex = ethers.utils.hexZeroPad(
          ethers.BigNumber.from(proofPayload.nullifierHash).toHexString(),
          32
        );
        const rootHex = ethers.utils.hexZeroPad(
          ethers.BigNumber.from(proofPayload.root).toHexString(),
          32
        );

        const tx = await votingContract.vote(
          selectedCandidate,
          nullifierHex,
          rootHex,
          proofPayload.proof_a,
          proofPayload.proof_b,
          proofPayload.proof_c
        );
        const receipt = await tx.wait();
        setVoteReceipt({
          transactionHash: receipt.transactionHash,
          gasUsed: receipt.gasUsed.toNumber(),
          method: "Direct Wallet Submission",
        });
      } else {
        setProofProgress("Relaying transaction through Relayer Queue (Zero Gas, Wallet Hidden)...");
        const res = await fetch(`${RELAYER_URL}/api/relay/vote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            candidateId: selectedCandidate,
            nullifier: proofPayload.nullifierHash,
            root: proofPayload.root,
            proof_a: proofPayload.proof_a,
            proof_b: proofPayload.proof_b,
            proof_c: proofPayload.proof_c,
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        setVoteReceipt({
          transactionHash: data.transactionHash,
          gasUsed: data.gasUsed,
          method: "Anonymous Relayer (Wallet Address Never Exposed)",
        });
      }
    } catch (err) {
      console.error(err);
      setErrorMsg(err.reason || err.message || "Failed to submit anonymous vote.");
    } finally {
      setIsGeneratingProof(false);
    }
  };

  return (
    <div>
      {errorMsg && <div className="alert alert-error">⚠️ {errorMsg}</div>}

      {/* Step Navigation Wizard */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "24px" }}>
        <button
          className={`btn ${activeStep === 1 ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveStep(1)}
        >
          1. Identity & Commitment
        </button>
        <button
          className={`btn ${activeStep === 2 ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveStep(2)}
        >
          2. Validator Approval Status ({approvalsCount}/2)
        </button>
        <button
          className={`btn ${activeStep === 3 ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveStep(3)}
        >
          3. Anonymous Vote Casting
        </button>
      </div>

      {/* STEP 1: GENERATE COMMITMENT & SECRET */}
      {activeStep === 1 && (
        <div className="card">
          <div className="card-title">🔐 Step 1: Generate Voter Note & Request Registration</div>
          <div className="card-desc">
            Your cryptographic secrets (`nullifier` and `secret`) are generated locally on your
            device. Only your one-way MiMC commitment goes out to validators.
          </div>

          <div className="input-group">
            <label className="input-label">Student ID / Roll Number (Verified off-chain)</label>
            <input
              type="text"
              className="input-text"
              placeholder="e.g. 2023-CS-101"
              value={voterRollNumber}
              onChange={(e) => setVoterRollNumber(e.target.value)}
            />
          </div>

          <div className="input-group">
            <label className="input-label">Private Salt (Optional - auto-generated if blank)</label>
            <input
              type="text"
              className="input-text"
              placeholder="Keep blank for secure random 128-bit salt"
              value={voterSalt}
              onChange={(e) => setVoterSalt(e.target.value)}
            />
          </div>

          <div style={{ marginTop: "16px" }}>
            <button
              className="btn btn-primary"
              onClick={handleGenerateAndRegister}
              disabled={currentPhaseNum !== 1}
            >
              Generate Secret Note & Request Approval
            </button>
            {currentPhaseNum !== 1 && (
              <span style={{ marginLeft: "12px", fontSize: "13px", color: "var(--accent-amber)" }}>
                ⚠️ Registration is only allowed during the Registration Phase.
              </span>
            )}
          </div>
        </div>
      )}

      {/* STEP 2: VALIDATOR APPROVALS MONITOR */}
      {activeStep === 2 && (
        <div className="card">
          <div className="card-title">🛡️ Step 2: 2-of-3 Validator Multi-Signature Status</div>
          <div className="card-desc">
            A 2-of-3 threshold is enforced on-chain. Two distinct registered validators must inspect
            your ID off-chain and sign an EIP-712 typed approval over your commitment.
          </div>

          {requestStatus ? (
            <div>
              <div style={{ marginBottom: "16px" }}>
                <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>Request ID:</div>
                <code className="mono">{requestStatus.id}</code>
              </div>
              <div style={{ marginBottom: "16px" }}>
                <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>Your Commitment Leaf:</div>
                <code className="mono" style={{ fontSize: "12px", wordBreak: "break-all" }}>
                  {requestStatus.commitment}
                </code>
              </div>
              <div style={{ marginBottom: "16px" }}>
                <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>Salted Identity Hash:</div>
                <code className="mono" style={{ fontSize: "12px" }}>
                  {requestStatus.identityHash}
                </code>
              </div>

              <div style={{ marginBottom: "20px" }}>
                <strong>Approvals Collected: </strong>
                <span className={`badge ${requestStatus.approvals.length >= 2 ? "badge-success" : "badge-warning"}`}>
                  {requestStatus.approvals.length} / 2 Required
                </span>
              </div>

              <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <button className="btn btn-secondary" onClick={checkApprovals}>
                  🔄 Refresh Status
                </button>
                {requestStatus.isRelayed ? (
                  <span className="badge badge-success">
                    ✅ Inserted into On-Chain Merkle Tree (Tx: {requestStatus.txHash?.substring(0, 10)}...)
                  </span>
                ) : requestStatus.approvals.length >= 2 ? (
                  <button
                    className="btn btn-primary"
                    onClick={() => submitRegistrationThroughRelayer(requestStatus)}
                  >
                    Submit to Blockchain (Relayer Gas Sponsored)
                  </button>
                ) : (
                  <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                    Waiting for validators to sign... Switch to Validator Tab if testing locally.
                  </span>
                )}
              </div>

              {requestStatus.isRelayed && (
                <div style={{ marginTop: "20px" }}>
                  <button className="btn btn-primary" onClick={() => setActiveStep(3)}>
                    Proceed to Vote ➡️
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="alert alert-info">
              No registration request in progress. Please complete Step 1 first.
            </div>
          )}
        </div>
      )}

      {/* STEP 3: ANONYMOUS VOTE CASTING */}
      {activeStep === 3 && (
        <div className="card">
          <div className="card-title">🗳️ Step 3: Cast Anonymous Zero-Knowledge Vote</div>
          <div className="card-desc">
            Your browser generates a Groth16 zk-SNARK proof verifying you possess a leaf in the
            on-chain Merkle tree, without revealing WHICH leaf is yours. The vote is relayed so your
            wallet address is never stored on the blockchain.
          </div>

          <div className="input-group">
            <label className="input-label">Select Your Candidate</label>
            <div className="candidate-grid">
              {(electionConfig?.candidates || []).map((cand, idx) => {
                const candidateId = idx + 1;
                return (
                  <div
                    key={candidateId}
                    className={`candidate-card ${selectedCandidate === candidateId ? "selected" : ""}`}
                    onClick={() => setSelectedCandidate(candidateId)}
                  >
                    <div className="candidate-id">Option #{candidateId}</div>
                    <div className="candidate-name">{cand}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="input-group">
            <label className="input-label">Upload Your Secret Note JSON (Downloaded during Step 1)</label>
            <input
              type="file"
              ref={fileInputRef}
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  processNoteFile(e.target.files[0]);
                }
              }}
            />

            {!loadedFileInfo ? (
              <div
                className={`file-upload-box ${isDragging ? "drag-over" : ""}`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div className="file-upload-icon">📁</div>
                <div className="file-upload-title">Click to Browse or Drag & Drop Secret Note JSON</div>
                <div className="file-upload-subtitle">
                  Upload your <code>voting_secret_note_*.json</code> file to automatically extract cryptographic credentials
                </div>
              </div>
            ) : (
              <div className="file-loaded-card">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
                  <div>
                    <div style={{ fontWeight: 600, color: "var(--accent-emerald)", display: "flex", alignItems: "center", gap: "8px", fontSize: "14px" }}>
                      <span>📄</span> <span>{loadedFileInfo.name}</span>
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>
                      Student ID: <strong style={{ color: "var(--text-main)" }}>{loadedFileInfo.voterRollNumber}</strong> &nbsp;|&nbsp; 
                      Commitment: <code className="mono">{loadedFileInfo.commitmentShort}</code>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: "11px", padding: "4px 12px" }}
                    onClick={() => {
                      setLoadedFileInfo(null);
                      setParsedNote(null);
                      setNoteJsonInput("");
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                  >
                    Change File
                  </button>
                </div>
              </div>
            )}
          </div>

          <div style={{ marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px" }}>
            <input
              type="checkbox"
              id="directFallback"
              checked={useDirectFallback}
              onChange={(e) => setUseDirectFallback(e.target.checked)}
            />
            <label htmlFor="directFallback" style={{ fontSize: "13px", color: "var(--text-muted)" }}>
              Direct Fallback Submission (Bypasses Relayer, pay gas with connected wallet. Warning:
              wallet address appears in transaction sender!)
            </label>
          </div>

          <div>
            <button
              className="btn btn-primary"
              onClick={handleCastVote}
              disabled={isGeneratingProof || currentPhaseNum !== 3}
            >
              {isGeneratingProof ? (
                <>
                  <span className="spinner"></span>
                  Generating ZK Proof & Voting...
                </>
              ) : (
                "Cast Anonymous Vote"
              )}
            </button>

            {currentPhaseNum !== 3 && (
              <span style={{ marginLeft: "12px", fontSize: "13px", color: "var(--accent-amber)" }}>
                ⚠️ Voting is active only during Phase 3 (Voting Window).
              </span>
            )}
          </div>

          {/* Proof Progress Bar */}
          {isGeneratingProof && (
            <div style={{ marginTop: "16px" }}>
              <div style={{ fontSize: "13px", color: "var(--accent-cyan)", fontWeight: 600 }}>
                {proofProgress}
              </div>
              <div className="progress-bar-bg">
                <div className="progress-bar-fill" style={{ width: "85%" }}></div>
              </div>
            </div>
          )}

          {/* Vote Success Confirmation */}
          {voteReceipt && (
            <div className="alert alert-success" style={{ marginTop: "20px", display: "block" }}>
              <div style={{ fontWeight: 700, fontSize: "15px", marginBottom: "6px" }}>
                🎉 Vote Cast & Cryptographically Verified On-Chain!
              </div>
              <div style={{ fontSize: "13px", marginBottom: "4px" }}>
                <strong>Method:</strong> {voteReceipt.method}
              </div>
              <div style={{ fontSize: "13px", marginBottom: "4px" }}>
                <strong>Transaction Hash:</strong>{" "}
                <code className="mono">{voteReceipt.transactionHash}</code>
              </div>
              <div style={{ fontSize: "13px" }}>
                <strong>Gas Used:</strong> {voteReceipt.gasUsed} units |{" "}
                <strong>Client Proof Generation:</strong> {proofDurationSec}s
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
