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

| Versi | Nama                                      | Status                      | Sprint Target |
|-------|-------------------------------------------|-----------------------------|---------------|
| v1.0  | Foundation                                | CLOSED · VERIFIED           | Selesai       |
| v1.1  | Ketahanan Data & Fondasi Katalog (P0)     | CLOSED · VERIFIED           | Sprint 1      |
| v1.2  | Program Promo & Loyalitas (P1)            | CLOSED · VERIFIED           | Sprint 2      |
| v2.0  | Agentic Purchasing & Supplier Dinamis (P2)| CLOSED · VERIFIED           | Sprint 3 (P2a/b)|
| v3.x  | Long-Term / P3                            | OPTIONAL · GATED            | TBD           |

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

- [X] BR-8a: Tambah `rclone` ke service `db-backup` di `docker-compose.yml`.
  Konfigurasi env: `BACKUP_RCLONE_REMOTE` (nama remote rclone, misal `gdrive:backups/bridge`).
- [X] BR-8b: Enkripsi dump sebelum upload. Gunakan `openssl enc -aes-256-cbc` dengan kunci
  `BACKUP_ENCRYPTION_KEY` yang **disimpan terpisah dari VPS** (misalnya di password manager atau
  secret store terpisah dari `KEYS_ENCRYPTION_KEY`).
- [X] BR-8c: Perbarui `scripts/export_decrypted.ts` — tambah flag `--plaintext` yang wajib
  eksplisit. Default output dienkripsi dengan `KEYS_ENCRYPTION_KEY` yang sudah ada.
- [X] BR-8d: Tambah script `scripts/verify_backup.sh` — restore dump terakhir ke DB `bridge_verify`,
  bandingkan `SELECT COUNT(*) FROM "Transaction"`, kirim hasil ke Telegram admin.
- [X] BR-8e: Dokumentasikan prosedur escrow kunci di `docs/operations/key-escrow.md`.
- [X] BR-8f: Tambah env vars baru ke `src/config/env.ts` (Zod schema) dan `.env.example`.
- [X] BR-8g: Perbaiki contoh `KEYS_ENCRYPTION_KEY=1234567890=` di `README.md:52` — bukan 32-byte
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

- [x] BR-5a: Implementasikan penggunaan `ProductMapping` di `orchestrator.ts` —
  resolve `vlProductId` dari tabel `ProductMapping` berdasarkan `supplierCode` + `supplierProductId`,
  fallback ke pola lama `[UNKNOWN]` hanya jika tidak ditemukan (dengan warning).
- [x] BR-5b: Tambah command `/map <SUPPLIER> <SUPPLIER_PRODUCT_ID> <VL_PRODUCT_ID>` di
  `commandParser.ts` dan `router.ts` agar admin bisa mendaftarkan mapping dari Telegram.
- [x] BR-5c: Tambah field opsional `categorySlug?: string` dan `tags?: string[]` ke tipe
  `Product` di `src/suppliers/types.ts` (backward-compatible, opsional).
- [x] BR-5d: `ISupplierAdapter.getProductList()` meneruskan `categorySlug` jika ada dari API
  supplier. RezekiShop adapter dicek apakah endpoint `/v1/products` mengembalikan kategori.

**Pekerjaan storefront (v1.1-ST):**

- [x] ST-5a: Desain & migrasi skema `Category` (id, slug, name) dan relasi opsional ke
  `Product` (`categoryId`, `onDelete: SetNull`).
- [x] ST-5b: Endpoint `PATCH /api/bridge/products/:vlProductId/category` agar bridge atau admin
  bisa set kategori saat mapping. Bearer-only, guard chain IP → rate-limit → bearer → Zod,
  body `{ categorySlug: string }`, kode 200 / 400 INVALID_BODY / 401 / 403 / 404
  PRODUCT_NOT_FOUND | CATEGORY_NOT_FOUND / 429 / 500.
- [x] ST-5c: UI admin kategorisasi (bisa sederhana: dropdown saat edit produk).

**Acceptance criteria:**
- `vlProductId` tidak lagi `[UNKNOWN]` untuk produk yang sudah dimapping.
- `/map RZK <id_supplier> <id_vl>` berhasil menyimpan ke `ProductMapping` dan dikonfirmasi bot.
- Kategori terpilih tampil di katalog storefront.
- `PATCH /api/bridge/products/:vlProductId/category` hanya bisa diakses dengan bearer token valid,
  mengembalikan `CATEGORY_NOT_FOUND` jika slug tidak ada, dan tidak pernah membuat kategori baru.

---

## 5. Sprint P1 — Program Promo & Loyalitas (v1.2)

