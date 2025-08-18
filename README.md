# DeFiScanner

🔍 **DeFiScanner** is an open-source security and transparency scanner for **EVM-based tokens**.  
It analyzes smart contracts and liquidity pools to help the community spot risks early.

## Features
- 📊 **Holder Analysis** – Detects concentration among top holders (circulating vs burned/infra wallets).
- 💧 **Liquidity Safety** – Checks Uniswap V2/V3 pools, reserves, and slippage impact.
- 🛡️ **Honeypot Detection** – Flags transfer taxes and suspicious tokenomics.
- ⚡ **Quoter Simulation** – Estimates real swap slippage for $1k–$10k trades.
- 🎖️ **Badges** – Highlights tokens with Deep Liquidity, Community Safety, or Risk Flags.

## Tech Stack
- **Backend**: Node.js + Express  
- **Blockchain Access**: `ethers.js` + `viem`  
- **APIs**: Ethplorer (holders), Uniswap Subgraphs, On-chain factory queries  
- **Frontend**: Next.js + TailwindCSS (coming soon)  

## Getting Started

### Prerequisites
- Node.js >= 18  
- npm or yarn  
- An Ethplorer API key (free tier works)  

### Installation
```bash
# Clone repo
git clone https://github.com/AndrewDeFever/DeFiScanner.git
cd DeFiScanner

# Install dependencies
npm install
