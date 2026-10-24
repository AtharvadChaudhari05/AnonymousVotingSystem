const crypto = require("crypto");
const snarkjs = require("snarkjs");
const { buildMimcSponge } = require("circomlibjs");
const { ethers } = require("ethers");
const path = require("path");

const ZERO_VALUE = ethers.BigNumber.from(
  "21663839004416932945382355908790599225266501822907911457504978515578255421292"
);

// Load the compiled WASM buffer from circuits/Verifier.js
let wasmBufferCache = null;
function getVerifierWASM() {
  if (!wasmBufferCache) {
    const loadWebAssembly = require(path.join(__dirname, "../circuits/Verifier.js"));
    wasmBufferCache = loadWebAssembly().buffer;
  }
  return wasmBufferCache;
}

let mimcCache = null;
async function getMiMC() {
  if (!mimcCache) {
    mimcCache = await buildMimcSponge();
  }
  return mimcCache;
}

function calculateHash(mimc, left, right) {
  return ethers.BigNumber.from(mimc.F.toString(mimc.multiHash([left, right])));
}

/**
 * Generate a new commitment note for a voter
 */
async function generateCommitment() {
  const mimc = await getMiMC();
  // 31 bytes ensures the value is strictly less than the AltBn128 scalar field prime
  const nullifier = ethers.BigNumber.from(crypto.randomBytes(31)).toString();
  const secret = ethers.BigNumber.from(crypto.randomBytes(31)).toString();
  const commitment = mimc.F.toString(mimc.multiHash([nullifier, secret]));
  const nullifierHash = mimc.F.toString(mimc.multiHash([nullifier]));
  return {
    nullifier,
    secret,
    commitment,
    nullifierHash,
  };
}

/**
 * Salted hash of a voter's real-world identity (e.g., student roll number + salt)
 */
function generateIdentityHash(voterIdentifier, salt) {
  const finalSalt = salt || crypto.randomBytes(16).toString("hex");
  const hash = ethers.utils.solidityKeccak256(
    ["string", "string"],
    [voterIdentifier, finalSalt]
  );
  return {
    identityHash: hash,
    salt: finalSalt,
  };
}

/**
 * Generate zero nodes for MiMC Merkle tree of given levels
 */
function generateZeros(mimc, levels) {
  const zeros = [];
  zeros[0] = ZERO_VALUE;
  for (let i = 1; i <= levels; i++) {
    zeros[i] = calculateHash(mimc, zeros[i - 1], zeros[i - 1]);
  }
  return zeros;
}

/**
 * Calculates Merkle root and proof path for an element
 */
function calculateMerkleRootAndPath(mimc, levels, elements, targetElement) {
  const capacity = 2 ** levels;
  if (elements.length > capacity) throw new Error("Tree capacity exceeded");

  const zeros = generateZeros(mimc, levels);
  const layers = [];
  layers[0] = elements.slice();

  for (let level = 1; level <= levels; level++) {
    layers[level] = [];
    const prevLayer = layers[level - 1];
    for (let i = 0; i < Math.ceil(prevLayer.length / 2); i++) {
      const left = prevLayer[i * 2];
      const right = i * 2 + 1 < prevLayer.length ? prevLayer[i * 2 + 1] : zeros[level - 1];
      layers[level][i] = calculateHash(mimc, left, right);
    }
  }

  const root = layers[levels].length > 0 ? layers[levels][0] : zeros[levels - 1];

  let pathElements = [];
  let pathIndices = [];

  if (targetElement) {
    const bne = ethers.BigNumber.from(targetElement);
    let index = layers[0].findIndex((e) => ethers.BigNumber.from(e).eq(bne));
    if (index === -1) throw new Error("Target commitment leaf not found in tree");

    for (let level = 0; level < levels; level++) {
      pathIndices[level] = index % 2;
      pathElements[level] =
        (index ^ 1) < layers[level].length ? layers[level][index ^ 1] : zeros[level];
      index >>= 1;
    }
  }

  return {
    root: root.toString(),
    pathElements: pathElements.map((v) => v.toString()),
    pathIndices: pathIndices.map((v) => v.toString()),
  };
}

/**
 * Query Commit events from contract to reconstruct the tree and build proof path
 */
async function calculateMerkleRootAndPathFromContract(contract, levels, targetCommitment) {
  const mimc = await getMiMC();
  const filter = contract.filters.Commit();
  const events = await contract.queryFilter(filter);
  const commitments = events.map((e) => ethers.BigNumber.from(e.args.commitment));
  return calculateMerkleRootAndPath(mimc, levels, commitments, targetCommitment);
}

/**
 * Parse snarkjs exportSolidityCallData output
 */
function parseSolidityCalldata(calldataStr) {
  const argv = calldataStr
    .replace(/["[\]\s]/g, "")
    .split(",")
    .map((x) => ethers.BigNumber.from(x).toString());

  const a = [argv[0], argv[1]];
  const b = [
    [argv[2], argv[3]],
    [argv[4], argv[5]],
  ];
  const c = [argv[6], argv[7]];
  const input = [argv[8], argv[9]];

  return { a, b, c, input };
}

/**
 * Generate Groth16 zero-knowledge proof for anonymous vote
 */
async function generateZKProof(contract, levels, commitmentNote, zkeyPath) {
  const rootAndPath = await calculateMerkleRootAndPathFromContract(
    contract,
    levels,
    commitmentNote.commitment
  );

  const circuitInput = {
    nullifier: commitmentNote.nullifier,
    secret: commitmentNote.secret,
    pathElements: rootAndPath.pathElements,
    pathIndices: rootAndPath.pathIndices,
  };

  const finalZkeyPath = zkeyPath || path.join(__dirname, "../circuits/verifier.zkey");
  const wasmBuffer = getVerifierWASM();

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    wasmBuffer,
    finalZkeyPath
  );

  const rawCallData = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const cd = parseSolidityCalldata(rawCallData);

  return {
    nullifierHash: publicSignals[0],
    root: publicSignals[1],
    proof_a: cd.a,
    proof_b: cd.b,
    proof_c: cd.c,
  };
}

/**
 * EIP-712 Sign a voter's commitment approval with a validator wallet
 */
async function signVoterApproval(validatorSigner, contractAddress, chainId, commitment, identityHash) {
  const domain = {
    name: "AnonymousVotingSystem",
    version: "1",
    chainId: chainId,
    verifyingContract: contractAddress,
  };

  const types = {
    VoterApproval: [
      { name: "commitment", type: "bytes32" },
      { name: "identityHash", type: "bytes32" },
    ],
  };

  const value = {
    commitment: ethers.utils.hexZeroPad(ethers.BigNumber.from(commitment).toHexString(), 32),
    identityHash: identityHash,
  };

  const signature = await validatorSigner._signTypedData(domain, types, value);
  return signature;
}

module.exports = {
  getMiMC,
  getVerifierWASM,
  generateCommitment,
  generateIdentityHash,
  calculateMerkleRootAndPath,
  calculateMerkleRootAndPathFromContract,
  generateZKProof,
  signVoterApproval,
  parseSolidityCalldata,
};
