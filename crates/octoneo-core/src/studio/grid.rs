//! Grid bots on the desk: preview, launch, the regular look at the exchange, stop and delete,
//! and the grid bot the assistant drafts for the trader to start.
//!
//! All work that sends grid orders is serialised by one lock, so a background look at the
//! exchange never interleaves with a start or a stop.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use chrono::{SecondsFormat, Utc};
use rust_decimal::Decimal;

use crate::error::Result;
use crate::exchange::{ExchangeClient, OrderKind, OrderRequest};
use crate::grid::{
    Ended, Fill, GridBot, GridDirection, GridLevel, GridStatus, OrderFate, SyncDecision, closes_at_start,
    compute_levels, estimate_grid_liquidation, plan_initial_deployment, plan_sync, profit_per_grid_pct,
    size_per_grid, validate_triggers,
};
use crate::model::{Market, Network, Side, cents, decimal_text, money, positive, price_text};
use crate::studio::view::{
    GridBotView, GridDraftView, GridLevelView, GridPreviewView, GridRequest, Snapshot, StepView,
};
use crate::studio::{Studio, new_id, timed};
use crate::{bail, desk_err};

/// Estimated one-way maker fee fraction (0.02% = 0.0002).
fn maker_fee_rate() -> Decimal {
    Decimal::new(2, 4)
}

fn optional_positive(raw: Option<&str>, label: &str) -> Result<Option<Decimal>> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(text) => {
            positive(text).map(Some).map_err(|_| desk_err!("Enter a valid positive number for {label}."))
        }
    }
}

/// "1 order", "3 orders".
fn counted(count: usize, one: &str, many: &str) -> String {
    if count == 1 { format!("1 {one}") } else { format!("{count} {many}") }
}

/// A level with no order on it.
fn empty(level: &mut GridLevel) {
    level.order_id = None;
    level.client_id = None;
    level.side = None;
    level.closing = false;
}

/// A grid bot the assistant drafted, with the desk it was drafted under.
pub(super) struct GridDraft {
    pub view: GridDraftView,
    /// A change of network, wallet or limits since then makes the draft stale.
    pub epoch: u64,
}

struct PreparedGrid {
    network: Network,
    market: Market,
    mark: Decimal,
    direction: GridDirection,
    spacing: crate::grid::GridSpacing,
    lower: Decimal,
    upper: Decimal,
    grids: u32,
    leverage: u32,
    isolated: bool,
    margin: Decimal,
    qty_per_grid: Decimal,
    notional_per_grid: Decimal,
    min_margin: Decimal,
    levels: Vec<Decimal>,
    initial_leg: Option<(Side, Decimal)>,
    ladder: Vec<(usize, Side, Decimal)>,
    trigger_price: Option<Decimal>,
    stop_upper: Option<Decimal>,
    stop_lower: Option<Decimal>,
    close_on_stop: bool,
    post_only: bool,
    est_liq_long: Option<Decimal>,
    est_liq_short: Option<Decimal>,
    warnings: Vec<String>,
    wallet_connected: bool,
    available_margin: Option<Decimal>,
}

impl PreparedGrid {
    fn inside_range(&self) -> bool {
        self.lower <= self.mark && self.mark <= self.upper
    }
}

impl Studio {
    /// Whether a grid bot is waiting or running on a market.
    fn active_bot_on(&self, network: Network, symbol: &str) -> bool {
        self.state().grids.iter().any(|bot| {
            bot.network == network
                && bot.symbol == symbol
                && matches!(bot.status, GridStatus::Waiting | GridStatus::Running)
        })
    }

