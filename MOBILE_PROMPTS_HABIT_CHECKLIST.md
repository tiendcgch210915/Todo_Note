# Bộ prompt cho Claude Code (Mobile): Habit ↔ Checklist và đóng ngày lúc 00h

Tài liệu này dành cho **bạn** (người điều phối). Nội dung bên trong các khối `text` là thứ cần dán vào Claude Code ở **repo Mobile**. Back-end là nguồn sự thật: Mobile phải bám đúng những gì back-end đã làm, không tự suy diễn.

## Cách dùng

1. Mở Claude Code ở repo Mobile, dán **PROMPT 0** trước. Prompt này chỉ khảo sát và lưu hợp đồng API vào repo Mobile, **chưa sửa code tính năng**.
2. Đọc báo cáo khảo sát của Claude, sửa/xác nhận các điểm nó hỏi, rồi dán lần lượt **PROMPT 1 → 5**. Mỗi prompt là một giai đoạn; xong giai đoạn nào phải chạy phân tích tĩnh + test của giai đoạn đó và commit trước khi sang giai đoạn tiếp theo.
3. Các prompt 1–5 tham chiếu `docs/backend-habit-checklist-contract.md` (tệp do Prompt 0 tạo) và nhắc lại các quy tắc sống còn của riêng giai đoạn đó, nên vẫn đúng nếu Claude bị mất ngữ cảnh giữa chừng.

Thứ tự phụ thuộc: **0 → 1 → 2 → 3 → 4 → 5**. Prompt 2, 3, 4 chỉ làm sau khi Prompt 1 (dữ liệu + sync) đã xong và test xanh.

Tóm tắt thay đổi ở back-end (để bạn nắm):

- **Tính năng A, liên kết:** habit có thêm `checklist_template_id` (có thể `null`). Khi **một lần chạy (run) của checklist đó hoàn thành**, back-end tự ghi log `completed = true` cho habit **đúng ngày địa phương** hoàn thành (theo `users.timezone`).
- **Tính năng B, đóng ngày:** qua 00h (theo `users.timezone`) mà habit chưa có log cho ngày vừa qua thì back-end tự ghi log `completed = false` (trước đây là không có log).
- Tệp contract phía back-end tương ứng: `MOBILE_HABIT_CHECKLIST_LINK_CONTRACT.md` (cùng repo back-end).

---

## PROMPT 0: Khảo sát codebase Mobile và lưu hợp đồng API (không sửa code tính năng)

````text
Bạn là Claude Code làm việc trong repo ứng dụng MOBILE của dự án Todo_Note (nhiều khả năng là Flutter/Dart; hãy xác nhận từ code chứ không giả định). Back-end (Fastify + SQLite/Turso, repo riêng) vừa bổ sung 2 tính năng. Nhiệm vụ cuối cùng của chuỗi prompt là áp dụng chúng vào giao diện và logic Mobile, bám đúng hợp đồng API của back-end. GIAI ĐOẠN NÀY CHỈ KHẢO SÁT VÀ LƯU TÀI LIỆU, TUYỆT ĐỐI CHƯA SỬA CODE TÍNH NĂNG.

HAI TÍNH NĂNG CẦN ÁP DỤNG (tóm tắt):
A) Habit có thể được GẮN với một checklist (field mới `checklist_template_id`). Khi người dùng HOÀN THÀNH một lần chạy (run) của checklist đó, back-end tự đánh dấu habit hoàn thành cho đúng ngày địa phương người dùng đã hoàn thành checklist.
B) Qua 00h (theo múi giờ của người dùng) mà một habit chưa được tick cho ngày vừa qua thì back-end tự ghi một log `completed = false` cho ngày đó. Trước đây ngày đó chỉ đơn giản là KHÔNG có log.

BƯỚC 1: Lưu hợp đồng API.
Tạo tệp `docs/backend-habit-checklist-contract.md` trong repo Mobile (tạo thư mục `docs/` nếu chưa có; nếu repo đã có chỗ đặt tài liệu API/backend thì dùng chỗ đó và ghi lại đường dẫn bạn chọn). Nội dung là NGUYÊN VĂN khối hợp đồng ở cuối prompt này (từ dòng `=== BẮT ĐẦU HỢP ĐỒNG ===` đến `=== KẾT THÚC HỢP ĐỒNG ===`), không bỏ sót, không diễn giải lại. Đây là tài liệu tham chiếu cho mọi giai đoạn sau.

BƯỚC 2: Khảo sát codebase (chỉ đọc). Hãy suy nghĩ từng bước và tìm câu trả lời bằng cách đọc code thật, trích dẫn đường dẫn tệp và số dòng:
 1. Framework, ngôn ngữ, quản lý state (Riverpod/Bloc/Provider/GetX...), điều hướng, thư viện HTTP, thư viện DB cục bộ (Drift/sqflite/Isar/Hive...), cách chạy phân tích tĩnh và test (lệnh chính xác).
 2. Mô hình HABIT: file model, bảng/collection cục bộ, mapper JSON, repository, màn hình/màn hình con (danh sách, chi tiết, form tạo/sửa, lịch, thống kê, widget). Mô hình HABIT LOG tương tự. Habit hiện có những field nào (frequency_type, target_per_period, active_weekdays, start_date, end_date, is_archived, streak...) và UI có dùng `active_weekdays`/`frequency_type` để quyết định ngày nào "đến hạn" không?
 3. Mô hình CHECKLIST: template (cả template của hệ thống `is_system` lẫn của người dùng), template items, RUN, run items; màn hình thực hiện checklist; chỗ nào gọi hoàn thành run (REST `POST /checklists/runs/:id/complete` hay đẩy qua sync, hay cả hai); chỗ nào set `completed_at`/`duration_ms`.
 4. SYNC ENGINE: pull (`GET /sync/changes`) và push (`POST /sync/push`): cơ chế outbox/hàng đợi thao tác, thứ tự đẩy, cách áp dụng bản ghi pull vào DB cục bộ (có khóa ngoại cục bộ không? thứ tự áp dụng?), cách xử lý kết quả `applied | conflict | error`, đặc biệt nhánh `conflict` + `server_version` (có đổi id cục bộ sang id của server không, ví dụ với tag hoặc habit_log trùng khóa tự nhiên?), cách xử lý lỗi theo từng thao tác.
 5. Cách app xác định "hôm nay" và "ngày địa phương": dùng múi giờ máy hay `user.timezone` từ server? Có chỗ nào lấy `DateTime.now()` rồi cắt chuỗi ngày không? Hàm tiện ích ngày/giờ hiện có.
 6. Mọi nơi app TỰ TẠO HOẶC TỰ SỬA habit log (tick thủ công, undo, xóa log, todo hoàn thành tự tick habit nếu app có làm phía client...). Mọi nơi suy ra "ngày nào chưa làm" từ việc KHÔNG có log (lịch, thống kê, tỉ lệ hoàn thành, streak, widget, thông báo cục bộ...).
 7. Cách app chuyển đổi kiểu dữ liệu giữa REST và sync (REST trả số 0/1 cho `completed`/`is_archived`; sync trả boolean).
 8. Cách app xử lý lỗi API chung và ví dụ mã lỗi nghiệp vụ hiện có (ví dụ `invalid_habit`, `invalid_category`, `incomplete_required`) để sau này thêm `invalid_checklist` đúng phong cách.

