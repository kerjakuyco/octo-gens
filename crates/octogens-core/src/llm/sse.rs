//! A minimal Server-Sent Events decoder for streamed model replies.

/// Feed it bytes as they arrive; it returns each completed event's `data` payload.
///
/// Only what model APIs use is implemented: `data:` fields (joined with a newline
/// when an event has several), comment lines starting with `:` (OpenRouter sends
/// these as keep-alives), and blank-line event boundaries. Bytes are split on
/// newlines before decoding, so a multi-byte character cut across two network
/// chunks is reassembled correctly.
#[derive(Default)]
pub struct SseDecoder {
    pending: Vec<u8>,
    data: Vec<String>,
    /// Bytes held in `data` for the event being assembled.
    held: usize,
    overflowed: bool,
}

/// More than any one line or event of a model reply could be. A server that
/// sends more without ever finishing a line is not sending a reply.
pub const EVENT_LIMIT: usize = 4_000_000;

impl SseDecoder {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        // What was held before this chunk has no newline in it, so only the new bytes are searched.
        let mut from = self.pending.len();
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(offset) = self.pending[from..].iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = self.pending.drain(..=from + offset).collect();
            from = 0;
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.line(&String::from_utf8_lossy(&line), &mut events);
        }
        if self.pending.len() > EVENT_LIMIT || self.held > EVENT_LIMIT {
            self.overflowed = true;
            self.pending.clear();
            self.data.clear();
            self.held = 0;
        }
        events
    }

    /// The stream held more than [`EVENT_LIMIT`] without completing an event, and was dropped.
    pub fn overflowed(&self) -> bool {
        self.overflowed
    }

    /// Flushes an event the server did not terminate with a blank line.
    pub fn finish(&mut self) -> Vec<String> {
        let mut events = Vec::new();
        if !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            self.line(String::from_utf8_lossy(&line).trim_end_matches('\r'), &mut events);
        }
        self.line("", &mut events);
        events
    }

    fn line(&mut self, line: &str, events: &mut Vec<String>) {
        if line.is_empty() {
            if !self.data.is_empty() {
                events.push(std::mem::take(&mut self.data).join("\n"));
                self.held = 0;
            }
        } else if let Some(value) = line.strip_prefix("data:") {
            let value = value.strip_prefix(' ').unwrap_or(value);
            self.held += value.len();
            self.data.push(value.to_string());
        }
        // Comments (`: keep-alive`) and other fields (`event:`, `id:`, `retry:`) carry nothing we use.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_survive_arbitrary_chunk_boundaries() {
        let wire = ": OPENROUTER PROCESSING\n\ndata: {\"a\":\"h\u{e9}llo \u{1f419}\"}\n\nevent: ping\ndata: one\r\ndata: two\r\n\r\ndata: [DONE]\n\n";
        let whole = SseDecoder::default().feed(wire.as_bytes());
        assert_eq!(whole, ["{\"a\":\"h\u{e9}llo \u{1f419}\"}", "one\ntwo", "[DONE]"]);
        // Feeding one byte at a time must give the same events, even mid-character.
        let mut decoder = SseDecoder::default();
        let mut pieces = Vec::new();
        for byte in wire.as_bytes() {
            pieces.extend(decoder.feed(std::slice::from_ref(byte)));
        }
        assert_eq!(pieces, whole);
    }

    #[test]
    fn a_stream_that_never_finishes_a_line_is_dropped_not_hoarded() {
        let mut decoder = SseDecoder::default();
        let piece = vec![b'x'; 1_000_000];
        for _ in 0..4 {
            assert!(decoder.feed(&piece).is_empty());
            assert!(!decoder.overflowed());
        }
        assert!(decoder.feed(&piece).is_empty());
        assert!(decoder.overflowed(), "five megabytes with no newline is not a reply");
        assert!(decoder.finish().is_empty(), "nothing of it is kept");

        // The same for an event that keeps adding data lines and never ends.
        let mut decoder = SseDecoder::default();
        let line = format!("data: {}\n", "y".repeat(500_000));
        for _ in 0..9 {
            decoder.feed(line.as_bytes());
        }
        assert!(decoder.overflowed());
    }

    #[test]
    fn an_unterminated_final_event_is_flushed() {
        let mut decoder = SseDecoder::default();
        assert!(decoder.feed(b"data: tail").is_empty());
        assert_eq!(decoder.finish(), ["tail"]);
        assert!(decoder.finish().is_empty());
    }
}
