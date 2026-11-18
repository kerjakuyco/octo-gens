//! The desk without a window: run one prompt through the studio and print the trace.
//!
//! ```sh
//! cargo run -p octogens-core --example desk -- sample "Compare BTC and ETH"
//! cargo run -p octogens-core --example desk -- okx "How is SOL doing?"
//! ```
//!
//! It uses a throwaway data folder and the built-in agents, so it needs no keys
//! and leaves nothing behind. Handy for trying a change to the core quickly.

use std::sync::Arc;

use octogens_core::model::Feed;
use octogens_core::store::MemorySecrets;
use octogens_core::studio::view::{StepStatus, TurnEvent, TurnSink};
use octogens_core::studio::{Studio, StudioConfig};

struct Print;

impl TurnSink for Print {
    fn emit(&self, event: TurnEvent) {
        match event {
            TurnEvent::Step { step, .. } if step.status != StepStatus::Running => {
                println!("  [{:?}] {} {} ({} ms)", step.status, step.name, step.detail, step.ms);
            }
            TurnEvent::Text { delta } => print!("{delta}"),
            _ => {}
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), octogens_core::DeskError> {
    let mut args = std::env::args().skip(1);
    let feed = Feed::parse(&args.next().unwrap_or_else(|| "sample".to_string()))?;
    let prompt = args.next().unwrap_or_else(|| "Compare BTC and ETH".to_string());

    let folder = std::env::temp_dir().join(format!("octogens-desk-{}", std::process::id()));
    let studio = Studio::open(StudioConfig::new(folder.clone(), Arc::new(MemorySecrets::default())))?;
    studio.boot().await?;
    if feed != Feed::Sample {
        let snapshot = studio.set_feed(feed).await?;
        println!(
            "{}: {} of {} watchlist pairs priced",
            feed.name(),
            snapshot.quotes.len(),
            snapshot.instruments.len()
        );
    }
    let snapshot = studio.ask(&prompt, &Print).await?;
    let run = &snapshot.runs[0];
    println!("\n{} ({:?}, {} ms)\n{}", run.agent, run.status, run.ms, run.output);
    studio.close().await;
    let _ = std::fs::remove_dir_all(folder);
    Ok(())
}
