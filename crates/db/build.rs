fn main() {
    // `sqlx::migrate!` embeds migrations at compile time. Cargo does not
    // otherwise know that adding a file under this directory must rebuild the
    // db crate, which can produce a binary with new queries but an old embedded
    // migrator. Tracking the directory also catches newly added migrations.
    println!("cargo:rerun-if-changed=migrations");
}
