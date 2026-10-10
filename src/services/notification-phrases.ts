/**
 * Kho câu cho thông báo buổi sáng. Toàn bộ là câu NGUYÊN BẢN, không gán cho người thật và
 * không lấy lại câu trích dẫn có sẵn. Thêm/bớt câu thoải mái, miễn là mỗi kho còn >= 30 câu
 * và số câu nguyên tố cùng nhau với bước nhảy (xem `STEP_*`; test kiểm tra điều này).
 */

/** Câu cổ vũ, ngắn, tích cực. */
export const CHEER_PHRASES: readonly string[] = [
  "Bạn làm được, cứ từng việc một thôi nhé!",
  "Một khởi đầu nhỏ hôm nay là đủ để ngày thêm nhẹ nhàng.",
  "Cứ chậm mà chắc, bạn đang tiến bộ mỗi ngày.",
  "Hôm nay hãy tử tế với bản thân và làm hết sức mình.",
  "Bạn đã đi được một đoạn đường dài rồi, tiếp tục nhé!",
  "Chỉ cần bắt đầu thôi, phần còn lại sẽ dễ dần lên.",
  "Mỗi việc nhỏ hoàn thành là một niềm vui nhỏ đáng ghi nhận.",
  "Bạn có đủ năng lượng để làm điều mình đã đặt ra.",
  "Hít một hơi thật sâu, rồi bắt tay vào việc đầu tiên nào!",
  "Đừng quên khen bản thân sau mỗi việc hoàn thành nhé.",
  "Ngày hôm nay là của bạn, hãy dùng nó thật ý nghĩa.",
  "Bạn không cần hoàn hảo, chỉ cần kiên trì là đã giỏi lắm rồi.",
  "Cố lên, từng bước nhỏ cũng đưa bạn đến nơi bạn muốn.",
  "Tin vào bản thân một chút, bạn sẽ ngạc nhiên về những gì mình làm được.",
  "Mỗi buổi sáng là một trang giấy trắng, hãy viết điều bạn thích.",
  "Hôm nay cứ làm tốt phần việc của mình là đủ rồi.",
  "Bạn đang làm rất tốt, hãy giữ nhịp này nhé!",
  "Một chút nỗ lực hôm nay sẽ giúp ngày mai thảnh thơi hơn.",
  "Bạn xứng đáng với một ngày trọn vẹn và nhiều niềm vui.",
  "Đừng vội, hãy làm từng việc một và tận hưởng quá trình.",
  "Cảm ơn bạn đã kiên trì, mình tin bạn sẽ về đích.",
  "Dù hôm nay thế nào, bạn vẫn đang cố gắng, và điều đó thật đáng quý.",
  "Hãy bắt đầu với việc dễ nhất, đà tiến sẽ tự đến.",
  "Bạn mạnh mẽ hơn bạn nghĩ, cứ thử rồi sẽ thấy.",
  "Làm xong một việc, bạn đã nhẹ gánh thêm một chút.",
  "Hôm nay chỉ cần tiến thêm một chút so với hôm qua là tuyệt rồi.",
  "Nghỉ ngơi một chút cũng được, miễn là bạn quay lại với mục tiêu.",
  "Bạn đã chọn cố gắng, đó là phần khó nhất rồi!",
  "Hãy để niềm vui nhỏ từ việc hoàn thành dẫn lối bạn cả ngày.",
  "Mình ở đây cổ vũ bạn, cùng bước tiếp nhé!",
  "Một ngày tập trung đáng giá hơn nhiều ngày lo nghĩ.",
  "Chúc bạn một ngày thật năng suất và thật bình yên!",
];