BƯỚC 3: Báo cáo. Viết kết quả khảo sát (KHÔNG ghi vào repo, chỉ in ra cho tôi) gồm:
 - Bản đồ các tệp/thành phần liên quan, theo 8 mục trên.
 - Danh sách các điểm bạn thấy MÂU THUẪN hoặc KHÔNG KHỚP giữa hợp đồng và code Mobile hiện tại (ví dụ: sync push body dùng key khác, kiểu dữ liệu khác, app đang tự tạo log ở client, app đang dùng múi giờ máy...).
 - Danh sách câu hỏi cần tôi quyết định trước khi sang giai đoạn sau (chỉ hỏi điều thật sự không suy ra được từ code).
 - Đề xuất kế hoạch thực hiện cho 5 giai đoạn sau (1: dữ liệu + sync; 2: form habit chọn checklist; 3: tự tick khi hoàn thành checklist; 4: hiển thị trạng thái ngày và đóng ngày lúc 00h; 5: test + nghiệm thu), gắn với các tệp cụ thể bạn đã tìm thấy.

QUY TẮC CHUNG CHO CẢ CHUỖI PROMPT:
 - Không sửa back-end, không bịa endpoint hay field. Nếu thấy hợp đồng và code Mobile mâu thuẫn, hoặc hợp đồng thiếu thông tin, hãy DỪNG VÀ HỎI thay vì đoán.
 - Bám phong cách code hiện có (đặt tên, cấu trúc thư mục, quản lý state, xử lý lỗi, i18n/chuỗi tiếng Việt nếu app có). Không refactor ngoài phạm vi.
 - Làm theo từng bước nhỏ, commit gọn, mỗi giai đoạn phải chạy phân tích tĩnh và test; nêu rõ lệnh bạn đã chạy và kết quả.

=== BẮT ĐẦU HỢP ĐỒNG ===

# Hợp đồng back-end: Habit ↔ Checklist và đóng ngày lúc 00h

Nguồn: back-end Todo_Note. API base: `/api/v1`. Mọi endpoint dưới đây cần header `Authorization: Bearer <token>`. JSON dùng snake_case. Thời gian là ISO-8601 UTC (hậu tố `Z`). Ngày là `YYYY-MM-DD`.

## 0. Khái niệm then chốt

- "Ngày địa phương" của người dùng = ngày theo `users.timezone` (IANA, ví dụ `Asia/Ho_Chi_Minh`, mặc định nếu rỗng/không hợp lệ). Giá trị này có trong object `user` của phản hồi đăng nhập và trong thực thể sync `user`. App PHẢI dùng múi giờ này (không phải múi giờ máy) khi cần suy ra ngày của habit; chỉ rơi về múi giờ máy khi chưa biết `user.timezone`.
- Một habit gắn với tối đa 1 checklist (`checklist_template_id`). Nhiều habit có thể cùng gắn một checklist. Checklist có thể là của người dùng hoặc template hệ thống (`is_system = 1`, dùng chung mọi người).
- Liên kết nằm ở phía HABIT (không nằm trên template), nên gắn template hệ thống không sửa template dùng chung.

## 1. Hành vi back-end (bắt buộc app phản ánh đúng)

### 1.1 Tự tick habit khi hoàn thành checklist
- Chạy ĐÚNG MỘT LẦN, tại thời điểm một run chuyển sang `completed`: (a) lần gọi đầu của `POST /checklists/runs/:id/complete`, hoặc (b) lần sync push đưa một run sang `status = "completed"`. Gọi complete lần hai không làm gì thêm.
- Ngày ghi log = ngày địa phương (theo `users.timezone`) của `completed_at` của run. Hoàn thành lúc 23:50 rồi sync sau nửa đêm vẫn tính cho ngày 23:50 đó.
- Tác động lên mọi habit "còn sống" của người dùng, chưa archive, có `checklist_template_id` = template của run: log của ngày đó thành `completed = true`. `note` đang có được giữ nguyên. Log trước đó `completed = false` (kể cả do job nửa đêm) được nâng lên `true`.
- Sau đó back-end tính lại streak của habit.
- KHÔNG đổi log đã ghi khi: bỏ dở (abandon) hay xóa run về sau, đổi hay gỡ liên kết, hoặc xóa checklist. Hoàn thành không có thao tác "bỏ hoàn thành". Gắn checklist KHÔNG backfill các run đã hoàn thành trước đó.
- Habit gắn cả todo lẫn checklist: hai cách đều hợp lệ; một ngày đã hoàn thành nhờ checklist sẽ không bị todo hoàn thành trễ hạ xuống "chưa xong".
- Run chỉ hoàn thành được khi mọi bước bắt buộc không còn `pending` (nếu không: `409 { "error": "incomplete_required" }`).

### 1.2 Đóng ngày lúc 00h
- Khi ngày địa phương D của một người dùng kết thúc (00:00 theo `users.timezone`), mọi habit thỏa: chưa xóa, KHÔNG archive, `start_date <= D`, (`end_date` rỗng hoặc `end_date >= D`) và CHƯA CÓ log còn sống cho D, sẽ nhận một log `completed = false`, `note = null`.
- Back-end KHÔNG xét `frequency_type`, `target_per_period`, `active_weekdays` khi đóng ngày: mọi habit hoạt động đều nhận log false mỗi ngày bị bỏ lỡ.
- Log đã bị xóa mềm của ngày D coi như "không có log": được hồi sinh thành `completed = false`. Log đang sống (đã tick, hay đã là false, hay có note) không bao giờ bị đụng.
- Chỉ áp dụng từ khi triển khai trở đi, không backfill lịch sử. Nếu server ngủ/tắt qua nửa đêm, nó bù tối đa 7 ngày gần nhất ở lần chạy kế tiếp, hoặc ở lần `GET /sync/changes` kế tiếp, hoặc ở lần `GET` bất kỳ dưới `/habits`.
- Log này đến app qua sync pull như mọi `habit_log`, KHÔNG có field đặc biệt phân biệt.
- Không tính lại streak khi đóng ngày (log false không đổi kết quả streak).
- Khi habit đang archive, các ngày trôi qua không được đóng.

### 1.3 Hệ quả quan sát được
- `GET /habits/calendar`: `by_date[ngày][habit_id]` giờ có giá trị `0` cho ngày đã đóng mà không tick (trước đây không có khóa).
- `GET /habits/:id`: `recent_logs` (30 log gần nhất) giờ là 30 ngày liên tiếp thay vì 30 ngày có log.
- `GET /habits/:id/logs` và sync pull trả thêm các dòng `completed = false` (khoảng 1 dòng/habit hoạt động/ngày).
- `PATCH /habits/:id/logs/:log_date` dùng được trên ngày đã đóng (trước đây 404 vì chưa có log).
- Dashboard/điểm/digest/streak KHÔNG đổi: trước nay chúng đã coi "thiếu log" và `completed=false` như nhau.

## 2. Mô hình dữ liệu

### Habit
| Field | Kiểu | Ghi chú |
| --- | --- | --- |
| `id` | string (UUIDv7) | Client có thể tự sinh khi tạo qua sync. |
| `user_id` | string | |
| `title` | string 1..200 | |
| `description`, `icon` | string \| null | |
| `color` | `#rrggbb` | |
| `frequency_type` | `daily` \| `weekly` \| `custom` | |
| `target_per_period` | int 1..50 | |
| `active_weekdays` | `"1,3,5"` \| null | Thứ Hai=1 ... Chủ Nhật=7. |
| `start_date` | `YYYY-MM-DD` | |
| `end_date` | `YYYY-MM-DD` \| null | |
| **`checklist_template_id`** | string (uuid) \| null | **MỚI.** Checklist được gắn. `null` = không gắn. |
| `current_streak`, `longest_streak` | int | Chỉ server ghi (client gửi lên sẽ bị bỏ qua). |
| `is_archived` | **REST: 0/1; sync: boolean** | |
| `created_at`, `updated_at`, `deleted_at` | ISO UTC \| null | |

