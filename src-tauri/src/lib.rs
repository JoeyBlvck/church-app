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
    fs::{self, OpenOptions},
    io::Write,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const LOCAL_PORT: u16 = 47821;

struct LocalServer(Mutex<Option<Child>>);

// A plain-text diary of start-up (startup.log, in the app's data folder), so that if the app ever
// fails to open there is something to look at instead of nothing. Windows only: the offline
// edition is the one that has to be fixable on a PC with no internet and no developer around.
static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();

fn note(msg: &str) {
    if let Some(p) = LOG_FILE.get() {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(p) {
            let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let _ = writeln!(f, "[{}] {}", secs, msg);
        }
    }
}

// Logs the problem and, on Windows, tells the person in a message box -- a desktop app that fails
// silently looks exactly like one that "never opens".
fn show_error(msg: &str) {
    note(msg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("powershell")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show($env:CF_MSG, 'The ChurchFlow')",
            ])
            .env("CF_MSG", msg)
            .creation_flags(0x0800_0000)
            .spawn();
    }
}

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

// Starts the bundled server. Ok(None): this is the cloud edition, nothing is bundled. Err: this IS
// the offline edition but the server could not be started -- the reason is returned in plain words.
// The server's own standard input stays open for as long as this app runs: when the app closes --
// or crashes -- the input ends and the server stops with it.
fn start_local_server(app: &tauri::AppHandle) -> Result<Option<Child>, String> {
    let offline = app.config().identifier.ends_with(".offline");
    let res = plain(app.path().resource_dir().map_err(|e| format!("no resource folder: {e}"))?);
    let candidates = [res.join("local-server"), res.join("resources").join("local-server")];
    let base = candidates.iter().find(|p| p.join("server").join("src").join("local.js").exists());
    let Some(base) = base else {
        if offline {
            return Err(format!("The program files of the church server are missing from this installation (looked in {}). Please reinstall The ChurchFlow.", res.display()));
        }
        return Ok(None);
    };
    let node = base.join(if cfg!(windows) { "node.exe" } else { "node" });
    if !node.exists() {
        return Err(format!("node is missing from the installation ({}). Please reinstall The ChurchFlow.", node.display()));
    }
    let script = base.join("server").join("src").join("local.js");
    let data_dir = plain(app.path().app_data_dir().map_err(|e| format!("no data folder: {e}"))?);
    fs::create_dir_all(&data_dir).map_err(|e| format!("cannot create the data folder {}: {e}", data_dir.display()))?;
    let backup_dir = match app.path().document_dir() {
        Ok(d) => plain(d).join("ChurchFlow Backups"),
        Err(_) => data_dir.join("Backups"),
    };
    note(&format!("starting {} {}", node.display(), script.display()));
    let mut cmd = Command::new(&node);
    cmd.arg("--no-warnings")
        .arg(&script)
        .env("DATA_DIR", &data_dir)
        .env("BACKUP_DIR", &backup_dir)
        .env("PORT", LOCAL_PORT.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no black console window flashing up
    }
    cmd.spawn().map(Some).map_err(|e| format!("Windows would not start the church server ({}): {e}", node.display()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let dir = PathBuf::from(appdata).join(&context.config().identifier);
            if fs::create_dir_all(&dir).is_ok() {
                let _ = LOG_FILE.set(dir.join("startup.log"));
            }
        }
    }
    // The release build aborts on a panic with no window and no message; say something first.
    std::panic::set_hook(Box::new(|info| {
        show_error(&format!(
            "The ChurchFlow stopped unexpectedly.\n\n{info}\n\nA note about this was saved in startup.log (in the folder %APPDATA%\\com.joeystudios.churchflow.offline)."
        ));
    }));
    note("launching");

    let built = tauri::Builder::default()
        // See app/js/updater.js: it drives both of these from the frontend via
        // window.__TAURI__.updater / .process (app.withGlobalTauri, set in tauri.conf.json, is what
        // exposes that global). The offline edition turns the update check off -- see
        // tauri.offline.conf.json and updater.js -- since the church PC has no internet and its
        // installer is not the cloud app's.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // The window opens straight away. The server is started first, but the page itself waits
            // for it (app/js/main.js), so a slow start shows as "starting", never as an app that
            // does not open.
            let mut offline = false;
            let mut child = None;
            if local_server_up() {
                // Already answering (a second window of the app, say): use it as it is.
                offline = true;
                note("a server is already running; using it");
            } else {
                match start_local_server(app.handle()) {
                    Ok(Some(c)) => {
                        offline = true;
                        child = Some(c);
                        note("server process started");
                    }
                    Ok(None) => note("cloud edition: no bundled server"),
                    Err(e) => {
                        offline = true;
                        show_error(&e);
                    }
                }
            }
            let started = child.is_some();
            app.manage(LocalServer(Mutex::new(child)));

            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("The ChurchFlow")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .resizable(true);
            if offline {
                window = window.initialization_script(&format!(
                    "window.__CHURCHFLOW_LOCAL_API__ = 'http://127.0.0.1:{}';",
                    LOCAL_PORT
                ));
            }
            if let Err(e) = window.build() {
                show_error(&format!("The ChurchFlow window could not be opened: {e}\n\nIf this keeps happening, the Windows component \"WebView2\" may be missing or damaged."));
                return Err(e.into());
            }
            note("window opened");

            if started {
                // If the server never starts listening, say so rather than leave a blank page.
                thread::spawn(|| {
                    let deadline = Instant::now() + Duration::from_secs(60);
                    while !local_server_up() && Instant::now() < deadline {
                        thread::sleep(Duration::from_millis(200));
                    }
                    if local_server_up() {
                        note("server is answering");
                    } else {
                        show_error("The church server did not start. Close The ChurchFlow and open it again. If it still does not work, please send the file server.log (in the folder %APPDATA%\\com.joeystudios.churchflow.offline) to Joey Studios.");
                    }
                });
            }
            Ok(())
        })
        .build(context);
    let app = match built {
        Ok(a) => a,
        Err(e) => {
            show_error(&format!("The ChurchFlow could not start: {e}"));
            return;
        }
    };

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
