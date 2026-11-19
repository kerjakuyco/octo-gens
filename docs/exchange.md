# The exchange

OctoNeo trades perpetual futures on one decentralised exchange, through its futures API. This page describes what the app sends, how it signs, how a wallet is connected, and how funds are deposited and withdrawn. The code is in `crates/octoneo-core/src/exchange` and `crates/octoneo-core/src/connect`.

| Network | What it is |
| --- | --- |
| Mainnet | Real funds |
| Testnet | The same order flow with test funds |

Each network has its own API origin and its own site. Both are constants at the top of [`exchange/mod.rs`](../crates/octoneo-core/src/exchange/mod.rs). The app reads the site's public API to learn what can be deposited and withdrawn, and links to the site's page for managing API wallets. You never have to visit the site to connect, deposit or withdraw.

## What the app asks the exchange

| Request | Signed | Used for |
| --- | --- | --- |
| `GET /fapi/v3/exchangeInfo` | No | The market list and each market's rules: tick size, quantity step, smallest order, maintenance margin |
| `GET /fapi/v3/ticker/24hr`, `GET /fapi/v3/premiumIndex` | No | Last price and 24h statistics; mark price, index price and funding |
| `GET /fapi/v3/klines`, `GET /fapi/v3/depth`, `GET /fapi/v3/trades` | No | Candles (15m, 1h, 4h, 1d), the order book and the latest trades |
| `GET /fapi/v3/fundingRate`, `GET /fapi/v3/fundingInfo`, `GET /fapi/v3/openInterest` | No | Settled funding rates, the hours between payments, and open interest |
| `GET /fapi/v3/time` | No | Measuring how far this computer's clock is from the exchange's |
| `GET /fapi/v3/account`, `positionRisk`, `openOrders`, `balance` | Yes | Equity, positions and open orders |
| `GET /fapi/v3/multiAssetsMargin` | Yes | Whether the account is in Multi-Assets mode, where only cross margin exists |
| `POST /fapi/v3/marginType`, `POST /fapi/v3/leverage` | Yes | Setting up a market before a new position opens |
| `POST /fapi/v3/order` | Yes | Market orders, and the stop-loss and take-profit that follow them |
| `GET /fapi/v3/order` | Yes | Looking an order up by its client id when its answer was lost |
| `DELETE /fapi/v3/order`, `DELETE /fapi/v3/allOpenOrders` | Yes | Cancelling orders |
| `POST /fapi/v3/registerAndApproveAgent` | By your wallet | Approving the app's API wallet, once |
| `GET` deposit assets, withdraw assets (site API) | No | What can be deposited and withdrawn, on which networks |
| `GET` deposit address (site API) | No | The vault a deposit goes to, compared with the one the app knows |
| `GET` withdraw fee estimate (site API) | No | What the exchange charges for a withdrawal |
| `POST /fapi/v3/…/user-withdraw-info` | Yes | What the account may withdraw now, per asset and network |
| `POST /fapi/v3/…/user-withdraw` | By your wallet, twice | A withdrawal |

A few paths carry the exchange's name; they are shortened here and spelled out in [`exchange/mod.rs`](../crates/octoneo-core/src/exchange/mod.rs).