### Habit log
| Field | Kiểu | Ghi chú |
| --- | --- | --- |
| `id` | string | |
| `habit_id` | string | |
| `log_date` | `YYYY-MM-DD` | Duy nhất theo `(habit_id, log_date)`. |
| `completed` | **REST: 0/1; sync: boolean** | |
| `note` | string \| null | |
| `created_at`, `updated_at`, `deleted_at` | | |

LƯU Ý kiểu dữ liệu: REST của habits trả số `0/1` cho `completed` và `is_archived`; còn `/sync/*` dùng boolean `true/false`. Mapper phải xử lý cả hai.

## 3. REST

### Habits (`/habits`)
- `POST /habits` -> `201 { "habit": {...} }`. Body: `title` (bắt buộc), `start_date` (bắt buộc), tùy chọn `description`, `icon`, `color`, `frequency_type`, `target_per_period`, `active_weekdays`, `end_date` (nullable), **`checklist_template_id` (uuid, nullable)**.
- `GET /habits?include_archived=true|false` -> `{ "items": [habit...] }`.
- `GET /habits/:id` -> `{ "habit": {...}, "recent_logs": [log...] }` (tối đa 30, mới nhất trước).
- `PATCH /habits/:id` -> `{ "habit": {...} }`. Mọi field tùy chọn (thêm `is_archived: boolean`). **`checklist_template_id`: vắng = giữ nguyên liên kết; `null` = gỡ liên kết; chuỗi uuid = gắn.**
- `DELETE /habits/:id` -> `204`.
- `POST /habits/:id/archive` | `/unarchive` -> `{ "habit": {...} }`.
- `POST /habits/:id/logs` -> `201 { "log": {...}, "streaks": { "current", "longest" } }`. Body `{ "log_date": "YYYY-MM-DD", "completed": true, "note": "..." }` (`completed` mặc định `true`). Đây là UPSERT theo `(habit_id, log_date)`: ghi đè `completed` và `note`, hồi sinh log đã xóa.
- `PATCH /habits/:id/logs/:log_date` -> `{ "log", "streaks" }`. Body `{ "completed"?: boolean, "note"?: string|null }`. `404 not_found` nếu ngày đó chưa có log sống.
- `DELETE /habits/:id/logs/:log_date` -> `{ "streaks" }`. Xóa mềm log (`404` nếu không có).
- `GET /habits/:id/logs?from=&to=` -> `{ "items": [log...] }`; `GET /habits/calendar?from=&to=` -> `{ "from", "to", "by_date": { "YYYY-MM-DD": { "<habit_id>": 0|1 } } }`. Khoảng tối đa 90 ngày, nếu không `400 invalid_range`.
- Lỗi: `401`; `404 { "error": "not_found" }`; `400 { "error": "archived" }` (ghi log cho habit đã archive); `400 { "error": "invalid_range" }`; `400 { "error": "bad_input", "issues": [...] }`; **`400 { "error": "invalid_checklist" }`** khi `checklist_template_id` không tồn tại, đã xóa, hoặc là template riêng của người khác (template hệ thống thì hợp lệ).

### Checklist cần dùng
- `GET /checklists/templates?scope=all|own|system` -> `{ "items": [template...] }` (mỗi template có `id`, `title`, `icon`, `category`, `category_id`, `is_system`, `sort_order`...). Dùng `scope=all` cho bộ chọn checklist.
- `GET /checklists/templates/:id` -> `{ "template", "items", "schedule" }`.
- `POST /checklists/runs` body `{ "template_id": uuid, "name"?: string }` -> `201 { "run", "items" }`.
- `PATCH /checklists/runs/:id/items/:itemId` body `{ "status": "pending"|"done"|"skipped", "note"? }` -> `{ "item" }`.
- `POST /checklists/runs/:id/complete` body `{ "duration_ms"?: int>=0|null }` -> `200 { "status": "completed", "duration_ms": ... }`; `409 { "error": "incomplete_required" }`.
- `POST /checklists/runs/:id/abandon` -> `{ "status": "abandoned" }`; `DELETE /checklists/runs/:id` -> `204`.
- Hoàn thành run KHÔNG tự xảy ra khi tick xong bước cuối: phải gọi `complete` (REST) hoặc đẩy `status = "completed"` (sync).

## 4. Sync

- Pull: `GET /sync/changes?since=<ISO>` (bỏ `since` = tải toàn bộ lần đầu) -> `{ "server_time": ISO, "changes": { "habits": [...], "habit_logs": [...], "checklist_templates": [...], "checklist_runs": [...], ... } }`. Bản ghi bị xóa trong lần pull có `since` mang `deleted_at` khác null.
- Push: `POST /sync/push`. Body: `{ "operations": [ { "op": "create"|"update"|"delete", "type": "<entity>", "payload": { ... } } ] }` (tối đa 100 thao tác; KHÓA LÀ `operations`, KHÔNG phải `ops`; tài liệu cũ `MOBILE_CHECKLIST_SCHEDULE_CONTRACT.md` ghi nhầm là `ops`). Phản hồi: `{ "server_time", "results": [ { "id": "...", "status": "applied"|"conflict"|"error", "server_version"?: {...}, "error"?: "..." } ] }`, thứ tự kết quả khớp thứ tự thao tác; mỗi thao tác độc lập, lỗi một thao tác không hủy các thao tác khác.
- Loại thực thể liên quan: `habit` (mảng pull `habits`), `habit_log` (`habit_logs`), `checklist_template` (`checklist_templates`), `checklist_run` (`checklist_runs`), `checklist_run_item`, `user`.
- Last-Write-Wins theo `updated_at` (bản cũ hơn bị bỏ qua và trả `conflict` + `server_version`).
- Mã lỗi thao tác: `bad_input`, `forbidden`, `read_only` (sửa/xóa template hệ thống), `invalid_habit` (todo), **`invalid_checklist`** (habit trỏ tới template không hợp lệ).

### Habit qua sync
- Payload habit: `id`, `title`, `description`, `icon`, `color`, `frequency_type`, `target_per_period`, `active_weekdays`, `start_date`, `end_date`, **`checklist_template_id`**, `is_archived` (boolean), `created_at`, `updated_at`, `deleted_at`. `current_streak`/`longest_streak` bị bỏ qua.
- **`checklist_template_id` vắng = giữ nguyên liên kết đã lưu (bản app cũ không gửi field này sẽ không xóa liên kết); `null` = gỡ liên kết; chuỗi = gắn.** Template phải tồn tại và hiển thị được cho người dùng (của mình hoặc hệ thống, chưa xóa), nếu không thao tác trả `{ "status": "error", "error": "invalid_checklist" }` và KHÔNG ghi gì; kiểu sai (không phải chuỗi) trả `bad_input`.
- THỨ TỰ ĐẨY: đẩy checklist template mới tạo TRƯỚC habit gắn với nó (cùng lô thì để template đứng trước).
- Xóa checklist (REST, sync hoặc admin với template hệ thống): back-end tự đặt `checklist_template_id = null` cho các habit đang gắn nó và tăng `updated_at` của những habit đó, nên bản cập nhật habit sẽ đến qua pull. Vì vậy khi tự xóa template ở cục bộ, app phải gỡ liên kết ở các habit cục bộ ngay, KHÔNG đẩy habit mang liên kết cũ (sẽ bị `invalid_checklist`).

### Habit log qua sync
- Payload: `id`, `habit_id`, `log_date`, `completed` (boolean), `note`, `created_at`, `updated_at`, `deleted_at`.
- Khóa tự nhiên `(habit_id, log_date)`. Đẩy `create` với `id` KHÁC cho cùng `(habit_id, log_date)`:
  - Nếu server đã có log SỐNG do người dùng tạo (hoặc do tự tick từ todo/checklist): kết quả `conflict` + `server_version` (bản server), giá trị server thắng, app đổi id cục bộ sang `server_version.id` và nhận giá trị server.
  - Nếu server chỉ có log đã xóa mềm HOẶC log do job đóng ngày ghi (`completed=false`, người dùng chưa chạm): server áp dụng `completed`/`note` của client lên đúng dòng đó và trả `conflict` + `server_version` (giá trị đã là của client, id là id chuẩn của server). App đổi id cục bộ sang `server_version.id`.
