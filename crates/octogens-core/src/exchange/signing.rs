//! Wallet-style signing for the exchange's V3 API.
//!
//! The exchange does not use an API key and secret. A request is authorised by an
//! *API wallet* (the exchange also calls it an agent): an ordinary EVM key that the
//! trader's main wallet has approved for trading. Every signed request carries
//! the API wallet's address, a nonce, and an EIP-712 signature over the exact
//! parameter string that is sent.
//!
//! The app only ever holds API wallet keys. The main wallet signs once, in the
//! trader's own wallet software, to approve the API wallet.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

use crate::error::Result;
use crate::{bail, desk_err};

/// EIP-712 domain name every exchange signature uses.
const DOMAIN_NAME: &str = "AsterSignTransaction";
const DOMAIN_VERSION: &str = "1";
/// Chain id the exchange requires in the domain when a main wallet approves an API wallet.
pub const APPROVAL_CHAIN_ID: u64 = 56;

pub fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// A 20-byte EVM address. Displayed with the EIP-55 mixed-case checksum.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Address([u8; 20]);

impl Address {
    /// Parses `0x` followed by 40 hex digits. Case is not checked: wallets hand
    /// out lower-case and checksummed forms alike.
    pub fn parse(raw: &str) -> Result<Self> {
        let text = raw.trim();
        let digits = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")).unwrap_or("");
        let mut bytes = [0u8; 20];
        if digits.len() != 40 || hex::decode_to_slice(digits, &mut bytes).is_err() {
            bail!("Enter a wallet address: 0x followed by 40 hexadecimal characters.");
        }
        Ok(Self(bytes))
    }

    fn of(key: &VerifyingKey) -> Self {
        // An address is the last 20 bytes of the hash of the uncompressed public key, without its 0x04 prefix.
        let point = key.to_sec1_point(false);
        let hash = keccak(&point.as_bytes()[1..]);
        let mut bytes = [0u8; 20];
        bytes.copy_from_slice(&hash[12..]);
        Self(bytes)
    }

    /// `0x1234…cdef`, for places too narrow for the whole address.
    pub fn short(&self) -> String {
        let full = self.to_string();
        format!("{}…{}", &full[..6], &full[full.len() - 4..])
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let lower = hex::encode(self.0);
        let hash = keccak(lower.as_bytes());
        f.write_str("0x")?;
        for (index, digit) in lower.chars().enumerate() {
            let nibble = (hash[index / 2] >> if index % 2 == 0 { 4 } else { 0 }) & 0xf;
            write!(f, "{}", if nibble >= 8 { digit.to_ascii_uppercase() } else { digit })?;
        }
        Ok(())
    }
}

impl fmt::Debug for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self}")
    }
}

/// The private key of an API wallet. It never appears in logs, errors or snapshots.
#[derive(Clone)]
pub struct AgentKey(SigningKey);

impl fmt::Debug for AgentKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "AgentKey({})", self.address())
    }
}

impl AgentKey {
    /// A fresh key from the operating system's random source.
    pub fn generate() -> Result<Self> {
        for _ in 0..8 {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes)
                .map_err(|error| desk_err!("The system could not produce a random key: {error}."))?;
            // A random 32-byte value is a valid key except with negligible probability.
            if let Ok(key) = SigningKey::from_slice(&bytes) {
                return Ok(Self(key));
            }
        }
        bail!("The system could not produce a valid key.")
    }

    /// Parses 64 hex digits, with or without `0x`.
    pub fn parse(raw: &str) -> Result<Self> {
        let text = raw.trim();
        let digits = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")).unwrap_or(text);
        let mut bytes = [0u8; 32];
        if digits.len() != 64 || hex::decode_to_slice(digits, &mut bytes).is_err() {
            bail!("Enter the API wallet's private key: 64 hexadecimal characters.");
        }
        match SigningKey::from_slice(&bytes) {
            Ok(key) => Ok(Self(key)),
            Err(_) => bail!("That is not a valid private key."),
        }
    }

    pub fn address(&self) -> Address {
        Address::of(self.0.verifying_key())
    }

    /// The key as hex, for the secret store only.
    pub fn to_secret(&self) -> String {
        hex::encode(self.0.to_bytes())
    }

    /// Signs `message` as EIP-712 typed data in the exchange's domain on `chain_id`.
    /// Returns `0x` + r + s + v, the form wallets and the exchange use.
    pub fn sign(&self, chain_id: u64, message: &str) -> String {
        let digest = typed_digest(chain_id, message);
        let (signature, recovery): (Signature, RecoveryId) = self.0.sign_prehash_recoverable(&digest);
        format!("0x{}{:02x}", hex::encode(signature.to_bytes()), 27 + recovery.to_byte())
    }
}

fn word(value: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&value.to_be_bytes());
    out
}

