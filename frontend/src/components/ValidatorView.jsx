import React, { useState, useEffect } from "react";
import { ethers } from "ethers";

const RELAYER_URL = "http://localhost:3001";

// Demo eligible roll list held off-chain by validators (CSV mock)
const ELIGIBLE_STUDENT_ROSTER = [
  { rollNo: "2023-CS-101", name: "David Kim", department: "Computer Science", eligible: true },
  { rollNo: "2023-CS-102", name: "Elena Rostova", department: "Information Tech", eligible: true },
  { rollNo: "2023-CS-103", name: "Farhan Qureshi", department: "Computer Science", eligible: true },
  { rollNo: "2023-CS-104", name: "Grace Hopper", department: "Computer Science", eligible: true },
  { rollNo: "STUDENT_001", name: "Sample Student 1", department: "Engineering", eligible: true },
  { rollNo: "STUDENT_002", name: "Sample Student 2", department: "Engineering", eligible: true },
];

export default function ValidatorView({
  votingContract,
  account,
  provider,
  electionConfig,
}) {
  const [requests, setRequests] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [signingReqId, setSigningReqId] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);

  const fetchRequests = async () => {
    try {
      setIsLoading(true);
      const res = await fetch(`${RELAYER_URL}/api/requests`);
      const data = await res.json();
      setRequests(data.requests || []);
    } catch (e) {
      console.error(e);
      setStatusMsg({ type: "error", text: "Could not fetch requests from Relayer service." });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests();
    const interval = setInterval(fetchRequests, 5000);
    return () => clearInterval(interval);
  }, []);

  // Check if connected wallet is one of the 3 registered validators
  const registeredValidators = (
    (electionConfig?.validators && electionConfig.validators.length > 0)
      ? electionConfig.validators
      : [
          "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
          "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
        ]
  );
  const isRegisteredValidator = registeredValidators.some(
    (v) => (v || "").toLowerCase() === (account || "").toLowerCase()
  );

  const handleSignApproval = async (request) => {
    try {
      setStatusMsg(null);
      setSigningReqId(request.id);

      if (!account) {
        throw new Error("Please connect your validator MetaMask wallet.");
      }
      if (!isRegisteredValidator) {
        throw new Error("Connected account is NOT one of the 3 registered election validators!");
      }

      const signer = provider.getSigner();
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

      // Sign EIP-712 typed signature via MetaMask
      const signature = await signer._signTypedData(domain, types, value);

      // Submit signature to Relayer
      const res = await fetch(`${RELAYER_URL}/api/requests/${request.id}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          validatorAddress: account,
          signature: signature,
        }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setStatusMsg({
        type: "success",
        text: `Approval signed! Request ${request.id} now has ${data.approvalCount}/2 approvals.`,
      });
      fetchRequests();
    } catch (err) {
      console.error(err);
      setStatusMsg({ type: "error", text: err.message || "Failed to sign approval." });
    } finally {
      setSigningReqId(null);
    }
  };

  const handleDemoApprove = async (request, validatorIndex) => {
    try {
      setStatusMsg(null);
      setSigningReqId(`${request.id}_${validatorIndex}`);
      const res = await fetch(`${RELAYER_URL}/api/requests/${request.id}/demo-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ validatorIndex }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setStatusMsg({
        type: "success",
        text: `Validator ${validatorIndex + 1} signed EIP-712 approval! Total: ${data.approvalCount}/2.`,
      });
      fetchRequests();
    } catch (err) {
      console.error(err);
      setStatusMsg({ type: "error", text: err.message || "Failed to sign approval." });
    } finally {
      setSigningReqId(null);
    }
  };

  const handleRelayRegistration = async (request) => {
    try {
      setStatusMsg(null);
      setSigningReqId(`${request.id}_relay`);
      const signatures = request.approvals.map((a) => a.signature);
      const validatorAddresses = request.approvals.map((a) => a.validator);

      const res = await fetch(`${RELAYER_URL}/api/relay/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commitment: request.commitment,
          identityHash: request.identityHash,
          signatures,
          validatorAddresses,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setStatusMsg({
        type: "success",
        text: `Voter ${request.voterIdentifier} registered on-chain in tx ${data.transactionHash.slice(0, 10)}... (Leaf Index: ${data.leafIndex})!`,
      });
      fetchRequests();
    } catch (err) {
      console.error(err);
      setStatusMsg({ type: "error", text: err.message || "Failed to relay registration." });
    } finally {
      setSigningReqId(null);
    }
  };

  return (
    <div>
      <div className="card">
        <div className="card-title">🛡️ Validator Approval Desk (2-of-3 Threshold)</div>
        <div className="card-desc">
          Validators verify real-world eligibility off-chain against student records, then sign
          an EIP-712 approval for the voter's <strong>commitment</strong> (never their wallet).
          A request becomes valid for on-chain insertion when 2 of 3 validators have signed.
        </div>

        <div style={{ marginBottom: "16px" }}>
          <strong>Your Connected Account: </strong>
          <code className="mono">{account || "Not Connected"}</code>{" "}
          {isRegisteredValidator ? (
            <span className="badge badge-success">Registered Validator</span>
          ) : (
            <span className="badge badge-warning">Observer (Not a Validator)</span>
          )}
        </div>

        {statusMsg && (
          <div className={`alert alert-${statusMsg.type === "error" ? "error" : "success"}`}>
            {statusMsg.text}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "14px" }}>
          <h3>Pending Registration Queue ({requests.length})</h3>
          <button className="btn btn-secondary" onClick={fetchRequests} disabled={isLoading}>
            {isLoading ? "Refreshing..." : "🔄 Refresh Queue"}
          </button>
        </div>

        {requests.length === 0 ? (
          <div className="alert alert-info">No pending voter registration requests in the queue.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="custom-table">
              <thead>
                <tr>
                  <th>Request ID</th>
                  <th>Student ID</th>
                  <th>Roster Status</th>
                  <th>Commitment</th>
                  <th>Approvals</th>
                  <th>On-Chain Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((req) => {
                  const rosterMatch = ELIGIBLE_STUDENT_ROSTER.find(
                    (r) => r.rollNo.toLowerCase() === req.voterIdentifier.toLowerCase()
                  );
                  const hasAlreadySigned = (req.approvals || []).some(
                    (a) => a.validator.toLowerCase() === (account || "").toLowerCase()
                  );

                  return (
                    <tr key={req.id}>
                      <td className="mono" style={{ fontSize: "12px" }}>{req.id}</td>
                      <td>
                        <strong>{req.voterIdentifier}</strong>
                        {rosterMatch && (
                          <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                            {rosterMatch.name} ({rosterMatch.department})
                          </div>
                        )}
                      </td>
                      <td>
                        {rosterMatch ? (
                          <span className="badge badge-success">Verified Eligible</span>
                        ) : (
                          <span className="badge badge-warning">Unlisted (Manual Check)</span>
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: "11px", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {req.commitment}
                      </td>
                      <td>
                        <span className={`badge ${req.approvals.length >= 2 ? "badge-success" : "badge-info"}`}>
                          {req.approvals.length} / 2
                        </span>
                      </td>
                      <td>
                        {req.isRelayed ? (
                          <span className="badge badge-success">Registered on-chain</span>
                        ) : req.approvals.length >= 2 ? (
                          <span className="badge badge-warning">Ready to relay</span>
                        ) : (
                          <span className="badge badge-info">Awaiting approvals</span>
                        )}
                      </td>
                      <td>
                        {req.isRelayed ? (
                          <span className="badge badge-success">✅ On-Chain (Leaf {req.leafIndex !== undefined ? req.leafIndex : ""})</span>
                        ) : req.approvals.length >= 2 ? (
                          <button
                            className="btn btn-primary"
                            style={{ padding: "6px 14px", fontSize: "12px", background: "#10b981", borderColor: "#10b981" }}
                            disabled={signingReqId === `${req.id}_relay`}
                            onClick={() => handleRelayRegistration(req)}
                          >
                            {signingReqId === `${req.id}_relay` ? "Submitting..." : "🚀 Submit to Blockchain"}
                          </button>
                        ) : (
                          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                            {isRegisteredValidator && (
                              <button
                                className="btn btn-secondary"
                                style={{ padding: "5px 10px", fontSize: "11px" }}
                                disabled={signingReqId === req.id || hasAlreadySigned}
                                onClick={() => handleSignApproval(req)}
                              >
                                {hasAlreadySigned ? "✅ Signed" : "Approve (MetaMask)"}
                              </button>
                            )}
                            <button
                              className="btn btn-secondary"
                              style={{ padding: "5px 10px", fontSize: "11px", background: "rgba(99, 102, 241, 0.25)", borderColor: "var(--accent-primary)" }}
                              disabled={
                                (req.approvals || []).some(
                                  (a) => a.validator.toLowerCase() === (electionConfig?.validators[0] || "").toLowerCase()
                                ) || signingReqId === `${req.id}_0`
                              }
                              onClick={() => handleDemoApprove(req, 0)}
                            >
                              {(req.approvals || []).some(
                                (a) => a.validator.toLowerCase() === (electionConfig?.validators[0] || "").toLowerCase()
                              )
                                ? "✅ Val 1 Signed"
                                : "⚡ Sign as Val 1"}
                            </button>
                            <button
                              className="btn btn-secondary"
                              style={{ padding: "5px 10px", fontSize: "11px", background: "rgba(99, 102, 241, 0.25)", borderColor: "var(--accent-primary)" }}
                              disabled={
                                (req.approvals || []).some(
                                  (a) => a.validator.toLowerCase() === (electionConfig?.validators[1] || "").toLowerCase()
                                ) || signingReqId === `${req.id}_1`
                              }
                              onClick={() => handleDemoApprove(req, 1)}
                            >
                              {(req.approvals || []).some(
                                (a) => a.validator.toLowerCase() === (electionConfig?.validators[1] || "").toLowerCase()
                              )
                                ? "✅ Val 2 Signed"
                                : "⚡ Sign as Val 2"}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
