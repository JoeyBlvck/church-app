// The ChurchFlow desktop wrapper. The app itself is the existing local-first web client
// (../app) — this crate just puts it in a native window via Tauri. No custom commands or
// bundled server: the frontend talks to the hosted sync server directly over HTTPS exactly
// like it does in a browser, and works offline the same way (IndexedDB), syncing whenever
// a connection is available.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // See app/js/updater.js: it drives both of these from the frontend via
        // window.__TAURI__.updater / .process (app.withGlobalTauri, set in tauri.conf.json,
        // is what exposes that global without needing an npm build step for the frontend).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("error while running The ChurchFlow");
}