    async fn prepare_grid_plan(&self, request: &GridRequest) -> Result<PreparedGrid> {
        let (network, risk) = {
            let state = self.state();
            (state.network, (state.prefs.max_leverage, state.prefs.isolated))
        };
        let (max_leverage, default_isolated) = risk;

        if request.leverage < 1 || request.leverage > max_leverage {
            bail!(
                "Leverage {}x is above your limit of {}x. You can raise the limit in Settings, under Trading.",
                request.leverage,
                max_leverage
            );
        }

        let client = self.client(network);
        let market = client.market(&request.symbol).await?;
        let lower = positive(&request.lower_price)
            .map_err(|_| desk_err!("Enter a positive number for the lower price."))?;
        let upper = positive(&request.upper_price)
            .map_err(|_| desk_err!("Enter a positive number for the upper price."))?;
        let margin = positive(&request.margin)
            .map_err(|_| desk_err!("Enter a positive USDT amount for the initial margin."))?;
        let trigger_price = optional_positive(request.trigger_price.as_deref(), "trigger price")?
            .map(|p| market.round_price(p));
        let stop_upper = optional_positive(request.stop_upper.as_deref(), "stop-upper price")?
            .map(|p| market.round_price(p));
        let stop_lower = optional_positive(request.stop_lower.as_deref(), "stop-lower price")?
            .map(|p| market.round_price(p));

        let lower = market.round_price(lower);
        let upper = market.round_price(upper);
        let levels = compute_levels(lower, upper, request.grids, request.spacing, &market)?;
        validate_triggers(lower, upper, stop_lower, stop_upper)?;

        let mark = match client.premium(&market.symbol).await {
            Ok(p) => p.mark,
            Err(_) => {
                let state = self.state();
                state
                    .quotes
                    .get(&market.symbol)
                    .map(|q| q.reference())
                    .ok_or_else(|| desk_err!("Could not read the price of {} right now.", market.base))?
            }
        };

        let wallet_connected = client.wallet().is_some();
        let account = if wallet_connected { self.fetch_account(network).await.ok() } else { None };
        let multi_assets = account.as_ref().is_some_and(|a| a.multi_assets);
        let isolated = default_isolated && !multi_assets;
        let available_margin = account.as_ref().map(|a| a.available);

        let (qty_per_grid, notional_per_grid, min_margin) =
            size_per_grid(margin, request.leverage, &levels, mark, &market)?;

        let ref_deploy_price = trigger_price.unwrap_or(mark);
        let (initial_leg, ladder) =
            plan_initial_deployment(request.direction, &levels, ref_deploy_price, qty_per_grid);
        let (est_liq_long, est_liq_short) = estimate_grid_liquidation(
            request.direction,
            lower,
            upper,
            ref_deploy_price,
            request.leverage,
            isolated,
            &market,
        );

        let mut warnings = Vec::new();
        if !wallet_connected {
            warnings.push("Connect a wallet to start a grid bot.".to_string());
        } else if let Some(avail) = available_margin
            && margin > avail
        {
            warnings.push(format!(
                "The margin, {} {}, is more than your free balance, {} {}.",
                money(margin),
                market.quote,
                money(avail),
                market.quote
            ));
        }
        if ref_deploy_price < lower || ref_deploy_price > upper {
            warnings.push("The price is outside this range, so every order starts on one side.".to_string());
        }
        let (min_pct, _) = profit_per_grid_pct(&levels);
        if min_pct <= 0.05 {
            warnings.push(format!(
                "Each grid earns only {min_pct:.2}% after fees. Use fewer grids or a wider range."
            ));
        }
        if multi_assets && default_isolated {
            warnings.push("Your account uses Multi-Assets mode, so this bot uses cross margin.".to_string());
        }
        // One net position per market: the grid's orders add to and take from whatever is held there.
        if let Some(position) = account.as_ref().and_then(|a| a.position(&market.symbol)) {
            warnings.push(format!(
                "You already hold a {} {} {}. The bot trades that same position, and stopping it with Close position closes all of it.",
                decimal_text(position.amount.abs()),
                market.base,
                if position.is_long() { "long" } else { "short" },
            ));
        }
        if self.active_bot_on(network, &market.symbol) {
            warnings.push(format!(
                "A grid bot is already running on {}. Stop it before starting another on the same market.",
                market.base
            ));
        }

        Ok(PreparedGrid {
            network,
            market,
            mark,
            direction: request.direction,
            spacing: request.spacing,
            lower,
            upper,
            grids: request.grids,
            leverage: request.leverage,
            isolated,
            margin,
            qty_per_grid,
            notional_per_grid,
            min_margin,
            levels,
            initial_leg,
            ladder,
            trigger_price,
            stop_upper,
            stop_lower,
            close_on_stop: request.close_on_stop.unwrap_or(true),
            post_only: request.post_only.unwrap_or(true),
            est_liq_long,
            est_liq_short,
            warnings,
            wallet_connected,
            available_margin,
        })
    }

    fn preview_of(plan: PreparedGrid) -> GridPreviewView {
        let (profit_min, profit_max) = profit_per_grid_pct(&plan.levels);
        let buy_orders = plan.ladder.iter().filter(|(_, s, _)| *s == Side::Buy).count() as u32;
        let sell_orders = plan.ladder.iter().filter(|(_, s, _)| *s == Side::Sell).count() as u32;

        let side_by_idx: HashMap<usize, Side> =
            plan.ladder.iter().map(|&(idx, side, _)| (idx, side)).collect();
        let levels: Vec<GridLevelView> = plan
            .levels
            .iter()
            .enumerate()
            .map(|(index, &p)| GridLevelView {
                index,
                price: decimal_text(p),
                side: side_by_idx.get(&index).copied(),
                order_id: None,
                filled_count: 0,
            })
            .collect();

        let total_notional = (plan.qty_per_grid * plan.mark * Decimal::from(plan.grids)).round_dp(2);

        GridPreviewView {
            network: plan.network,
            symbol: plan.market.symbol,
            base: plan.market.base,
            quote: plan.market.quote,
            mark_price: decimal_text(plan.mark),
            direction: plan.direction,
            spacing: plan.spacing,
            lower_price: decimal_text(plan.lower),
            upper_price: decimal_text(plan.upper),
            grids: plan.grids,
            leverage: plan.leverage,
            isolated: plan.isolated,
            margin: decimal_text(cents(plan.margin)),
            qty_per_grid: decimal_text(plan.qty_per_grid),
            notional_per_grid: decimal_text(cents(plan.notional_per_grid)),
            total_notional: decimal_text(cents(total_notional)),
            min_margin: decimal_text(cents(plan.min_margin)),
            profit_per_grid_min_pct: profit_min,
            profit_per_grid_max_pct: profit_max,
            initial_side: plan.initial_leg.map(|(s, _)| s),
            initial_qty: plan.initial_leg.map(|(_, q)| decimal_text(q)),
            est_liq_long: plan.est_liq_long.map(decimal_text),
            est_liq_short: plan.est_liq_short.map(decimal_text),
            buy_orders,
            sell_orders,
            trigger_price: plan.trigger_price.map(decimal_text),
            stop_upper: plan.stop_upper.map(decimal_text),
            stop_lower: plan.stop_lower.map(decimal_text),
            close_on_stop: plan.close_on_stop,
            post_only: plan.post_only,
            levels,
            warnings: plan.warnings,
        }
    }

