use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use x25519_dalek::{EphemeralSecret, PublicKey};

pub fn derive_room_key(password: &str) -> [u8; 32] {
    *blake3::hash(password.as_bytes()).as_bytes()
}

pub struct CryptoSession {
    secret: EphemeralSecret,
    pub public_key: PublicKey,
}

impl CryptoSession {
    pub fn new() -> Self {
        let secret = EphemeralSecret::random_from_rng(OsRng);
        let public_key = PublicKey::from(&secret);
        Self { secret, public_key }
    }

    pub fn compute_shared_secret(self, peer_pub_key: &PublicKey) -> [u8; 32] {
        *self.secret.diffie_hellman(peer_pub_key).as_bytes()
    }
}

pub fn encrypt(shared_secret: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = ChaCha20Poly1305::new(shared_secret.into());
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    match cipher.encrypt(nonce, plaintext) {
        Ok(ciphertext) => {
            let mut payload = nonce_bytes.to_vec();
            payload.extend_from_slice(&ciphertext);
            Ok(payload)
        }
        Err(e) => Err(format!("Şifreleme hatası: {:?}", e)),
    }
}

pub fn decrypt(shared_secret: &[u8; 32], payload: &[u8]) -> Result<Vec<u8>, String> {
    if payload.len() < 12 {
        return Err("Paket geçersiz!".to_string());
    }

    let cipher = ChaCha20Poly1305::new(shared_secret.into());
    let (nonce_bytes, ciphertext) = payload.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    match cipher.decrypt(nonce, ciphertext) {
        Ok(plaintext) => Ok(plaintext),
        Err(_) => Err("Şifre çözme hatası!".to_string()),
    }
}
