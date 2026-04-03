const { ethers } = require("ethers");

const ABI = ["function balanceOf(address owner) view returns (uint256)"];

async function getBalance(walletAddress, contractAddress) {
  const provider = new ethers.JsonRpcProvider(process.env.TEMPO_RPC);
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