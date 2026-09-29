// The ChurchFlow desktop wrapper. The app itself is the existing local-first web client
// (../app) — this crate just puts it in a native window via Tauri. No custom commands or
// bundled server: the frontend talks to the hosted sync server directly over HTTPS exactly
// like it does in a browser, and works offline the same way (IndexedDB), syncing whenever
// a connection is available.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running The ChurchFlow");
}
