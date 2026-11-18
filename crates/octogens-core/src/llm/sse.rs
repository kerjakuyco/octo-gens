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
}

impl SseDecoder {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = self.pending.drain(..=end).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.line(&String::from_utf8_lossy(&line), &mut events);
        }
        events
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
            }
        } else if let Some(value) = line.strip_prefix("data:") {
            self.data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
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
    fn an_unterminated_final_event_is_flushed() {
        let mut decoder = SseDecoder::default();
        assert!(decoder.feed(b"data: tail").is_empty());
        assert_eq!(decoder.finish(), ["tail"]);
        assert!(decoder.finish().is_empty());
    }
}
