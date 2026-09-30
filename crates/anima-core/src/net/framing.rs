//! Sans-IO frame decoder: turns a byte stream into discrete packets.
//!
//! This handles the **login phase** (uncompressed) stream. The game phase adds
//! a Huffman layer *before* framing — that decompressor (TODO `net::huffman`)
//! will feed its decompressed output into the same length-based logic here.
//!
//! Sans-IO by design: you `feed()` whatever bytes arrived from the socket and
//! `pop()` complete frames. No sockets, no async — so it runs identically on
//! native and WASM, and is trivially testable from byte vectors (e.g. replaying
//! `uo_proxy` captures).

use super::lengths::{packet_length, PacketLength};

/// Counts and packet metadata only; no payload or credential bytes are exposed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DecoderDiagnostics {
    pub compressed_bytes: usize,
    pub decoded_bytes: usize,
    pub pending_opcode: Option<u8>,
    pub pending_frame_length: Option<usize>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FramingError {
    /// Packet id is not in the length table — we can't know its boundary, so the
    /// stream can't be safely resynced without higher-level knowledge.
    /// `net::lengths` covers all 256 ids, so this is the fail-closed path for a
    /// row that went missing rather than something a shard can provoke.
    UnknownPacket(u8),
    /// A variable-length frame declared a total length < 3 (impossible: the
    /// id + length header alone is 3 bytes). Indicates a desync/corruption.
    MalformedLength { id: u8, declared: u16 },
}

impl std::fmt::Display for FramingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Name the opcode in hex: the only fix for either error is to go
            // edit that id's row in `net::lengths`.
            FramingError::UnknownPacket(id) => {
                write!(f, "packet 0x{id:02X} has no entry in the length table")
            }
            FramingError::MalformedLength { id, declared } => {
                write!(f, "packet 0x{id:02X} declared length {declared} (< 3)")
            }
        }
    }
}

// Paired with `Display` like every other error in the net stack (`PacketError`
// in `net::packet`, `DriverError` in `anima-net`), so a caller can box this or
// `?` it into an error type that requires `std::error::Error`.
impl std::error::Error for FramingError {}

/// Accumulates bytes and yields complete frames.
#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append freshly-received bytes.
    pub fn feed(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    fn diagnostics(&self) -> DecoderDiagnostics {
        let pending_opcode = self.buf.first().copied();
        let pending_frame_length = pending_opcode.and_then(|id| match packet_length(id) {
            PacketLength::Fixed(length) => Some(length),
            PacketLength::Variable if self.buf.len() >= 3 => {
                Some(u16::from_be_bytes([self.buf[1], self.buf[2]]) as usize)
            }
            _ => None,
        });
        DecoderDiagnostics {
            decoded_bytes: self.buf.len(),
            pending_opcode,
            pending_frame_length,
            ..DecoderDiagnostics::default()
        }
    }

    /// Pop one complete frame (id byte included), or `None` if more bytes are
    /// needed. The returned frame includes the id and, for variable packets,
    /// the 2-byte length field — i.e. exactly the bytes on the wire.
    pub fn pop(&mut self) -> Result<Option<Vec<u8>>, FramingError> {
        if self.buf.is_empty() {
            return Ok(None);
        }
        let id = self.buf[0];
        match packet_length(id) {
            PacketLength::Fixed(n) => {
                if self.buf.len() < n {
                    return Ok(None);
                }
                Ok(Some(self.split_off_front(n)))
            }
            PacketLength::Variable => {
                if self.buf.len() < 3 {
                    return Ok(None);
                }
                let declared = u16::from_be_bytes([self.buf[1], self.buf[2]]);
                if declared < 3 {
                    return Err(FramingError::MalformedLength { id, declared });
                }
                let total = declared as usize;
                if self.buf.len() < total {
                    return Ok(None);
                }
                Ok(Some(self.split_off_front(total)))
            }
            PacketLength::Unknown => Err(FramingError::UnknownPacket(id)),
        }
    }

    fn split_off_front(&mut self, n: usize) -> Vec<u8> {
        let frame = self.buf[..n].to_vec();
        self.buf.drain(..n);
        frame
    }
}

/// Game-phase decoder: Huffman-decompress incoming bytes, then frame the
/// decompressed stream with the same length logic as [`FrameDecoder`].
#[derive(Default)]
pub struct GameFrameDecoder {
    compressed: Vec<u8>,
    frames: FrameDecoder,
}

impl GameFrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append freshly-received (compressed) bytes, decompressing every complete
    /// chunk into the inner frame buffer.
    pub fn feed(&mut self, data: &[u8]) {
        self.compressed.extend_from_slice(data);
        while let Some((chunk, consumed)) = super::huffman::decompress_one(&self.compressed, 0) {
            if consumed == 0 {
                break;
            }
            self.compressed.drain(..consumed);
            self.frames.feed(&chunk);
        }
    }

    pub fn pop(&mut self) -> Result<Option<Vec<u8>>, FramingError> {
        self.frames.pop()
    }
}

/// A connection's incoming decoder. Starts in login phase (plaintext) and is
/// switched to game phase (Huffman) when the login handshake reconnects to the
/// game server. Lets a driver hold one object across both phases.
pub enum StreamDecoder {
    Login(FrameDecoder),
    Game(GameFrameDecoder),
}