- Tức là: tick offline lúc 23:50 rồi đẩy sau nửa đêm KHÔNG bị dòng `completed=false` do job ghi đè mất.

### Run qua sync
- Để hoàn thành bằng sync: đẩy `checklist_run` (`update`, hoặc `create` với `status: "completed"`) có `status: "completed"`, `completed_at` (ISO UTC dạng chuẩn `YYYY-MM-DDTHH:mm:ss.SSSZ`), `duration_ms` (tùy chọn), `updated_at`. Back-end lấy ngày log từ `completed_at` (nếu null/không hợp lệ thì dùng `updated_at`). Hook chỉ chạy khi trạng thái chuyển từ khác `completed` sang `completed`; đẩy lại cùng bản không chạy lại.

## 5. Bảng trạng thái hiển thị của một habit trong một ngày D (hôm nay = T theo `user.timezone`)

| Điều kiện (xét theo thứ tự) | Trạng thái |
| --- | --- |
| `D < habit.start_date` hoặc (`habit.end_date` khác null và `D > habit.end_date`) | Không áp dụng |
| `D > T` | Tương lai |
| Có log sống, `completed = true` | Hoàn thành |
| Có log sống, `completed = false` | Bỏ lỡ (không hoàn thành) |
| Không có log, `D = T` | Chưa làm (đang chờ trong hôm nay) |
| Không có log, `D < T` | Bỏ lỡ (server sẽ ghi `completed=false`; app hiển thị như đã bỏ lỡ ngay, kể cả khi chưa pull kịp hoặc dữ liệu trước ngày triển khai) |

## 6. Những điều KHÔNG được làm
- KHÔNG tự tạo log `completed=false` ở client để "đóng ngày". Việc này thuộc server. Client chỉ suy ra trạng thái hiển thị theo bảng trên.
- KHÔNG dùng `DELETE /habits/:id/logs/:log_date` để "bỏ tick" một ngày đã qua: server đã đóng ngày đó và sẽ không tạo lại log, ngày đó thành "không có dữ liệu". Bỏ tick = ghi `completed = false` (PATCH nếu đã có log, POST/upsert nếu chưa) hoặc đẩy `habit_log` với `completed=false`.
- KHÔNG đẩy habit mang `checklist_template_id` trỏ tới template đã xóa/không nhìn thấy được.
- KHÔNG đặt khóa ngoại cứng ở DB cục bộ từ `habits.checklist_template_id` sang bảng template (thứ tự áp dụng pull không đảm bảo template đến trước habit).
- KHÔNG tự suy diễn ngày hoàn thành checklist bằng ngày máy khi biết `user.timezone`.

=== KẾT THÚC HỢP ĐỒNG ===
````

---

## PROMPT 1: Dữ liệu cục bộ và sync (nền tảng)

````text
Giai đoạn 1/5: tầng DỮ LIỆU và SYNC cho tính năng "habit gắn checklist" và "đóng ngày lúc 00h". Chưa làm giao diện ở giai đoạn này (chỉ sửa UI nếu code cũ bắt buộc phải sửa để biên dịch được).

Đọc trước: `docs/backend-habit-checklist-contract.md` (hợp đồng API, nguồn sự thật) và báo cáo khảo sát của Prompt 0. Nếu thiếu tệp hợp đồng thì DỪNG và báo tôi.

Hãy suy nghĩ từng bước và làm theo thứ tự:

1. MÔ HÌNH HABIT
   - Thêm field `checklistTemplateId` (nullable String) vào model Habit, ánh xạ JSON `checklist_template_id` ở CẢ HAI mapper: REST (số 0/1 cho `completed`/`is_archived`) và sync (boolean). Field luôn có mặt trong đối tượng, mang giá trị `null` khi không gắn.
   - Thêm cột tương ứng vào DB cục bộ bằng MIGRATION an toàn (nâng schema version; dữ liệu cũ nhận `NULL`). KHÔNG đặt khóa ngoại cứng sang bảng template.
   - Cập nhật mọi nơi sao chép/so sánh/serialize habit (copyWith, ==, toJson, fromJson, mapper DB, fixtures test) để không làm mất field mới.

2. PUSH HABIT
   - Mọi thao tác push `habit` (create/update) phải LUÔN gửi key `checklist_template_id` một cách tường minh: chuỗi uuid khi đang gắn, `null` khi không gắn/gỡ gắn. Không bao giờ bỏ key (bản cũ bỏ key là "giữ nguyên" ở server, nhưng app mới muốn gửi trạng thái rõ ràng).
   - Xử lý kết quả thao tác `status: "error"` với `error: "invalid_checklist"`: không retry vô hạn. Gỡ liên kết cục bộ của habit đó (đặt `checklistTemplateId = null`), đánh dấu thao tác đã xử lý, rồi đẩy lại habit với `null`; ghi log và (nếu app có cơ chế) báo cho UI để hiện thông báo "Checklist đã gắn không còn khả dụng, liên kết đã được gỡ". Các mã lỗi khác (`bad_input`, `forbidden`...) xử lý theo cơ chế hiện có của app.
   - Bảo đảm THỨ TỰ trong outbox: thao tác tạo `checklist_template` luôn đứng trước thao tác `habit` gắn nó. Nếu outbox hiện không đảm bảo thứ tự theo phụ thuộc, bổ sung một cách tối thiểu (ví dụ sắp xếp ổn định theo loại thực thể hoặc theo thời điểm tạo) và nói rõ bạn đã chọn gì.

3. PULL HABIT
   - Áp dụng `checklist_template_id` từ bản ghi pull vào DB cục bộ như mọi field khác, kể cả `null` (server gỡ liên kết khi template bị xóa, và việc đó đến app dưới dạng cập nhật habit có `updated_at` mới).
   - Khi người dùng tự xóa một checklist template ở cục bộ (hoặc pull về một template có `deleted_at`), gỡ liên kết ngay ở các habit cục bộ đang trỏ tới nó (đặt `checklistTemplateId = null`) trong cùng giao dịch. KHÔNG tạo thao tác push habit chỉ vì lý do này (server đã tự gỡ và sẽ gửi xuống).

4. HABIT LOG và đóng ngày (ĐỌC KỸ, dễ sai)
   - App KHÔNG được tự tạo log `completed=false` để đóng ngày. Tìm mọi chỗ trong code đang làm việc đó (job nền, lúc mở app, lúc đổi ngày...) và loại bỏ hoặc vô hiệu hóa, ghi rõ bạn đã gỡ chỗ nào. Nếu không có chỗ nào thì ghi "không có".
   - Pull `habit_logs` vẫn áp dụng như cũ; sẽ có thêm nhiều dòng `completed=false` do server ghi, không có field phân biệt. Đảm bảo DB cục bộ có UNIQUE `(habit_id, log_date)` hoặc có cơ chế tương đương để dòng pull trùng khóa tự nhiên nhưng khác id không tạo bản sao (nếu đã có thì giữ nguyên).
   - Xử lý kết quả `conflict` của thao tác `habit_log`: đổi id cục bộ của dòng đó thành `server_version.id`, áp dụng `completed`/`note`/`updated_at` từ `server_version`, và bỏ thao tác khỏi outbox. Nếu app đã làm điều này cho các thực thể khác (ví dụ tag) thì dùng lại đúng cơ chế đó; nếu habit_log chưa được xử lý thì bổ sung. Đây là trường hợp bắt buộc đúng: tick offline lúc 23:50 rồi đẩy sau nửa đêm sẽ gặp `conflict` mà server đã áp dụng giá trị của client.
   - "Bỏ tick" một ngày (undo): ghi `completed=false` (cập nhật log hiện có hoặc tạo log mới với `completed=false`), KHÔNG xóa mềm log của ngày đã qua. Tìm chỗ undo/xóa log hiện tại và sửa cho đúng; với riêng ngày hôm nay, ghi `completed=false` cũng được chấp nhận và nhất quán.

