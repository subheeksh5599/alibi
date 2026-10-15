fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto");
    println!("cargo:rerun-if-changed={}", proto_dir.display());
    tonic_build::configure()
        .build_server(false)
        .compile_protos(
            &[proto_dir.join("service.proto"), proto_dir.join("compact_formats.proto")],
            &[proto_dir],
        )?;
    Ok(())
}
