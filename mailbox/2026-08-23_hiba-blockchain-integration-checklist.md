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

## 部署結果（2026-08-23，同日完成）

使用者確認要從頭部署，選定 Sepolia（本機連不到 `env.json` 設定的區網 Anvil `192.168.1.60:8545`）、公開免申請 RPC `https://ethereum-sepolia-rpc.publicnode.com`、使用者自有錢包（`0x482D8AAd1cfa61996f631e6682B09a4E8a6D9F91`，部署前餘額 8.074 ETH）簽署。

安全處理：私鑰貼出後先用 `ethers.Wallet` 驗證確實對應該地址，再**只**寫入 `hiba-core/.env.local`（已在 commit `eb3350e` 補上 `.gitignore` 排除規則），從頭到尾沒有寫進 `env.json` 或任何會被 git 追蹤的檔案。本機沒有 `forge`/`anvil`，改用 Node.js（`solc` + `ethers`，裝在 scratchpad，不在任一 repo 內）編譯並部署，繞過裝 Foundry 的需求。

| 合約 | 地址 | 部署 tx |
|---|---|---|
| `FileProtectionContract` | `0x3366D83cd1C7F3f65006C4c176d5F4a4DA45a488` | `0xc533e2e7645a9c6b12c486c828053784124bc27a5e40324f5d76ce0a3d4f5353` |
| `TPMDeviceRegistry` | `0x0968dc3b04Ed6a97280F56358F210d738aA86441` | `0x29b352ef83347bfa02988261b554ba94eb52e7986089e8d157311333099d6428` |

部署後跑了端對端功能驗證（非只是查 bytecode 存在）：`FileProtectionContract.storeFile()` 寫入一筆測試檔案 metadata 並 mined 成功；`TPMDeviceRegistry.registerDevice()` 註冊一個測試 TPM fingerprint，`isDeviceRegistered()`／`getPublicKey()` 讀回結果與寫入值完全一致。部署+驗證共花費約 0.0054 ETH gas（餘額 8.074 → 8.0686）。

`hiba-core/.env.local` 現在同時持有 RPC／私鑰／兩個合約地址，`SystemConfigurationLoader` 會優先讀這些環境變數（見上方需要提供的資料表），`env.json` 本身維持空字串不動——啟動 Java 服務前記得先把 `.env.local` 的內容 export 進行程序環境（這個 repo 沒有 dotenv 自動載入機制）。

## 待辦 / 已知落差

- 私鑰不可入庫（`docs/BLOCKCHAIN.md` 已明確警告）——已處理，見上方部署結果段落。
- 這批工作在 `Desktop\hiba`（獨立 git repo，Java/Maven），跟本 repo（HiBA-AB）技術棧不同、也不共用 git 歷史。
- 已補上 `run-with-blockchain-env.sh`（commit `14f29b7`，`Desktop\hiba` 根目錄）：載入 `.env.local` 進程序環境、必要時跑 `make package`、再啟動 `output/hiba-core-*.jar`；並且會檢查 `.env.local` 是否意外被 git 追蹤，追蹤到就直接拒絕執行。

## 端對端驗證（2026-08-23，同日完成）

這台機器原本沒裝 JDK／Maven（`Get-Command java`／`mvn` 在 Bash 跟 PowerShell 都找不到），已補上：
- JDK 21（Eclipse Temurin，`winget install EclipseAdoptium.Temurin.21.JDK`，裝在系統預設路徑 `C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot`）
- Maven 3.9.16（winget 沒有官方套件，改用 Apache 官方 zip 手動解壓到 `C:\Users\gslab\tools\apache-maven-3.9.16`）

`run-with-blockchain-env.sh` 更新為：找不到 `java`/`mvn` 在 PATH 上時，自動 fallback 去上述路徑找（因為新裝的工具不會立刻反映在既有 shell session 的 PATH 裡）。

實際跑了一次 `./run-with-blockchain-env.sh`（`AutoTrackStarter` 完整開機，非只是查設定），log 確認：
- `Web3jBlockchainServiceImpl` 成功連上 Sepolia（`Connected to network: 11155111`），讀到的 `Contract address`／`Account address` 跟 `.env.local` 一致，不是 `env.json` 的空字串。
- `TPMDeviceRegistryConfig` 印出的 Blockchain Configuration 區塊同樣讀到正確的 RPC／合約地址／Chain ID；私鑰在 log 裡只顯示前 6 碼（`a5a24a***`），沒有外洩。
- `TPMService`（原本擔心因為沒有實體 TPM/swtpm 而初始化失敗）意外地順利通過，"Shared TPMService instance initialized successfully"——看起來有軟體 fallback，不用額外處理。
- `HiBAHttpRequestServer` 正常在 8092 啟動；唯一噴出的例外是 `lscpu: command not found`（CPU 效能評測嘗試呼叫 Linux 專用指令，Windows 上不存在），跟區塊鏈無關、不影響其他服務，屬於既有小毛病，不在這次範圍內處理。

驗證完成後已手動 `kill` 掉這個 process（會佔用本機 8092 port 並寫入 `hiba-core/blockchain_file_protect.db`，純粹是這次驗證用，沒必要留著跑）。
- 部署用的錢包餘額還有 8 ETH 測試幣，之後若要棄用這把私鑰，記得先把餘額轉走。