The key the app holds cannot withdraw or transfer: it is approved without that permission, and the exchange refuses it. Funds move only by what your own wallet does in your browser, described under [Deposits and withdrawals](#deposits-and-withdrawals).

Refreshing the watchlist costs two requests however long the list is, because the ticker and funding endpoints answer for every market at once. The screener of every market costs the same two. Daily history, which draws the sparklines, is read again every ten minutes.

The market panel reads on demand, for the market on screen only and only while the window is in view: twenty levels a side of the order book and the last forty trades (every four seconds while the Book tab is open), two weeks of settled funding with open interest, and candles for a technical reading on each timeframe. `openInterest` is not in the exchange's published list of endpoints but answers on both networks; if it stops, the panel shows funding without it. Where `fundingInfo` names no interval for a market, the spacing of its last two payments is used.

Public reads are retried once when no answer arrives. Signed requests are sent exactly once.

An order's answer can go missing: no response at all, an HTTP 5xx (which the exchange documents as *execution status unknown*), or the codes `-1006` and `-1007`. The app does not read any of these as a refusal, because the order may have been taken. It asks the exchange for the order by its client id, up to three times:

- **The exchange has the order.** The app carries on as if the answer had arrived, and places the stop-loss.
- **The exchange has no such order.** The ticket says it was most likely not placed.
- **The exchange cannot be asked.** The ticket says the order may or may not exist, and gives the client id to check before sending it again.

Whatever the outcome, the message stays on the ticket.

## Markets

Only perpetual markets that are trading are listed. What you or a model type is matched without guessing:

- `BTCUSDT`, `btc/usdt`, `$BTC`, `BTC-PERP` and `btc` all mean `BTCUSDT`.
- A bare asset prefers its USDT market, then USD1, then USDC.
- A name the exchange does not list is an error. It is never replaced by something similar.

The watchlist starts with the major markets the network lists. Markets you add are remembered and shown on every network that lists them.

## How requests are signed

Account requests are signed by the **API wallet**: a secp256k1 key held in your system keychain. Your own wallet's key is never involved.

1. The parameters are URL-encoded in order, followed by `nonce` and `signer`.
   - `nonce` is the current time in microseconds, in the exchange's clock. The exchange accepts it within about a minute and never twice.
   - `signer` is the API wallet's address.
2. That exact string is signed as [EIP-712](https://eips.ethereum.org/EIPS/eip-712) typed data:

   ```
   domain   { name: <the exchange's signing domain>, version: "1", chainId, verifyingContract: 0x0000…0000 }
   type     Message(string msg)
   message  { msg: "<the parameter string>" }
   ```

   The domain's name is `DOMAIN_NAME` in [`signing.rs`](../crates/octoneo-core/src/exchange/signing.rs); your wallet shows it when you approve an API wallet. `chainId` is `1666` on mainnet and `714` on testnet, so a signature made for one network is worthless on the other.
3. The request is sent as that same string with `&signature=0x…` appended. What was signed is what is sent, byte for byte.

## Connecting a wallet

The exchange lets a wallet approve an *agent* that may trade for it. OctoNeo asks for the narrowest approval:

```
user=<your wallet>&nonce=<microseconds>&agentName=OctoNeo&agentAddress=<API wallet>
&expired=<milliseconds>&signatureChainId=56
&canSpotTrade=false&canPerpTrade=true&canWithdraw=false&ipWhitelist=
```

Your wallet signs this string as the same kind of typed data, with `chainId` `56`. `canWithdraw` is always `false`; there is no setting that changes it.

### Approving in a browser wallet

A desktop app cannot talk to a wallet extension, because extensions live in the browser. So the app serves one small page on your computer and opens it in your browser:

1. The app creates a new API wallet key and keeps it in memory.
2. It serves the approval page on `127.0.0.1`, on a random port, behind a random path, for ten minutes.
3. The page finds the wallets in your browser; when there is more than one, you pick. It connects your wallet, asks the app for the message above, and asks your wallet to sign it with `eth_signTypedData_v4`. The message carries a fresh nonce, so confirm the wallet prompt within about ten seconds.
4. The app checks that the signature came from the account that connected, sends it to the exchange, and on success stores the API wallet key in the keychain. The page shuts down.

What crosses that page is your wallet's address and one signature. The page loads nothing from the internet, answers only its own secret path and only the requests of its own task, and refuses requests that arrive under another host name. It shows each step and where you are in it, and counts down the seconds the exchange gives the signature.

To look at the page without the app, `cargo run -p octoneo-core --example wallet_page -- connect` serves it against a stand-in for the exchange.

### Pasting an API wallet key

You can instead create an API wallet on the exchange's API wallet page (`/en/api-wallet`, the *Pro API* tab) and paste its key with your wallet address. The app tries the key against the exchange before storing it. It refuses a key that belongs to the wallet address you entered: that would be your main wallet's key, which must never be pasted anywhere.

### What to expect

- **Deposit first.** The exchange answers every account request with "can only be used after deposit" until the wallet has deposited, on testnet too, and it checks this before it checks the signature. So a wallet that has never deposited is accepted and shown as *waiting for its deposit*, with a **Deposit** button; a wrong key only shows up after the deposit, as a rejected signature.
- **Expiry.** An approval made in the browser lasts as long as you chose. When it ends, the exchange rejects the key and the app asks you to connect again.
- **Disconnecting** removes the key from this computer. It does not revoke the approval on the exchange; do that on the exchange's API wallet page if you need it gone at once.
- **Hedge mode** is not supported. The app trades one net position per market and says so if the account is in hedge mode.

## Deposits and withdrawals

Funds move between your own wallet and your trading account on the exchange. Both directions start in **Settings** under *Wallet*, or on the **Account** page, and both happen on the same kind of page as the approval: served on your computer, opened in the browser where your wallet is. The code is in [`exchange/funding.rs`](../crates/octoneo-core/src/exchange/funding.rs).

| Trading network | Funds move on |
| --- | --- |
| Mainnet | BNB Smart Chain, Ethereum, Arbitrum One |
| Testnet | BNB Smart Chain Testnet, Sepolia |

The page must be opened with the wallet that is connected in the app. A deposit is credited to that wallet's account, and a withdrawal is paid out to that wallet. There is no field for another address.

### Depositing

Your wallet sends the deposit; the app only builds the transactions.

1. The page lists the networks and assets the exchange accepts now. Tokenised shares are left out.
2. You choose a network, an asset and an amount. The app checks the vault it knows for that network against the one the exchange reports at that moment. If they differ, nothing is built and the page says so.
3. For a token, your wallet first allows the vault to take **exactly that amount**, unless an earlier allowance already covers it. A network's own coin needs no allowance.
4. Your wallet sends `depositFor(token, your wallet, amount, 1)` to the vault. The last argument names the futures account.
5. The page tells the app the transaction's hash, waits for the network to confirm it, and tells the app the result. The exchange credits the account a little later, usually within a few minutes.

The deposit and its transaction hash are recorded under **Activity**. If you close the page after the wallet has sent the transaction, the deposit is still recorded, as sent but not seen confirmed. Each transaction costs the network's gas, paid by your wallet.

The vaults are constants in `funding.rs`:

| Network | Vault |
| --- | --- |
| BNB Smart Chain | `0x128463A60784c4D3f46c23Af3f65Ed859Ba87974` |
| Ethereum | `0x604DD02d620633Ae427888d41bfd15e38483736E` |
| Arbitrum One | `0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5` |
| BNB Smart Chain Testnet | `0x62904590b575ea1C3F4aC411EB6A5A3140d6956e` |
| Sepolia | `0x58D1E4C7b75450EfB2f437CE969aB8552F38371D` |

The mainnet vaults are the ones in the exchange's API documentation. The testnet vaults are the ones its testnet reports.

### Withdrawing

The exchange carries out a withdrawal only when your own wallet has signed it twice. The key the app holds takes no part.

1. The page shows what the account may withdraw now, per asset and network, with the exchange's fee and what is left of the daily limit.
2. **First signature: the withdrawal.** Your wallet signs typed data that names the amount, the fee, the network and the destination, which is your own wallet:

   ```
   domain   { name: <the exchange's withdrawal domain>, version: "1", chainId: <the network you withdraw to>, verifyingContract: 0x0000…0000 }
   type     Action(type, destination, destination Chain, token, amount, fee, nonce, <the exchange's chain field>)
   message  { type: "Withdraw", destination: <your wallet>, destination Chain: "BSC", token: "USDT", amount: "40", fee: "0.5", nonce: <microseconds>, … }
   ```

3. **Second signature: the request.** Your wallet signs the request that carries the first signature, as `Message(string msg)` in the same domain trading requests use, with `chainId` `1666` on mainnet and `714` on testnet. This proves to the exchange that you are the one asking. The request is accepted for about a minute, so confirm this prompt promptly.
4. The app checks that both signatures came from the connected wallet, sends the request once, and records the exchange's id for it under **Activity**.

If no clear answer comes back, the app does not treat that as a refusal. It tells you the withdrawal may or may not have been accepted, and to check your balance before asking again.

**Wallets and the second signature.** Its typed data names the exchange's own network (`1666` or `714`). MetaMask signs typed data only for the network it is on, and that network cannot be added to a wallet, so MetaMask refuses the second signature. Wallets that sign across networks, such as Rabby, do not. When MetaMask refuses, nothing has been sent and nothing is withdrawn; the page explains this.

## From ticket to order

A ticket is priced against the live account: the app reads the mark price and the account, then checks the order.

| Check | What happens when it fails |
| --- | --- |
| The quantity is rounded down to the market's step and must reach its smallest order and smallest value | The ticket is refused with the market's limit |
| Leverage must be within your limit (Settings, 3x by default, 50x at most) | Refused |
| On USDT-margined markets, the margin must fit in the available balance | Refused, with both figures |
| A stop-loss must be on the losing side of the price, and inside the estimated liquidation price for isolated margin | Refused |
| An order against a position may shrink or close it, never flip it | Refused; close first |
| In Multi-Assets mode the exchange allows only cross margin | The ticket uses cross margin and says so, whatever the setting is |
| A ticket from the assistant that opens or adds to a position must carry a stop-loss | Refused, and the model is told why |
| The network, the wallet and the risk limits must not change while the ticket is being priced | The ticket is discarded |

A ticket can wait while you read it, and the market does not. So when you confirm, the app checks again before it sends anything, in this order:

1. **The position.** It must be exactly as it was when the ticket was drafted: the same size and direction, and for an addition the same leverage and margin mode. Otherwise nothing is sent.
2. **The price**, for an order that opens or adds. If the mark price has moved more than 1% since the draft, or the stop-loss is no longer on the losing side of the price and inside the estimated liquidation price, nothing is sent.
3. **The market's settings.** For a new position, the margin mode and the leverage are set if they differ from the ticket.
4. **The order.** The market order goes out with the ticket's id as its client order id.
5. **Its protection.** The stop-loss and take-profit are placed as `STOP_MARKET` and `TAKE_PROFIT_MARKET` orders: reduce-only, for the quantity that filled, triggered by the mark price. Their client ids are the ticket's id with `-sl` and `-tp`.
6. **Leftovers.** If the ticket closed the whole position and the position is now flat, the reduce-only orders left on it are cancelled, so they cannot act on the next position you open in that market. After a partial fill they stay, because they still guard what is left.

The receipt says what happened, including what did not: an order that only partly filled, a stop-loss the exchange did not confirm (the position may then be open without it), or orders that could not be cancelled.

The estimated liquidation price on a ticket is `entry × (1 ∓ (1 / leverage − maintenance margin))`. It ignores fees, funding and the exchange's margin tiers, so it is a guide to how much room a stop has. The exchange's own figure appears under **Account** once the position is open. No estimate is shown for cross margin, where liquidation depends on the whole account.

## Errors

The exchange's errors are turned into something you can act on:

| The exchange says | The app says |
| --- | --- |
| `-5050` | Trading and account data start after the wallet's first deposit |
| `-1022` | The API wallet's signature was rejected; its approval may have expired or been revoked |
| `-4168` | The account is in Multi-Assets mode, which allows only cross margin; draft the ticket again |
| `-1021`, `-4225`, `-4226` | The request's timing was rejected; check this computer's clock |
| HTTP 403 | Your network or region may be blocked |
| HTTP 418 or 429 | The exchange is rate limiting the app; wait a minute |
| Anything else | The exchange's own message and code |

## Tool servers

Market data, the account and tickets need nothing but the app. If you want the assistant to read more, such as news or on-chain data, attach a [Model Context Protocol](https://modelcontextprotocol.io) server in **Settings** under *Tools*.

| Kind | What starts | Needs |
| --- | --- | --- |
| Local command | Any program that speaks MCP over stdin/stdout | The program |
| Remote | A Streamable HTTP endpoint | An HTTPS URL (plain HTTP only on this computer) |

- **Read-only rule.** The assistant may call only tools the server marks `readOnlyHint: true`. Anything else must be run by you, from the server's tool list in Settings.
- **Privacy.** Output of tool-server tools is shown for the session and never written to the journal.
- **Trust.** A local command runs with your user's permissions. Attach only servers you trust.
- **Windows.** `npx.cmd` is a shell wrapper and cannot carry a JSON-RPC stream, so the app runs `node` with `npx-cli.js` directly and refuses `.cmd` and `.bat` launchers.

## Checking against the exchange

Tests never reach the internet. They run against a stand-in for the exchange that keeps positions and orders and rejects any account request the API wallet did not sign for the right network.

```sh
cargo test -p octoneo-core                  # the stand-in, in process
pnpm tauri build --debug --no-bundle
pnpm smoke                                   # the real window against a stand-in on this computer
cargo run -p octoneo-core --example probe   # live, read-only: prices, book, trades, funding on both networks
cargo run -p octoneo-core --example funding # live, read-only: the vaults, and each deposit simulated on its chain
```

`OCTONEO_MAINNET_URL` and `OCTONEO_TESTNET_URL` point a network at another origin. The smoke test uses them. Anything you point them at receives your signed requests, so do not use them to route real trading through a server you do not control.

What has been checked against the live service so far:

| | Mainnet | Testnet |
| --- | --- | --- |
| Market list, prices, funding, candles, order book | Yes | Yes |
| Latest trades, settled funding rates, open interest | Yes | Yes |
| A wallet's approval of an API wallet | No | Yes, with throwaway keys |
| Signed account reads | No | Yes, by a funded wallet in the app |
| Orders | No | No |
| The vault on each network matches the one the exchange reports | Yes | Yes |
| A deposit, simulated on its chain without sending it | Yes | Yes |
| A deposit sent by a wallet | No | No |
| A withdrawal | No | No |

Account requests cannot be exercised without a wallet that has deposited, so orders are verified against the stand-in, which follows the exchange's API documentation.

The `funding` example asks a public node on each network to simulate the deposit the app would build. A coin deposit is accepted. A token deposit from a wallet that holds none fails inside the token, at the point where the vault collects the tokens, which shows the vault took the call. A withdrawal needs a funded wallet's own signatures, so it is verified against the stand-in and against signatures produced by an independent implementation of the same typed data, not against the live service. If a withdrawal is refused, the exchange's own words are shown and nothing has moved. If you see the exchange answer differently from what this page describes, please [open an issue](https://github.com/kerjakuyco/octo-gens/issues) with the error text.
