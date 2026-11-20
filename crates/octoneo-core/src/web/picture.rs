//! The pictures of the stories on the News page.
//!
//! The interface cannot reach the web, so the core fetches a story's picture
//! for it. Only a picture the News page was given is fetched, never an address
//! of someone else's choosing, and only the ordinary kinds of picture are
//! passed on, told by their first bytes rather than by what the server says.

use std::collections::VecDeque;

/// Pictures the News page may ask for: those of the stories it was given lately.
const OFFERED: usize = 1000;
/// Pictures kept after they are fetched, by count and by size.
const KEPT: usize = 64;
const KEPT_BYTES: usize = 32 * 1024 * 1024;

/// A story's picture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Picture {
    /// What the picture's first bytes say it is, e.g. `image/jpeg`.
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// What kind of picture `bytes` hold, told by how they begin: JPEG, PNG, WebP,
/// GIF or AVIF. Anything else, an SVG or a web page among them, is not shown.
pub(crate) fn kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if avif(bytes) {
        Some("image/avif")
    } else {
        None
    }
}

/// An AVIF file opens with an `ftyp` box that lists `avif` (a still) or `avis` (a
/// sequence) among its brands. Other files in the same box, HEIC photos among them, are not shown.
fn avif(bytes: &[u8]) -> bool {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    // The main brand, then a version, then the brands the file is also compatible with.
    let compatible = bytes.get(16..size.min(bytes.len())).unwrap_or_default();
    std::iter::once(&bytes[8..12])
        .chain(compatible.chunks_exact(4))
        .any(|brand| brand == b"avif" || brand == b"avis")
}

/// The pictures of the stories the News page was given, the latest last.
#[derive(Default)]
pub(crate) struct Offered(VecDeque<String>);

impl Offered {
    /// Notes a picture the page was given. One given again counts as given now.
    pub(crate) fn add(&mut self, address: String) {
        if let Some(at) = self.0.iter().position(|held| *held == address) {
            self.0.remove(at);
        }
        self.0.push_back(address);
        let extra = self.0.len().saturating_sub(OFFERED);
        self.0.drain(..extra);
    }

    pub(crate) fn has(&self, address: &str) -> bool {
        self.0.iter().any(|held| held == address)
    }
}

/// Pictures fetched lately, the one last shown last, so that scrolling back to a
/// story does not fetch its picture again.
#[derive(Default)]
pub(crate) struct Album {
    held: VecDeque<(String, Picture)>,
    bytes: usize,
}

impl Album {
    pub(crate) fn get(&mut self, address: &str) -> Option<Picture> {
        let at = self.held.iter().position(|(held, _)| held == address)?;
        let entry = self.held.remove(at)?;
        let picture = entry.1.clone();
        self.held.push_back(entry);
        Some(picture)
    }

    /// Keeps a picture, letting go of the ones shown longest ago when there are too many.
    pub(crate) fn put(&mut self, address: String, picture: Picture) {
        if let Some(at) = self.held.iter().position(|(held, _)| *held == address)
            && let Some((_, old)) = self.held.remove(at)
        {
            self.bytes -= old.bytes.len();
        }
        self.bytes += picture.bytes.len();
        self.held.push_back((address, picture));
        while self.held.len() > KEPT || self.bytes > KEPT_BYTES {
            let Some((_, gone)) = self.held.pop_front() else {
                break;
            };
            self.bytes -= gone.bytes.len();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(size: usize) -> Picture {
        Picture { content_type: "image/png".to_string(), bytes: vec![0; size] }
    }

    #[test]
    fn a_picture_is_told_by_its_first_bytes() {
        assert_eq!(kind(&[0xff, 0xd8, 0xff, 0xe0, 0, 0x10, b'J', b'F', b'I', b'F']), Some("image/jpeg"));
        assert_eq!(kind(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), Some("image/png"));
        assert_eq!(kind(b"GIF89a\x01\0\x01\0"), Some("image/gif"));
        assert_eq!(kind(b"GIF87a\x01\0\x01\0"), Some("image/gif"));
        assert_eq!(kind(b"RIFF\x8a\x3e\x0e\0WEBPVP8 "), Some("image/webp"));
        let ftyp = |brands: &[&[u8; 4]]| -> Vec<u8> {
            let mut bytes = ((16 + 4 * (brands.len() - 1)) as u32).to_be_bytes().to_vec();
            bytes.extend_from_slice(b"ftyp");
            bytes.extend_from_slice(brands[0]);
            bytes.extend_from_slice(&[0, 0, 0, 0]);
            brands[1..].iter().for_each(|brand| bytes.extend_from_slice(*brand));
            bytes.extend_from_slice(b"\0\0\0\x08meta");
            bytes
        };
        assert_eq!(kind(&ftyp(&[b"avif", b"mif1", b"miaf"])), Some("image/avif"));
        assert_eq!(kind(&ftyp(&[b"mif1", b"miaf", b"avif"])), Some("image/avif"));
        assert_eq!(kind(&ftyp(&[b"avis", b"avis"])), Some("image/avif"));

        // What only says it is a picture is not one.
        let heic = ftyp(&[b"heic", b"mif1", b"heic"]);
        let others: [&[u8]; 8] = [
            b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
            b"<!doctype html><html><body>Just a moment...</body></html>",
            b"%PDF-1.7",
            b"RIFF\0\0\0\0WAVEfmt ",
            &heic,
            b"\xff\xd8",
            b"",
        ];
        for other in others {
            assert_eq!(kind(other), None, "{:?}", String::from_utf8_lossy(other));
        }
    }

    #[test]
    fn only_the_latest_pictures_offered_are_known_and_a_few_are_kept() {
        let mut offered = Offered::default();
        for n in 0..1100 {
            offered.add(format!("https://cdn.example.com/{n}.jpg"));
        }
        assert!(
            offered.has("https://cdn.example.com/1099.jpg") && offered.has("https://cdn.example.com/100.jpg")
        );
        assert!(!offered.has("https://cdn.example.com/99.jpg"));
        // A picture given again is given now, so it outlasts the ones given after it once.
        offered.add("https://cdn.example.com/100.jpg".to_string());
        offered.add("https://cdn.example.com/new.jpg".to_string());
        assert!(
            offered.has("https://cdn.example.com/100.jpg") && !offered.has("https://cdn.example.com/101.jpg")
        );

        let mut album = Album::default();
        for n in 0..70 {
            album.put(format!("https://cdn.example.com/{n}.jpg"), picture(10));
        }
        assert_eq!((album.held.len(), album.bytes), (64, 640));
        assert!(album.get("https://cdn.example.com/5.jpg").is_none(), "the oldest went first");
        // The one shown last is kept longest.
        assert_eq!(album.get("https://cdn.example.com/6.jpg"), Some(picture(10)));
        album.put("https://cdn.example.com/70.jpg".to_string(), picture(10));
        assert!(
            album.get("https://cdn.example.com/6.jpg").is_some()
                && album.get("https://cdn.example.com/7.jpg").is_none()
        );
        // Big pictures fill it sooner, and one kept again is not counted twice.
        for n in 0..9 {
            album.put(format!("https://cdn.example.com/big-{n}.jpg"), picture(4 * 1024 * 1024));
        }
        assert!(album.bytes <= 32 * 1024 * 1024 && album.get("https://cdn.example.com/big-0.jpg").is_none());
        album.put("https://cdn.example.com/big-8.jpg".to_string(), picture(4 * 1024 * 1024));
        let total: usize = album.held.iter().map(|(_, picture)| picture.bytes.len()).sum();
        assert_eq!(album.bytes, total);
    }
}