/// The EIP-712 domain separator for a domain with a zero verifying contract.
fn domain_separator(name: &str, version: &str, chain_id: u64, contract: &[u8; 20]) -> [u8; 32] {
    let mut data = Vec::with_capacity(160);
    data.extend(keccak(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    ));
    data.extend(keccak(name.as_bytes()));
    data.extend(keccak(version.as_bytes()));
    data.extend(word(chain_id));
    data.extend([0u8; 12]);
    data.extend(contract);
    keccak(&data)
}

/// The hash a wallet signs for the exchange's `Message(string msg)` typed data.
pub fn typed_digest(chain_id: u64, message: &str) -> [u8; 32] {
    let mut body = Vec::with_capacity(64);
    body.extend(keccak(b"Message(string msg)"));
    body.extend(keccak(message.as_bytes()));
    let mut data = Vec::with_capacity(66);
    data.extend([0x19, 0x01]);
    data.extend(domain_separator(DOMAIN_NAME, DOMAIN_VERSION, chain_id, &[0u8; 20]));
    data.extend(keccak(&body));
    keccak(&data)
}

/// The same typed data as JSON, for a wallet's `eth_signTypedData_v4`.
pub fn typed_data(chain_id: u64, message: &str) -> Value {
    json!({
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "Message": [{"name": "msg", "type": "string"}],
        },
        "primaryType": "Message",
        "domain": {
            "name": DOMAIN_NAME,
            "version": DOMAIN_VERSION,
            "chainId": chain_id,
            "verifyingContract": "0x0000000000000000000000000000000000000000",
        },
        "message": {"msg": message},
    })
}

/// The address that produced `signature` over `message`. Used to check a wallet's
/// approval before it is sent to the exchange.
pub fn recover(chain_id: u64, message: &str, signature: &str) -> Result<Address> {
    let invalid = || desk_err!("The wallet returned a signature this app cannot read.");
    let digits = signature.trim().strip_prefix("0x").unwrap_or(signature.trim());
    let bytes = hex::decode(digits).map_err(|_| invalid())?;
    if bytes.len() != 65 {
        return Err(invalid());
    }
    // Wallets send v as 27/28; a few send the bare recovery id.
    let recovery = RecoveryId::from_byte(if bytes[64] >= 27 { bytes[64] - 27 } else { bytes[64] })
        .ok_or_else(invalid)?;
    let parsed = Signature::from_slice(&bytes[..64]).map_err(|_| invalid())?;
    let key = VerifyingKey::recover_from_prehash(&typed_digest(chain_id, message), &parsed, recovery)
        .map_err(|_| invalid())?;
    Ok(Address::of(&key))
}

/// Encodes parameters the way the exchange's reference client does (`urllib.parse.urlencode`):
/// letters, digits and `_.-~` stay, a space becomes `+`, everything else is
/// percent-encoded as UTF-8. The result is both sent and signed, so it must be
/// built exactly once.
pub fn encode_params(pairs: &[(&str, String)]) -> String {
    fn push(out: &mut String, text: &str) {
        for byte in text.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-' | b'~' => out.push(byte as char),
                b' ' => out.push('+'),
                other => out.push_str(&format!("%{other:02X}")),
            }
        }
    }
    let mut out = String::new();
    for (index, (key, value)) in pairs.iter().enumerate() {
        if index > 0 {
            out.push('&');
        }
        push(&mut out, key);
        out.push('=');
        push(&mut out, value);
    }
    out
}

/// Microsecond nonces that never repeat, as the exchange's replay protection requires.
#[derive(Default)]
pub struct Nonces {
    last: AtomicU64,
}

