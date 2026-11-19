# The exchange

OctoNeo trades perpetual futures on one decentralised exchange, through its futures API. This page describes what the app sends, how it signs, and how a wallet is connected. The code is in `crates/octoneo-core/src/exchange` and `crates/octoneo-core/src/connect`.

| Network | What it is |
| --- | --- |
| Mainnet | Real funds |
| Testnet | The same order flow with test funds |

Each network has its own API origin and its own site, where you deposit and withdraw. Both are constants at the top of [`exchange/mod.rs`](../crates/octoneo-core/src/exchange/mod.rs); the app opens the site for you where it is needed.

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

The app never calls an endpoint that withdraws or transfers funds.

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
3. The page connects your wallet, asks the app for the message above, and asks your wallet to sign it with `eth_signTypedData_v4`. The message carries a fresh nonce, so confirm the wallet prompt within about ten seconds.
4. The app checks that the signature came from the account that connected, sends it to the exchange, and on success stores the API wallet key in the keychain. The page shuts down.

What crosses that page is your wallet's address and one signature. The page loads nothing from the internet, answers only its own secret path, and refuses requests that arrive under another host name.

### Pasting an API wallet key

You can instead create an API wallet on the exchange's API wallet page (`/en/api-wallet`, the *Pro API* tab) and paste its key with your wallet address. The app tries the key against the exchange before storing it. It refuses a key that belongs to the wallet address you entered: that would be your main wallet's key, which must never be pasted anywhere.

### What to expect

- **Deposit first.** The exchange answers every account request with "can only be used after deposit" until the wallet has deposited, on testnet too, and it checks this before it checks the signature. So a wallet that has never deposited is accepted and shown as *waiting for its deposit*; a wrong key only shows up after the deposit, as a rejected signature.
- **Expiry.** An approval made in the browser lasts as long as you chose. When it ends, the exchange rejects the key and the app asks you to connect again.
- **Disconnecting** removes the key from this computer. It does not revoke the approval on the exchange; do that on the exchange's API wallet page if you need it gone at once.
- **Hedge mode** is not supported. The app trades one net position per market and says so if the account is in hedge mode.

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
| `-5050` | Trading and account data start after the wallet's first deposit, with the site to deposit on |
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

Account requests cannot be exercised without a wallet that has deposited, so orders are verified against the stand-in, which follows the exchange's API documentation. If you see the exchange answer differently from what this page describes, please [open an issue](https://github.com/kerjakuyco/octo-gens/issues) with the error text.
