const hre = require("hardhat");
const { ethers } = hre;
const { mimcSpongecontract } = require("circomlibjs");
const fs = require("fs");
const path = require("path");

const SEED = "mimcsponge";
const TREE_LEVELS = 20;

async function main() {
  console.log("=================================================");
  console.log("  ANONYMOUS VOTING SYSTEM - CONTRACT DEPLOYMENT  ");
  console.log("=================================================");

  const configPath = path.join(__dirname, "../election.config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error("election.config.json not found!");
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  const [deployer, validator1, validator2, validator3, relayerSigner] =
    await ethers.getSigners();

  console.log(`Deployer Account: ${deployer.address}`);
  console.log(`Network: ${hre.network.name} (Chain ID: ${(await ethers.provider.getNetwork()).chainId})`);

  const validators = [
    validator1.address,
    validator2.address,
    validator3.address,
  ];

  console.log(`Configured Validators (3):`);
  validators.forEach((v, idx) => console.log(`  [Validator ${idx + 1}]: ${v}`));

  // 1. Deploy MiMC Sponge Hasher
  console.log("\n1. Deploying MiMCSponge Hasher contract...");
  const MiMCSpongeFactory = new ethers.ContractFactory(
    mimcSpongecontract.abi,
    mimcSpongecontract.createCode(SEED, 220),
    deployer
  );
  const mimcsponge = await MiMCSpongeFactory.deploy();
  await mimcsponge.deployed();
  console.log(`   MiMCSponge Hasher deployed at: ${mimcsponge.address}`);

  // 2. Deploy Groth16 Verifier
  console.log("\n2. Deploying Groth16 Verifier contract...");
  const VerifierFactory = await ethers.getContractFactory("Verifier", deployer);
  const verifier = await VerifierFactory.deploy();
  await verifier.deployed();
  console.log(`   Groth16 Verifier deployed at: ${verifier.address}`);

  // 3. Compute Phase Timestamps
  const currentBlock = await ethers.provider.getBlock("latest");
  const nowTs = currentBlock.timestamp;
  const regDuration = config.timing.registrationDurationSeconds || 300;
  const pauseDuration = config.timing.pauseBetweenRegistrationAndVotingSeconds || 5;
  const voteDuration = config.timing.votingDurationSeconds || 300;

  const regStart = nowTs; // starts immediately
  const regEnd = regStart + regDuration;
  const voteStart = regEnd + pauseDuration;
  const voteEnd = voteStart + voteDuration;

  console.log("\n3. Deployment Schedule:");
  console.log(`   Registration: ${new Date(regStart * 1000).toLocaleTimeString()} -> ${new Date(regEnd * 1000).toLocaleTimeString()} (${regDuration}s)`);
  console.log(`   Voting:       ${new Date(voteStart * 1000).toLocaleTimeString()} -> ${new Date(voteEnd * 1000).toLocaleTimeString()} (${voteDuration}s)`);

  // 4. Deploy AnonymousVotingSystem
  console.log("\n4. Deploying AnonymousVotingSystem (No Admin, Immutable Config)...");
  const VotingSystemFactory = await ethers.getContractFactory("AnonymousVotingSystem", deployer);
  const votingSystem = await VotingSystemFactory.deploy(
    TREE_LEVELS,
    mimcsponge.address,
    verifier.address,
    config.electionTitle,
    config.candidates,
    validators,
    config.approvalThreshold,
    regStart,
    regEnd,
    voteStart,
    voteEnd
  );
  await votingSystem.deployed();
  console.log(`   AnonymousVotingSystem deployed at: ${votingSystem.address}`);

  // Advance 2 seconds and mine a block on local node so phase is active
  try {
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);
  } catch (e) {}

  // 5. Save contract deployment artifacts
  const deploymentInfo = {
    network: hre.network.name,
    chainId: (await ethers.provider.getNetwork()).chainId,
    deployedAt: new Date().toISOString(),
    votingSystemAddress: votingSystem.address,
    mimcspongeAddress: mimcsponge.address,
    verifierAddress: verifier.address,
    validators: validators,
    relayerAddress: relayerSigner ? relayerSigner.address : null,
    electionTitle: config.electionTitle,
    candidates: config.candidates,
    approvalThreshold: config.approvalThreshold,
    regStart,
    regEnd,
    voteStart,
    voteEnd,
    abi: JSON.parse(votingSystem.interface.format("json")),
  };

  const outputPath = path.join(__dirname, "../deployed-contracts.json");
  fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\nDeployment details successfully written to: ${outputPath}`);

  // Also write to frontend if frontend directory exists
  const frontendContractsDir = path.join(__dirname, "../frontend/src/contracts");
  if (!fs.existsSync(frontendContractsDir)) {
    fs.mkdirSync(frontendContractsDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(frontendContractsDir, "deployed-contracts.json"),
    JSON.stringify(deploymentInfo, null, 2)
  );

  console.log("=================================================");
  console.log("               DEPLOYMENT COMPLETE               ");
  console.log("=================================================\n");

  return votingSystem.address;
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = main;