    /// Validates and previews a perpetual futures grid without sending any orders.
    pub async fn preview_grid(&self, request: GridRequest) -> Result<GridPreviewView> {
        let plan = self.prepare_grid_plan(&request).await?;
        Ok(Self::preview_of(plan))
    }

    /// Places a grid's first orders: margin mode and leverage, the opening market order of a long
    /// or short grid, then the resting limit orders. On success the bot is running. When something
    /// was placed before a failure, the bot is marked as an error with a note that says what is
    /// open, so the trader sees it and can stop it.
    async fn deploy_grid_orders(
        &self,
        client: &ExchangeClient,
        bot: &mut GridBot,
        mark: Decimal,
        steps: &mut Vec<StepView>,
    ) -> Result<String> {
        let symbol = bot.symbol.clone();

        // Configure margin mode & leverage before submitting orders.
        let mode_label = if bot.isolated { "isolated margin" } else { "cross margin" };
        let _ =
            timed(steps, "exchange.margin_mode", mode_label, client.set_margin_type(&symbol, bot.isolated))
                .await;
        let lev_label = format!("{}x", bot.leverage);
        timed(steps, "exchange.leverage", &lev_label, client.set_leverage(&symbol, bot.leverage)).await?;

        let prices: Vec<Decimal> = bot.levels.iter().map(|lvl| lvl.price).collect();
        let (initial_leg, ladder) = plan_initial_deployment(bot.direction, &prices, mark, bot.qty_per_grid);

        let mut summary_parts = Vec::new();
        let mut opened = None;

        // Open initial directional leg for Long or Short grids.
        if let Some((side, qty)) = initial_leg {
            let cid = bot.client_order_id(999);
            let order = OrderRequest {
                symbol: symbol.clone(),
                side,
                kind: OrderKind::Market,
                qty,
                reduce_only: false,
                client_id: cid,
            };
            let detail = format!("{side} {} {} at market", decimal_text(qty), bot.base);
            let ack = timed(steps, "exchange.order", &detail, self.send_order(client, &order)).await?;
            let position = format!("a {} {} {}", decimal_text(qty), bot.base, side.direction());
            summary_parts.push(format!("Opened {position} (order {}).", ack.order_id));
            opened = Some(position);
        }

        // Place each resting limit rung on the book.
        let mut placed = 0u32;
        let mut failed = 0u32;
        for (idx, side, rung_price) in ladder {
            let cid = bot.client_order_id(idx);
            let req = OrderRequest {
                symbol: symbol.clone(),
                side,
                kind: OrderKind::Limit { price: rung_price, post_only: bot.post_only },
                qty: bot.qty_per_grid,
                reduce_only: false,
                client_id: cid.clone(),
            };
            let detail = format!(
                "{side} {} {} at {}",
                decimal_text(bot.qty_per_grid),
                bot.base,
                price_text(rung_price)
            );
            match timed(steps, "exchange.order", &detail, self.send_order(client, &req)).await {
                Ok(ack) => {
                    if let Some(level) = bot.levels.get_mut(idx) {
                        level.side = Some(side);
                        level.order_id = Some(ack.order_id);
                        level.client_id = Some(cid);
                        level.closing = closes_at_start(bot.direction, side);
                    }
                    placed += 1;
                }
                Err(_) => {
                    failed += 1;
                }
            }
        }

        if placed == 0 {
            let Some(position) = opened else {
                bail!(
                    "The exchange took none of the bot's orders for {}. Check your balance, the margin mode and the range.",
                    bot.base
                );
            };
            // Something is open on the exchange: the bot stays in the list, marked, so the trader can stop it.
            let note = format!(
                "Opened {position}, but the exchange took none of the bot's orders. The position is still open: stop the bot with Close position, or close it under Account."
            );
            bot.status = GridStatus::Error;
            bot.updated_at = Utc::now();
            bot.last_note = note.clone();
            bail!("{note}");
        }

        bot.status = GridStatus::Running;
        bot.entry_price = mark;
        bot.updated_at = Utc::now();
        let note = if failed > 0 {
            format!("Running: {} placed, {} refused.", counted(placed as usize, "order", "orders"), failed)
        } else {
            format!("Running: {} placed.", counted(placed as usize, "order", "orders"))
        };
        bot.last_note = note.clone();
        summary_parts.push(note);
        Ok(summary_parts.join(" "))
    }