impl Default for StreamDecoder {
    fn default() -> Self {
        StreamDecoder::Login(FrameDecoder::new())
    }
}

impl StreamDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Switch to game phase. Call this exactly when reconnecting to the game
    /// server (a fresh connection → fresh, empty Huffman state).
    pub fn switch_to_game(&mut self) {
        *self = StreamDecoder::Game(GameFrameDecoder::new());
    }

    pub fn feed(&mut self, data: &[u8]) {
        match self {
            StreamDecoder::Login(d) => d.feed(data),
            StreamDecoder::Game(d) => d.feed(data),
        }
    }

    pub fn pop(&mut self) -> Result<Option<Vec<u8>>, FramingError> {
        match self {
            StreamDecoder::Login(d) => d.pop(),
            StreamDecoder::Game(d) => d.pop(),
        }
    }

    pub fn diagnostics(&self) -> DecoderDiagnostics {
        match self {
            StreamDecoder::Login(decoder) => decoder.diagnostics(),
            StreamDecoder::Game(decoder) => DecoderDiagnostics {
                compressed_bytes: decoder.compressed.len(),
                ..decoder.frames.diagnostics()
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_frame_split_across_feeds() {
        // 0x55 LoginComplete = fixed 1 byte; 0x8C ServerRedirect = fixed 11.
        let mut d = FrameDecoder::new();
        d.feed(&[0x55]);
        assert_eq!(d.pop().unwrap(), Some(vec![0x55]));
        assert_eq!(d.pop().unwrap(), None);

        // 0x8C split into two reads.
        d.feed(&[0x8C, 0, 0, 0, 0]);
        assert_eq!(d.pop().unwrap(), None); // only 5 of 11 bytes
        d.feed(&[0, 0, 0xDE, 0xAD, 0xBE, 0xEF]);
        assert_eq!(d.pop().unwrap().unwrap().len(), 11);
    }

    #[test]
    fn variable_frame() {
        // 0xA8 ServerList = variable. Build a 6-byte frame: [id][len=6][body..]
        let mut d = FrameDecoder::new();
        d.feed(&[0xA8, 0x00, 0x06, 0x01, 0x02, 0x03]);
        let f = d.pop().unwrap().unwrap();
        assert_eq!(f, vec![0xA8, 0x00, 0x06, 0x01, 0x02, 0x03]);
        assert_eq!(d.pop().unwrap(), None);
    }

    #[test]
    fn two_frames_back_to_back() {
        let mut d = FrameDecoder::new();
        d.feed(&[0x55, 0x55]); // two LoginComplete
        assert_eq!(d.pop().unwrap(), Some(vec![0x55]));
        assert_eq!(d.pop().unwrap(), Some(vec![0x55]));
        assert_eq!(d.pop().unwrap(), None);
    }

    #[test]
    fn unhandled_id_still_frames() {
        // 0x50 is a bulletin-board packet we have no handler for. Framing it is
        // still mandatory — before `net::lengths` was completed this errored out
        // and took the whole session with it.
        let mut d = FrameDecoder::new();
        d.feed(&[0x50, 0x00, 0x05, 0xAA, 0xBB, 0x55]);
        assert_eq!(d.pop().unwrap(), Some(vec![0x50, 0x00, 0x05, 0xAA, 0xBB]));
        assert_eq!(d.pop().unwrap(), Some(vec![0x55]));
    }

    #[test]
    fn malformed_length() {
        let mut d2 = FrameDecoder::new();
        d2.feed(&[0xA8, 0x00, 0x02]); // variable but declared < 3
        assert_eq!(
            d2.pop(),
            Err(FramingError::MalformedLength {
                id: 0xA8,
                declared: 2
            })
        );
    }

    #[test]
    fn diagnostics_distinguish_partial_header_body_and_empty_stream() {
        let mut decoder = StreamDecoder::new();
        assert_eq!(decoder.diagnostics(), DecoderDiagnostics::default());
        decoder.feed(&[0xA8, 0x01]);
        assert_eq!(decoder.diagnostics().pending_opcode, Some(0xA8));
        assert_eq!(decoder.diagnostics().pending_frame_length, None);
        decoder.feed(&[0x00, 0xAA]);
        assert_eq!(decoder.diagnostics().pending_frame_length, Some(256));
        assert_eq!(decoder.diagnostics().decoded_bytes, 4);
        decoder.switch_to_game();
        decoder.feed(&[0xFF]);
        assert_eq!(decoder.diagnostics().compressed_bytes, 1);
    }

    #[test]
    fn errors_name_the_opcode() {
        // Both errors are fatal to the session, so the message has to say which
        // id to go add — in hex, the way every packet reference writes them.
        assert_eq!(
            FramingError::UnknownPacket(0x50).to_string(),
            "packet 0x50 has no entry in the length table"
        );
        assert_eq!(
            FramingError::MalformedLength {
                id: 0xA8,
                declared: 2
            }
            .to_string(),
            "packet 0xA8 declared length 2 (< 3)"
        );
    }
}
