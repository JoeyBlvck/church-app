// The ChurchFlow desktop wrapper. The app itself is the existing local-first web client
// (../app) — this crate puts it in a native window via Tauri.
//
// Two editions share this one crate:
//
//  * Cloud edition (the Mac/Windows builds in .github/workflows/desktop-build.yml): no server is
//    bundled. The frontend talks to the hosted sync server over HTTPS exactly like it does in a
//    browser, and works offline the same way (IndexedDB), syncing whenever there's a connection.
//
//  * Offline edition (.github/workflows/offline-windows-build.yml): the installer also carries a
//    copy of Node and the sync server ("local-server" resource, assembled by
//    scripts/prepare-offline.mjs). On start-up this starts that server on 127.0.0.1 -- this
//    computer only -- keeps it running for as long as the window is open, and tells the page where
//    it is (window.__CHURCHFLOW_LOCAL_API__, read by app/js/config.js). Nothing leaves the PC; the
//    church's records live in the app's data folder and are backed up by the server itself
//    (server/src/backup.js). Whether this is the offline edition is decided purely by whether the
//    "local-server" resource exists, so the cloud builds are unaffected.
use std::{
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const LOCAL_PORT: u16 = 47821;

struct LocalServer(Mutex<Option<Child>>);

fn local_server_up() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], LOCAL_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

// Tauri hands back Windows paths in the verbatim form `\\?\C:\...`, which Node cannot load a
// script from. Strip the prefix so the same path works for both.
fn plain(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

// Starts the bundled server, or returns None when this isn't the offline edition (nothing bundled)
// or it could not be started. The server's own standard input stays open for as long as this app
// runs: when the app closes -- or crashes -- the input ends and the server stops with it.
fn start_local_server(app: &tauri::AppHandle) -> Option<Child> {
    let res = plain(app.path().resource_dir().ok()?);
    let base = [res.join("local-server"), res.join("resources").join("local-server")]
        .into_iter()
        .find(|p| p.join("server").join("src").join("local.js").exists())?;
    let node = base.join(if cfg!(windows) { "node.exe" } else { "node" });
    if !node.exists() {
        return None;
    }
    let script = base.join("server").join("src").join("local.js");
    let data_dir = plain(app.path().app_data_dir().ok()?);
    let backup_dir = match app.path().document_dir() {
        Ok(d) => plain(d).join("ChurchFlow Backups"),
        Err(_) => data_dir.join("Backups"),
    };
    let mut cmd = Command::new(node);
    cmd.arg("--no-warnings")
        .arg(script)
        .env("DATA_DIR", data_dir)
        .env("BACKUP_DIR", backup_dir)
        .env("PORT", LOCAL_PORT.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no black console window flashing up
    }
    cmd.spawn().ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // See app/js/updater.js: it drives both of these from the frontend via
        // window.__TAURI__.updater / .process (app.withGlobalTauri, set in tauri.conf.json, is what
        // exposes that global). The offline edition turns the update check off -- see
        // tauri.offline.conf.json and updater.js -- since the church PC has no internet and its
        // installer is not the cloud app's.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // If something is already answering on our port (a second window of the app, say), use it
            // as it is rather than fighting over the port.
            let started = if local_server_up() { None } else { start_local_server(app.handle()) };
            let had_bundle = started.is_some();
            app.manage(LocalServer(Mutex::new(started)));

            // Give the server a few seconds to start listening before the page loads and asks for it.
            let deadline = Instant::now() + Duration::from_secs(25);
            while had_bundle && !local_server_up() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(150));
            }

            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("The ChurchFlow")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .resizable(true);
            if local_server_up() {
                window = window.initialization_script(&format!(
                    "window.__CHURCHFLOW_LOCAL_API__ = 'http://127.0.0.1:{}';",
                    LOCAL_PORT
                ));
            }
            window.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building The ChurchFlow");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<LocalServer>() {
                if let Some(mut child) = state.0.lock().ok().and_then(|mut g| g.take()) {
                    drop(child.stdin.take()); // end of its input tells it to shut down cleanly
                    let deadline = Instant::now() + Duration::from_secs(4);
                    while Instant::now() < deadline {
                        if let Ok(Some(_)) = child.try_wait() {
                            return;
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                    let _ = child.kill();
                }
            }
        }
    });
}