5. TIMEZONE VÀ NGÀY
   - Tạo (hoặc tái dùng nếu đã có) MỘT hàm duy nhất, ví dụ `localDateOf(DateTime instantUtc, String ianaTimeZone) -> 'YYYY-MM-DD'` và `todayLocal(now, tz)`, dùng múi giờ IANA của người dùng (`user.timezone`, lấy từ phản hồi đăng nhập/sync `user`) và rơi về múi giờ máy nếu chưa có. Phải đúng khi ngày địa phương khác ngày UTC (ví dụ `2026-01-01T17:30:00Z` ở `Asia/Ho_Chi_Minh` là ngày `2026-01-02`) và qua thời điểm đổi giờ mùa hè. Nếu đã có thư viện timezone trong dự án thì dùng nó; chỉ thêm thư viện mới khi không còn cách nào và nói rõ lý do.
   - Mọi `completed_at` của run khi đẩy lên phải là ISO UTC dạng chuẩn `YYYY-MM-DDTHH:mm:ss.SSSZ`.

6. REPOSITORY / API CLIENT
   - REST: `POST /habits` và `PATCH /habits/:id` nhận `checklist_template_id` (PATCH: vắng = giữ, `null` = gỡ). Thêm mã lỗi `invalid_checklist` (HTTP 400) vào cách app phân loại lỗi, đúng phong cách các mã lỗi nghiệp vụ hiện có.
   - Cập nhật chỗ cần dùng: repository habit, use-case/service, provider/bloc liên quan, để UI giai đoạn sau có API sẵn như `setLinkedChecklist(habitId, templateId?)`.

7. TEST (viết cùng lúc, không để cuối)
   - Mapper: REST (số) và sync (boolean) đều đọc/ghi đúng `checklist_template_id`, kể cả `null`.
   - Migration DB: dữ liệu habit cũ vẫn đọc được, `checklistTemplateId == null`.
   - Outbox: thứ tự template trước habit; payload habit luôn có key `checklist_template_id`.
   - Kết quả `invalid_checklist`: liên kết bị gỡ cục bộ, không vòng lặp retry.
   - Xóa template cục bộ gỡ liên kết ở habit; pull habit mang `null` cũng gỡ.
   - `conflict` của habit_log: id cục bộ được đổi sang `server_version.id`, giá trị lấy từ server_version, không sinh bản sao.
   - Hàm ngày: các ca biên múi giờ (23:50, 00:10, UTC+7, múi giờ âm, DST).
   - Undo ngày đã qua ghi `completed=false` chứ không xóa.

Kết thúc giai đoạn: chạy phân tích tĩnh + toàn bộ test, báo lệnh và kết quả; liệt kê tệp đã sửa và các quyết định thiết kế (nhất là mục 2 về thứ tự outbox, mục 4 về nơi bạn gỡ việc tự tạo log). Commit với thông điệp rõ ràng. CHƯA làm giao diện mới.
````

---

## PROMPT 2: Giao diện chọn/gắn checklist cho habit

````text
Giai đoạn 2/5: giao diện GẮN CHECKLIST vào habit. Điều kiện: giai đoạn 1 (dữ liệu + sync) đã xong và test xanh. Đọc `docs/backend-habit-checklist-contract.md` trước.

Mục tiêu: người dùng có thể gắn một habit với một checklist, đổi sang checklist khác, hoặc gỡ liên kết; và thấy rõ habit đang gắn checklist nào.

Hãy suy nghĩ từng bước, bám phong cách UI hiện có (widget dùng chung, theme, chuỗi tiếng Việt, i18n nếu app có):

1. FORM TẠO/SỬA HABIT
   - Thêm một hàng/trường "Checklist liên kết" (tùy chọn). Trạng thái rỗng: hiển thị "Không liên kết" cùng mô tả ngắn: "Khi bạn hoàn thành checklist này, thói quen sẽ tự được đánh dấu hoàn thành cho đúng ngày đó."
   - Chạm vào mở bộ chọn checklist (bottom sheet/trang chọn theo phong cách app) liệt kê TẤT CẢ checklist người dùng có thể thấy: của người dùng và template hệ thống (`scope=all`/dữ liệu cục bộ tương ứng), chưa xóa. Hiển thị tiêu đề, icon, nhãn "Hệ thống" cho template hệ thống, có ô tìm kiếm nếu danh sách dài, có lựa chọn "Không liên kết" để gỡ.
   - Nhiều habit được phép gắn cùng một checklist; KHÔNG chặn việc đó.
   - Khi lưu: nếu có chọn thì gửi `checklist_template_id` là uuid, nếu gỡ thì `null`. Với PATCH, chỉ gửi `null` khi người dùng chủ động gỡ; nếu không đổi, giữ nguyên (đừng gửi `null` nhầm khi người dùng không đụng đến trường này).
   - Offline-first: lưu cục bộ ngay, đẩy sau qua sync như các thay đổi khác (giai đoạn 1 đã lo thứ tự outbox và `invalid_checklist`).
   - Ghi chú trong màn hình (một dòng mô tả dưới trường, không phải popup): "Gắn checklist chỉ có tác dụng cho các lần hoàn thành từ nay về sau, không tính lại các lần đã hoàn thành trước đó." (đây là hành vi thật của back-end: gắn không backfill).

2. HIỂN THỊ LIÊN KẾT
   - Danh sách habit: nếu habit có liên kết, hiện một huy hiệu nhỏ (icon checklist + tên checklist rút gọn). Habit không liên kết thì giữ nguyên giao diện cũ.
   - Màn chi tiết habit: khối "Checklist liên kết" gồm tên checklist, nút "Mở checklist" (điều hướng tới màn chi tiết/bắt đầu checklist hiện có của app) và nút "Gỡ liên kết" (có xác nhận). Nếu checklist liên kết không tìm thấy trong dữ liệu cục bộ (đã bị xóa) thì hiển thị "Checklist không còn khả dụng" và coi như không gắn, không crash.
   - Tên checklist lấy từ dữ liệu cục bộ theo `checklistTemplateId`; cân nhắc hiệu năng danh sách (tránh N truy vấn: dùng map/join).

3. XỬ LÝ LỖI VÀ TRẠNG THÁI
   - Nếu lưu qua REST (nơi app dùng REST thay vì outbox) trả `400 invalid_checklist`: hiện thông báo "Checklist đã chọn không còn khả dụng", đưa bộ chọn về trạng thái "Không liên kết", không đóng form.
   - Khi một checklist bị xóa: habit đang gắn chuyển về "Không liên kết" (giai đoạn 1 đã gỡ ở dữ liệu cục bộ). Đảm bảo UI cập nhật phản ứng theo (stream/provider), không cần khởi động lại app.
   - Habit đã archive: vẫn xem được liên kết, nhưng nhớ rằng habit archive không được tự tick.

4. KHÔNG làm ở giai đoạn này: hành vi tự tick khi hoàn thành checklist (giai đoạn 3); hiển thị trạng thái ngày/đóng ngày (giai đoạn 4).