> **Prasyarat:** v1.1 (P0) selesai. Item 2 (Referral) dan Item 1 (Loyalty/Broadcast) dikerjakan
> sebagai **dua engine terpisah**, dipisah berdasarkan siapa yang menciptakan nilai (lihat
> `docs/initiatives/PROMO_ENGINE_DESIGN.md` untuk desain lengkap + rencana migrasi): Engine A
> `CustomerCredit` (akrual: komisi referral, refund stockout) dan Engine B `VoucherRule` +
> `VoucherRedemption` (aturan admin: voucher manual, promo terjadwal, diskon customer baru).
> Item 3 (Voucher Berjadwal) menumpang Engine B. Semua pekerjaan P1 ada di sisi **storefront**
> kecuali yang bertanda [Bridge].

### [Storefront] Item 2 + 1 — Referral & Loyalty Engine

**Kondisi sekarang (gap):**
- [x] Customer + ReferralCode + consent sudah ada (ST-2a-1, selesai sprint sebelumnya).
- Belum ada engine kredit akrual (`CustomerCredit`), engine voucher (`VoucherRule`), atau payout.
- `PromoCode` (stockout refund) dan `Voucher` (diskon admin) model lama tumpang-tindih secara semantik dan **overload `Transaction.promoCodeId`** (arti "kode dipakai" di checkout VS "kode diterbitkan" di `transactionStatus.ts` — bug nyata, lihat Tech Debt TD-8).
- `lib/discount.ts` adalah dead code — nol caller, test-nya mock seluruh modul (TD-9).

**Kondisi target — skema storefront (to-be):**

```
Customer                              -- [x] sudah ada
  id, phone UNIQUE, name, consentPromoAt, createdAt

ReferralCode                          -- [x] sudah ada
  code UNIQUE (13 char), customerId -> Customer.id

ProgramConfig                         -- singleton, admin-editable, pola sama dgn SupplierConfig
  id
  referralCommissionPct  Int     -- basis komisi: Transaction.finalAmount (bukan originalPrice)
  referralCommissionCap  Int?    -- cap Rupiah per transaksi, opsional
  refereeDiscountValue   Int     -- diskon tetap utk customer baru yg pakai referral code
  accrualWindowDays      Int     DEFAULT 15  -- hard ceiling 15, validasi tolak input > 15
  minPayoutAmount        Int     DEFAULT 20000
  updatedBy / updatedAt

CustomerCredit                        -- Engine A: ledger akrual
  id
  customerId      String?  -> Customer.id   -- nullable: refund stockout tanpa Customer match
  claimCode       String?  UNIQUE           -- hanya utk STOCKOUT_REFUND
  kind            Enum: STOCKOUT_REFUND | REFERRAL_COMMISSION
  amount          Int                       -- selalu CASH utk REFERRAL_COMMISSION (D4)
  appliedRatePct  Int?                      -- snapshot ProgramConfig.referralCommissionPct saat akrual
  status          Enum: ACCRUED | PAYABLE | REDEEMED | PAID | VOID | EXPIRED
  sourceTxnId     String?                   -- order pemicu
  consumedTxnId   String?                   -- order yg memakai credit sbg diskon (STOCKOUT_REFUND)
  referralCodeId  String?
  payoutBatchId   String?  -> PayoutBatch.id
  payableAt       DateTime?                 -- sourceTxn.paidAt + accrualWindowDays, dihitung saat akrual
  expiresAt       DateTime?
  createdAt / updatedAt
  @@unique([kind, sourceTxnId])             -- idempotensi: satu order = satu credit per kind

VoucherRule                           -- Engine B: aturan admin
  id, code UNIQUE, name
  kind            Enum: MANUAL | SCHEDULED | REFERRAL_NEW | LOYALTY
  discountType    Enum: PERCENT | FIXED_IDR
  value           Int
  maxDiscount     Int?      -- wajib diisi admin utk PERCENT
  minSpend        Int   DEFAULT 0
  validFrom       DateTime  -- UTC
  validUntil      DateTime? -- WAJIB non-null utk SCHEDULED
  quotaTotal      Int?
  quotaPerCustomer Int DEFAULT 1
  categoryId      String?
  isActive        Boolean
  usedCount       Int DEFAULT 0

VoucherRedemption
  id, ruleId, customerId, transactionId, seq Int, redeemedAt
  @@unique([ruleId, customerId, seq])  -- seq 1..quotaPerCustomer, tegakkan kuota >1 scr atomik
  @@unique([ruleId, transactionId])    -- satu rule sekali per order

ReferralRedemption                    -- counter terpisah dari VoucherRedemption (B4: max 2x per kode)
  id, referralCodeId, refereeCustomerId, transactionId, seq Int, redeemedAt
  @@unique([referralCodeId, refereeCustomerId, seq])  -- seq 1..2

PayoutBatch
  id, period String, channel Enum: GOPAY | OVO | BANK_TRANSFER
  totalAmount Int, status Enum: DRAFT | APPROVED | PAID
  approvedBy String?, approvedAt DateTime?, createdAt DateTime
```

