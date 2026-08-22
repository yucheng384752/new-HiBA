# 補齊 HiBA（Java，`C:\Users\gslab\Desktop\hiba`）區塊鏈整合所需資料

## Context

`CLAUDE.md` 深度掃描摘要已核實：`hiba-core/env.json` 裡 `BlockchainFileProtect.contractAddress`／`.privateKey`、`BlockchainTPMRegistry.contractAddress`／`.privateKey` 目前皆為空字串，即便 `HiBANetwork.BlockchainFileProtect` 開關已是 `true`。這篇記錄回答「要接上區塊鏈還缺什麼」，只做盤點，沒有實際部署（部署需要 `forge`/`anvil` 或 Sepolia 帳號，屬於使用者要執行的步驟）。

現況核實：`hiba-core/contract/` 底下只有兩份 `.sol` 原始碼（`FileMetadataContract.sol`、`TPMDeviceRegistry.sol`），沒有任何 `.abi`/`.bin` 編譯產物，代表**合約從未部署過**，不只是設定沒填。

## 需要提供的資料

兩個獨立合約各自需要一組地址＋私鑰，共用同一個 RPC 端點：

| 項目 | 說明 | 目前狀態 |
|---|---|---|
| RPC 端點 | 以太坊節點的 JSON-RPC URL | `env.json` 已填 `http://192.168.1.60:8545`（`networkID: 31337`，本地 Anvil）；也可改用 Sepolia 測試網 |
| `BlockchainFileProtect.contractAddress` | `FileProtectionContract` 部署後的合約地址 | 空，待部署後填入 |
| `BlockchainFileProtect.privateKey` | 用來簽署上鏈交易的帳戶私鑰（需有測試幣支付 gas） | 空，待提供 |
| `BlockchainTPMRegistry.contractAddress` | `TPMDeviceRegistry` 部署後的合約地址 | 空，待部署後填入 |
| `BlockchainTPMRegistry.privateKey` | 同上，TPM 設備註冊用的簽署私鑰（可與上面共用同一把，也可分開） | 空，待提供 |

## 部署合約需要誰先做什麼

合約地址不是憑空填的，要先部署才有：

1. 準備一個有測試幣的帳戶私鑰（本地 Anvil 預設帳戶自帶測試幣；Sepolia 需要自己去 faucet 領）。
2. 用 Foundry 部署兩份合約（`docs/BLOCKCHAIN.md` §5 已有現成指令樣板）：
   ```bash
   forge create --rpc-url <RPC_URL> --private-key <PRIVATE_KEY> \
       hiba-core/contract/FileMetadataContract.sol:FileProtectionContract
   forge create --rpc-url <RPC_URL> --private-key <PRIVATE_KEY> \
       hiba-core/contract/TPMDeviceRegistry.sol:TPMDeviceRegistry
   ```
   （Sepolia 部署要加 `--optimizer-runs 200`，否則合約體積會超過 `max initcode size`。）
3. 把 `forge create` 印出的合約地址填回 `env.json` 對應欄位；私鑰同一組直接填入。
4. （選用）用 `web3j generate solidity` 從 ABI/BIN 產生 Java 包裝類——`FileProtectionContract.java` 已經在 repo 裡了，只有換合約版本才需要重產生。

## 待辦 / 已知落差

- 私鑰不可入庫（`docs/BLOCKCHAIN.md` 已明確警告）。要提供的私鑰應該用環境變數傳入（`TPM_DEVICE_REGISTRY_PRIVATE_KEY` 等），不要直接寫進 `env.json` 再一起 commit——`env.json` 目前是明碼放兩把私鑰欄位的設計，之後若要真的填值，建議連同 `.gitignore`/機密管理方式一併檢查，這不在這次盤點範圍內，先記著。
- 這批工作在 `Desktop\hiba`（獨立 git repo，Java/Maven），跟本 repo（HiBA-AB）技術棧不同、也不共用 git 歷史；填完 `env.json` 之後的驗證方式（例如跑哪個測試/腳本確認上鏈成功）還沒盤點，需要時再展開。