5. TEST
   - Widget/UI test: form hiển thị "Không liên kết" mặc định; chọn checklist thì payload lưu đúng `checklistTemplateId`; gỡ thì `null`; sửa habit mà không đụng trường này thì không đổi liên kết; template hệ thống có nhãn; danh sách habit hiện huy hiệu; checklist đã xóa thì không crash.
   - Nếu app có golden test/snapshot thì cập nhật có chủ đích.

Kết thúc giai đoạn: chạy phân tích tĩnh + test, báo kết quả; đính kèm mô tả ngắn các màn hình đã đổi (và ảnh chụp/golden nếu app hỗ trợ). Commit.
````

---

## PROMPT 3: Tự tick habit khi hoàn thành checklist (logic phía Mobile)

````text
Giai đoạn 3/5: HÀNH VI khi người dùng hoàn thành một lần chạy (run) checklist có habit gắn kèm. Điều kiện: giai đoạn 1 và 2 đã xong. Đọc `docs/backend-habit-checklist-contract.md` (mục 1.1, 4 "Run qua sync", 6) trước.

SỰ THẬT CỦA BACK-END (không được làm khác):
 - Back-end tự ghi log `completed=true` cho mọi habit còn sống, chưa archive, gắn với checklist của run, vào ĐÚNG NGÀY ĐỊA PHƯƠNG (theo `user.timezone`) của `completed_at`. Xảy ra đúng một lần lúc run chuyển sang `completed` (REST `POST /checklists/runs/:id/complete` hoặc sync push `status:"completed"`).
 - Không có thao tác "bỏ hoàn thành" run. Xóa/bỏ dở run về sau KHÔNG đổi log habit đã ghi. Gắn checklist KHÔNG backfill.
 - Log đã ở trạng thái `completed=false` (kể cả do job đóng ngày) sẽ được nâng lên `true`; `note` giữ nguyên.
 - Habit vừa gắn todo vừa gắn checklist: hoàn thành bằng cách nào cũng được tính.

Hãy suy nghĩ từng bước:

1. KHI NGƯỜI DÙNG HOÀN THÀNH RUN TRÊN THIẾT BỊ
   - Giữ nguyên luồng hoàn thành run hiện có (REST hoặc sync, tùy app). Đảm bảo `completed_at` là thời điểm thực tế hoàn thành, dạng ISO UTC chuẩn `YYYY-MM-DDTHH:mm:ss.SSSZ`, và với đường sync thì đẩy `status:"completed"` cùng `completed_at`, `duration_ms`, `updated_at` trong CÙNG một thao tác.
   - Tính ngày log cục bộ bằng hàm ngày của giai đoạn 1: `localDateOf(completed_at, user.timezone)`. Tuyệt đối không dùng ngày máy hay cắt chuỗi UTC.

2. CẬP NHẬT LẠC QUAN (optimistic) CHO HABIT GẮN KÈM
   - Ngay khi hoàn thành run, với mọi habit cục bộ thỏa: `checklistTemplateId == run.templateId`, chưa xóa, chưa archive, hiển thị log của ngày đó là "Hoàn thành" cho giao diện (lịch, danh sách, chi tiết, streak hiển thị nếu app tính cục bộ) mà KHÔNG chờ mạng.
   - Cách làm ƯU TIÊN: chỉ cập nhật tầng hiển thị/DB cục bộ ở dạng "suy ra", KHÔNG đưa một thao tác `habit_log` vào outbox, vì back-end sẽ tự tạo log khi nhận được run hoàn thành; lần pull tiếp theo sẽ thay thế bằng dòng thật của server. Khi pull về dòng thật cho cùng `(habit_id, log_date)`, bản suy ra bị thay thế, không tạo bản sao.
   - Cách làm CHẤP NHẬN ĐƯỢC nếu kiến trúc hiện tại không có khái niệm "dòng suy ra": ghi một `habit_log` cục bộ `completed=true` và đưa vào outbox. Khi đó thao tác `habit_log` PHẢI được đẩy SAU thao tác hoàn thành run trong cùng thứ tự outbox; kết quả sẽ là `conflict` (server đã tự ghi log), và cơ chế remap id của giai đoạn 1 sẽ hợp nhất mà không tạo bản sao. Hãy chọn cách phù hợp, giải thích lựa chọn, và đảm bảo không sinh log trùng.
   - Không ghi đè `note` đang có của log; không hạ một ngày đã `completed=true` xuống `false`.

3. SAU KHI ĐỒNG BỘ
   - Sau khi đẩy xong (hoặc sau phản hồi `complete` thành công), thực hiện một lần pull để lấy log thật và streak do server tính. Nếu server trả log khác bản lạc quan (ví dụ vì ngày địa phương lệch do múi giờ), lấy server làm chuẩn và cập nhật UI.
   - Nếu đẩy run bị lỗi `409 incomplete_required` (REST), giữ nguyên trạng thái chưa hoàn thành, KHÔNG cập nhật lạc quan habit, hiển thị thông báo hiện có của app cho trường hợp này.

4. GIAO DIỆN CHO HABIT CÓ LIÊN KẾT
   - Ở danh sách/chi tiết habit có liên kết, nút tick thủ công VẪN dùng được như cũ. Thêm gợi ý nhỏ (không chặn thao tác): "Tự hoàn thành khi bạn xong checklist <tên>".
   - Khi habit vừa được tự tick nhờ checklist, có thể hiển thị chú thích nhẹ (ví dụ "Hoàn thành qua checklist") nếu việc này đơn giản trong kiến trúc hiện tại; nếu cần thêm field lưu nguồn thì KHÔNG thêm, vì back-end không cung cấp nguồn của log. Bỏ qua chú thích này nếu không thể làm mà không bịa dữ liệu.
   - Từ màn chi tiết habit có nút "Bắt đầu checklist" hoặc "Mở checklist" để người dùng chuyển ngay sang thực hiện.

5. CÁC CA BIÊN BẮT BUỘC XỬ LÝ ĐÚNG
   - Hoàn thành checklist lúc 23:50, đẩy sau nửa đêm: log thuộc ngày 23:50 (ngày trước), không phải ngày đang sync.
   - Hoàn thành lúc 00:05 theo giờ địa phương nhưng vẫn là ngày hôm trước theo UTC (và ngược lại): dùng `user.timezone`.
   - Hai thiết bị cùng hoàn thành checklist cùng ngày: idempotent, không lỗi, không log trùng.
   - Habit bị gỡ liên kết hoặc archive trước khi run hoàn thành: không tự tick.
   - Run bỏ dở (abandon) hoặc xóa: KHÔNG tick, và không hạ log cũ.
   - Ngày đã bị job đóng (log `completed=false`) rồi sau đó mới hoàn thành checklist (ví dụ đồng bộ muộn): log được nâng lên `completed=true`.
   - Người dùng đổi múi giờ: lần sau dùng giá trị `user.timezone` mới; không cố sửa log cũ.

6. TEST
   - Unit test hàm tính ngày log từ `completed_at` + múi giờ với các ca ở mục 5.
   - Test logic tick lạc quan: chỉ habit đủ điều kiện (đúng template, chưa archive/xóa) được tick; không ghi đè note; không hạ trạng thái; không tạo log trùng khi pull dòng thật.
   - Test luồng sync: hoàn thành run offline rồi đồng bộ, thứ tự outbox, kết quả `conflict` được hợp nhất đúng nếu bạn chọn cách chấp nhận được.
   - Test lỗi `incomplete_required` không tick lạc quan.

Kết thúc giai đoạn: phân tích tĩnh + test, báo kết quả, mô tả cách bạn chọn ở mục 2 và lý do, commit.
````

---

## PROMPT 4: Trạng thái ngày, lịch, thống kê và rollover lúc 00h

