# VendingLink Bridge — Product Roadmap

**Dokumen:** `docs/initiatives/ROADMAP.md`
**Diperbarui:** 2026-10-09
**Owner teknis:** Bridge maintainer (repo ini) & VendingLink storefront maintainer (repo terpisah)

---

## Daftar Isi

1. [Arsitektur Ownership: Bridge vs Storefront](#1-arsitektur-ownership-bridge-vs-storefront)
2. [Versi & Status Roadmap](#2-versi--status-roadmap)
3. [v1.0 Foundation (CLOSED · VERIFIED)](#3-v10--foundation-closed--verified)
4. [Sprint P0 — Ketahanan Data & Fondasi Katalog (v1.1)](#4-sprint-p0--ketahanan-data--fondasi-katalog-v11)
5. [Sprint P1 — Program Promo & Loyalitas (v1.2)](#5-sprint-p1--program-promo--loyalitas-v12)
6. [Sprint P2 — Agentic Purchasing & Supplier Dinamis (v2.0)](#6-sprint-p2--agentic-purchasing--supplier-dinamis-v20)
7. [Long-Term / P3 — Opsi Roadmap Lanjutan](#7-long-term--p3--opsi-roadmap-lanjutan)
8. [Tech Debt Register](#8-tech-debt-register)
9. [Open Questions & Gate Eksternal](#9-open-questions--gate-eksternal)

---

## 1. Arsitektur Ownership: Bridge vs Storefront

Pemisahan ini adalah keputusan arsitektural yang mengunci semua sprint di bawah.

```
BRIDGE (repo ini)                         STOREFRONT (repo terpisah)
---------------------------------         ----------------------------------
- Pembelian stok dari supplier            - Katalog produk & kategorisasi
- Queue & retry resilience                - Customer, consent, phone, loyalty
- Enkripsi & audit trail kunci            - Referral, voucher, promo engine
- Webhook delivery ke storefront          - Order retail pelanggan akhir
- Telegram admin bot                      - Pembayaran (Xendit/Midtrans/dll)
- [P2] Agentic auto-purchase              - Konten panduan produk
- [P2] Dynamic supplier adapter build     - Marketplace integration (Shopee)
- [P2] Balance monitoring bot             - Internasionalisasi & multi-currency

TIDAK BOLEH berisi:                       TIDAK BOLEH berisi:
- Customer PII                            - Logika pembelian dari supplier
- Voucher / referral logic                - Adapter supplier (RZK, dll)
- Payment gateway                         - Kunci terenkripsi
```

**Kontrak bridge <-> storefront (saat ini — satu arah):**
```
POST {VENDINGLINK_URL}/api/bridge/webhook/stock/topup
Authorization: Bearer BRIDGE_SECRET_KEY
Idempotency-Key: BRG-YYYYMMDD-XXXXXX
```
Spec lengkap: `VENDINGLINK_WEBHOOK_SPEC.md` + `docs/openapi.yaml`.

**Kontrak baru yang direncanakan (P2 — dua arah):**
```
POST {BRIDGE_URL}/api/v1/requests
Authorization: Bearer BRIDGE_SECRET_KEY   <- pola yang sama
Idempotency-Key: <uuid dari storefront>
```
Setiap perubahan kontrak wajib direvisi di kedua dokumen sebelum implementasi.

---

## 2. Versi & Status Roadmap

| Versi | Nama                                      | Status             | Sprint Target |
|-------|-------------------------------------------|--------------------|---------------|
| v1.0  | Foundation                                | CLOSED · VERIFIED  | Selesai       |
| v1.1  | Ketahanan Data & Fondasi Katalog (P0)     | IN PLANNING        | Sprint 1      |
| v1.2  | Program Promo & Loyalitas (P1)            | PLANNED            | Sprint 2-3    |
| v2.0  | Agentic Purchasing & Supplier Dinamis (P2)| PLANNED            | Sprint 4-6    |
| v3.x  | Long-Term / P3                            | OPTIONAL · GATED   | TBD           |

---

## 3. v1.0 — Foundation (CLOSED · VERIFIED)

> Semua task di bawah telah diimplementasi dan dapat diverifikasi dari kode
> di branch `main` (HEAD commit `9af5ade`). Mengacu pada tiga fase `PRD_PLAN.md`.

### Fase 1 — Inbound, Autentikasi, & Sistem Komando

| Task | Deskripsi PRD                          | Bukti Implementasi                                                                  | Status   |
|------|----------------------------------------|-------------------------------------------------------------------------------------|----------|
| 1.1  | Setup Express + TypeScript + deps      | `package.json`: express, telegraf, pino, axios, zod, bullmq, prisma                | VERIFIED |
| 1.2  | Endpoint `POST /webhook/telegram`      | `src/app.ts:60` — terdaftar dengan `verifySecretMiddleware`                         | VERIFIED |
| 1.3  | Validasi secret Telegram               | `src/telegram/middleware/verifySecret.ts` — `timingSafeEqual` terhadap env var     | VERIFIED |
| 1.3  | Hard-filter whitelist admin            | `src/telegram/middleware/whitelist.ts` — cek `ADMIN_TELEGRAM_ID` CSV, drop non-private | VERIFIED |
| 1.4  | Command parser & routing               | `src/telegram/parser/commandParser.ts` — Zod-validated, 7 commands                 | VERIFIED |

### Fase 2 — Core Middleware: Database, Factory, Orkestrasi

| Task | Deskripsi PRD                          | Bukti Implementasi                                                                  | Status   |
|------|----------------------------------------|-------------------------------------------------------------------------------------|----------|
| 2.1  | Setup database & tabel Transactions    | `prisma/schema.base.prisma` — model Transaction + TransactionLog + enum status     | VERIFIED |
| 2.1  | Penyimpanan raw payload (audit trail)  | `src/services/transactionService.ts:78` — `appendLog()` + `deepRedact()` + file ke `audit_logs/` | VERIFIED |
| 2.2  | Supplier Factory (Strategy Pattern)    | `ISupplierAdapter.ts`, `SupplierFactory.ts`, `RezekiShop.adapter.ts`               | VERIFIED |
| 2.3  | Eksekusi dinamis & notifikasi Telegram | `src/telegram/router.ts` — routing via `supplierFactory.getAdapter()`              | VERIFIED |

### Fase 3 — Outbound Delivery, Resiliensi, Containerization

| Task | Deskripsi PRD                          | Bukti Implementasi                                                                  | Status   |
|------|----------------------------------------|-------------------------------------------------------------------------------------|----------|
| 3.1  | Integrasi POST ke VendingLink          | `src/vendinglink/vendingLinkClient.ts` — Bearer + Idempotency-Key, 10s timeout     | VERIFIED |
| 3.2  | BullMQ retry + 3 queue                 | `src/queues/queues.ts` — supplier-order (1 attempt), vending-delivery (12, exp backoff), reconcile (6, fixed 60s) | VERIFIED |
| 3.2  | Sweeper orphan recovery                | `src/queues/sweeper.ts` — re-enqueue tiap 10 menit, 4 status ditangani             | VERIFIED |
| 3.2  | Reconcile worker timeout supplier      | `src/queues/workers/reconcile.worker.ts` — `findRecentOrder()`, escalate NEEDS_REVIEW | VERIFIED |
| 3.3  | Laporan Telegram final COMPLETED       | `src/queues/workers/vendingDelivery.worker.ts:40-52` — update COMPLETED + summary  | VERIFIED |
| 3.4  | Containerization Docker                | `Dockerfile` (multi-stage, node:20-alpine), `docker-compose.yml` (5 services)      | VERIFIED |

### Tambahan melebihi scope PRD awal (v1.0)

- Konfirmasi beli interaktif dengan inline keyboard (`src/telegram/callbacks/confirmBuy.ts`)
- AES-256-GCM enkripsi kunci lisensi (`src/lib/crypto.ts`)
- Optimistic lock transisi status via `updateMany` dengan filter `fromStatus` (`transactionService.ts:30`)
- Idempotency di queue via `jobId: tx.transactionId`
- Script export/decrypt operasional (`scripts/export_decrypted.ts`, `scripts/export_tr_req_resp_decrypted.ts`)
- OpenAPI 3.1 spec + Redoc UI di `/docs` (`docs/openapi.yaml`)
- Dual-provider schema generation SQLite/Postgres (`scripts/gen-schema.ts`)

---

## 4. Sprint P0 — Ketahanan Data & Fondasi Katalog (v1.1)

> **Mengapa P0?** Dua item ini murah tapi mencegah kerugian permanen: data
> hilang tidak bisa dipulihkan, dan skema katalog yang dibangun terlambat
> memaksa migrasi di tiga fitur sekaligus (P1 voucher, P2 konten, P3 Shopee).

### [Bridge] Item 8 — Backup & DR yang Andal

**Kondisi sekarang (gap):**
- `docker-compose.yml` service `db-backup` menulis `pg_dump` ke `./backups` di disk VPS yang sama.
- Retensi hanya 7 hari, tidak ada copy off-site.
- `KEYS_ENCRYPTION_KEY` hanya ada di `.env` di VPS yang sama — kalau VPS hilang, backup pun tidak bisa dibaca.
- `scripts/export_decrypted.ts:39` menulis kunci terdekripsi ke JSON plaintext di `backups/` (gitignored tapi tetap unencrypted di disk).
- Tidak ada uji restore terjadwal.
- Integrasi Google Drive belum ada di repo ini (kode tidak ditemukan di codebase).

**Kondisi target (to-be):**

```
pg_dump -Fc  -->  enkripsi (age/openssl)  -->  rclone copy  -->  remote storage
                                                                  (GDrive atau S3-compatible)
```

Retensi berlapis: harian 7 hari · mingguan 4 minggu · bulanan 6 bulan.
Uji restore otomatis mingguan ke database sementara + validasi jumlah baris.

**Pekerjaan bridge (v1.1-BR):**

- [ ] BR-8a: Tambah `rclone` ke service `db-backup` di `docker-compose.yml`.
  Konfigurasi env: `BACKUP_RCLONE_REMOTE` (nama remote rclone, misal `gdrive:backups/bridge`).
- [ ] BR-8b: Enkripsi dump sebelum upload. Gunakan `openssl enc -aes-256-cbc` dengan kunci
  `BACKUP_ENCRYPTION_KEY` yang **disimpan terpisah dari VPS** (misalnya di password manager atau
  secret store terpisah dari `KEYS_ENCRYPTION_KEY`).
- [ ] BR-8c: Perbarui `scripts/export_decrypted.ts` — tambah flag `--plaintext` yang wajib
  eksplisit. Default output dienkripsi dengan `KEYS_ENCRYPTION_KEY` yang sudah ada.
- [ ] BR-8d: Tambah script `scripts/verify_backup.sh` — restore dump terakhir ke DB `bridge_verify`,
  bandingkan `SELECT COUNT(*) FROM "Transaction"`, kirim hasil ke Telegram admin.
- [ ] BR-8e: Dokumentasikan prosedur escrow kunci di `docs/operations/key-escrow.md`.
- [ ] BR-8f: Tambah env vars baru ke `src/config/env.ts` (Zod schema) dan `.env.example`.
- [ ] BR-8g: Perbaiki contoh `KEYS_ENCRYPTION_KEY=1234567890=` di `README.md:52` — bukan 32-byte
  valid dan berisiko disalin apa adanya.

**Acceptance criteria:**
- Backup harian berhasil tersimpan di remote storage yang terpisah dari VPS.
- Uji restore mingguan berjalan otomatis dan hasilnya masuk notifikasi Telegram.
- `export_decrypted.ts` tanpa flag `--plaintext` tidak menulis kunci ke disk tak terenkripsi.

**Owner:** Bridge maintainer.

---

### [Storefront] Item 5 — Kategorisasi Produk

**Kondisi sekarang (gap) — di sisi bridge:**
- Model `ProductMapping` ada di `prisma/schema.base.prisma:72-80` tapi tidak direferensikan
  satu baris pun di `src/` (grep `ProductMapping` → 0 hasil).
- `src/services/orchestrator.ts:26`: `vlProductId = "[UNKNOWN]"` — mapping produk ke VendingLink
  belum diimplementasi.
- `ISupplierAdapter` tidak memiliki field `category` di tipe `Product` (`src/suppliers/types.ts`).

**Kondisi sekarang (gap) — di sisi storefront:**
- Tidak ada model Category atau tag pada produk (tidak dapat diverifikasi karena repo terpisah,
  tapi menjadi prasyarat fitur voucher per-kategori, konten panduan, dan listing Shopee).

**Kondisi target (to-be):**

Storefront memiliki model kategori hierarkis. Bridge memperbarui `ProductMapping` saat admin
melakukan mapping dari bot atau dari UI storefront. Tipe `Product` di bridge diperluas dengan
`categoryId?: string` dan `tags?: string[]`.

**Pekerjaan bridge (v1.1-BR):**

- [ ] BR-5a: Implementasikan penggunaan `ProductMapping` di `orchestrator.ts` —
  resolve `vlProductId` dari tabel `ProductMapping` berdasarkan `supplierCode` + `supplierProductId`,
  fallback ke pola lama `[UNKNOWN]` hanya jika tidak ditemukan (dengan warning).
- [ ] BR-5b: Tambah command `/map <SUPPLIER> <SUPPLIER_PRODUCT_ID> <VL_PRODUCT_ID>` di
  `commandParser.ts` dan `router.ts` agar admin bisa mendaftarkan mapping dari Telegram.
- [ ] BR-5c: Tambah field opsional `categorySlug?: string` dan `tags?: string[]` ke tipe
  `Product` di `src/suppliers/types.ts` (backward-compatible, opsional).
- [ ] BR-5d: `ISupplierAdapter.getProductList()` meneruskan `categorySlug` jika ada dari API
  supplier. RezekiShop adapter dicek apakah endpoint `/v1/products` mengembalikan kategori.

**Pekerjaan storefront (v1.1-ST):**

- [ ] ST-5a: Desain & migrasi skema `Category` (id, slug, name, parentId?) dan relasi ke
  `Product`.
- [ ] ST-5b: Endpoint `PATCH /api/bridge/products/:vlProductId/category` agar bridge atau admin
  bisa set kategori saat mapping.
- [ ] ST-5c: UI admin kategorisasi (bisa sederhana: dropdown saat edit produk).

**Acceptance criteria:**
- `vlProductId` tidak lagi `[UNKNOWN]` untuk produk yang sudah dimapping.
- `/map RZK <id_supplier> <id_vl>` berhasil menyimpan ke `ProductMapping` dan dikonfirmasi bot.
- Kategori terpilih tampil di katalog storefront.

---

## 5. Sprint P1 — Program Promo & Loyalitas (v1.2)

> **Prasyarat:** v1.1 (P0) selesai. Item 2 (Referral) dan Item 1 (Loyalty/Broadcast) dikerjakan
> sebagai satu engine, bukan dua fitur terpisah. Item 3 (Voucher Berjadwal) menumpang engine
> yang sama. Semua pekerjaan P1 ada di sisi **storefront** kecuali yang bertanda [Bridge].

### [Storefront] Item 2 + 1 — Referral & Loyalty Engine

**Kondisi sekarang (gap):**
- Tidak ada entitas Customer atau nomor HP di sistem manapun yang terobservasi.
- Tidak ada mekanisme consent promo.
- Tidak ada kode referral, voucher, atau akrual reward.

**Kondisi target — skema storefront (to-be):**

```
Customer
  id          CUID
  phone       String  UNIQUE  -- wajib normalisasi E.164 sebelum simpan
  name        String?
  consentPromoAt  DateTime?   -- NULL = tidak boleh dibroadcast, tanpa pengecualian
  createdAt   DateTime

ReferralCode
  code        String  UNIQUE  -- 8 karakter, dibuat saat Customer dibuat
  ownerId     String  -> Customer.id
  active      Boolean

VoucherRule
  id          CUID
  kind        Enum: REFERRAL_NEW | REFERRAL_OLD | SCHEDULED | LOYALTY
  discountType Enum: PERCENT | FIXED_IDR
  value       Float
  minSpend    Float   DEFAULT 0
  validFrom   DateTime  -- UTC
  validUntil  DateTime  -- WAJIB non-null untuk SCHEDULED
  quotaTotal  Int?    -- null = tidak terbatas
  quotaPerCustomer Int DEFAULT 1
  categoryId  String? -- opsional, filter per kategori (sambungan ke Item 5)

VoucherRedemption
  id          CUID
  ruleId      -> VoucherRule.id
  customerId  -> Customer.id
  orderId     String
  redeemedAt  DateTime
  @@unique([ruleId, customerId])  -- kunci anti-abuse: satu customer satu kali per rule

ReferralReward
  id          CUID
  referrerId  -> Customer.id
  refereeOrderId  String       -- order yang memicu reward
  amount      Float
  status      Enum: ACCRUED | PAYABLE | VOID | PAID
  payoutBatchId  String?  -> PayoutBatch.id

PayoutBatch
  id          CUID
  period      String        -- contoh: "2026-10"
  channel     Enum: GOPAY | OVO
  totalAmount Float
  status      Enum: DRAFT | APPROVED | PAID
  approvedBy  String?       -- Telegram ID admin
  approvedAt  DateTime?
  createdAt   DateTime
```

**Guardrail yang menentukan program ini untung atau bocor:**

- `phone` UNIQUE + normalisasi E.164 (`+628xxx`) **sebelum simpan**. Tanpa ini `0812` dan `+62812`
  jadi dua orang berbeda dan self-referral terbuka.
- Tolak redeem jika `referrer.phone == referee.phone` setelah normalisasi.
- Reward naik ke `PAYABLE` hanya lewat cron job terjadwal, setelah order `COMPLETED` dan melewati
  window refund. Reward saat order dibuat = bayar untuk order yang belum pasti.
- Payout tetap **manual dengan dual-control**: sistem generate `PayoutBatch` + CSV, admin approve
  via Telegram command/button, sistem tandai `PAID` beserta `approvedBy`. Jangan otomatiskan
  transfer uang keluar di fase ini.
- `consentPromoAt` NULL = tidak boleh masuk broadcast list. Tanpa pengecualian.
- `validUntil` WAJIB non-null untuk VoucherRule dengan kind `SCHEDULED`.

**Pekerjaan storefront (v1.2-ST):**

- [ ] ST-2a: Migrasi skema — semua model di atas.
- [ ] ST-2b: Endpoint registrasi Customer (`POST /api/customers`) dengan validasi + normalisasi phone.
- [ ] ST-2c: Generasi `ReferralCode` otomatis saat Customer dibuat.
- [ ] ST-2d: Endpoint redeem voucher di checkout — cek anti-abuse, quota, window waktu.
- [ ] ST-2e: Cron job akrual reward: ACCRUED -> PAYABLE setelah N hari order COMPLETED.
- [ ] ST-2f: Command Telegram `/payout preview <period>` untuk generate PayoutBatch + CSV.
- [ ] ST-2g: Button "Approve" di pesan Telegram yang menandai batch APPROVED + catat `approvedBy`.
- [ ] ST-1a: Broadcast promo ke segmen Customer yang `consentPromoAt IS NOT NULL`.
  Integrasi dengan WhatsApp Business API atau platform broadcast pilihan.
- [ ] ST-1b: Halaman opt-in consent dengan timestamp yang dicatat.

**Pekerjaan bridge (v1.2-BR):**
- Tidak ada perubahan wajib di bridge untuk P1. Bridge hanya supplier data, bukan customer data.
- Opsional: command `/payout` di bot Telegram bridge sebagai shortcut ke storefront API
  (nilai rendah, bisa diskip).

**Acceptance criteria:**
- Customer A pakai referral code Customer B: A dapat diskon, B dapat reward ACCRUED.
- Self-referral (phone sama setelah normalisasi) ditolak.
- Reward tidak pernah PAYABLE sebelum order COMPLETED + N hari.
- Broadcast hanya terkirim ke customer dengan `consentPromoAt IS NOT NULL`.
- CSV payout terbuat, admin approve via Telegram, status berubah ke APPROVED (transfer tetap manual).

---

### [Storefront] Item 3 — Voucher Berjadwal & Pop-up

**Kondisi sekarang (gap):**
- Belum ada engine voucher (dibangun di Item 2+1 di atas).
- Tidak ada sistem notifikasi pop-up time-based di storefront.

**Kondisi target (to-be):**
- VoucherRule dengan `kind = SCHEDULED` + `validFrom`/`validUntil` UTC yang ketat.
- Pop-up muncul di storefront saat `NOW() BETWEEN validFrom AND validUntil`.
- Admin bisa buat/edit/hapus VoucherRule dari UI storefront.

**Pekerjaan storefront (v1.2-ST lanjutan):**

- [ ] ST-3a: UI admin buat VoucherRule dengan kind `SCHEDULED` — wajib input `validUntil`.
- [ ] ST-3b: API endpoint untuk storefront frontend cek active promos:
  `GET /api/promos/active` — kembalikan rules yang aktif sekarang.
- [ ] ST-3c: Komponen pop-up di frontend yang memanggil endpoint di atas saat halaman dimuat.
- [ ] ST-3d: Validasi server-side: tolak redeem jika `NOW() > validUntil` meski frontend bypass.
  Semua window waktu disimpan dan dievaluasi dalam UTC.

**Acceptance criteria:**
- Voucher dengan `validUntil` yang lewat tidak bisa dipakai meskipun kode diketik manual.
- Pop-up muncul tepat saat `validFrom` tercapai dan hilang setelah `validUntil`.
- Admin bisa buat promo baru dari UI tanpa deploy kode.

---

## 6. Sprint P2 — Agentic Purchasing & Supplier Dinamis (v2.0)

> **Prasyarat:** v1.1 (P0) selesai.
> Test coverage jalur uang (Tech Debt TD-1) wajib ada sebelum P2a deploy ke production.
> P2 dibagi: **P2a** (Agentic Core) → stabil 2 minggu → **P2b** (Dynamic Supplier + Adapter Build).

### [Bridge] P2a — Agentic Purchasing & Product Request (Item 10 + 9)

**Mengapa 10 sebelum 9:** Item 9 menjanjikan SLA 3 menit. Janji itu hanya bisa ditepati
kalau mesin #10 sudah stabil. Merilis #9 sebelum #10 = membuat janji tanpa infrastruktur.

**Kondisi sekarang (gap):**
- `orchestrator.ts:42-52` — `executePurchase()` stub kosong tidak dipakai, import menganggur.
- Semua pembelian lewat konfirmasi manual admin via inline keyboard `confirmBuy.ts`.
- Tidak ada endpoint inbound bisnis selain `/webhook/telegram` dan `/health`.
- Tidak ada model `ProductRequest`, queue product search, atau guardrail plafon belanja.

**Kondisi target — alur (to-be):**

```
[Storefront] Customer klik "Request Produk"
    |
    v  POST /api/v1/requests  (endpoint baru di bridge)
       Authorization: Bearer BRIDGE_SECRET_KEY
       Idempotency-Key: <uuid dari storefront>
       Body: { customerRef, query, categorySlug?, maxBudget? }
    |
    v  Simpan ProductRequest(SEARCHING) -> enqueue productSearchQueue
    |
    v  Worker: parallel query adapters, timeout 15s/adapter
    |
    +-- Ditemukan -> evaluasi guardrail -> notif ke storefront
    +-- Tidak ditemukan -> notif "belum tersedia"
    |
    v  Customer konfirmasi: POST /api/v1/requests/:id/confirm
       -> masuk supplierOrderQueue (attempts:1, TIDAK BERUBAH)
```

**Skema baru di `prisma/schema.base.prisma`:**

```prisma
model ProductRequest {
  id                String               @id @default(cuid())
  customerRef       String               -- opaque ID storefront, BUKAN PII
  idempotencyKey    String               @unique
  query             String
  categorySlug      String?
  maxBudget         Float?
  status            ProductRequestStatus @default(SEARCHING)
  foundSupplierCode String?
  foundProductId    String?
  quotedPrice       Float?
  notifiedAt        DateTime?
  confirmedAt       DateTime?
  transactionId     String?
  createdAt         DateTime             @default(now())
  updatedAt         DateTime             @updatedAt
  @@index([status, createdAt])
}
enum ProductRequestStatus {
  SEARCHING FOUND NOT_FOUND CONFIRMED PURCHASED EXPIRED
}
```

**Guardrail belanja otonom (env vars baru di `src/config/env.ts`):**

```
AGENT_ENABLED=true
AGENT_MAX_SPEND_PER_REQUEST=500000   -- Rp 500rb per request
AGENT_MAX_SPEND_PER_DAY=5000000     -- Rp 5jt agregat per hari
AGENT_MIN_BALANCE_FLOOR=200000      -- Saldo tidak boleh di bawah ini
AGENT_PRICE_DELTA_ALERT_PCT=20      -- Lonjakan >20% -> eskalasi admin
AGENT_ALLOWED_SUPPLIER_CODES=RZK   -- CSV allowlist
AGENT_HIGH_VALUE_THRESHOLD=1000000 -- Di atas ini -> konfirmasi manual
```

Urutan evaluasi (sebelum order): AGENT_ENABLED > allowlist > per-request cap >
daily cap > balance floor > price delta > high value threshold.
`supplierOrderQueue` TETAP `attempts: 1` — tidak boleh diubah.

**Pekerjaan bridge P2a:**

- [ ] BR-P2a-1: Cleanup `orchestrator.ts` — hapus stub dan import menganggur.
- [ ] BR-P2a-2: Migrasi schema `ProductRequest` + enum ke `schema.base.prisma`.
- [ ] BR-P2a-3: Env vars guardrail ke `src/config/env.ts` + `.env.example`.
- [ ] BR-P2a-4: `POST /api/v1/requests` — Zod, rate-limit, Bearer auth.
- [ ] BR-P2a-5: `POST /api/v1/requests/:id/confirm`.
- [ ] BR-P2a-6: `productSearchQueue` + worker — parallel, timeout, guardrail, status update.
- [ ] BR-P2a-7: Balance monitor — cron 30 menit, alert Telegram di bawah floor.
- [ ] BR-P2a-8: `/agent pause` + `/agent resume` di parser + router.
- [ ] BR-P2a-9: `/balance all` — cek semua supplier aktif.
- [ ] BR-P2a-10: Notif ke storefront `POST {VL_URL}/api/bridge/webhook/request-update`
  — revisi `docs/openapi.yaml` + `VENDINGLINK_WEBHOOK_SPEC.md`.
- [ ] BR-P2a-11: Test coverage guardrail (Vitest + nock). **Wajib lulus sebelum deploy.**

**Pekerjaan storefront P2a:**

- [ ] ST-P2a-1: Tombol "Request Produk" di katalog.
- [ ] ST-P2a-2: `POST /api/bridge/webhook/request-update` — terima notif bridge.
- [ ] ST-P2a-3: Forward notif ke customer (WA/push).
- [ ] ST-P2a-4: Tombol konfirmasi beli yang trigger `confirm` ke bridge.

**SLA:** fase 1 = "secepatnya". Fase 2 setelah 2 minggu stabil = umumkan "maks 3 menit".

**Acceptance criteria P2a:**
- Request selesai dalam < 3 menit (p95). Plafon harian ditolak dengan error tercatat.
- Lonjakan harga → alert + pause, bukan auto-purchase. Kill switch efektif < 30 detik.
- Semua test guardrail lulus sebelum deploy ke production.

---

### [Bridge] P2b — Dynamic Supplier Management & Agentic Adapter Build

**Kondisi sekarang (gap):**
- `SupplierFactory.ts:9` hardcode hanya `new RezekiShopAdapter()`.
- Tambah supplier baru = tulis adapter TypeScript, daftarkan di factory, rebuild Docker, redeploy.
- Env vars supplier hardcode di `src/config/env.ts:20-21`.
- Tidak ada model Supplier di DB, tidak ada UI manajemen di storefront.

**Kondisi target (to-be):**

```
Admin UI Storefront: Manajemen Supplier
    |  Form: nama, base_url, auth, credentials, descriptor JSON
    v
    POST /api/v1/suppliers  (bridge)
    Simpan Supplier(PENDING_VALIDATION)
    Worker: dry-run getProductList + getBalance
    |
    +-- OK   -> status ACTIVE, notif Telegram
    +-- FAIL -> panggil LLM agent (feature-flagged)
                Output: kandidat adapter TypeScript -> DRAFT PR (BUKAN hot-load)
                Notif Telegram: link PR untuk review
                Setelah merge + rebuild -> supplier aktif
```

**Skema baru di `prisma/schema.base.prisma`:**

```prisma
model Supplier {
  code           String         @id
  displayName    String
  baseUrl        String
  authType       String         -- API_KEY | BEARER | BASIC
  credentialsEnc String         -- AES-256-GCM
  descriptor     String         -- JSON descriptor
  status         SupplierStatus @default(PENDING_VALIDATION)
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt
}
enum SupplierStatus {
  PENDING_VALIDATION ACTIVE PAUSED DEPRECATED
}
```

**Batasan keamanan agentic adapter (MUTLAK):**
LLM output tidak pernah di-eval atau hot-load di runtime. Output berupa TypeScript file
yang masuk sebagai **draft PR**, di-review developer, di-merge, baru rebuild Docker.
PR wajib lulus `tsc --noEmit` dan dry-run test sebelum merge.

**Pekerjaan bridge P2b:**

- [ ] BR-P2b-1: Migrasi schema `Supplier` + enum ke `schema.base.prisma`.
- [ ] BR-P2b-2: `GenericRestAdapter` — `ISupplierAdapter` berbasis descriptor JSON.
- [ ] BR-P2b-3: Update `SupplierFactory` — load dari tabel `Supplier` (DB), RZK hardcode sebagai fallback.
- [ ] BR-P2b-4: `POST /api/v1/suppliers` + `PATCH /api/v1/suppliers/:code` dengan Bearer auth.
- [ ] BR-P2b-5: Validation worker — dry-run saat supplier baru didaftarkan.
- [ ] BR-P2b-6: LLM integration (feature-flagged `AGENT_ADAPTER_BUILD_ENABLED`) — draft PR + notif link.
- [ ] BR-P2b-7: Command `/suppliers` — list semua supplier dan statusnya.
- [ ] BR-P2b-8: `SUPPLIER_RZK_*` di `env.ts` jadi deprecated (baca tapi tidak required, backward-compat).

**Pekerjaan storefront P2b:**

- [ ] ST-P2b-1: UI Manajemen Supplier — form tambah, upload descriptor, lihat status validasi.
- [ ] ST-P2b-2: Tentukan ownership enkripsi credentials (storefront atau bridge) dan dokumentasikan.

**Acceptance criteria P2b:**
- Tambah supplier baru dari UI tanpa deploy ulang (untuk supplier dengan descriptor valid).
- `GenericRestAdapter` berhasil untuk supplier standard REST.
- Supplier invalid menghasilkan draft PR, bukan error diam-diam.
- LLM output tidak pernah aktif tanpa review + merge + rebuild.

---

### [Storefront] Item 4 — Halaman Panduan Produk (P2 — paralel P2a/P2b)

**Kondisi sekarang (gap):** Tidak ada sistem konten panduan di codebase yang terobservasi.

**Rekomendasi arsitektur:** Telegraph sebagai pihak ketiga tanpa SLA dan tanpa kontrol SEO
sebaiknya jadi opsi supplementary (publish dari CMS ke Telegraph), bukan sumber kebenaran.
Bangun CMS minimal di storefront dengan MDX atau rich-text editor.

**Pekerjaan storefront:**

- [ ] ST-4a: Model `GuidePost` (id, productId, title, slug, content, status, publishedAt) + `GuideAuthor`.
- [ ] ST-4b: Rich-text editor (Tiptap atau Plate) untuk agent/writer.
- [ ] ST-4c: Halaman `/panduan/:slug`, linked dari halaman produk.
- [ ] ST-4d: Opsional — tombol "Publish ke Telegraph" dari editor (supplementary).
- [ ] ST-4e: Opsional — `GuideComment` untuk chat interaktif ke penulis.

---

## 7. Long-Term / P3 — Opsi Roadmap Lanjutan

> P3 adalah opsi, bukan komitmen. Masing-masing gated oleh kondisi eksternal yang harus
> terpenuhi terlebih dahulu sebelum engineering effort dialokasikan.

### Item 7 — Shopee API & Marketplace Integration

**Gate (harus selesai sebelum engineering dimulai):**
- [ ] Verifikasi kebijakan Shopee: apakah penjualan akun/lisensi digital diperbolehkan.
  Kebijakan default Shopee umumnya melarang, tapi ada program khusus untuk digital goods seller.
- [ ] Verifikasi ToS produk yang akan dijual (contoh: Canva) — reseller/wholesale agreement.
- [ ] Jika kedua di atas OK, baru buat proof-of-concept OAuth + product listing sync.

**Scope teknis (jika gate terbuka):**
- OAuth flow Shopee Seller API, product sync dari katalog storefront ke Shopee listing.
- Order webhook Shopee → buat order di storefront → trigger bridge procurement.
- Stock sync dua arah saat bridge deliver ke storefront.

### Item 6 — Pasar Internasional & USDT/Binance Pay

**Gate (harus selesai sebelum engineering dimulai):**
- [ ] Review legal: di Indonesia, aset kripto boleh diperdagangkan sebagai komoditas di bursa
  berizin Bappebti, tetapi **dilarang sebagai alat pembayaran** (PBI 23/6/PBI/2021 dan
  peraturan turunannya). Menerima USDT sebagai pembayaran memerlukan opini legal tertulis
  sebelum satu baris kode ditulis.
- [ ] Jika legal OK: roadmap multi-currency (IDR + USDT), i18n storefront, KYC/AML
  untuk transaksi internasional, integrasi payment gateway yang mendukung USDT (Binance Pay,
  atau gateway kripto berizin Indonesia).

**Scope teknis (jika gate terbuka):**
- Multi-currency pricing di storefront, FX rate feed, pisah reporting per currency.
- Storefront i18n (id, en, minimal dua bahasa ASEAN lain).
- Supplier adapter internasional (supplier luar negeri bisa masuk via P2b).

---

## 8. Tech Debt Register

> Item-item ini bukan fitur baru. Kegagalan menyelesaikannya meningkatkan risiko setiap
> sprint berikutnya.

| ID   | Deskripsi                                                                     | Risiko    | Sprint target    |
|------|-------------------------------------------------------------------------------|-----------|------------------|
| TD-1 | Nol test file di `src/` meski Vitest + nock + supertest terpasang. `npm run test` tidak memverifikasi apa pun. | TINGGI — wajib selesai sebelum P2a deploy | P0/v1.1 |
| TD-2 | `scripts/export_decrypted.ts` menulis kunci terdekripsi ke JSON plaintext tanpa flag eksplisit. File sudah ada di working tree. | TINGGI — data kunci di disk tanpa enkripsi | P0/v1.1 |
| TD-3 | `README.md:52` contoh `KEYS_ENCRYPTION_KEY=1234567890=` bukan 32-byte valid, berisiko disalin apa adanya. | MEDIUM | P0/v1.1 (BR-8g) |
| TD-4 | `db.ts:12` logging `query` aktif di production — noise log dan potensi ekspos query sensitif. Ganti ke `['error']` di production. | MEDIUM | P0/v1.1 |
| TD-5 | `ProductMapping` model di schema tapi 0 referensi di `src/` (dead model). `vlProductId = "[UNKNOWN]"` di orchestrator. | MEDIUM | P0/v1.1 (BR-5a) |
| TD-6 | `orchestrator.ts:42-52` `executePurchase()` stub kosong + import menganggur. | LOW | P2a (BR-P2a-1) |
| TD-7 | Session middleware in-memory (`session.ts:20`). Restart bot = state AWAITING_EMAIL hilang. Cukup untuk admin tunggal, tapi dokumentasikan limitasinya di README. | LOW | Opsional |

---

## 9. Open Questions & Gate Eksternal

Keputusan berikut tidak bisa dibuat oleh engineering saja dan akan mem-block sprint yang bersangkutan
jika tidak dijawab.

| # | Pertanyaan                                                              | Block sprint | Owner keputusan |
|---|-------------------------------------------------------------------------|--------------|-----------------|
| Q1 | Integrasi Google Drive yang "rusak" — kode tidak ditemukan di repo bridge. Di mana kode tersebut berada? (VPS script? Storefront?) Perlu diidentifikasi sebelum BR-8a bisa dirancang final. | P0 (BR-8a) | Admin/DevOps |
| Q2 | Storefront VendingLink: framework apa, repo di mana? Semua task ST-* dalam roadmap ini perlu akses ke repo storefront untuk dieksekusi. | P0 (ST-5a) | Storefront maintainer |
| Q3 | N hari window refund untuk ReferralReward ACCRUED -> PAYABLE? Ini keputusan bisnis, bukan teknis. | P1 (ST-2e) | Owner bisnis |
| Q4 | AGENT_MAX_SPEND_PER_REQUEST dan _PER_DAY — berapa angka yang tepat? Ditentukan bersamaan dengan eksperimen operasional P2a. | P2a (BR-P2a-3) | Owner bisnis |
| Q5 | LLM mana yang akan digunakan untuk agentic adapter build? Self-hosted (Ollama + Qwen/CodeLlama) vs API komersial (Claude/GPT-4o)? Mempengaruhi biaya, latency, dan keamanan karena kode supplier dikirim ke LLM. | P2b (BR-P2b-6) | Admin/Bisnis |
| Q6 | Item 7 (Shopee) dan Item 6 (USDT) — gate legal belum dibuka. Tidak ada effort engineering sebelum gate terbuka. | P3 | Owner bisnis + legal |

---

*Dokumen ini harus diperbarui setiap akhir sprint. Checklist item yang selesai ditandai `[x]`
dan status versi diperbarui di tabel Bagian 2.*