    fn persist_grid(&self, bot: &GridBot) {
        let updated = bot.updated_at.to_rfc3339_opts(SecondsFormat::Secs, true);
        let _ = self.journal.save_grid(&bot.id, &updated, bot);
        let mut state = self.state();
        if let Some(slot) = state.grids.iter_mut().find(|g| g.id == bot.id) {
            *slot = bot.clone();
        } else {
            state.grids.insert(0, bot.clone());
        }
        state.grids.sort_by_key(|bot| std::cmp::Reverse(bot.updated_at));
    }

    /// Launches a grid bot. `drafted` means the assistant drafted it and the trader started it: then
    /// the price must still be inside the range the draft was made for. Call it holding the grid lock.
    async fn launch_grid(&self, request: &GridRequest, drafted: bool) -> Result<String> {
        let plan = self.prepare_grid_plan(request).await?;
        if !plan.wallet_connected {
            bail!("Connect a wallet to start a grid bot. You can do that in Settings.");
        }
        if let Some(avail) = plan.available_margin
            && plan.margin > avail
        {
            bail!(
                "This bot needs {} {} of margin, but only {} {} is free.",
                money(plan.margin),
                plan.market.quote,
                money(avail),
                plan.market.quote
            );
        }
        // Two bots on one market would trade one net position against each other.
        if self.active_bot_on(plan.network, &plan.market.symbol) {
            bail!(
                "A grid bot is already running on {}. Stop it before starting another on the same market.",
                plan.market.base
            );
        }
        if drafted && !plan.inside_range() {
            bail!(
                "{} is at {} now, outside the drafted range of {} to {}, so every order would start on one side. Ask the assistant for a new grid bot.",
                plan.market.base,
                price_text(plan.mark),
                price_text(plan.lower),
                price_text(plan.upper)
            );
        }

        let now = Utc::now();
        let levels: Vec<GridLevel> = plan
            .levels
            .iter()
            .enumerate()
            .map(|(index, &price)| GridLevel {
                index,
                price,
                side: None,
                order_id: None,
                client_id: None,
                filled_count: 0,
                closing: false,
            })
            .collect();

        let mut bot = GridBot {
            id: new_id().chars().take(12).collect(),
            network: plan.network,
            symbol: plan.market.symbol.clone(),
            base: plan.market.base.clone(),
            quote: plan.market.quote.clone(),
            direction: plan.direction,
            spacing: plan.spacing,
            status: GridStatus::Waiting,
            lower_price: plan.lower,
            upper_price: plan.upper,
            grids: plan.grids,
            leverage: plan.leverage,
            isolated: plan.isolated,
            margin: plan.margin,
            qty_per_grid: plan.qty_per_grid,
            entry_price: plan.mark,
            trigger_price: plan.trigger_price,
            stop_upper: plan.stop_upper,
            stop_lower: plan.stop_lower,
            close_on_stop: plan.close_on_stop,
            post_only: plan.post_only,
            matched_trades: 0,
            realized_pnl: Decimal::ZERO,
            fees_est: Decimal::ZERO,
            created_at: now,
            updated_at: now,
            stopped_at: None,
            last_note: String::new(),
            levels,
            rebalance_seq: 0,
        };

        let started = Instant::now();
        let mut steps = Vec::new();
        let title = format!("Start a {} grid bot", bot.base);

        let armed = bot.trigger_price.filter(|trigger| (plan.mark - *trigger).abs() > plan.market.tick);
        let outcome = match armed {
            Some(trigger) => {
                let msg = format!("Waiting for {} to reach {}.", bot.base, price_text(trigger));
                bot.status = GridStatus::Waiting;
                bot.last_note = msg.clone();
                Ok(msg)
            }
            None => {
                let client = self.client(plan.network);
                self.deploy_grid_orders(client, &mut bot, plan.mark, &mut steps).await
            }
        };

        let run = self.quick_run("Execution", &title, plan.network, started, steps, &outcome);
        self.record(run, false);

        // A bot that left something open on the exchange is kept even when the launch failed.
        if outcome.is_ok() || bot.status == GridStatus::Error {
            self.persist_grid(&bot);
        }
        let _ = self.fetch_account(plan.network).await;
        outcome
    }