````text
Giai đoạn 4/5: HIỂN THỊ trạng thái "không hoàn thành" và xử lý qua 00h. Điều kiện: giai đoạn 1–3 đã xong. Đọc `docs/backend-habit-checklist-contract.md` (mục 1.2, 1.3, 5, 6) trước.

SỰ THẬT CỦA BACK-END:
 - Qua 00h theo `user.timezone`, mọi habit hoạt động (chưa xóa, chưa archive, trong khoảng `start_date..end_date`) chưa có log cho ngày vừa qua sẽ được server ghi log `completed=false`, không note. Không xét `frequency_type`/`target_per_period`/`active_weekdays`. Chỉ từ khi triển khai trở đi; ngày cũ trước đó vẫn trống.
 - Các dòng này đến app qua sync pull như log bình thường. Server bù tối đa 7 ngày nếu nó ngủ, và cũng đóng ngày ngay khi app pull hoặc gọi GET /habits sau nửa đêm.
 - Streak/dashboard/điểm không đổi.

Hãy suy nghĩ từng bước:

1. MỘT HÀM TRẠNG THÁI NGÀY DUY NHẤT
   - Tạo (hoặc tái dùng nếu đã có chỗ tương đương) một hàm thuần, ví dụ `HabitDayState resolveDayState(habit, date, log?, todayLocal)` trả về một trong: `notApplicable`, `future`, `done`, `missed`, `pending`. Quy tắc CHÍNH XÁC theo bảng mục 5 của hợp đồng:
     1) `date < habit.startDate` hoặc (`habit.endDate` khác null và `date > habit.endDate`) -> notApplicable
     2) `date > todayLocal` -> future
     3) có log sống `completed=true` -> done
     4) có log sống `completed=false` -> missed
     5) không có log và `date == todayLocal` -> pending
     6) không có log và `date < todayLocal` -> missed
   - `todayLocal` luôn tính từ `user.timezone` (hàm của giai đoạn 1), không phải ngày máy khi hai giá trị có thể khác nhau.
   - Dùng hàm này ở MỌI nơi hiển thị trạng thái ngày: lịch tháng/tuần, heatmap, danh sách "hôm nay", chi tiết habit (lịch sử), widget màn hình chính nếu có, và thống kê. Tìm và thay thế mọi chỗ đang suy ra trạng thái bằng "có log hay không".

2. LỊCH VÀ LỊCH SỬ
   - Ngày `missed` hiển thị rõ khác ngày `pending`/`future`/`notApplicable` (ví dụ dấu X/đỏ cho missed, ô trống/nhạt cho pending và future, ẩn hoặc xám cho notApplicable). Chọn theo design system hiện có, nhưng PHẢI phân biệt được `missed` với `pending`.
   - `GET /habits/calendar` và `GET /habits/:id/logs` (nếu app gọi trực tiếp) có thêm giá trị `0`/`false` cho ngày đã đóng: đừng coi `0` là "không có dữ liệu". Giới hạn khoảng truy vấn 90 ngày (nếu không `400 invalid_range`).
   - `recent_logs` của chi tiết habit nay là 30 ngày liên tiếp: danh sách lịch sử/streak hiển thị không được giả định "mỗi dòng là một ngày có tick".

3. THỐNG KÊ VÀ STREAK HIỂN THỊ
   - Tỉ lệ hoàn thành, số ngày bỏ lỡ, biểu đồ: mẫu số = số ngày áp dụng (không tính notApplicable/future; và tính cả pending hôm nay theo cách app đang làm cho "ngày hôm nay chưa hết"), tử số = số ngày `done`. Mọi ngày `missed` (kể cả không có log) tính là không hoàn thành.
   - KHÔNG đổi cách tính/hiển thị streak hiện có; chỉ cần đảm bảo ngày `missed` cắt chuỗi như một ngày không hoàn thành. Với streak do server cung cấp (`current_streak`/`longest_streak`) thì giữ nguyên nguồn đó.
   - Nếu UI hiện tại có khái niệm "ngày không đến hạn" dựa trên `active_weekdays`/`frequency_type` (hãy kiểm tra thật trong code), GIỮ NGUYÊN cách hiển thị đó cho các ngày không đến hạn và đừng hiển thị các dòng `completed=false` do server ghi ở những ngày ấy như "bỏ lỡ"; báo lại cho tôi chỗ bạn áp dụng quy tắc này, vì back-end chưa phân biệt các ngày đó. Nếu UI không có khái niệm này thì không làm gì thêm.

4. TƯƠNG TÁC TRÊN NGÀY ĐÃ QUA
   - Người dùng chạm vào ngày `missed` để chuyển thành hoàn thành: ghi `completed=true` (PATCH nếu đã có log sống, ngược lại POST/upsert hoặc `habit_log` qua sync). Hợp lệ kể cả với ngày đã bị đóng; xử lý `conflict` theo giai đoạn 1.
   - Bỏ tick một ngày đã qua: ghi `completed=false`, KHÔNG xóa log (xem mục 6 hợp đồng). Xóa log hôm nay thì chấp nhận được nhưng hãy thống nhất dùng `completed=false`.
   - Habit đã archive: không cho tick; nhớ rằng server không đóng ngày của habit đang archive.
   - Không ghi log cho `future` và `notApplicable` (nếu cho phép ghi ở các ngày này trong app hiện tại thì giữ như cũ, đừng thay đổi phạm vi của yêu cầu này).

5. QUA 00h KHI APP ĐANG MỞ HOẶC ĐANG NỀN
   - Khi ngày địa phương đổi (app đang foreground qua 00:00 theo `user.timezone`, hoặc app resume sau khi đã qua nửa đêm): cập nhật "hôm nay" cho toàn bộ giao diện (reactive: cuộn/làm mới danh sách hôm nay, ô hôm qua chuyển thành `missed` nếu chưa tick) mà không cần khởi động lại. Dùng timer chính xác tới 00:00 giờ địa phương kế tiếp (hoặc cơ chế sẵn có), nhớ hủy timer khi dispose; cũng bắt sự kiện lifecycle resume.
   - Sau khi đổi ngày hoặc resume: kích hoạt MỘT lần pull (đúng cơ chế debounce/throttle của app). Server sẽ đóng ngày ngay trong lần pull đó nên dòng `completed=false` đến liền; trong lúc chờ, hàm trạng thái mục 1 đã hiển thị đúng nên không có hiện tượng nhấp nháy.
   - KHÔNG tạo log false ở client, KHÔNG đưa thao tác nào vào outbox vì lý do đổi ngày.

6. TEST
   - Unit test `resolveDayState` đầy đủ 6 nhánh + các ca biên: đúng `start_date`, đúng `end_date`, hôm nay, hôm qua, tương lai, múi giờ khác múi giờ máy, qua nửa đêm.
   - Test thống kê/tỉ lệ với dữ liệu có cả ngày thiếu log lẫn log false.
   - Widget test lịch: missed khác pending; ngày notApplicable/future hiển thị đúng.
   - Test rollover: đổi "ngày hiện tại" trong test clock, UI cập nhật hôm nay và ngày hôm qua thành missed nếu chưa tick.
   - Test tương tác: chạm ngày missed -> done; bỏ tick ngày đã qua -> ghi `false`, không xóa.

Kết thúc giai đoạn: phân tích tĩnh + test, báo kết quả; liệt kê các màn hình/widget đã chuyển sang dùng `resolveDayState` và những chỗ còn lại bạn chủ ý không đổi (kèm lý do). Commit.
````

---

## PROMPT 5: Kiểm thử tích hợp, rà soát và nghiệm thu

````text
Giai đoạn 5/5: KIỂM THỬ TÍCH HỢP, RÀ SOÁT và NGHIỆM THU toàn bộ tính năng. Điều kiện: giai đoạn 1–4 đã xong và commit. Đọc lại `docs/backend-habit-checklist-contract.md`.

