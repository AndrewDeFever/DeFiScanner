# DeFiScanner

🔍 **DeFiScanner** is an open-source security and transparency scanner for **EVM-based tokens**.  
It helps traders and communities identify risks by analyzing smart contracts, liquidity pools, and token holder data.

---

## ✨ Features
- 📊 **Holder Analysis** – Detects concentration among top holders (circulating vs burned/infra wallets).  
- 💧 **Liquidity Safety** – Checks Uniswap V2/V3 pools, reserves, and slippage impact.  
- 🛡️ **Honeypot Detection** – Flags transfer taxes and suspicious tokenomics.  
- ⚡ **Quoter Simulation** – Estimates real swap slippage for $1k–$10k trades.  
- 🎖️ **Badges System** – Highlights tokens with Deep Liquidity, Community Safety, or Risk Flags.  

---

## 🛠️ Tech Stack
- **Backend**: Node.js + Express  
- **Blockchain Access**: ethers.js + viem  
- **APIs**: Ethplorer (holders), Uniswap Subgraphs, On-chain factory queries  
- **Frontend**: Next.js + TailwindCSS (coming soon)  

---

## 🚀 Getting Started

### Prerequisites
- Node.js >= 18  
- npm or yarn  
- Ethplorer API key (free tier works)  

### Installation
```bash
git clone https://github.com/AndrewDeFever/DeFiScanner.git
cd DeFiScanner
npm install
```

### Running Locally
```bash
npm run dev
```

### Example API Request
```bash
curl -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"chain":"eth","address":"0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE"}'
```

### Example Output
```json
{
  "riskScore": 11,
  "summary": [
    "Circulating top10 holders ~19.17% (burn/infra excluded).",
    "Est. slippage for $10k swap: buy 0.57%, sell 0.54%.",
    "No obvious transfer tax detected."
  ],
  "badges": ["DeFiV3", "DeepLiquidity", "CommunitySafe"]
}
```

---

## 🗺️ Roadmap
- [ ] Frontend UI (Next.js + TailwindCSS)  
- [ ] Multi-chain support (BSC, Polygon, Arbitrum…)  
- [ ] Telegram/Discord bot integration  
- [ ] Risk scoring algorithm improvements  

---

## 🤝 Contributing
Pull requests are welcome! For major changes, open an issue first to discuss your ideas.  

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