**Guardrail yang menentukan program ini untung atau bocor:**

- `phone` UNIQUE + normalisasi 628xxx tanpa `+` (format Saungwa) **sebelum simpan**.
- **Self-referral:** tolak jika (a) `referrer.phone == referee.phone` setelah normalisasi — independen, hard reject — ATAU (b) kemiripan nama ternormalisasi ≥ 0.9 (Levenshtein) — independen, reject + flag admin. Dua kondisi OR, bukan AND: phone adalah UNIQUE jadi phone sama = orang yang sama secara definisi, nama tidak relevan lagi di jalur itu.
- **Referral 1 tingkat saja** (B4): komisi hanya utk pemilik `ReferralCode` langsung, tidak berjenjang.
- **Kuota referral code: max 2 redemption per (code, referee)** (B4), ditegakkan via `@@unique([referralCodeId, refereeCustomerId, seq])` dgn `seq` 1..2 — bukan `COUNT()` yang rawan race.
- `CustomerCredit.status` naik ke `PAYABLE` hanya lewat cron job terjadwal, setelah order `PAID` + `stockStatus=FULFILLED` + `accrualWindowDays` (default 15, hard ceiling 15, admin-editable via `ProgramConfig`). Stockout tidak mendapat komisi; credit historis belum dibatch di-VOID sebelum payout.
- **Slot cron sudah penuh** (`sync-supplier-stock`, `reconcile`). Akrual **menumpang** `/api/cron/reconcile` sbg fungsi terpisah (`lib/promo/accrual.ts`), dipanggil setelah blok rekonsiliasi. Idempoten by design via `payableAt` yang dihitung saat create, bukan saat eksekusi — aman terhadap presisi cron ±59 menit maupun piggyback di cron lain.
- `CustomerCredit.appliedRatePct` adalah **snapshot**, bukan live-join ke `ProgramConfig`. Admin mengubah persentase komisi tidak boleh mengubah nilai utang yang sudah terakrual.
- **Payout komisi referral = cash only** (D4), tujuan transfer = **nomor HP referrer sendiri** (B2) — GoPay/OVO/Dana di Indonesia terikat ke nomor HP, jadi `Customer.phone` sudah cukup sebagai identitas rekening tanpa model/field baru.
- `minPayoutAmount` = Rp 20.000 (B3). Credit `PAYABLE` di bawah ambang tetap `PAYABLE` dan ikut batch berikutnya sampai akumulasinya lewat ambang.
- Payout **manual**: sistem generate `PayoutBatch` + CSV, admin transfer manual di luar sistem, lalu menandai batch `PAID` beserta `approvedBy` lewat admin UI.
- `consentPromoAt` NULL = tidak boleh masuk broadcast list. Tanpa pengecualian.
- `validUntil` WAJIB non-null untuk `VoucherRule` dengan kind `SCHEDULED`.
- Kode referral & kode voucher dicek lewat **field input yang sama** di checkout (B5) — resolusi server berurutan: `ReferralCode` → `VoucherRule.code`.

**Migrasi:** 3 gelombang aditif, lihat `PROMO_ENGINE_DESIGN.md`. Gelombang 1 = tabel+kolom baru, nol downtime. Gelombang 2 = backfill (`vouchers`→`voucher_rules`, `promo_codes`→`customer_credits`, `Customer` dibackfill dari `transactions.customerPhone` historis dgn `consentPromoAt=NULL`) + cutover kode. Gelombang 3 (cleanup kolom/tabel lama) **di luar sprint ini**.

**Pekerjaan storefront (v1.2-ST):**