impl Nonces {
    /// The next nonce: the current time in microseconds shifted by `offset_micros`
    /// (server time minus local time), and always greater than the previous one.
    pub fn next(&self, offset_micros: i64) -> u64 {
        let local = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as i64).unwrap_or(0);
        let now = (local + offset_micros).max(0) as u64;
        let mut previous = self.last.load(Ordering::SeqCst);
        loop {
            let next = now.max(previous + 1);
            match self.last.compare_exchange(previous, next, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => return next,
                Err(actual) => previous = actual,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The example API wallet printed in the exchange's own documentation.
    const DOC_KEY: &str = "0x4fd0a42218f3eae43a6ce26d22544e986139a01e5b34a62db53757ffca81bae1";
    const DOC_ADDRESS: &str = "0x21cF8Ae13Bb72632562c6Fff438652Ba1a151bb0";

    #[test]
    fn a_key_derives_the_address_the_exchange_documents_for_it() {
        let key = AgentKey::parse(DOC_KEY).expect("key");
        assert_eq!(key.address().to_string(), DOC_ADDRESS);
        assert_eq!(AgentKey::parse(&DOC_KEY[2..]).expect("without 0x").address(), key.address());
        assert_eq!(AgentKey::parse(&key.to_secret()).expect("round trip").address(), key.address());
        assert_eq!(
            format!("{key:?}"),
            format!("AgentKey({DOC_ADDRESS})"),
            "debug output names the address, never the key"
        );
        for bad in ["", "0x1234", &"z".repeat(64), &"0".repeat(64)] {
            assert!(AgentKey::parse(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn addresses_parse_in_any_case_and_print_with_a_checksum() {
        let address = Address::parse(&DOC_ADDRESS.to_lowercase()).expect("lower case");
        assert_eq!(address.to_string(), DOC_ADDRESS);
        assert_eq!(address, Address::parse(DOC_ADDRESS).expect("checksummed"));
        assert_eq!(address.short(), "0x21cF…1bb0");
        for bad in [
            "",
            "21cF8Ae13Bb72632562c6Fff438652Ba1a151bb0",
            "0x21cF",
            "0xZZcF8Ae13Bb72632562c6Fff438652Ba1a151bb0",
        ] {
            assert!(Address::parse(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn the_domain_separator_matches_the_eip_712_specification() {
        // The "Ether Mail" domain from the EIP-712 text and its published separator.
        let mut contract = [0u8; 20];
        hex::decode_to_slice("CcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC", &mut contract).expect("hex");
        assert_eq!(
            hex::encode(domain_separator("Ether Mail", "1", 1, &contract)),
            "f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f"
        );
    }

    #[test]
    fn signatures_recover_to_their_signer_and_depend_on_chain_and_message() {
        let key = AgentKey::parse(DOC_KEY).expect("key");
        let message = "symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.01&nonce=1748310859508867&signer=0x21cF8Ae13Bb72632562c6Fff438652Ba1a151bb0";
        let signature = key.sign(1666, message);
        assert!(signature.starts_with("0x") && signature.len() == 132, "{signature}");
        assert!(signature.ends_with("1b") || signature.ends_with("1c"), "v is 27 or 28: {signature}");
        assert_eq!(recover(1666, message, &signature).expect("recovers"), key.address());
        // Signing is deterministic, so a retry sends the same bytes.
        assert_eq!(key.sign(1666, message), signature);
        // A signature for one network or message is worthless for another.
        assert_ne!(recover(714, message, &signature).expect("recovers something"), key.address());
        assert_ne!(
            recover(1666, &message.replace("0.01", "1"), &signature).expect("recovers something"),
            key.address()
        );
        // A bare recovery id in the last byte is accepted too.
        let bare = format!(
            "{}{:02x}",
            &signature[..130],
            u8::from_str_radix(&signature[130..], 16).expect("v") - 27
        );
        assert_eq!(recover(1666, message, &bare).expect("recovers"), key.address());
        for bad in ["", "0x1234", &format!("0x{}", "0".repeat(130))] {
            assert!(recover(1666, message, bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn typed_data_for_a_wallet_carries_the_same_domain_and_message() {
        let data = typed_data(APPROVAL_CHAIN_ID, "user=0xabc&canWithdraw=false");
        assert_eq!(
            (&data["primaryType"], &data["domain"]["chainId"], &data["domain"]["name"]),
            (&json!("Message"), &json!(56), &json!("AsterSignTransaction"))
        );
        assert_eq!(data["message"]["msg"], "user=0xabc&canWithdraw=false");
        assert_eq!(data["types"]["Message"], json!([{"name": "msg", "type": "string"}]));
    }

    #[test]
    fn parameters_are_encoded_like_the_reference_client() {
        let pairs = [
            ("symbol", "币安人生USDT".to_string()),
            ("note", "a b&c=d~e*".to_string()),
            ("empty", String::new()),
        ];
        assert_eq!(
            encode_params(&pairs),
            "symbol=%E5%B8%81%E5%AE%89%E4%BA%BA%E7%94%9FUSDT&note=a+b%26c%3Dd~e%2A&empty="
        );
        assert_eq!(encode_params(&[]), "");
    }

    #[test]
    fn nonces_are_microseconds_that_only_go_up() {
        let nonces = Nonces::default();
        let first = nonces.next(0);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock").as_micros() as u64;
        assert!(now.abs_diff(first) < 5_000_000, "close to the clock");
        let burst: Vec<u64> = (0..1000).map(|_| nonces.next(0)).collect();
        assert!(burst.windows(2).all(|w| w[1] > w[0]) && burst[0] > first);
        // A clock that jumps back cannot produce a nonce that was already used.
        assert!(nonces.next(-3_600_000_000) > burst[999]);
        assert!(Nonces::default().next(60_000_000) > now + 50_000_000, "the server offset is applied");
    }

    #[test]
    fn generated_keys_are_distinct_and_usable() {
        let (a, b) = (AgentKey::generate().expect("key"), AgentKey::generate().expect("key"));
        assert_ne!(a.address(), b.address());
        assert_eq!(recover(714, "hello", &a.sign(714, "hello")).expect("recovers"), a.address());
    }
}
