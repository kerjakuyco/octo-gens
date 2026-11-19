//! Which addresses the app may read from the web.
//!
//! A model chooses the links it reads, and what it reads can try to steer it.
//! So a link is followed only when it is an ordinary public web address:
//! `https`, a domain name, the standard port, no credentials. A name that
//! leads to this computer or to a private network is refused again when the
//! connection is made, which also covers a redirect and a name that changes
//! its answer between the check and the connection.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use url::{Host, Url};

use crate::bail;
use crate::error::Result;

/// Last labels of names that never belong to a public site.
const PRIVATE_SUFFIXES: [&str; 9] =
    ["localhost", "local", "internal", "intranet", "lan", "home", "arpa", "test", "invalid"];

const NOT_A_PAGE: &str = "That is not a public web page. Only https links to public sites can be read.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Guard {
    /// Public web addresses only.
    Public,
    /// Any `http` or `https` address. Only for tests, which read from a stand-in on this computer.
    Open,
}

impl Guard {
    /// Whether a link may be requested. Redirects are checked hop by hop with the same rule.
    pub(crate) fn check(self, url: &Url) -> Result<()> {
        if self == Guard::Open {
            if !matches!(url.scheme(), "http" | "https") {
                bail!("{NOT_A_PAGE}");
            }
            return Ok(());
        }
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            bail!("{NOT_A_PAGE}");
        }
        // `port()` is `None` for 443, written or not: any other port is not an ordinary site.
        if url.port().is_some() {
            bail!("{NOT_A_PAGE}");
        }
        // An address written as numbers is never a news site, whatever it points at.
        let Some(Host::Domain(name)) = url.host() else {
            bail!("{NOT_A_PAGE}");
        };
        let name = name.trim_end_matches('.').to_ascii_lowercase();
        let last = name.rsplit('.').next().unwrap_or_default();
        if !name.contains('.') || PRIVATE_SUFFIXES.contains(&last) {
            bail!("{NOT_A_PAGE}");
        }
        Ok(())
    }

    /// Reads a link as text and checks it.
    pub(crate) fn parse(self, raw: &str) -> Result<Url> {
        let Ok(mut url) = Url::parse(raw.trim()) else {
            bail!("{NOT_A_PAGE}");
        };
        self.check(&url)?;
        // The part after `#` never reaches a server.
        url.set_fragment(None);
        Ok(url)
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_documentation()
        // "This network", carrier-grade NAT, protocol assignments, benchmarking, reserved.
        || a == 0
        || (a == 100 && (b & 0xc0) == 64)
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (b & 0xfe) == 18)
        || a >= 240)
}

fn public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let s = ip.segments();
    let embedded = |high: u16, low: u16| {
        let [a, b] = high.to_be_bytes();
        let [c, d] = low.to_be_bytes();
        Ipv4Addr::new(a, b, c, d)
    };
    // An IPv4 address carried inside an IPv6 one (NAT64, 6to4) is judged as that IPv4 address.
    if s[0] == 0x64 && s[1] == 0xff9b {
        return public_v4(embedded(s[6], s[7]));
    }
    if s[0] == 0x2002 {
        return public_v4(embedded(s[1], s[2]));
    }
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        // Documentation, and the old "IPv4-compatible" form `::a.b.c.d`.
        || (s[0] == 0x2001 && s[1] == 0xdb8)
        || s[..6] == [0, 0, 0, 0, 0, 0])
}

/// Whether an address is on the public internet, as far as its number tells.
pub(crate) fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => public_v6(v6),
    }
}

/// Resolves names like the system does and keeps only public addresses, so a
/// connection can never be opened to this computer or to a private network.
pub(crate) struct PublicOnly;

impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let found = tokio::net::lookup_host((name.as_str(), 0)).await?;
            let public: Vec<SocketAddr> = found.filter(|address| public_address(address.ip())).collect();
            if public.is_empty() {
                return Err("the name does not lead to a public address".into());
            }
            let addresses: reqwest::dns::Addrs = Box::new(public.into_iter());
            Ok(addresses)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ordinary_public_https_links_pass() {
        for good in [
            "https://www.coindesk.com/markets/2026/11/19/a-story",
            "https://decrypt.co/383570/why?utm_source=rss#top",
            "https://example.co.uk:443/a",
            " https://news.example.com/a b ",
        ] {
            assert!(Guard::Public.parse(good).is_ok(), "{good}");
        }
        for bad in [
            "http://www.coindesk.com/markets",
            "https://user:secret@example.com/",
            "https://example.com:8443/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://2130706433/",
            "https://0x7f.1/",
            "https://localhost/",
            "https://router/",
            "https://printer.local/",
            "https://db.internal/",
            "https://nas.lan./",
            "file:///etc/passwd",
            "ftp://example.com/",
            "javascript:alert(1)",
            "not a link",
            "",
        ] {
            assert!(Guard::Public.parse(bad).is_err(), "{bad}");
        }
        // The fragment is dropped; the rest is kept as written.
        let parsed = Guard::Public.parse("https://decrypt.co/383570/why?utm_source=rss#top").expect("link");
        assert_eq!(parsed.as_str(), "https://decrypt.co/383570/why?utm_source=rss");
        // Tests read from a stand-in on this computer, still only over the web's own schemes.
        assert!(Guard::Open.parse("http://127.0.0.1:4010/feed").is_ok());
        assert!(Guard::Open.parse("file:///etc/passwd").is_err());
    }

    #[test]
    fn private_and_special_addresses_are_not_public() {
        for private in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "0.1.2.3",
            "192.0.0.8",
            "198.18.0.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "203.0.113.7",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::127.0.0.1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::1",
            "2002:c0a8:101::1",
        ] {
            let ip: IpAddr = private.parse().expect("address");
            assert!(!public_address(ip), "{private} must not be reachable");
        }
        for public in
            ["1.1.1.1", "8.8.8.8", "104.18.32.7", "2606:4700::6810:2007", "::ffff:8.8.8.8", "2002:808:808::1"]
        {
            let ip: IpAddr = public.parse().expect("address");
            assert!(public_address(ip), "{public} is an ordinary address");
        }
    }
}