Hãy suy nghĩ từng bước. Đây là giai đoạn kiểm tra chéo, không thêm tính năng mới; chỉ sửa lỗi tìm được.

1. RÀ SOÁT BÁM HỢP ĐỒNG (đọc diff của cả 4 giai đoạn, đối chiếu từng mục)
   Với mỗi mục sau, ghi "ĐẠT / CHƯA ĐẠT + tệp:dòng":
   - [ ] Model/DB/mapper có `checklist_template_id` (REST số 0/1, sync boolean), migration an toàn, không có khóa ngoại cứng.
   - [ ] Payload push habit luôn có key `checklist_template_id` (uuid hoặc null).
   - [ ] PATCH qua REST: vắng = giữ, null = gỡ; chỉ gửi null khi người dùng chủ động gỡ.
   - [ ] `invalid_checklist` được xử lý (REST 400 và sync op error): gỡ liên kết cục bộ, không vòng retry, thông báo hợp lý.
   - [ ] Outbox: template trước habit.
   - [ ] Xóa template cục bộ gỡ liên kết ở habit, không push habit chỉ vì lý do đó; pull habit `null` cũng gỡ.
   - [ ] Không còn đoạn nào của app tự tạo log `completed=false` để đóng ngày.
   - [ ] `conflict` của habit_log đổi id sang `server_version.id` và áp dụng giá trị; không bản sao; có UNIQUE hoặc tương đương cho `(habit_id, log_date)`.
   - [ ] Bỏ tick ngày đã qua ghi `completed=false` thay vì xóa.
   - [ ] Ngày log của hoàn thành checklist tính từ `completed_at` theo `user.timezone` (có test biên).
   - [ ] `completed_at` đẩy lên ở dạng ISO UTC chuẩn `YYYY-MM-DDTHH:mm:ss.SSSZ`.
   - [ ] Tick lạc quan: không outbox (hoặc outbox đúng thứ tự + hợp nhất conflict), không ghi đè note, không hạ trạng thái, không tạo trùng.
   - [ ] `resolveDayState` 6 nhánh đúng bảng hợp đồng, dùng ở mọi nơi hiển thị trạng thái ngày; không còn chỗ suy trạng thái bằng "có log hay không".
   - [ ] Rollover qua 00h cập nhật UI và kích hoạt một lần pull; timer được hủy đúng.
   - [ ] Khóa push là `operations` (không phải `ops`).
   - [ ] Không có endpoint/field nào được bịa ngoài hợp đồng.

2. KIỂM THỬ KỊCH BẢN (viết thành test tích hợp/mock server nếu kiến trúc cho phép; nếu không thì viết kịch bản kiểm tra tay có các bước và kết quả mong đợi trong `docs/qa-habit-checklist.md`):
   a) Gắn checklist cho habit -> hoàn thành run -> habit hiển thị hoàn thành đúng ngày (REST).
   b) Như (a) nhưng offline: hoàn thành run offline, bật mạng, đồng bộ -> một log duy nhất, không bản sao, không lỗi.
   c) Hoàn thành run lúc 23:50 (giờ địa phương), đồng bộ lúc 00:10 -> log thuộc ngày 23:50.
   d) Habit không tick cả ngày; qua 00h: ngày hôm qua hiển thị `missed` ngay (kể cả offline), sau khi pull thì có dòng `completed=false` thật; không nhân đôi.
   e) Tick habit offline lúc 23:50, đồng bộ sau 00h -> kết quả cuối `completed=true` (không bị `false` do job ghi đè), id cục bộ khớp server.
   f) Người dùng chạm ngày missed để hoàn thành bù -> `completed=true`; bỏ tick ngày đã qua -> `completed=false` (không xóa).
   g) Xóa checklist đang được gắn -> habit về "Không liên kết" ở cục bộ ngay, không push habit lỗi; pull sau đó nhất quán.
   h) Gắn checklist đã bị xóa từ thiết bị khác -> lỗi `invalid_checklist` được xử lý đúng, không lặp vô hạn.
   i) Hai thiết bị cùng hoàn thành checklist cùng ngày -> không lỗi, một log.
   j) Habit archive: không tự tick, không hiển thị là missed cho các ngày trong lúc archive theo quy tắc hiện có của app.
   k) Đổi múi giờ người dùng giữa chừng -> "hôm nay" và ngày log theo múi giờ mới, dữ liệu cũ không bị sửa.
   l) Dữ liệu cũ trước ngày triển khai: ngày quá khứ không có log hiển thị `missed`, tỉ lệ hoàn thành tính theo mẫu số mới, không crash.

3. CHẤT LƯỢNG
   - Chạy phân tích tĩnh/lint/format theo cấu hình repo; chạy TOÀN BỘ test; báo lệnh và kết quả đầy đủ (số test, số lỗi). Sửa mọi lỗi do thay đổi này gây ra; với lỗi có sẵn từ trước, nêu rõ nhưng không "sửa lan" nếu ngoài phạm vi.
   - Tìm trong code: chỗ nào còn dùng `DateTime.now()` để cắt chuỗi ngày cho habit/checklist? Chỗ nào bỏ qua `user.timezone`? Liệt kê và sửa nếu thuộc phạm vi tính năng.
   - Kiểm tra rò rỉ: timer rollover được hủy, listener/stream được dispose.

4. BÁO CÁO NGHIỆM THU (in ra, không ghi vào repo trừ `docs/qa-habit-checklist.md`)
   - Bảng checklist mục 1 với ĐẠT/CHƯA ĐẠT.
   - Kết quả từng kịch bản mục 2: đã tự động hóa / kiểm tra tay / chưa kiểm tra được (kèm lý do).
   - Các quyết định thiết kế và các điểm lệch so với hợp đồng (nếu có) cùng lý do.
   - Rủi ro còn lại và đề xuất theo dõi.

Chỉ coi là xong khi: toàn bộ mục checklist ĐẠT hoặc có giải thích chấp nhận được, toàn bộ test xanh, và báo cáo đầy đủ. Commit cuối cùng gọn gàng.
````

---

## Ghi chú cho người điều phối (không dán cho Claude)

- **Back-end là nguồn sự thật.** Nếu Claude Mobile báo mâu thuẫn giữa prompt và API thật, kiểm tra lại `MOBILE_HABIT_CHECKLIST_LINK_CONTRACT.md` ở repo back-end rồi cập nhật khối hợp đồng trong Prompt 0 (và tệp `docs/backend-habit-checklist-contract.md` ở Mobile).
- **Thứ tự triển khai nên là:** deploy back-end trước (chạy `npm run db:migrate` để áp dụng migration `0018` và `0019`), sau đó phát hành app Mobile mới. App cũ vẫn chạy được với back-end mới vì các field mới là tùy chọn, nhưng sẽ chưa thấy liên kết và sẽ hiển thị ngày đã đóng theo cách cũ.
- **Điểm hay sai nhất** (đã nhấn mạnh trong prompt): khóa push là `operations` chứ không phải `ops`; REST dùng số `0/1` còn sync dùng boolean; không tự tạo log false ở client; bỏ tick ngày đã qua phải ghi `completed=false` chứ không xóa; ngày của lần hoàn thành checklist lấy theo `user.timezone`; xử lý `conflict` của `habit_log` bằng cách đổi id sang `server_version.id`.
- **Quy ước server chưa phân biệt** `active_weekdays`/`frequency_type` khi đóng ngày (theo quyết định "mọi habit đang hoạt động"). Prompt 4 mục 3 yêu cầu Claude Mobile báo lại nếu UI hiện tại có khái niệm ngày không đến hạn, để bạn quyết định có đồng bộ lại với back-end hay không.
