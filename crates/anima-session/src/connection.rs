//! Bounded, cancellable native login transport. No credentials enter dial workers.
use crate::{DriverError, Endpoint};
use std::io;
use std::net::{Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Correlates UI work with one connection or prompt, including after a process
/// restart. This is an identity, not a credential or an authorization secret.
pub fn fresh_context_id() -> String {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{:x}-{time:x}-{:x}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

const DIAL_TIMEOUT: Duration = Duration::from_secs(8);
const WAIT_SLICE: Duration = Duration::from_millis(50);

#[derive(Clone, Copy)]
#[repr(u8)]
pub enum LoginPhase {
    Resolving,
    Connecting,
    Authenticating,
    GameServer,
    Characters,
    CharacterAction,
}
impl LoginPhase {
    pub fn message(self) -> &'static str {
        match self {
            Self::Resolving => "Looking up server address…",
            Self::Connecting => "Connecting to the login server…",
            Self::Authenticating => "Authenticating account…",
            Self::GameServer => "Connecting to the game server…",
            Self::Characters => "Choose a character.",
            Self::CharacterAction => "Waiting for the server's character response…",
        }
    }
}
struct Inner {
    id: String,
    // 0: active, 1: cancelled, 2: committed to a live session.
    state: AtomicU8,
    phase: AtomicU8,
    socket: Mutex<Option<TcpStream>>,
}
/// One attempt, including both UO connections and interactive character choice.
/// Cancelling closes its socket and never affects a newer attempt.
#[derive(Clone)]
pub struct LoginControl(Arc<Inner>);
impl Default for LoginControl {
    fn default() -> Self {
        Self(Arc::new(Inner {
            id: fresh_context_id(),
            state: AtomicU8::new(0),
            phase: AtomicU8::new(LoginPhase::Resolving as u8),
            socket: Mutex::new(None),
        }))
    }
}
impl LoginControl {
    pub fn id(&self) -> &str {
        &self.0.id
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.state.load(Ordering::Acquire) == 1
    }
    pub fn is_active(&self) -> bool {
        self.0.state.load(Ordering::Acquire) == 0
    }
    pub fn cancel(&self) -> bool {
        if self
            .0
            .state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return self.is_cancelled();
        }
        if let Some(socket) = self.0.socket.lock().unwrap().take() {
            let _ = socket.shutdown(Shutdown::Both);
        }
        true
    }
    pub fn check(&self) -> Result<(), DriverError> {
        if self.is_cancelled() {
            Err(DriverError::LoginCancelled)
        } else {
            Ok(())
        }
    }
    pub(crate) fn set_phase(&self, phase: LoginPhase) {
        self.0.phase.store(phase as u8, Ordering::Release);
    }
    pub fn message(&self) -> &'static str {
        if self.is_cancelled() {
            return "Cancelling connection…";
        }
        match self.0.phase.load(Ordering::Acquire) {
            0 => LoginPhase::Resolving,
            1 => LoginPhase::Connecting,
            2 => LoginPhase::Authenticating,
            3 => LoginPhase::GameServer,
            4 => LoginPhase::Characters,
            _ => LoginPhase::CharacterAction,
        }
        .message()
    }
    pub(crate) fn attach(&self, socket: &TcpStream) -> Result<(), DriverError> {
        let mut active = self.0.socket.lock().unwrap();
        self.check()?;
        *active = Some(socket.try_clone()?);
        Ok(())
    }
    pub(crate) fn release(&self) {
        self.0.socket.lock().unwrap().take();
    }
    pub(crate) fn finish(&self) -> Result<(), DriverError> {
        self.0
            .state
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| DriverError::LoginCancelled)?;
        self.release();
        Ok(())
    }
}

/// DNS resolution cannot be interrupted in std. Isolate DNS/dial in a worker
/// containing only an endpoint and cancellation flag; its late socket is dropped,
/// never handed a password. The caller stops waiting immediately on cancellation.
pub(crate) fn dial(endpoint: &Endpoint, control: &LoginControl) -> Result<TcpStream, DriverError> {
    control.set_phase(LoginPhase::Resolving);
    let host = endpoint.host.clone();
    let port = endpoint.port;
    let token = control.clone();
    dial_worker(control, DIAL_TIMEOUT, move |deadline| {
        let addresses = (host.as_str(), port)
            .to_socket_addrs()?
            .take(8)
            .collect::<Vec<_>>();
        token.set_phase(LoginPhase::Connecting);
        connect_addresses(addresses, deadline, &token)
    })
}
pub(crate) fn dial_address(
    address: SocketAddr,
    timeout: Duration,
    control: &LoginControl,
) -> Result<TcpStream, DriverError> {
    let token = control.clone();
    dial_worker(control, timeout, move |deadline| {
        connect_addresses(vec![address], deadline, &token)
    })
}
fn connect_addresses(
    addresses: Vec<SocketAddr>,
    deadline: Instant,
    control: &LoginControl,
) -> io::Result<TcpStream> {
    let mut last = io::Error::new(
        io::ErrorKind::AddrNotAvailable,
        "server has no usable address",
    );
    for address in addresses {
        if control.is_cancelled() {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "connection timed out",
            ));
        };
        match TcpStream::connect_timeout(&address, left.min(Duration::from_secs(3))) {
            Ok(socket) => return Ok(socket),
            Err(error) => last = error,
        }
    }
    Err(last)
}
fn dial_worker(
    control: &LoginControl,
    timeout: Duration,
    work: impl FnOnce(Instant) -> io::Result<TcpStream> + Send + 'static,
) -> Result<TcpStream, DriverError> {
    control.check()?;
    let deadline = Instant::now() + timeout;
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("anima-dial".into())
        .spawn(move || {
            let _ = tx.send(work(deadline));
        })?;
    loop {
        control.check()?;
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            return Err(DriverError::LoginTimeout);
        };
        match rx.recv_timeout(left.min(WAIT_SLICE)) {
            Ok(result) => {
                control.check()?;
                let socket = result?;
                socket.set_nodelay(true)?;
                socket.set_write_timeout(Some(Duration::from_secs(5)))?;
                control.attach(&socket)?;
                return Ok(socket);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(io::Error::other("connection worker stopped").into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_releases_a_waiting_resolver_without_waiting_for_it() {
        let control = LoginControl::default();
        let worker_control = control.clone();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let result = dial_worker(&worker_control, Duration::from_secs(10), move |_| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Err(io::Error::other("fixture resolver finished"))
            });
            result_tx
                .send(matches!(result, Err(DriverError::LoginCancelled)))
                .unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(control.cancel());
        let cancelled = result_rx.recv_timeout(Duration::from_secs(2));
        release_tx.send(()).unwrap();
        waiter.join().unwrap();
        assert!(cancelled.unwrap());
    }
    #[test]
    fn a_finished_attempt_cannot_be_cancelled_and_ids_are_distinct() {
        let old = LoginControl::default();
        old.finish().unwrap();
        let next = LoginControl::default();
        assert_ne!(old.id(), next.id());
        assert!(!old.cancel());
        assert!(next.is_active());
        assert!(next.cancel());
        assert!(next.finish().is_err());
    }
}