- [x] ST-2a-1: Migrasi skema dasar — `Customer` + `ReferralCode` + consent + phone normalization.
- [x] ST-2a-2: Migrasi skema engine — `ProgramConfig`, `CustomerCredit`, `VoucherRule`, `VoucherRedemption`, `ReferralRedemption`, `PayoutBatch`; migrasi gelombang 1+2; perbaiki bug `promoCodeId` overload (TD-8); hapus `lib/discount.ts` dead code (TD-9); konsolidasi `/api/voucher/validate` + `/api/promo-codes/validate` → `/api/discount/validate`.
- [x] ST-2b: Endpoint registrasi Customer (`POST /api/customers`) dengan validasi + normalisasi phone.
- [x] ST-2c: Generasi `ReferralCode` otomatis saat Customer dibuat.
- [x] ST-2c-2: Tampilkan `ReferralCode` + copy benefit ("komisi jual s.d. [ProgramConfig.referralCommissionPct]%") di `CustomerSuccessScreen.tsx`.
- [x] ST-2d: Endpoint redeem di checkout — resolusi referral/voucher dari field sama (B5), guard berurutan (rule aktif → window UTC → minSpend → kuota total → kuota per-customer → self-referral).
- [x] ST-2e: Fungsi akrual `CustomerCredit`: ACCRUED -> PAYABLE setelah `accrualWindowDays`, dipanggil dari `/api/cron/reconcile` (nebeng slot, lihat guardrail cron di atas).
- [x] ST-2f: Admin UI generate `PayoutBatch` + CSV untuk periode tertentu (tujuan = nomor HP referrer; GoPay/OVO saja, transfer bank menunggu data rekening).
- [x] ST-2f-2: Tabel payout batch di `/admin/reports`, ditambahkan di bagian bawah halaman yang ada.
- [x] ST-2g: Tombol "Sudah Ditransfer" di admin UI yang menandai batch dan credit PAID + catat `approvedBy`.
- [ ] ST-1a: Broadcast promo ke segmen Customer yang `consentPromoAt IS NOT NULL`. Integrasi dengan WhatsApp Business API atau platform broadcast pilihan. **Desain program broadcast ditunda ke sprint mendatang** — hanya daftar/listing yang masuk sprint ini (ST-1a-1).
- [x] ST-1a-1: Halaman admin `/admin/customers` — list Customer + status consent + referral code + jumlah/total order. Prasyarat utk ST-1a nanti.
- [x] ST-1b: Checkbox consent di form checkout saat nomor WhatsApp diisi, dengan timestamp yang dicatat.
- [x] ST-1b-2: Checkbox consent default `true`; copy jelaskan bahwa mengisi no WA memberi consent utk riwayat pembelian, kode referral, dan info program marketing txsiber; peringatan inline (bukan hover-only, harus bekerja di sentuh/keyboard) saat di-uncheck bahwa customer tidak akan mendapat riwayat pembelian & benefit referral code; font size `text-xs` + warna `text-slate-400`.
- [x] ST-1b-3 / TD-10: Gantikan pencarian prefix 8 digit yang masih membocorkan `redeemUrl`. GET hanya mengembalikan challenge lima produk untuk nomor dengan consent dan order PAID; POST memerlukan produk PAID terakhir + order ID bukti pembelian untuk membuka riwayat. Nomor legacy 08/62/+62 harus cocok utuh. Jika empat pengecoh tidak ada, fail closed; limiter 10/menit/IP. **Catatan:** in-memory limiter bukan lintas instance; perlu shared limiter sebelum skala horizontal.
- [x] ST-1b-4: Customer `consentPromoAt=NULL` tidak menerima riwayat atau referral benefit via endpoint customer; transaksi tetap tersimpan/admin-visible. Opt-out checkout untuk nomor lama tidak boleh mencabut consent lewat nomor saja (tanpa bukti kepemilikan).
- [ ] ST-1b-5: Alur pencabutan consent pelanggan lama yang terverifikasi (mis. proof-of-possession); setelah verifikasi, hapus `consentPromoAt` tanpa menghapus transaksi historis.
- [x] ST-2d-2: Reservasi kuota untuk PENDING tidak dipersingkat untuk toko volume rendah; lepas voucher/referral (termasuk `REFERRAL_NEW` via `ReferralRedemption.ruleId` baru) secara atomik dan idempoten saat EXPIRED/CANCELLED; validasi window UTC juga saat reservasi dalam DB. Reservasi referral historis sebelum migrasi memiliki ruleId NULL dan memerlukan audit manual jika expired.
- [x] ST-2e-2: Order OUT_OF_STOCK tidak mengakru komisi, credit lama ACCRUED/PAYABLE yang belum dibatch menjadi VOID; credit sudah PAID butuh rekonsiliasi manual.
- [x] ST-2e-3: `/api/cron/reconcile` fail closed bila `CRON_SECRET` tidak diatur; secret server-side saja.

**Pekerjaan bridge (v1.2-BR):**
- Tidak ada perubahan wajib di bridge untuk P1. Bridge hanya supplier data, bukan customer data.

**Acceptance criteria:**
- Customer A pakai referral code Customer B: A dapat diskon (`VoucherRule` kind `REFERRAL_NEW`), B dapat `CustomerCredit` kind `REFERRAL_COMMISSION` status `ACCRUED`.
- Self-referral ditolak lewat phone match ATAU name similarity ≥ 0.9, independen (OR).
- Satu kode referral maksimal dipakai 2x oleh customer yang sama (`ReferralRedemption.seq` 1..2).
- `CustomerCredit` tidak pernah `PAYABLE` sebelum order COMPLETED + `accrualWindowDays`.
- Mengubah `ProgramConfig.referralCommissionPct` tidak mengubah `CustomerCredit` yang sudah terakrual.
- Broadcast hanya terkirim ke customer dengan `consentPromoAt IS NOT NULL`.
- CSV payout terbuat dari admin UI, admin transfer manual ke nomor HP referrer, lalu menandai batch PAID beserta `approvedBy`.
- `/admin/reports` menampilkan tabel payout batch di bagian bawah halaman tanpa mengubah section yang ada.

