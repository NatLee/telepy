//! 掃描辨識網頁時用的 TLS 設定：接受任何憑證。區網裡幾乎都是自簽的，而我們只是**讀**它（主體、簽發者、到期），
//! 不送任何秘密、不信任任何回答。只給 `scan.rs` 的辨識用，別拿去連真正要信任的東西。
//! The TLS config for fingerprinting web ports during a scan: it accepts any certificate. LAN certificates are nearly
//! always self-signed, and we only *read* one (subject, issuer, expiry) — nothing secret is sent and nothing is trusted.
//! For the scan's identify step only; never use it for a connection that has to be trusted.

use std::sync::{Arc, OnceLock};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};

#[derive(Debug)]
struct ReadOnly(Arc<CryptoProvider>);

impl ServerCertVerifier for ReadOnly {
    fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// 只讀憑證的 TLS 設定（建一次）。/ The read-only-certificate TLS config (built once).
pub fn any_cert_config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let config = ClientConfig::builder_with_provider(provider.clone())
                .with_safe_default_protocol_versions()
                .expect("ring supports the default TLS versions")
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(ReadOnly(provider)))
                .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}
