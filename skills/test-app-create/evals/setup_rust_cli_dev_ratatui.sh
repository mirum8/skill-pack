#!/usr/bin/env bash
# Fixture for the `surface-discriminator` behaviour case.
#
#   bash setup_rust_cli_dev_ratatui.sh <dir>
#
# This is the hardest input Step 0 gets, and the fixture IS the specification of the answer:
# `ratatui` and `crossterm` are present, so every dependency-name signal says `tui` — but they
# are in [dev-dependencies], used only by a test helper, and nothing in src/ ever enters the
# alternate screen or turns on raw mode. The program parses argv, prints, and exits.
#
# Expected: SURFACE=cli. A scaffolder that answers `tui` here writes the wrong template pair for
# the user's whole generated skill, and every check in it then asks the wrong questions of the
# right program — which is why the discriminator is a runtime probe rather than a grep.
set -euo pipefail
d=${1:?usage: setup_rust_cli_dev_ratatui.sh <dir>}
mkdir -p "$d/src" "$d/tests"

cat > "$d/Cargo.toml" <<'TOML'
[package]
name = "ratesheet"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "ratesheet"
path = "src/main.rs"

[dependencies]
clap = { version = "4", features = ["derive"] }
serde_json = "1"

[dev-dependencies]
ratatui = "0.29"
crossterm = "0.28"
TOML

cat > "$d/src/main.rs" <<'RS'
use clap::Parser;

#[derive(Parser)]
#[command(name = "ratesheet", about = "Import and inspect rate sheets")]
struct Cli {
    #[arg(long)]
    input: String,
    #[arg(long, default_value_t = false)]
    dry_run: bool,
}

fn main() {
    let cli = Cli::parse();
    match ratesheet::import(&cli.input, cli.dry_run) {
        Ok(n) => println!("{n}"),
        Err(e) => {
            eprintln!("ratesheet: {e}");
            std::process::exit(2);
        }
    }
}
RS

cat > "$d/src/lib.rs" <<'RS'
pub fn import(path: &str, dry_run: bool) -> Result<usize, String> {
    if path.is_empty() {
        return Err("no input path".into());
    }
    if dry_run { Ok(0) } else { Ok(1) }
}
RS

# The only file in the tree that touches ratatui — a rendering helper for a snapshot test.
# It never runs outside `cargo test`, which is exactly why a dependency grep gets this wrong.
cat > "$d/tests/render_snapshot.rs" <<'RS'
use ratatui::{backend::TestBackend, Terminal};

#[test]
fn renders_a_summary_line() {
    let backend = TestBackend::new(40, 4);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|f| { let _ = f.area(); }).unwrap();
}
RS

echo "$d"
