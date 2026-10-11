# Key Escrow & Disaster Recovery Procedure

**Dokumen:** `docs/operations/key-escrow.md`  
**Status:** ACTIVE (Sprint P0 / BR-8e)  
**Tujuan:** Menjamin kunci enkripsi kredensial dan backup tidak hilang jika VPS rusak total.

---

## 1. Inventaris Kunci Rahasia Bridge

Bridge mengelola dua kunci enkripsi independen:

| Nama Kunci | Algoritma | Lokasi Aktif | Tujuan | Dampak Jika Hilang |
|---|---|---|---|---|
| `KEYS_ENCRYPTION_KEY` | AES-256-GCM (32 bytes base64) | `.env` VPS | Enkripsi data sensitif lisensi (`deliveredKeysEnc`) di database | Kunci lisensi tersimpan tidak bisa didekripsi selamanya |
| `BACKUP_ENCRYPTION_KEY` | AES-256-CBC (PBKDF2) | Password Manager / CI Secrets | Enkripsi dump PostgreSQL sebelum diupload ke remote storage (`rclone`) | File backup remote tidak bisa dipulihkan saat DR |

> **PERINGATAN ARSITEKTUR:** `BACKUP_ENCRYPTION_KEY` **DILARANG** disimpan di tempat yang sama dengan `KEYS_ENCRYPTION_KEY` di server VPS. Jika server VPS dikompromikan atau terbakar, pemulihan harus menggunakan kunci escrow eksternal.

---

## 2. Prosedur Escrow & Penyimpanan Kunci

1. **Password Manager Perusahaan (Bitwarden / 1Password / Vault):**
   - Buat item khusus `VendingLink Bridge - Master Key Escrow`.
   - Simpan:
     - `KEYS_ENCRYPTION_KEY`
     - `BACKUP_ENCRYPTION_KEY`
     - `BRIDGE_SECRET_KEY`
     - Kredensial Supplier API (`SUPPLIER_RZK_API_KEY`, `SUPPLIER_PDA_API_KEY`, `SUPPLIER_DAI_API_KEY`)
   - Hak akses hanya diberikan kepada Tech Lead / Owner.

2. **Rotasi Kunci:**
   - Rotasi dilakukan setiap 6 bulan atau bila ada indikasi kebocoran.
   - Script re-enkripsi: baca data lama dengan kunci lama, simpan kembali dengan kunci baru.

---

## 3. Prosedur Pemulihan Bencana (Disaster Recovery)

Jika server VPS hilang/rusak total:

1. **Provisioning Server Baru:**
   - Install Docker & Docker Compose.
   - Clone repo `vendinglink_bridge`.
2. **Setup Rclone:**
   - Konfigurasi `rclone` dengan akses remote storage (Google Drive / S3):
     ```bash
     rclone config
     ```
3. **Download & Dekripsi Backup:**
   - Tarik file backup terbaru:
     ```bash
     rclone copy gdrive:backups/bridge ./backups/
     ```
   - Dekripsi dump menggunakan `BACKUP_ENCRYPTION_KEY` dari escrow:
     ```bash
     openssl enc -d -aes-256-cbc -salt -pbkdf2 \
       -pass env:BACKUP_ENCRYPTION_KEY \
       -in ./backups/db-LATEST.dump.enc \
       -out ./backups/db-restore.dump
     ```
4. **Restore Database:**
   - Jalankan script verifikasi atau restore manual:
     ```bash
     ./scripts/verify_backup.sh
     ```
5. **Start Bridge Services:**
   - Masukkan `KEYS_ENCRYPTION_KEY` ke `.env` server baru.
   - Jalankan `docker compose up -d`.
   - Jalankan uji verifikasi:
     ```bash
     npm test
     ```