/** Câu triết lý về năng suất, hành động, thành công. */
export const PHILOSOPHY_PHRASES: readonly string[] = [
  "Hành động nhỏ nhưng đều đặn thắng kế hoạch lớn mà để đó.",
  "Thành công là tổng của những ngày bình thường được làm đến nơi đến chốn.",
  "Bắt đầu quan trọng hơn việc bắt đầu cho thật hoàn hảo.",
  "Thời gian không giữ lại được, nhưng có thể dành cho đúng việc.",
  "Làm ít mà trúng đích thường hơn làm nhiều mà lan man.",
  "Kỷ luật là cách ta giữ lời hứa với chính mình.",
  "Những việc nhỏ làm đi làm lại mỗi ngày dần khắc nên cách ta sống.",
  "Sự tập trung là món quà quý nhất bạn dành cho công việc.",
  "Tiến độ nhỏ hôm nay là nền móng của kết quả lớn ngày mai.",
  "Ý tưởng chỉ có giá trị khi được biến thành việc làm.",
  "Ưu tiên rõ ràng giúp một ngày nhiều việc vẫn đi đúng hướng.",
  "Nghỉ ngơi đúng lúc không làm ta chậm lại, nó giúp ta đi xa hơn.",
  "Sai sót là bài học trên đường, không phải dấu chấm hết.",
  "Mục tiêu cho ta hướng đi, thói quen mới đưa ta tới nơi.",
  "Việc khó thường nhẹ đi khi được chia thành những bước nhỏ.",
  "Đừng đợi hết sợ mới làm, hãy làm để nỗi sợ nhỏ dần.",
  "Kết quả đẹp thường được dệt từ rất nhiều buổi sáng bền bỉ.",
  "Làm việc quan trọng trước, việc còn lại sẽ tự tìm được chỗ của mình.",
  "Một danh sách ngắn được hoàn thành quý hơn một danh sách dài bỏ dở.",
  "Sự bền bỉ lặng lẽ thường đi xa hơn sự bùng nổ nhất thời.",
  "Ai biết mình đang làm vì điều gì thì ít khi lạc đường.",
  "Hôm nay là hạt giống, ngày mai mới là quả ngọt.",
  "Giữ được sự chú ý của mình cũng là giữ được thời gian của mình.",
  "Giá trị của một ngày nằm ở điều đã làm, không phải điều đã định làm.",
  "Chậm lại để nghĩ cho rõ, rồi hành động thật dứt khoát.",
  "Bận rộn chưa chắc là hiệu quả; hiệu quả là làm đúng việc, đúng lúc.",
  "Tin vào quá trình giúp ta đi qua những lúc kết quả chưa đến.",
  "Mỗi lần chọn làm thay vì trì hoãn là một lần ta tự do hơn.",
  "Mỗi thói quen tốt như một khoản tiết kiệm nhỏ, góp mãi rồi cũng thành của cải.",
  "Hãy đo thành công bằng sự tiến bộ của mình, đừng đo bằng tốc độ của người khác.",
  "Cái giá của việc trì hoãn thường lớn hơn cái giá của việc bắt đầu.",
  "Con đường chỉ hiện rõ khi ta đã bước đi.",
];

/**
 * Bước nhảy theo ngày và độ lệch riêng của từng kho. Chọn câu = (ngàyEpoch * STEP + OFFSET) mod n.
 * STEP nguyên tố cùng nhau với n nên hai ngày liên tiếp luôn cho hai chỉ số khác nhau, và
 * trong n ngày liên tiếp không câu nào lặp lại. Hai kho dùng OFFSET khác nhau.
 */
export const STEP_CHEER = 7;
export const OFFSET_CHEER = 3;
export const STEP_PHILOSOPHY = 11;
export const OFFSET_PHILOSOPHY = 17;

const epochDay = (localDate: string): number => {
  const [year, month, day] = localDate.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
};

const pick = (
  list: readonly string[],
  localDate: string,
  step: number,
  offset: number
): string => {
  const n = list.length;
  const index = (((epochDay(localDate) * step + offset) % n) + n) % n;
  return list[index];
};

/** Hàm xác định theo ngày địa phương (YYYY-MM-DD): cùng ngày luôn ra cùng câu. */
export const cheerForDate = (localDate: string): string =>
  pick(CHEER_PHRASES, localDate, STEP_CHEER, OFFSET_CHEER);

export const philosophyForDate = (localDate: string): string =>
  pick(PHILOSOPHY_PHRASES, localDate, STEP_PHILOSOPHY, OFFSET_PHILOSOPHY);
