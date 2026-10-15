fn main() {
    let proto = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../proto");
    println!("cargo:rerun-if-changed={}", proto.display());
    prost_build::compile_protos(&[proto.join("service.proto"), proto.join("compact_formats.proto")], &[proto]).unwrap();
}
