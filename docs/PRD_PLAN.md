desain implementasi VendingLink_bridge yang dibagi menjadi 3 tahapan utama:

Fase 1: Arsitektur Inbound, Autentikasi, & Sistem Komando (Telegram)
Fase ini berfokus pada pembangunan pintu masuk aplikasi, keamanan akses, dan penerjemah perintah (command parser) dari Telegram Anda ke dalam sistem internal Express.

Task 1.1: Inisialisasi Proyek Express & Dependensi Utama

Setup Express.js (sangat disarankan menggunakan TypeScript untuk type safety pada payload API).

Instalasi library esensial: axios (untuk HTTP request), telegraf atau node-telegram-bot-api (untuk wrapper webhook Telegram), dan winston atau pino (untuk logging terstruktur).

Task 1.2: Pembuatan Endpoint Webhook Telegram

Membangun endpoint POST /webhook/telegram yang akan didaftarkan ke API Telegram.

Menerapkan middleware validasi untuk memastikan request benar-benar berasal dari server Telegram.

Task 1.3: Keamanan & Filter Pengguna (Whitelist)

Membangun mekanisme hard-filter di awal pipeline. Ekstrak chat.id atau from.id dari payload pesan.

Jika ID tidak cocok dengan Telegram ID Anda yang disimpan di Environment Variable (ADMIN_TELEGRAM_ID), buang request (return 200 OK agar Telegram tidak retry, tapi jangan proses lebih lanjut).

Task 1.4: Command Parser & Routing Perintah

Membuat parser untuk menerjemahkan teks menjadi instruksi terstruktur. Contoh format perintah:

Cek Produk: /list [kode_supplier] (contoh: /list SUP_A)

Beli Stok: /buy [kode_supplier] [id_produk] [jumlah] (contoh: /buy SUP_A PROD_123 10)

Mengarahkan hasil parsing ke controller yang sesuai di Fase 2.

Fase 2: Mesin Orkestrasi, Audit Trail, & Fleksibilitas Supplier (Core Middleware)
Fase ini adalah jantung dari Bridge, tempat logika transaksional, penyimpanan log (audit trail), dan komunikasi dengan pihak ketiga (Supplier) terjadi secara dinamis.

Task 2.1: Setup Database & Logging Transaksi

Setup database ringan (seperti SQLite atau PostgreSQL) menggunakan ORM seperti Prisma.

Buat tabel Transactions untuk melacak transaction_id, supplier_code, product_id, qty, status (PENDING, SUPPLIER_OK, VENDING_OK, FAILED), dan timestamps.

Siapkan mekanisme penyimpanan raw payload (Request & Response dari/ke Supplier) untuk keperluan investigasi dan audit finansial.

Task 2.2: Implementasi Supplier Factory (Strategy Pattern)

Buat interface/contract standar di dalam kode, misalnya ISupplierAdapter, yang mewajibkan dua method: getProductList() dan purchaseProduct(productId, qty).

Buat implementasi spesifik (misal: SupplierA_Adapter.js dan SupplierB_Adapter.js) yang memuat URL, header autentikasi, dan manipulasi payload khusus untuk masing-masing supplier.

Task 2.3: Logika Eksekusi Dinamis & Notifikasi Telegram

Saat perintah /list atau /buy diproses, sistem menggunakan Supplier Factory untuk memanggil Adapter yang tepat berdasarkan kode_supplier.

Terapkan pengiriman pesan real-time ke Telegram:

"Mengeksekusi pembelian ke Supplier A..."

"Berhasil mendapat respons dari Supplier A. Saldo terpotong. Melanjutkan ke Vendinglink..."

Fase 3: Outbound Delivery (VendingLink), Resiliensi, & Containerization
Fase terakhir memastikan stok yang sudah berhasil dibeli dari supplier dijamin masuk ke VendingLink, menangani potensi kegagalan jaringan, dan membungkus seluruh aplikasi agar siap di-deploy.

Task 3.1: Integrasi ke Endpoint VendingLink

Membangun fungsi HTTP Client (POST) yang menembak ke https://[domain-vendinglink-anda]/api/bridge/webhook/stock/topup.

Menyusun payload standar yang disepakati, contoh: { "transaction_id": "...", "product_id": "...", "added_qty": 10, "source": "BRIDGE_BOT" }.

Menambahkan header keamanan (misal: Authorization: Bearer <BRIDGE_SECRET_KEY>) agar endpoint VendingLink mengenali bahwa request ini valid dari Bridge.

Task 3.2: Mekanisme Resiliensi (Retry & Fallback)

Jika langkah 2.3 (beli di supplier) sukses, tapi langkah 3.1 (POST ke Vendinglink) gagal (karena Vendinglink down atau timeout), stok tersebut rawan hilang (uang sudah keluar, stok belum masuk).

Implementasikan retry loop sederhana atau antrean (menggunakan bullmq dengan Redis, atau node-cron yang membaca status SUPPLIER_OK di database dan mencoba POST ulang ke VendingLink setiap 5 menit).

Kirim notifikasi Telegram jika masuk ke mode retry.

Task 3.3: Finalisasi Laporan Telegram

Jika POST ke Vendinglink merespons status 200 OK, perbarui status transaksi di database menjadi COMPLETED.

Kirim pesan penutup ke Telegram: "✅ Transaksi Selesai. Stok Vendinglink berhasil di-update."

Task 3.4: Containerization (Docker Setup)

Buat Dockerfile teroptimasi untuk lingkungan Node.js (menggunakan Alpine Linux untuk ukuran image yang kecil).

Buat docker-compose.yml untuk mempermudah injeksi Environment Variables (seperti PORT, BOT_TOKEN, ADMIN_TELEGRAM_ID, VENDINGLINK_URL, SUPPLIER_API_KEYS, DATABASE_URL).

(Opsional) Jika menggunakan Redis atau PostgreSQL untuk database/queue, tambahkan services tersebut ke dalam konfigurasi docker-compose agar saling terhubung dalam satu network terisolasi.