    /// Launches a confirmed perpetual futures grid bot on the active network.
    pub async fn start_grid(&self, request: GridRequest) -> Result<Snapshot> {
        let _work = self.grid_work.lock().await;
        self.launch_grid(&request, false).await?;
        Ok(self.snapshot())
    }

    /// Works out a grid bot for the assistant and keeps it as a draft for the trader to start.
    /// Nothing is sent. It replaces a draft already waiting.
    pub(crate) async fn draft_grid(&self, request: GridRequest, rationale: &str) -> Result<GridDraftView> {
        let network = self.network();
        let client = self.client(network);
        if client.wallet().is_none() {
            bail!("Connect a wallet on {} to run a grid bot. You can do that in Settings.", network.name());
        }
        let (live_tickets, epoch) = {
            let state = self.state();
            (state.prefs.live_tickets, state.epoch)
        };
        if network == Network::Mainnet && !live_tickets {
            bail!(
                "Mainnet tickets from the assistant are turned off, and grid bots follow the same switch. The trader can allow them in Settings, or switch to testnet to practise."
            );
        }
        let rationale = rationale.trim();
        if rationale.is_empty() {
            bail!("Give a one-sentence rationale that names the price that would prove the range wrong.");
        }
        // The exchange serves the account only after the wallet's first deposit.
        if let Err(error) = self.fetch_account(network).await {
            if client.is_deposit_notice(&error) {
                bail!(
                    "The wallet on {} has made no deposit yet, so it has no account to run a grid bot with. The trader can deposit in Settings, under Wallet.",
                    network.name()
                );
            }
            return Err(error);
        }
        let plan = self.prepare_grid_plan(&request).await?;
        if self.active_bot_on(network, &plan.market.symbol) {
            bail!(
                "A grid bot is already running on {}. The trader must stop it before another can run on the same market.",
                plan.market.base
            );
        }
        if !plan.inside_range() {
            bail!(
                "{} is at {}, outside the range {} to {}. A grid needs the price inside its range: use levels around the current price.",
                plan.market.base,
                price_text(plan.mark),
                price_text(plan.lower),
                price_text(plan.upper)
            );
        }
        // What starting it launches is exactly what was previewed: the market's own symbol and the
        // bounds as they were rounded to its tick.
        let request = GridRequest {
            symbol: plan.market.symbol.clone(),
            lower_price: decimal_text(plan.lower),
            upper_price: decimal_text(plan.upper),
            close_on_stop: Some(plan.close_on_stop),
            post_only: Some(plan.post_only),
            ..request
        };
        let view = GridDraftView {
            id: new_id(),
            network,
            request,
            preview: Self::preview_of(plan),
            rationale: rationale.to_string(),
        };
        let mut state = self.state();
        if state.network != network || state.epoch != epoch {
            bail!("The desk changed while the grid bot was being drafted. Ask again.");
        }
        state.grid_draft = Some(GridDraft { view: view.clone(), epoch });
        Ok(view)
    }

    /// Starts the grid bot the assistant drafted, now that the trader has looked it over. The draft is
    /// used up by its first start, and is checked again against the live price and account.
    pub async fn start_grid_draft(&self, id: &str) -> Result<Snapshot> {
        let _work = self.grid_work.lock().await;
        let draft = {
            let mut state = self.state();
            let live_tickets = state.prefs.live_tickets;
            match state.grid_draft.take() {
                Some(draft)
                    if draft.view.id == id
                        && draft.view.network == state.network
                        && draft.epoch == state.epoch
                        && (draft.view.network == Network::Testnet || live_tickets) =>
                {
                    draft
                }
                other => {
                    state.grid_draft = other.filter(|draft| draft.view.id != id);
                    bail!("This grid bot draft has expired. Ask the assistant for a new one.");
                }
            }
        };
        match self.launch_grid(&draft.view.request, true).await {
            Ok(note) => {
                self.state().receipts.insert(draft.view.id.clone(), note);
                Ok(self.snapshot())
            }
            Err(error) => {
                self.state().failures.insert(draft.view.id.clone(), error.0.clone());
                Err(error)
            }
        }
    }

    /// Discards the grid bot the assistant drafted.
    pub fn dismiss_grid_draft(&self) -> Snapshot {
        self.state().grid_draft = None;
        self.snapshot()
    }