---

### [Storefront] Item 3 — Voucher Berjadwal & Pop-up

**Kondisi sekarang (gap):**
- Engine `VoucherRule` dari Item 2 telah ada; CRUD SCHEDULED dan pop-up time-based selesai.

**Kondisi target (to-be):**
- VoucherRule dengan `kind = SCHEDULED` + `validFrom`/`validUntil` UTC yang ketat.
- Pop-up muncul di storefront saat `NOW() BETWEEN validFrom AND validUntil`.
- Admin bisa buat/edit/hapus VoucherRule dari UI storefront.

**Pekerjaan storefront (v1.2-ST lanjutan):**

- [x] ST-3a: UI admin `/admin/voucher-rules` + API CRUD SCHEDULED — wajib input `validUntil` (hapus = nonaktif, agar redemption historis tidak hilang).
- [x] ST-3b: API endpoint untuk storefront frontend cek active promos:
  `GET /api/promos/active` — kembalikan rules yang aktif sekarang.
- [x] ST-3c: Komponen pop-up di frontend yang memanggil endpoint di atas saat halaman dimuat dan refresh berkala 30 detik.
- [x] ST-3d: Validasi server-side: tolak redeem jika `NOW() >= validUntil` meski frontend bypass; pemeriksaan ulang ketika reservasi kuota.
  Semua window waktu disimpan dan dievaluasi dalam UTC.

**Acceptance criteria:**
- Voucher dengan `validUntil` yang lewat tidak bisa dipakai meskipun kode diketik manual.
- Pop-up muncul tepat saat `validFrom` tercapai dan hilang setelah `validUntil`.
- Admin bisa buat promo baru dari UI tanpa deploy kode.

### [Storefront] Refinements Bisnis P1 (Keputusan 1 s.d 5 — CLOSED · VERIFIED)
- [x] **Keputusan 1 (Referee Discount & MinSpend):** Rule `REFERRAL_NEW` diskon 5% dari harga produk dengan `minSpend` Rp 50.000. Belanja di bawah Rp 50.000 ditolak dengan pesan yang jelas.
- [x] **Keputusan 2 (Referral Commission Floor):** Ditetapkan `REFERRAL_COMMISSION_FLOOR = 100`. Setiap transaksi referee yang berhasil mendatangkan komisi minimal Rp 100 untuk referrer, bahkan untuk transaksi Rp 0.
- [x] **Keputusan 3 (Penyatuan Dualisme Diskon & Labeling Admin):** Laporan penjualan (`/api/admin/reports` & UI `/admin/reports` + export CSV/GDrive) menyatukan riwayat diskon dari `VoucherRule`, `ReferralCode`, `PromoCode`, dan legacy `Voucher`. Label sidebar `/admin/voucher-rules` menjadi "Promo & Voucher" dan `/admin/vouchers` menjadi "Voucher (Legacy)".
- [x] **Keputusan 4 (Audit Trail & paymentType FREE_PROMO):** Transaksi Rp 0 akibat diskon 100% diberi label `paymentType: "FREE_PROMO"` (bukan lagi `"MIDTRANS"`), mempermudah rekonsiliasi kas riil bank/Midtrans vs diskon promosi.
- [x] **Keputusan 5 (Ekspektasi Payout Batch & Transparansi Kredit Referrer):** UI `/admin/reports` pada panel Payout Batch diperkaya dengan infobox masa tunggu 15 hari, ringkasan saldo PAYABLE/ACCRUED, dan tabel monitoring status kredit seluruh referrer via endpoint `GET /api/admin/payout-batches/summary`.

