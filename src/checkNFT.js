const { ethers } = require("ethers");

const ABI = ["function balanceOf(address owner) view returns (uint256)"];

let sharedProvider = null;

function getProvider() {
  if (!sharedProvider) {
    sharedProvider = new ethers.JsonRpcProvider(process.env.TEMPO_RPC);
  }
  return sharedProvider;
}

async function getBalance(walletAddress, contractAddress) {
  const provider = getProvider();
  const contract = new ethers.Contract(contractAddress, ABI, provider);
  try {
    const balance = await contract.balanceOf.staticCall(walletAddress);
    return Number(balance);
  } catch (err) {
    console.error("checkNFT error: " + err.message);
    throw new Error("Could not reach Tempo chain.");
  }
}

module.exports = { getBalance };