    async fn halt_bot(
        &self,
        bot: &mut GridBot,
        close_position: bool,
        reason: &str,
        steps: &mut Vec<StepView>,
    ) -> Result<String> {
        let client = self.client(bot.network);
        let mut cancelled = 0u32;
        for level in &mut bot.levels {
            if let Some(oid) = level.order_id.take() {
                let detail = format!("{} order {oid}", bot.base);
                if timed(steps, "exchange.cancel", &detail, client.cancel_order(&bot.symbol, &oid))
                    .await
                    .is_ok()
                {
                    cancelled += 1;
                }
            }
            empty(level);
        }

        let mut closed_msg = String::new();
        if close_position
            && let Ok(positions) = client.positions(Some(&bot.symbol)).await
            && let Some(pos) = positions.into_iter().find(|p| p.symbol == bot.symbol && !p.amount.is_zero())
        {
            let side = if pos.amount > Decimal::ZERO { Side::Sell } else { Side::Buy };
            let qty = pos.amount.abs();
            let cid = bot.client_order_id(998);
            let close_req = OrderRequest {
                symbol: bot.symbol.clone(),
                side,
                kind: OrderKind::Market,
                qty,
                reduce_only: true,
                client_id: cid,
            };
            let detail = format!("{side} {} {} at market, reduce only", decimal_text(qty), bot.base);
            match timed(steps, "exchange.order", &detail, self.send_order(client, &close_req)).await {
                Ok(ack) => {
                    closed_msg = format!(
                        " Closed the {} {} position (order {}).",
                        decimal_text(qty),
                        bot.base,
                        ack.order_id
                    );
                }
                Err(err) => {
                    closed_msg = format!(" Could not close the position: {}", err.0);
                }
            }
        }

        let now = Utc::now();
        bot.status = GridStatus::Stopped;
        bot.updated_at = now;
        bot.stopped_at = Some(now);
        let note =
            format!("{reason} Cancelled its {}.{closed_msg}", counted(cancelled as usize, "order", "orders"));
        bot.last_note = note.clone();
        self.persist_grid(bot);
        Ok(note)
    }

    /// What became of each of a bot's orders. One that is still open says so; one that is no longer
    /// open is looked up by the client id it was sent with, because missing from the book is not
    /// proof of a fill: it may have been cancelled or may have expired. A lookup that fails is left
    /// for the next look.
    async fn order_fates(
        &self,
        client: &ExchangeClient,
        bot: &GridBot,
        open: &HashSet<String>,
    ) -> HashMap<String, OrderFate> {
        let mut fates = HashMap::new();
        for level in &bot.levels {
            let Some(id) = &level.order_id else {
                continue;
            };
            let fate = if open.contains(id) {
                OrderFate::Open
            } else {
                match &level.client_id {
                    None => OrderFate::Unknown,
                    Some(client_id) => match client.find_order(&bot.symbol, client_id).await {
                        Ok(Some(ack)) => OrderFate::from_status(&ack.status, ack.executed_qty),
                        // The exchange has no such order: it never rested, so it never filled.
                        Ok(None) => {
                            OrderFate::Ended { status: "UNKNOWN".to_string(), executed: Decimal::ZERO }
                        }
                        Err(_) => OrderFate::Unknown,
                    },
                }
            };
            fates.insert(id.clone(), fate);
        }
        fates
    }

    /// Answers fills with their paired orders, credits the cycles that closed, and empties the
    /// levels whose order ended without a fill.
    async fn answer_fills(
        &self,
        client: &ExchangeClient,
        bot: &mut GridBot,
        fills: Vec<Fill>,
        ended: Vec<Ended>,
    ) {
        let started = Instant::now();
        let mut steps = Vec::new();
        let (filled, mut placed, mut refused, mut completed) = (fills.len(), 0usize, 0usize, 0usize);
        let mut earned = Decimal::ZERO;

        for fill in fills {
            let price = bot.levels.get(fill.index).map_or(Decimal::ZERO, |level| level.price);
            if let Some(level) = bot.levels.get_mut(fill.index) {
                level.filled_count = level.filled_count.saturating_add(1);
                empty(level);
            }
            let fee = (price * bot.qty_per_grid * maker_fee_rate()).round_dp(4);
            bot.fees_est += fee;
            if fill.cycle_profit > Decimal::ZERO {
                // Both legs of the cycle paid a maker fee.
                let net = fill.cycle_profit - fee * Decimal::from(2);
                bot.matched_trades = bot.matched_trades.saturating_add(1);
                bot.realized_pnl += net;
                earned += net;
                completed += 1;
            }
            let Some(counter) = fill.counter else {
                continue;
            };
            let cid = bot.client_order_id(counter.index);
            let req = OrderRequest {
                symbol: bot.symbol.clone(),
                side: counter.side,
                kind: OrderKind::Limit { price: counter.price, post_only: bot.post_only },
                qty: bot.qty_per_grid,
                reduce_only: false,
                client_id: cid.clone(),
            };
            let detail = format!(
                "{} {} {} at {}",
                counter.side,
                decimal_text(bot.qty_per_grid),
                bot.base,
                price_text(counter.price)
            );
            match timed(&mut steps, "exchange.order", &detail, self.send_order(client, &req)).await {
                Ok(ack) => {
                    if let Some(target) = bot.levels.get_mut(counter.index) {
                        target.side = Some(counter.side);
                        target.order_id = Some(ack.order_id);
                        target.client_id = Some(cid);
                        target.closing = counter.closing;
                    }
                    placed += 1;
                }
                Err(_) => refused += 1,
            }
        }

        let mut notes = Vec::new();
        if filled > 0 {
            let after = if filled == 1 { "a fill".to_string() } else { format!("{filled} fills") };
            notes.push(format!("Placed {} after {after}.", counted(placed, "order", "orders")));
        }
        if refused > 0 {
            notes.push(format!(
                "{} could not be placed, so {} empty.",
                counted(refused, "order", "orders"),
                if refused == 1 { "its price level is" } else { "their price levels are" }
            ));
        }
        if completed > 0 {
            notes.push(format!(
                "{}, {} {} made.",
                counted(bot.matched_trades as usize, "completed trade", "completed trades"),
                money(bot.realized_pnl),
                bot.quote
            ));
        }
        if !ended.is_empty() {
            let partial: Decimal = ended.iter().map(|gone| gone.executed).sum();
            let first = if partial > Decimal::ZERO {
                format!(" ({} {} had filled first)", decimal_text(partial), bot.base)
            } else {
                String::new()
            };
            notes.push(format!(
                "{} cancelled or expired without filling{first}, so {} empty.",
                if ended.len() == 1 {
                    "1 order was".to_string()
                } else {
                    format!("{} orders were", ended.len())
                },
                if ended.len() == 1 { "its price level is" } else { "their price levels are" }
            ));
            for gone in &ended {
                if let Some(level) = bot.levels.get_mut(gone.index) {
                    empty(level);
                }
            }
        }

        bot.updated_at = Utc::now();
        let note = notes.join(" ");
        bot.last_note = note.clone();
        let title = if placed > 0 {
            format!("{} grid bot: placed {}", bot.base, counted(placed, "order", "orders"))
        } else if filled > 0 {
            format!("{} grid bot: {}", bot.base, counted(filled, "fill", "fills"))
        } else {
            format!("{} grid bot: orders ended without filling", bot.base)
        };
        let run = self.quick_run("Execution", &title, bot.network, started, steps, &Ok(note));
        self.record(run, false);
    }