### [Storefront] Initiative Cleanup 6 — Pembersihan Mode Supplier (AUTO & REZEKI) (CLOSED · VERIFIED)
- **Konteks:** Menegakkan batas arsitektur (*Architectural Boundary*). Storefront tidak lagi memanggil API pembelian supplier secara langsung/sinkron saat checkout. Seluruh pasokan stok eksternal dilakukan secara asinkron oleh `vendinglink_bridge` ke tabel `RedeemStock`.
- **Implementasi Terverifikasi:**
  - **Fase 1 (Data & Normalisasi Aman):** Script `scripts/normalize-supplier-modes.ts` dan hook di `prisma/seed.ts` memastikan seluruh produk aktif berada pada `supplierMode = "MANUAL"`. Integritas DB produksi aman tanpa penghapusan kolom destruktif.
  - **Fase 2 (Pruning Checkout):** Dihapus percabangan panggilan langsung Rezeki API di alur checkout customer (`/api/checkout/customer`), checkout agent (`/api/checkout/agent`), dan status settlement (`lib/transactionStatus.ts`). Pemenuhan stok 100% dipasok dari `RedeemStock`.
  - **Fase 3 (Bridge Topup Unblock):** Dihapus penolakan 400 REZEKI di `lib/bridge/topup.ts`. Topup stok dari Bridge selalu berhasil masuk ke `RedeemStock`.
  - **Fase 4 (Katalog & Admin UI):** Form admin inventory (`components/admin/SupplierProductLinker.tsx` & `app/admin/inventory/page.tsx`) mengunci mode ke `MANUAL` dan menyediakan input Bridge SKU/supplierProductId opsional. Tombol sync supplier dihapus dari inventory.
  - **Fase 5 (Deprecasi Modul & Testing):** Modul `lib/suppliers/rezeki.ts` dan `lib/suppliers/sync.ts` dianotasi `@deprecated`. Suite pengujian `__tests__/api/cleanup-supplier-modes.test.ts` berhasil lulus 100%.

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

