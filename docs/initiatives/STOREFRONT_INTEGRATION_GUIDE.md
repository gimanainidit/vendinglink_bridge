# Panduan Kontribusi Storefront — Integrasi dengan VendingLink Bridge

**Dokumen:** `docs/initiatives/STOREFRONT_INTEGRATION_GUIDE.md`
**Diperbarui:** 2026-10-10
**Audience:** Developer storefront yang mengerjakan sprint P1 (Promo Engine) dan P2 (Agentic Purchasing & Dynamic Supplier).
**Sumber kebenaran kontrak:** `docs/openapi.yaml` dan `VENDINGLINK_WEBHOOK_SPEC.md` di repo bridge.

---

## Daftar Isi

1. [Prinsip Pemisahan Tanggung Jawab](#1-prinsip-pemisahan-tanggung-jawab)
2. [Autentikasi & Keamanan](#2-autentikasi--keamanan)
3. [Kontrak Saat Ini (Bridge → Storefront)](#3-kontrak-saat-ini-bridge--storefront)
4. [P1 — Promo Engine: Persyaratan Sisi Storefront](#4-p1--promo-engine-persyaratan-sisi-storefront)
5. [P2a — Agentic Purchasing: Persyaratan Sisi Storefront](#5-p2a--agentic-purchasing-persyaratan-sisi-storefront)
6. [P2b — Dynamic Supplier: Persyaratan Sisi Storefront](#6-p2b--dynamic-supplier-persyaratan-sisi-storefront)
7. [Tabel Kontrak Baru](#7-tabel-kontrak-baru)
8. [Checklist Sebelum Merge](#8-checklist-sebelum-merge)

---

## 1. Prinsip Pemisahan Tanggung Jawab

Aturan ini tidak boleh dilanggar. Melanggarnya menciptakan coupling yang mahal dibongkar.

| Yang ada di Bridge | Yang ada di Storefront |
|--------------------|------------------------|
| Pembelian stok dari supplier | Katalog produk & kategorisasi |
| Queue & retry resilience | Customer, nomor HP, consent promo |
| Enkripsi kunci & audit trail | Referral code, voucher, loyalty points |
| Webhook delivery ke storefront | Order retail pelanggan akhir |
| Telegram admin bot | Payment gateway (Xendit, Midtrans, dll) |
| [P2] Agentic auto-purchase | Konten panduan produk |
| [P2] Dynamic supplier adapter | Marketplace integration (Shopee) |

**Bridge tidak menyimpan PII customer.** Setiap request ke bridge yang melibatkan
identitas customer harus menggunakan `customerRef` — opaque ID internal storefront,
bukan nomor HP, nama, atau email.

---

## 2. Autentikasi & Keamanan

Semua komunikasi antara storefront dan bridge menggunakan pola yang sama:

```
Authorization: Bearer <BRIDGE_SECRET_KEY>
Idempotency-Key: <uuid-v4>
Content-Type: application/json
```

**`BRIDGE_SECRET_KEY`** adalah secret bersama. Simpan di environment variable,
jangan hardcode atau masukkan ke version control.

**`Idempotency-Key`** wajib unik per operasi bisnis. Generate UUID v4 di storefront
dan simpan bersama record order/request. Jika storefront retry karena timeout, kirim
ulang dengan Idempotency-Key yang **sama** — bridge akan mengembalikan hasil sebelumnya
tanpa membuat transaksi baru.

**Rate limiting:** Bridge menerapkan rate limit per IP dan global. Implementasikan
exponential backoff saat menerima HTTP 429.

---

## 3. Kontrak Saat Ini (Bridge → Storefront)

Bridge mengirim satu jenis webhook ke storefront saat transaksi selesai:

```
POST {STOREFRONT_URL}/api/bridge/webhook/stock/topup
Authorization: Bearer BRIDGE_SECRET_KEY
Idempotency-Key: BRG-YYYYMMDD-XXXXXX
```

Spec lengkap payload ada di `VENDINGLINK_WEBHOOK_SPEC.md`. Storefront wajib:
- Membalas HTTP 200 dalam **10 detik**. Bridge akan retry jika timeout.
- Memproses idempotently — request dengan Idempotency-Key yang sama tidak boleh diproses dua kali.
- Mengembalikan HTTP 200 meski sudah pernah diproses sebelumnya (jangan 409).

---

## 4. P1 — Promo Engine: Persyaratan Sisi Storefront

**Bridge tidak perlu diubah untuk P1.** Seluruh implementasi P1 ada di storefront.

### 4.1 Skema Database Storefront

```
Customer
  id              CUID
  phone           String  UNIQUE       -- E.164, normalisasi SEBELUM simpan
  name            String?
  consentPromoAt  DateTime?            -- NULL = tidak boleh masuk broadcast
  createdAt       DateTime

ReferralCode
  code            String  UNIQUE       -- 8 karakter, auto-generate saat Customer dibuat
  ownerId         -> Customer.id
  active          Boolean

VoucherRule
  id              CUID
  kind            Enum: REFERRAL_NEW | REFERRAL_OLD | SCHEDULED | LOYALTY
  discountType    Enum: PERCENT | FIXED_IDR
  value           Float
  minSpend        Float                -- default 0
  validFrom       DateTime             -- UTC
  validUntil      DateTime             -- WAJIB non-null untuk kind SCHEDULED
  quotaTotal      Int?                 -- null = tidak terbatas
  quotaPerCustomer Int                 -- default 1
  categoryId      String?

VoucherRedemption
  id              CUID
  ruleId          -> VoucherRule.id
  customerId      -> Customer.id
  orderId         String
  redeemedAt      DateTime
  @@unique([ruleId, customerId])       -- satu customer satu kali per rule

ReferralReward
  id              CUID
  referrerId      -> Customer.id
  refereeOrderId  String
  amount          Float
  status          Enum: ACCRUED | PAYABLE | VOID | PAID
  payoutBatchId   String?

PayoutBatch
  id              CUID
  period          String               -- contoh: "2026-10"
  channel         Enum: GOPAY | OVO
  totalAmount     Float
  status          Enum: DRAFT | APPROVED | PAID
  approvedBy      String?              -- Telegram ID admin
  approvedAt      DateTime?
  createdAt       DateTime
```

### 4.2 Guardrail Wajib (Non-Negotiable)

**1. Normalisasi nomor HP ke E.164 sebelum simpan.**
```typescript
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0'))   return '+62' + digits.slice(1);
  if (digits.startsWith('62'))  return '+' + digits;
  if (digits.startsWith('+62')) return raw.replace(/\s/g, '');
  throw new Error('Format nomor HP tidak dikenali');
}
```
Tanpa normalisasi, `0812xxx` dan `+62812xxx` jadi dua entitas berbeda.

**2. Tolak self-referral di server-side.**
```typescript
if (normalizePhone(referee.phone) === normalizePhone(referrer.phone)) {
  throw new Error('Self-referral tidak diizinkan');
}
```

**3. Reward hanya PAYABLE setelah order COMPLETED + window refund.**
```typescript
await db.referralReward.updateMany({
  where: {
    status: 'ACCRUED',
    order: {
      status: 'COMPLETED',
      completedAt: { lt: subDays(new Date(), REFUND_WINDOW_DAYS) },
    },
  },
  data: { status: 'PAYABLE' },
});
```

**4. Payout tetap manual dengan dual-control.**
Sistem hanya men-generate `PayoutBatch` + CSV. Transfer uang dilakukan manual
oleh admin setelah menyetujui batch. Catat `approvedBy` dan `approvedAt` untuk
audit trail.

### 4.3 Aturan Broadcast

- Hanya kirim broadcast ke customer dengan `consentPromoAt IS NOT NULL`.
- Simpan jenis consent dan timestamp (untuk kepatuhan WhatsApp Business API).

### 4.4 Aturan Waktu Voucher

- Semua `validFrom` dan `validUntil` disimpan dan dievaluasi dalam **UTC**.
- Render ke `Asia/Jakarta` hanya di layer presentasi.
- `validUntil` WAJIB non-null untuk `VoucherRule` kind `SCHEDULED`.
- Validasi di server-side — tolak redeem jika `NOW() > validUntil`.

### 4.5 Task Storefront P1

| Task | Deskripsi |
|------|-----------|
| ST-2a | Migrasi skema semua model di 4.1 |
| ST-2b | `POST /api/customers` — normalisasi + validasi phone |
| ST-2c | Auto-generate `ReferralCode` saat Customer dibuat |
| ST-2d | Redeem voucher di checkout — cek anti-abuse, quota, window (server-side) |
| ST-2e | Cron job akrual: ACCRUED → PAYABLE setelah order COMPLETED + N hari |
| ST-2f | Generate `PayoutBatch` + CSV dari Telegram command/button |
| ST-2g | Tombol Approve di Telegram — set APPROVED, catat `approvedBy` |
| ST-1a | Broadcast promo via WhatsApp Business API ke segmen consent |
| ST-1b | Halaman opt-in consent dengan timestamp |
| ST-3a | UI admin buat `VoucherRule` kind `SCHEDULED` — wajib isi `validUntil` |
| ST-3b | `GET /api/promos/active` — kembalikan rules aktif saat ini |
| ST-3c | Pop-up promo frontend — panggil endpoint saat halaman dimuat |
| ST-3d | Validasi server-side redeem terhadap window waktu |

---


## 5. P2a — Agentic Purchasing: Persyaratan Sisi Storefront

**Jangan mulai ST-P2a-* sebelum endpoint bridge P2a selesai dan didokumentasikan di `docs/openapi.yaml`.**

### 5.1 Endpoint Bridge Baru (tersedia saat P2a selesai)

```
POST {BRIDGE_URL}/api/v1/requests
POST {BRIDGE_URL}/api/v1/requests/:id/confirm
```

### 5.2 Cara Mengirim Product Request

```http
POST {BRIDGE_URL}/api/v1/requests
Authorization: Bearer BRIDGE_SECRET_KEY
Idempotency-Key: <uuid-v4 di-generate storefront>
Content-Type: application/json

{
  "customerRef": "cust_abc123",
  "query": "Canva Pro 1 bulan",
  "categorySlug": "design-tools",
  "maxBudget": 150000
}
```

Response sinkron: `{ "requestId": "req_xyz", "status": "SEARCHING" }`

Bridge memproses asinkron (target < 3 menit) lalu mengirim notifikasi via webhook.

### 5.3 Menerima Notifikasi Status dari Bridge

Storefront wajib mengimplementasikan endpoint ini:

```
POST {STOREFRONT_URL}/api/bridge/webhook/request-update
Authorization: Bearer BRIDGE_SECRET_KEY
```

Payload:
```json
{
  "requestId": "req_xyz",
  "status": "FOUND",
  "customerRef": "cust_abc123",
  "foundProductId": "prod_vl_456",
  "quotedPrice": 95000,
  "supplierCode": "RZK",
  "idempotencyKey": "<key-asli>"
}
```

`status`: `FOUND` | `NOT_FOUND` | `PURCHASED` | `EXPIRED`

Storefront wajib:
- Balas HTTP 200 dalam 10 detik.
- Proses idempotently via `idempotencyKey`.
- Teruskan notifikasi ke customer.
- Simpan `requestId` + `quotedPrice` untuk konfirmasi.

### 5.4 Konfirmasi Pembelian

```http
POST {BRIDGE_URL}/api/v1/requests/{requestId}/confirm
Authorization: Bearer BRIDGE_SECRET_KEY
Idempotency-Key: <uuid-v4 baru>
Content-Type: application/json

{ "customerRef": "cust_abc123" }
```

HTTP 202 berarti bridge menerima. Storefront mendapat webhook lanjutan dengan status `PURCHASED` atau error.

### 5.5 customerRef adalah Opaque ID

`customerRef` tidak boleh berisi nomor HP, nama, atau data identitas lain.
Gunakan primary key Customer di database storefront.

### 5.6 Task Storefront P2a

| Task | Deskripsi |
|------|-----------|
| ST-P2a-1 | Tombol "Request Produk" di katalog → `POST /api/v1/requests` ke bridge |
| ST-P2a-2 | Implementasi `POST /api/bridge/webhook/request-update` |
| ST-P2a-3 | Forward notifikasi ke customer (WA / push) |
| ST-P2a-4 | Tombol konfirmasi beli → `POST /api/v1/requests/:id/confirm` ke bridge |

---

## 6. P2b — Dynamic Supplier: Persyaratan Sisi Storefront

### 6.1 Endpoint Bridge Baru (tersedia saat P2b selesai)

```
POST  {BRIDGE_URL}/api/v1/suppliers
PATCH {BRIDGE_URL}/api/v1/suppliers/:code
GET   {BRIDGE_URL}/api/v1/suppliers/:code
```

### 6.2 Format Registrasi Supplier

```json
{
  "code": "NEW_SUP",
  "displayName": "New Supplier",
  "baseUrl": "https://api.newsupplier.com",
  "authType": "API_KEY",
  "credentials": { "apiKey": "sk_live_xxx" },
  "descriptor": { "version": "1", "endpoints": { "..." : "..." } }
}
```

Format lengkap descriptor ada di ROADMAP.md bagian P2b.

### 6.3 Alur Validasi

1. Bridge simpan supplier dengan status `PENDING_VALIDATION`.
2. Dry-run `getProductList` + `getBalance`.
3. OK → status `ACTIVE`, notif Telegram admin.
4. Gagal → kandidat adapter LLM (feature-flagged) → draft PR → link dikirim ke admin.
   Status tetap `PENDING_VALIDATION` sampai PR di-merge + image di-rebuild.

### 6.4 Keputusan Enkripsi Credentials

Pilih satu dan dokumentasikan di spec kontrak:
- **Opsi A:** Storefront enkripsi API key sebelum dikirim (bridge hanya simpan ciphertext).
- **Opsi B:** Storefront kirim plaintext, bridge enkripsi dengan `KEYS_ENCRYPTION_KEY`.

### 6.5 Task Storefront P2b

| Task | Deskripsi |
|------|-----------|
| ST-P2b-1 | UI Manajemen Supplier — form tambah, upload descriptor, lihat status validasi |
| ST-P2b-2 | Tentukan ownership enkripsi credentials dan dokumentasikan di kontrak |

---

## 7. Tabel Kontrak Baru

Setiap perubahan kontrak wajib diupdate di `docs/openapi.yaml` dan `VENDINGLINK_WEBHOOK_SPEC.md` sebelum implementasi dimulai.

| Endpoint | Arah | Sprint | Status |
|----------|------|--------|--------|
| `POST /api/bridge/webhook/stock/topup` | Bridge → Storefront | Existing | Sudah berjalan |
| `POST /api/v1/requests` | Storefront → Bridge | P2a | Endpoint baru di bridge |
| `POST /api/v1/requests/:id/confirm` | Storefront → Bridge | P2a | Endpoint baru di bridge |
| `POST /api/bridge/webhook/request-update` | Bridge → Storefront | P2a | **Endpoint baru di storefront** |
| `POST /api/v1/suppliers` | Storefront → Bridge | P2b | Endpoint baru di bridge |
| `PATCH /api/v1/suppliers/:code` | Storefront → Bridge | P2b | Endpoint baru di bridge |

---

## 8. Checklist Sebelum Merge

### P1 (Promo Engine)
- [ ] Nomor HP dinormalisasi ke E.164 sebelum simpan.
- [ ] Self-referral ditolak di server-side.
- [ ] Reward tidak PAYABLE sebelum order COMPLETED + window refund.
- [ ] `validUntil` tidak null untuk `VoucherRule` kind `SCHEDULED`.
- [ ] Redeem divalidasi di server-side (bukan hanya frontend).
- [ ] Broadcast hanya ke customer dengan `consentPromoAt IS NOT NULL`.
- [ ] Transfer payout tetap manual — sistem hanya generate CSV + approval.

### P2a (Agentic Purchasing)
- [ ] `customerRef` adalah opaque ID, bukan PII.
- [ ] `Idempotency-Key` baru per operasi, disimpan bersama record.
- [ ] `POST /api/bridge/webhook/request-update` memproses idempotently.
- [ ] Exponential backoff untuk retry ke bridge (429 / 5xx).
- [ ] Notifikasi ke customer tidak dikirim dua kali untuk request yang sama.

### P2b (Dynamic Supplier)
- [ ] Credentials tidak di-log atau muncul di response API publik.
- [ ] Pilihan enkripsi credentials didokumentasikan di kontrak.

### Umum
- [ ] Perubahan kontrak diupdate di `docs/openapi.yaml` + `VENDINGLINK_WEBHOOK_SPEC.md`.
- [ ] Tidak ada PII customer yang dikirim ke bridge selain `customerRef`.

---

*Pertanyaan atau ambiguitas kontrak: koordinasikan dengan bridge maintainer sebelum mulai implementasi, bukan setelah.*