    /// Looks at the exchange for every waiting or running grid bot on the active network: arms the
    /// ones whose trigger was reached, answers fills with paired orders, empties levels whose order
    /// ended without a fill, and stops a bot whose stop price was reached or whose orders were all
    /// cancelled outside it.
    pub async fn sync_grids(&self) -> Result<Snapshot> {
        let _work = self.grid_work.lock().await;
        let network = self.network();
        let active_bots: Vec<GridBot> = {
            let state = self.state();
            state
                .grids
                .iter()
                .filter(|g| {
                    g.network == network && matches!(g.status, GridStatus::Waiting | GridStatus::Running)
                })
                .cloned()
                .collect()
        };

        if active_bots.is_empty() {
            return Ok(self.snapshot());
        }

        let client = self.client(network);
        if client.wallet().is_none() {
            return Ok(self.snapshot());
        }

        let Ok(account) = self.fetch_account(network).await else {
            return Ok(self.snapshot());
        };
        let open_ids: HashSet<String> = account.orders.iter().map(|o| o.id.clone()).collect();
        let mut mutated = false;

        for mut bot in active_bots {
            let mark = match client.premium(&bot.symbol).await {
                Ok(p) => p.mark,
                Err(_) => continue,
            };
            let fates = self.order_fates(client, &bot, &open_ids).await;

            match plan_sync(&bot, &fates, mark) {
                SyncDecision::None => {}
                SyncDecision::Activate => {
                    let started = Instant::now();
                    let mut steps = Vec::new();
                    let title = format!("Start the {} grid bot at {}", bot.base, price_text(mark));
                    let outcome = self.deploy_grid_orders(client, &mut bot, mark, &mut steps).await;
                    let run = self.quick_run("Execution", &title, network, started, steps, &outcome);
                    self.record(run, false);
                    if let Err(err) = outcome
                        && bot.status != GridStatus::Error
                    {
                        bot.status = GridStatus::Error;
                        bot.updated_at = Utc::now();
                        bot.last_note = err.0;
                    }
                    self.persist_grid(&bot);
                    mutated = true;
                }
                SyncDecision::StopOut(reason) => {
                    let started = Instant::now();
                    let mut steps = Vec::new();
                    let title = format!("{} grid bot stopped at its stop price", bot.base);
                    let close = bot.close_on_stop;
                    let outcome = self.halt_bot(&mut bot, close, &reason, &mut steps).await;
                    let run = self.quick_run("Execution", &title, network, started, steps, &outcome);
                    self.record(run, false);
                    mutated = true;
                }
                SyncDecision::Abandoned(reason) => {
                    // Nothing is sent: the orders are gone, and closing the position is the trader's call.
                    for level in &mut bot.levels {
                        empty(level);
                    }
                    let now = Utc::now();
                    bot.status = GridStatus::Stopped;
                    bot.updated_at = now;
                    bot.stopped_at = Some(now);
                    bot.last_note = reason.clone();
                    let title = format!("{} grid bot stopped: its orders were cancelled", bot.base);
                    let run =
                        self.quick_run("Execution", &title, network, Instant::now(), Vec::new(), &Ok(reason));
                    self.record(run, false);
                    self.persist_grid(&bot);
                    mutated = true;
                }
                SyncDecision::Update { fills, ended } => {
                    self.answer_fills(client, &mut bot, fills, ended).await;
                    self.persist_grid(&bot);
                    mutated = true;
                }
            }
        }

        if mutated {
            let _ = self.fetch_account(network).await;
        }
        Ok(self.snapshot())
    }

