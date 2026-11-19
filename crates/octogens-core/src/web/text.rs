//! Small text helpers for what is read from the web.

/// Characters that take no room on screen but can reorder or hide the text around them.
fn invisible(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2069}' | '\u{feff}')
}

/// One line of plain text: invisible characters removed, runs of whitespace collapsed.
pub(crate) fn squeeze(text: &str) -> String {
    let visible: String = text.chars().map(|c| if invisible(c) { ' ' } else { c }).collect();
    visible.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// At most `limit` characters, ending in an ellipsis when something was cut.
pub(crate) fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

/// At most `limit` bytes, cut on a character and preferably at the end of a
/// word. Returns the text and whether anything was left out.
pub fn fit(text: &str, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.to_string(), false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let kept = &text[..end];
    // Back up to the last gap between words, unless that would give up a long stretch.
    let kept = match kept.rfind(char::is_whitespace) {
        Some(gap) if kept.len() - gap <= 80 => &kept[..gap],
        _ => kept,
    };
    (kept.trim_end().to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_flattened_clipped_and_fitted_without_breaking_characters() {
        assert_eq!(squeeze("  Bitcoin\n\tfalls \u{202e}3%\u{200b}  today "), "Bitcoin falls 3% today");
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("Bitcoin falls three percent", 14), "Bitcoin falls…");
        assert_eq!(clip("né".repeat(5).as_str(), 4), "nén…");

        assert_eq!(fit("fits", 10), ("fits".to_string(), false));
        assert_eq!(fit("Bitcoin falls three percent", 15), ("Bitcoin falls".to_string(), true));
        // A cut never lands inside a character, and a text without gaps is cut where the room ends.
        assert_eq!(fit("ééééé", 5), ("éé".to_string(), true));
        let (kept, cut) = fit(&"x".repeat(500), 200);
        assert_eq!((kept.len(), cut), (200, true));
    }
}