model AgentOperationalConfig {
  id                 String    @id @default("default")
  maxSpendPerRequest Float     @default(500000)
  maxSpendPerDay     Float     @default(5000000)
  minBalanceFloor    Float     @default(200000)
  priceDeltaAlertPct Float     @default(20)
  highValueThreshold Float     @default(1000000)
  isAgentEnabled     Boolean   @default(true)
  updatedBy          String?   -- admin username atau 'hermes-agent'
  approvedAt         DateTime?
  updatedAt          DateTime  @updatedAt
}
```

**Guardrail belanja otonom (2-Layer Architecture):**

1. **Layer 1: Absolute Hard Boundaries (`src/config/env.ts`):**
   Ceiling mutlak yang tidak dapat di-override oleh database, LLM, maupun tombol Telegram untuk mencegah kebangkrutan/kebocoran dana akibat anomali logic:
   ```
   AGENT_ENABLED=true
   AGENT_HARD_MAX_SPEND_PER_REQUEST=1000000 -- Hard ceiling Rp 1jt per request
   AGENT_HARD_MAX_SPEND_PER_DAY=10000000    -- Hard ceiling Rp 10jt per hari
   AGENT_HARD_MIN_BALANCE_FLOOR=100000      -- Saldo mutlak tidak boleh di bawah Rp 100rb
   AGENT_ALLOWED_SUPPLIER_CODES=RZK        -- CSV allowlist
   ```
2. **Layer 2: Dynamic Operational Config (`AgentOperationalConfig` di DB):**
   Nilai operasional adaptif yang dievaluasi setiap transaksi (default fallback dari seed env).
3. **Layer 3: Hermes Agent Analytics & Telegram HITL:**
   Hermes Agent (berjalan di background worker/VPS terpisah) menganalisis kecepatan transaksi, tren produk paling dicari, dan saldo supplier via `getBalance()`. Hermes merumuskan rekomendasi limit harian baru dan mengirim Telegram alert interaktif dengan inline button approval (`[✅ Setujui]` / `[❌ Tolak]`). Approval admin langsung memperbarui `AgentOperationalConfig` secara instan tanpa restart container/redeploy.

Urutan evaluasi (sebelum order): AGENT_ENABLED > allowlist > per-request cap >
daily cap > balance floor > price delta > high value threshold.
`supplierOrderQueue` TETAP `attempts: 1` — tidak boleh diubah.

**Pekerjaan bridge P2a:**

- [x] BR-P2a-1: Cleanup `orchestrator.ts` — hapus stub dan import menganggur.
- [x] BR-P2a-2: Migrasi schema `ProductRequest` + `AgentOperationalConfig` + enum ke `schema.base.prisma`.
- [x] BR-P2a-3: Env vars hard ceiling guardrail ke `src/config/env.ts` + `.env.example`.
- [x] BR-P2a-4: `POST /api/v1/requests` — Zod, rate-limit, Bearer auth.
- [x] BR-P2a-5: `POST /api/v1/requests/:id/confirm`.
- [x] BR-P2a-6: `productSearchQueue` + worker — parallel, timeout, dynamic guardrail evaluation, status update.
- [x] BR-P2a-7: Balance monitor + metrics exporter — cron 30 menit, alert Telegram di bawah floor, feed metrics untuk Hermes analytics.
- [x] BR-P2a-8: Telegram bot handler: `/agent pause`, `/agent resume`, dan callback query listener untuk inline button approval dynamic guardrail.
- [x] BR-P2a-9: `/balance all` — cek semua supplier aktif.
- [x] BR-P2a-10: Notif ke storefront `POST {VL_URL}/api/bridge/webhook/request-update`
  — revisi `docs/openapi.yaml` + `VENDINGLINK_WEBHOOK_SPEC.md`.
- [x] BR-P2a-11: Test coverage guardrail (Vitest + nock). **Wajib lulus sebelum deploy.**

**Pekerjaan storefront P2a:**

- [x] ST-P2a-1: Tombol "Request Produk ini" di product card yang kosong pada halaman katalog (`CustomerProductCard.tsx` + `RequestProductModal.tsx` + `POST /api/customer/product-requests`).
- [x] ST-P2a-2: `POST /api/bridge/webhook/request-update` — terima notif bridge (`app/api/bridge/webhook/request-update/route.ts`).
- [x] ST-P2a-3: Forward notif ke customer (WA/push) (`lib/whatsapp.ts`: `sendProductFoundNotification` & `sendProductStatusNotification`).
- [x] ST-P2a-4: Tombol konfirmasi beli yang trigger `confirm` ke bridge (`POST /api/customer/product-requests/:id/confirm` & `/request-confirm/[id]`).

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
    Worker: dry-run getProductList + getBalance (GenericRestAdapter)
    |
    +-- OK   -> status ACTIVE, notif Telegram
    +-- FAIL -> Redaction/Sanitizer (masking token & credentials)
                -> Enqueue job ke Hermes Agent Runner (VPS/Worker mandiri di luar Vercel/Bridge)
                -> Hermes panggil Commercial LLM (Claude 3.5 Sonnet / GPT-4o)
                -> Generate `SupplierAdapter.ts` + Vitest mock test di sandbox
                -> Jalankan `npm test` di isolated container
                -> Lulus test -> Push branch & Open GitHub DRAFT PR
                -> Notif Telegram: link Draft PR untuk review developer
                -> Developer review & merge PR -> CI/CD rebuild -> status ACTIVE
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

**Batasan keamanan & isolasi agentic adapter (MUTLAK):**
1. **Isolated Worker (Zero Blast Radius):** Hermes Agent berjalan di VPS/worker terpisah di luar Vercel (Storefront) dan Bridge transaksi. Kegagalan agent tidak mempengaruhi operasional customer.
2. **Data Redaction:** Sebelum prompt/doc supplier dikirim ke LLM API, layer Sanitizer otomatis memotong/me-masking seluruh secret, signature key, dan password menjadi dummy `<MOCK_SECRET>`.
3. **No Hot-Reloading:** LLM output tidak pernah di-eval atau hot-load di runtime. Output berupa TypeScript file yang masuk sebagai **GitHub Draft PR**, di-review developer, di-merge, baru rebuild Docker.
4. **Automated Verification:** PR wajib lulus `tsc --noEmit` dan Vitest dry-run test di sandbox sebelum PR dibuat.

**Pekerjaan bridge P2b:**

- [x] BR-P2b-1: Migrasi schema `Supplier` + enum ke `schema.base.prisma`.
- [x] BR-P2b-2: `GenericRestAdapter` — `ISupplierAdapter` berbasis descriptor JSON.
- [x] BR-P2b-3: Update `SupplierFactory` — load dari tabel `Supplier` (DB), RZK hardcode sebagai fallback.
- [x] BR-P2b-4: `POST /api/v1/suppliers` + `PATCH /api/v1/suppliers/:code` dengan Bearer auth.
- [x] BR-P2b-5: Validation worker — dry-run saat supplier baru didaftarkan.
- [x] BR-P2b-6: Hermes Agent adapter builder pipeline (feature-flagged `AGENT_ADAPTER_BUILD_ENABLED`) — sanitizer layer, sandbox Vitest runner, GitHub API Draft PR creator, notif link PR ke Telegram.
- [x] BR-P2b-7: Command `/suppliers` — list semua supplier dan statusnya.
- [x] BR-P2b-8: `SUPPLIER_RZK_*` di `env.ts` jadi deprecated (baca tapi tidak required, backward-compat).

**Pekerjaan storefront P2b:**

- [x] ST-P2b-1: UI Manajemen Supplier — form tambah, upload descriptor, lihat status validasi.
- [x] ST-P2b-2: Tentukan ownership enkripsi credentials (storefront atau bridge) dan dokumentasikan.

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
Bangun CMS minimal di storefront dengan MDX atau rich-text editor yang mirip telegraph.

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
| TD-4 | `db.ts:12` logging `query` aktif di production — noise log dan potensi ekspos query sensitif. Ganti ke `['error']` di production. | ✅ RESOLVED (db.ts production check) | P0/v1.1 |
| TD-5 | `ProductMapping` model di schema tapi 0 referensi di `src/` (dead model). `vlProductId = "[UNKNOWN]"` di orchestrator. | MEDIUM | P0/v1.1 (BR-5a) |
| TD-6 | `orchestrator.ts:42-52` `executePurchase()` stub kosong + import menganggur. | LOW | P2a (BR-P2a-1) |
| TD-7 | Session middleware in-memory (`session.ts:20`). Restart bot = state AWAITING_EMAIL hilang. Cukup untuk admin tunggal, tapi dokumentasikan limitasinya di README. | LOW | Opsional |
| TD-8 | `Transaction.promoCodeId` overloaded: ditulis baik oleh jalur "kode dipakai saat checkout" maupun jalur "kode diterbitkan sbg refund stockout" di `transactionStatus.ts`, saling menimpa. Memungkinkan reuse kode promo yang seharusnya sudah terpakai. | ✅ RESOLVED (ST-2a-2, 2026-10-11): kolom `Transaction.refundPromoCodeId` terpisah untuk kode refund terbit + backfill gelombang 2 | — |
| TD-9 | `lib/discount.ts` dead code — nol caller di codebase (checkout query Prisma langsung). `__tests__/lib/discount.test.ts` memock seluruh modul yang diuji (`vi.mock('@/lib/discount')`), jadi 17 test-nya memvalidasi mock, bukan logika nyata. | ✅ RESOLVED (ST-2a-2, 2026-10-11): `lib/discount.ts` + 2 mock-only test dihapus; diganti test integrasi nyata `discount-validate.test.ts` | — |
| TD-10 | `GET /api/customer/orders` dulu memakai `customerPhone: { contains: sanitizedPhone }` dan mengembalikan `redeemUrl` tanpa bukti pembelian. | ✅ RESOLVED (2026-10-11): GET hanya challenge 5 opsi setelah consent; POST meminta jawaban produk terakhir + order ID milik nomor yang sama, pembatasan 10/menit/IP; tidak ada lookup substring. Shared rate limiter untuk multi-instance masih follow-up. | P1 (ST-1b-3) |

---

## 9. Open Questions & Gate Eksternal

Keputusan berikut tidak bisa dibuat oleh engineering saja dan akan mem-block sprint yang bersangkutan
jika tidak dijawab.

| # | Pertanyaan                                                              | Block sprint | Owner keputusan |
|---|-------------------------------------------------------------------------|--------------|-----------------|
| Q1 | Integrasi Google Drive yang "rusak" — kode tidak ditemukan di repo bridge. Di mana kode tersebut berada? (VPS script? Storefront?) Perlu diidentifikasi sebelum BR-8a bisa dirancang final. | P0 (BR-8a) | Admin/DevOps |
| Q2 | Storefront VendingLink: framework apa, repo di mana? Semua task ST-* dalam roadmap ini perlu akses ke repo storefront untuk dieksekusi. | P0 (ST-5a) | Storefront maintainer |
| Q3 | ~~N hari window refund untuk ReferralReward ACCRUED -> PAYABLE?~~ **RESOLVED**: `accrualWindowDays` default 15 hari, hard ceiling 15, admin-editable via `ProgramConfig`. | P1 (ST-2e) | Owner bisnis |
| Q4 | ~~AGENT_MAX_SPEND_PER_REQUEST dan _PER_DAY — berapa angka yang tepat?~~ **RESOLVED**: Menggunakan **Dynamic Guardrail via Hermes Agent** yang tersimpan di DB `AgentOperationalConfig` (default Rp 500rb/req, Rp 5jt/hari). Hermes menganalisis pola saldo/demand & mengirim rekomendasi approval interaktif ke Telegram Admin. Nilai di `env.ts` bertindak sebagai *Absolute Hard Boundary*. | P2a (BR-P2a-3) | Owner bisnis |
| Q5 | ~~LLM mana yang akan digunakan untuk agentic adapter build?~~ **RESOLVED**: Menggunakan **API Komersial (Claude 3.5 Sonnet / GPT-4o)** via **Hermes Agent Runner di VPS/worker terpisah** (di luar Vercel/Bridge). Biaya sangat rendah (<$5/bln karena frekuensi rendah). Keamanan kredensial dijamin lewat **Data Redaction layer**. Output wajib berupa **GitHub Draft PR + Vitest PASS**, tanpa runtime hot-load. | P2b (BR-P2b-6) | Admin/Bisnis |
| Q6 | Item 7 (Shopee) dan Item 6 (USDT) — gate legal belum dibuka. Tidak ada effort engineering sebelum gate terbuka. | P3 | Owner bisnis + legal |

---

*Dokumen ini harus diperbarui setiap akhir sprint. Checklist item yang selesai ditandai `[x]`
dan status versi diperbarui di tabel Bagian 2.*
