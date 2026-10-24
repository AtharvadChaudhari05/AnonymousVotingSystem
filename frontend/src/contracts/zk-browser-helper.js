import { buildMimcSponge } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { ethers } from "ethers";
import loadWebAssembly from "./Verifier.js";

const ZERO_VALUE = ethers.BigNumber.from(
  "21663839004416932945382355908790599225266501822907911457504978515578255421292"
);

let mimcInstance = null;
export async function getMiMC() {
  if (!mimcInstance) {
    mimcInstance = await buildMimcSponge();
  }
  return mimcInstance;
}

function calculateHash(mimc, left, right) {
  return ethers.BigNumber.from(mimc.F.toString(mimc.multiHash([left, right])));
}

export async function generateCommitment() {
  const mimc = await getMiMC();
  const nullifierBytes = new Uint8Array(31);
  window.crypto.getRandomValues(nullifierBytes);
  const secretBytes = new Uint8Array(31);
  window.crypto.getRandomValues(secretBytes);

  const nullifier = ethers.BigNumber.from(nullifierBytes).toString();
  const secret = ethers.BigNumber.from(secretBytes).toString();

  const commitment = mimc.F.toString(mimc.multiHash([nullifier, secret]));
  const nullifierHash = mimc.F.toString(mimc.multiHash([nullifier]));

  return {
    nullifier,
    secret,
    commitment,
    nullifierHash,
  };
}

export function generateIdentityHash(voterIdentifier, salt) {
  const finalSalt =
    salt ||
    Array.from(window.crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const hash = ethers.utils.solidityKeccak256(
    ["string", "string"],
    [voterIdentifier, finalSalt]
  );
  return {
    identityHash: hash,
    salt: finalSalt,
  };
}

function generateZeros(mimc, levels) {
  const zeros = [];
  zeros[0] = ZERO_VALUE;
  for (let i = 1; i <= levels; i++) {
    zeros[i] = calculateHash(mimc, zeros[i - 1], zeros[i - 1]);
  }
  return zeros;
}

export function calculateMerkleRootAndPath(mimc, levels, elements, targetElement) {
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
      const right =
        i * 2 + 1 < prevLayer.length ? prevLayer[i * 2 + 1] : zeros[level - 1];
      layers[level][i] = calculateHash(mimc, left, right);
    }
  }

  const root = layers[levels].length > 0 ? layers[levels][0] : zeros[levels - 1];

  let pathElements = [];
  let pathIndices = [];

  if (targetElement) {
    const bne = ethers.BigNumber.from(targetElement);
    let index = layers[0].findIndex((e) => ethers.BigNumber.from(e).eq(bne));
    if (index === -1) throw new Error("Commitment leaf not found in on-chain Merkle tree");

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

export async function calculateMerkleRootAndPathFromContract(
  contract,
  levels,
  targetCommitment
) {
  const mimc = await getMiMC();
  const filter = contract.filters.Commit();
  const events = await contract.queryFilter(filter);
  const commitments = events.map((e) => ethers.BigNumber.from(e.args.commitment));
  return calculateMerkleRootAndPath(mimc, levels, commitments, targetCommitment);
}

export function parseSolidityCalldata(calldataStr) {
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

export async function generateZKProofBrowser(
  contract,
  levels,
  commitmentNote,
  onProgress
) {
  if (onProgress) onProgress("Reconstructing on-chain Merkle tree...");
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

  if (onProgress) onProgress("Loading circuit parameters & generating witness...");
  const wasmBuffer = loadWebAssembly().buffer;
  const zkeyUrl = "/verifier.zkey";

  if (onProgress) onProgress("Computing Groth16 zero-knowledge proof (AltBn128)...");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    wasmBuffer,
    zkeyUrl
  );

  if (onProgress) onProgress("Formatting Solidity calldata...");
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