    /// Stops a running or waiting grid bot, cancelling its resting limit orders and optionally closing the position.
    pub async fn stop_grid(&self, id: &str, close_position: bool) -> Result<Snapshot> {
        let _work = self.grid_work.lock().await;
        let mut bot = {
            let state = self.state();
            state
                .grids
                .iter()
                .find(|g| g.id == id)
                .cloned()
                .ok_or_else(|| desk_err!("That grid bot was not found."))?
        };

        if bot.status == GridStatus::Stopped {
            return Ok(self.snapshot());
        }

        let started = Instant::now();
        let mut steps = Vec::new();
        let title = format!("Stop the {} grid bot", bot.base);
        let outcome = self.halt_bot(&mut bot, close_position, "Stopped.", &mut steps).await;
        let run = self.quick_run("Execution", &title, bot.network, started, steps, &outcome);
        self.record(run, false);
        let _ = self.fetch_account(bot.network).await;
        outcome?;
        Ok(self.snapshot())
    }

    /// Deletes a stopped or errored grid bot from local history.
    pub fn delete_grid(&self, id: &str) -> Result<Snapshot> {
        let mut state = self.state();
        let Some(pos) = state.grids.iter().position(|g| g.id == id) else {
            return Ok(self.snapshot());
        };
        if matches!(state.grids[pos].status, GridStatus::Running | GridStatus::Waiting) {
            bail!("Stop this grid bot before deleting it.");
        }
        state.grids.remove(pos);
        drop(state);
        self.journal.delete_grid(id)?;
        Ok(self.snapshot())
    }

    /// Builds `GridBotView` list for the current snapshot, enriched with live mark price & position unrealized P&L.
    pub(super) fn grid_views(&self, state: &super::State) -> Vec<GridBotView> {
        state
            .grids
            .iter()
            .filter(|bot| bot.network == state.network)
            .map(|bot| {
                let mark = state.quotes.get(&bot.symbol).map(|q| q.reference()).or_else(|| {
                    state
                        .account
                        .as_ref()
                        .and_then(|acc| acc.positions.iter().find(|p| p.symbol == bot.symbol))
                        .map(|p| p.mark_price)
                });
                let unrealized = if matches!(bot.status, GridStatus::Running) {
                    state
                        .account
                        .as_ref()
                        .and_then(|acc| acc.positions.iter().find(|p| p.symbol == bot.symbol))
                        .map(|p| p.unrealized_pnl)
                        .unwrap_or(Decimal::ZERO)
                } else {
                    Decimal::ZERO
                };
                GridBotView::from_bot(bot, mark, unrealized)
            })
            .collect()
    }

    /// One line per waiting or running grid bot on the active network, for the assistant's desk.
    pub(super) fn grid_lines(state: &super::State) -> Vec<String> {
        state
            .grids
            .iter()
            .filter(|bot| bot.network == state.network)
            .filter(|bot| matches!(bot.status, GridStatus::Waiting | GridStatus::Running))
            .map(|bot| {
                let status = match (bot.status, bot.trigger_price) {
                    (GridStatus::Waiting, Some(trigger)) => format!("waiting for {}", price_text(trigger)),
                    (GridStatus::Waiting, None) => "waiting".to_string(),
                    _ => "running".to_string(),
                };
                format!(
                    "{} {} grid {status}, {} to {}, {} grids, {} USDT at {}x, {}, grid profit {} USDT",
                    bot.symbol,
                    bot.direction.as_str(),
                    price_text(bot.lower_price),
                    price_text(bot.upper_price),
                    bot.grids,
                    money(bot.margin),
                    bot.leverage,
                    counted(bot.matched_trades as usize, "completed grid trade", "completed grid trades"),
                    money(bot.realized_pnl),
                )
            })
            .collect()
    }

    /// The grid bot waiting for the trader to start it, in one line, for the assistant's desk.
    pub(super) fn pending_grid_line(state: &super::State) -> Option<String> {
        let draft = state.grid_draft.as_ref()?;
        let preview = &draft.view.preview;
        Some(format!(
            "{} grid on {}, {} to {}, {} grids, {} USDT at {}x",
            preview.direction.as_str(),
            preview.symbol,
            preview.lower_price,
            preview.upper_price,
            preview.grids,
            preview.margin,
            preview.leverage
        ))
    }
}
