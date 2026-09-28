use super::*;
use std::net::TcpListener;
use std::sync::mpsc;

fn stalled_server() -> (Endpoint, mpsc::Receiver<()>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (ready_tx, ready_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut initial = [0; 83]; // 0xEF seed + 0x80 account login
        socket.read_exact(&mut initial).unwrap();
        assert_eq!((initial[0], initial[21]), (0xEF, 0x80));
        ready_tx.send(()).unwrap();
        // An incomplete server-list frame must not count as a completed phase.
        socket.write_all(&[0xA8]).unwrap();
        let mut tail = [0; 1];
        let _ = socket.read(&mut tail);
    });
    (Endpoint::new("127.0.0.1", port), ready_rx, worker)
}

#[test]
fn cancelled_login_closes_a_stalled_authentication_socket() {
    let (endpoint, ready, server) = stalled_server();
    let control = LoginControl::default();
    let worker_control = control.clone();
    let (tx, rx) = mpsc::channel();
    let client = std::thread::spawn(move || {
        let result = Session::connect_and_login_controlled(
            &endpoint,
            LoginConfig::default(),
            &worker_control,
            None,
        );
        tx.send(matches!(result, Err(DriverError::LoginCancelled)))
            .unwrap();
    });
    ready.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(control.cancel());
    assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap());
    client.join().unwrap();
    server.join().unwrap();
}

#[test]
fn an_incomplete_packet_cannot_keep_the_login_phase_alive_forever() {
    let (endpoint, ready, server) = stalled_server();
    let control = LoginControl::default();
    let result = login(
        &endpoint,
        LoginConfig::default(),
        None,
        &control,
        Duration::from_millis(100),
    );
    control.release();
    assert!(ready.recv_timeout(Duration::from_secs(2)).is_ok());
    assert!(matches!(result, Err(DriverError::LoginTimeout)));
    server.join().unwrap();
}

#[test]
fn cancellation_before_dial_opens_no_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = Endpoint::new("127.0.0.1", listener.local_addr().unwrap().port());
    let control = LoginControl::default();
    control.cancel();
    assert!(matches!(
        Session::connect_and_login_controlled(&endpoint, LoginConfig::default(), &control, None),
        Err(DriverError::LoginCancelled)
    ));
    assert_eq!(listener.accept().unwrap_err().kind(), ErrorKind::WouldBlock);
}

fn successful_login_server() -> (Endpoint, std::thread::JoinHandle<()>) {
    // Canonical Huffman encodings of 0xA9 (one "Fixture" character, no cities)
    // and 0x1B (serial 42, body 400, position 1000/2000). These exercise the real
    // login machine/stream decoder, not a mocked "login succeeded" callback.
    const CHARACTERS: &[u8] = &[
        129, 73, 111, 227, 224, 228, 230, 155, 15, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 104,
    ];
    const CONFIRM: &[u8] = &[
        72, 0, 130, 0, 250, 230, 147, 187, 37, 240, 0, 0, 0, 0, 0, 52,
    ];
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket.read_exact(&mut [0; 83]).unwrap();
        socket.write_all(&[0xA8, 0, 6, 0, 0, 0]).unwrap();
        let mut selection = [0; 3];
        socket.read_exact(&mut selection).unwrap();
        assert_eq!(selection, [0xA0, 0, 0]);
        let mut redirect = vec![0x8C, 127, 0, 0, 1];
        redirect.extend(port.to_be_bytes());
        redirect.extend([0x11, 0x22, 0x33, 0x44]);
        socket.write_all(&redirect).unwrap();
        drop(socket);
        let (mut game, _) = listener.accept().unwrap();
        game.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut login = [0; 69]; // game seed (4) + 0x91 (65)
        game.read_exact(&mut login).unwrap();
        assert_eq!(login[4], 0x91);
        game.write_all(CHARACTERS).unwrap();
        let mut play = [0; 73];
        game.read_exact(&mut play).unwrap();
        assert_eq!(play[0], 0x5D);
        game.write_all(CONFIRM).unwrap();
        // Keep the transport alive for Session's initial stats/view requests.
        let _ = game.read_to_end(&mut Vec::new());
    });
    (Endpoint::new("127.0.0.1", port), server)
}

#[test]
fn two_phase_login_excludes_human_character_choice_from_the_response_deadline() {
    let (endpoint, server) = successful_login_server();
    let control = LoginControl::default();
    let cfg = LoginConfig {
        defer_character_choice: true,
        ..Default::default()
    };
    let mut choose = |prompt: CharacterPrompt| {
        assert_eq!(prompt.list.slots[0].name, "Fixture");
        std::thread::sleep(Duration::from_millis(600));
        Ok(CharacterChoice::Play(0))
    };
    let result = login(
        &endpoint,
        cfg,
        Some(&mut choose),
        &control,
        Duration::from_millis(500),
    );
    control.release();
    assert_eq!(result.unwrap().0.serial, 42);
    server.join().unwrap();
}

#[test]
fn sessions_keep_connection_identity_but_reconnects_with_the_same_serial_do_not() {
    let mut ids = Vec::new();
    for _ in 0..2 {
        let (endpoint, server) = successful_login_server();
        let session = Session::connect_and_login(
            &endpoint,
            LoginConfig {
                username: "layout-account".into(),
                password: "fixture-password-not-layout".into(),
                ..LoginConfig::default()
            },
        )
        .unwrap();
        let id = session.id().to_owned();
        assert!(!id.is_empty());
        // `anima-net`'s render scene publishes these two verbatim as `sessionId` and
        // `layoutIdentity`; they must hold steady across polls of one connection.
        for _ in 0..2 {
            assert_eq!(session.id(), id);
            let layout = session.layout_identity();
            let identity: serde_json::Value = serde_json::from_str(layout).unwrap();
            assert_eq!(
                identity,
                serde_json::json!([
                    "native-v1",
                    endpoint.host,
                    endpoint.port,
                    0,
                    "layout-account"
                ])
            );
            assert!(!layout.contains("fixture-password-not-layout"));
        }
        ids.push(id);
        drop(session);
        server.join().unwrap();
    }
    assert_ne!(ids[0], ids[1]);
}
